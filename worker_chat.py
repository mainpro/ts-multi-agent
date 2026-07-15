import json
import sys

from playwright.sync_api import sync_playwright

CDP_URL = "http://localhost:9222"

REPLY_TEXT = "您好，这边是兜底人工，业务系统的业务可能不特别清楚，您是哪个系统有问题或者给我下网址我帮您查下对应负责人。"
SKILL_GROUP_KEYWORD = "doudi_应用一线兜底技能组_一线"

VISITOR_NAME_SELECTOR = '.visitor-name-text'
SKILL_GROUP_SELECTOR = '.visitorInfo-row .info-option'
CHAT_MSG_SELECTOR = '.visitor-chat .text-content span'
EDITOR_SELECTOR = '.textarea-wrapper .my-tiny-editor.mce-content-body'
SEND_BTN_SELECTOR = '.textarea-wrapper .ant-btn'


def run(playwright, user_name: str) -> None:
    browser = playwright.chromium.connect_over_cdp(CDP_URL)
    try:
        ctx = browser.contexts[0]

        page = next(
            (pg for pg in ctx.pages if "webcustomer" in pg.url),
            ctx.pages[0] if ctx.pages else None,
        )
        if not page:
            print("找不到 IM 页面，请确认 daemon 已登录")
            return

        print(f"已连接，当前页面: {page.url}")

        names = page.locator(VISITOR_NAME_SELECTOR)
        name_count = names.count()
        print(f"找到访客: {name_count} 个")

        target_idx = -1
        for i in range(name_count):
            name = names.nth(i).text_content()
            if name and user_name in name:
                target_idx = i
                break

        if target_idx == -1:
            print(f"找不到包含用户名 '{user_name}' 的访客，脚本结束")
            return

        names.nth(target_idx).click()
        print(f"已点击用户: {user_name}")

        page.wait_for_selector(CHAT_MSG_SELECTOR, timeout=10000)
        print("聊天面板已加载")

        skill_options = page.locator(SKILL_GROUP_SELECTOR)
        is_doudi = False
        for i in range(skill_options.count()):
            text = skill_options.nth(i).text_content() or ""
            if SKILL_GROUP_KEYWORD in text:
                is_doudi = True
                print(f"技能组信息: {text.strip()}")
                break

        if not is_doudi:
            print(f"非兜底技能组，不执行回复，脚本结束")
            return

        print("是兜底技能组，继续处理")

        messages = page.evaluate("""
        () => {
            const allSpans = Array.from(document.querySelectorAll('.visitor-chat .text-content span'));
            const markerIdx = allSpans.findIndex(s => s.textContent?.trim() === '以下是最新消息');
            const recent = markerIdx >= 0 ? allSpans.slice(markerIdx + 1) : allSpans.slice(-5);
            const result = recent.map((s, i) => ({
                index: i,
                text: s.textContent?.trim()
            }));
            return JSON.stringify({ total: result.length, messages: result });
        }
        """)
        print(f"聊天消息:\n{messages}")

        msg_data = json.loads(messages)
        msgs = msg_data["messages"]
        if len(msgs) == 0:
            print("没有聊天消息，脚本结束")
            return

        last_msg = msgs[-1]["text"] or ""

        if last_msg == "转人工":
            print('最后一条是"转人工"，发送默认话术')
            editor = page.locator(EDITOR_SELECTOR)
            if editor.count() == 0:
                print("找不到编辑器，跳过回复")
                return

            editor.first.click()
            page.wait_for_timeout(300)
            page.keyboard.type(REPLY_TEXT)

            send_btns = page.locator(SEND_BTN_SELECTOR)
            btn_count = send_btns.count()
            print(f"找到发送按钮: {btn_count} 个")
            if btn_count > 0:
                send_btns.nth(btn_count - 1).click()
                print("已点击发送按钮")
        else:
            user_msgs = [m["text"] for m in msgs[-5:] if m["text"] and m["text"] != "转人工"]
            print(f'USER_MSG_COUNT: {len(user_msgs)}')
            for msg in user_msgs:
                print(f"MSG:{msg}")
    finally:
        browser.close()
        print("worker-chat 已断开连接")


if __name__ == "__main__":
    user_name = sys.argv[1] if len(sys.argv) > 1 else ""
    if not user_name:
        print("用法: python3 worker_chat.py <用户名>")
        sys.exit(1)
    with sync_playwright() as playwright:
        run(playwright, user_name)
