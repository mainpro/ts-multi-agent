import sys

from playwright.sync_api import sync_playwright

CDP_URL = "http://localhost:9222"

TRANSFER_ICON_SELECTOR = 'img[src*="transfer-icon"]'
SKILL_INPUT_SELECTOR = 'input[placeholder="请输入技能组名称"]'
SKILL_LIST_FIRST_SELECTOR = '.skill-list li'
MODAL_CONFIRM_SELECTOR = '.ant-modal-footer .ant-btn-primary'


def run(playwright, user_name: str, group_name: str) -> None:
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

        visitor = page.locator(f'.isFlex .visitor-name:has-text("{user_name}")')
        if visitor.count() == 0:
            print(f"找不到包含用户名 '{user_name}' 的访客，脚本结束")
            return
        visitor.first.click()
        print(f"已点击用户: {user_name}")

        page.wait_for_timeout(500)

        transfer_icon = page.locator(TRANSFER_ICON_SELECTOR)
        if transfer_icon.count() == 0:
            print("找不到转接图标，脚本结束")
            return
        transfer_icon.first.click(force=True)
        print("已点击转接图标")

        page.wait_for_selector('.ant-radio-group', timeout=10000)
        page.get_by_text("线上转接", exact=True).click()
        print("已选择线上转接")

        skill_input = page.locator(SKILL_INPUT_SELECTOR)
        skill_input.click()
        skill_input.fill(group_name)
        page.keyboard.press("Enter")
        print(f"已输入技能组名称: {group_name}")

        page.wait_for_selector(SKILL_LIST_FIRST_SELECTOR, timeout=10000)
        first_skill = page.locator(SKILL_LIST_FIRST_SELECTOR).first
        skill_name = first_skill.get_attribute("title") or first_skill.text_content()
        first_skill.click()
        print(f"已选择技能组: {skill_name}")

        page.locator(MODAL_CONFIRM_SELECTOR).click()
        print("已点击确定")
    finally:
        browser.close()
        print("forward 已断开连接")


if __name__ == "__main__":
    user_name = sys.argv[1] if len(sys.argv) > 1 else ""
    group_name = sys.argv[2] if len(sys.argv) > 2 else "应用一线兜底"
    if not user_name:
        print("用法: python3 forward.py <用户名> [技能组名称]")
        sys.exit(1)
    with sync_playwright() as playwright:
        run(playwright, user_name, group_name)
