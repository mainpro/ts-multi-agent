import json
import subprocess
import sys
import threading
import urllib.request
from pathlib import Path
from typing import Optional

from playwright.sync_api import Playwright, Page, sync_playwright

WORKER_CHAT = str(Path(__file__).parent / "worker_chat.py")
AGENT_URL = "http://localhost:3000/tasks"
MAX_CONCURRENT = 5
AGENT_TIMEOUT = 60

REPLY_TEXT = "您好，这边是兜底人工，业务系统的业务可能不特别清楚，您是哪个系统有问题或者给我下网址我帮您查下对应负责人。"
SKILL_GROUP_KEYWORD = "doudi_应用一线兜底技能组_一线"

IDLE = "idle"
IN_PROGRESS = "in_progress"

_page: Optional[Page] = None


def dom_monitor_callback(message: str) -> None:
    print(f"[DOM Monitor] {message}")


class UserSession:
    def __init__(self, user_name: str):
        self.user_name = user_name
        self.state = IDLE
        self.has_pending = False
        self.lock = threading.Lock()


class SessionManager:
    def __init__(self, max_concurrent: int):
        self._semaphore = threading.Semaphore(max_concurrent)
        self._sessions = {}  # type: dict
        self._sessions_lock = threading.Lock()
        self._page_lock = threading.Lock()
        self._pending_queue = []  # type: list
        self._queue_lock = threading.Lock()

    def get_session(self, user_name):
        # type: (str) -> UserSession
        with self._sessions_lock:
            if user_name not in self._sessions:
                self._sessions[user_name] = UserSession(user_name)
            return self._sessions[user_name]

    def enqueue(self, user_name):
        # type: (str) -> bool
        session = self.get_session(user_name)
        with session.lock:
            if session.state == IN_PROGRESS:
                session.has_pending = True
                print(f"[Queue] {user_name} 正在处理中，标记 pending")
                return False
        with self._queue_lock:
            if user_name in self._pending_queue:
                print(f"[Queue] {user_name} 已在队列中，跳过")
                return False
            self._pending_queue.append(user_name)
            print(f"[Queue] {user_name} 入队，当前队列: {self._pending_queue}")
        return True

    def dequeue(self):
        # type: () -> Optional[str]
        with self._queue_lock:
            if not self._pending_queue:
                return None
            user_name = self._pending_queue.pop(0)
            print(f"[Queue] {user_name} 出队，剩余队列: {self._pending_queue}")
            return user_name

    def acquire_slot(self):
        self._semaphore.acquire()

    def release_slot(self):
        self._semaphore.release()

    def lock_page(self):
        return self._page_lock

    def mark_in_progress(self, user_name):
        # type: (str) -> None
        session = self.get_session(user_name)
        with session.lock:
            session.state = IN_PROGRESS

    def check_and_clear_pending(self, user_name):
        # type: (str) -> bool
        session = self.get_session(user_name)
        with session.lock:
            if session.has_pending:
                session.has_pending = False
                return True
            session.state = IDLE
            return False


manager = SessionManager(MAX_CONCURRENT)


def run_worker_chat(user_name):
    # type: (str) -> list
    with manager.lock_page():
        result = subprocess.run(
            ["python3", WORKER_CHAT, user_name],
            capture_output=True,
            text=True,
            timeout=30,
        )
    if result.returncode != 0:
        print(f"[Worker] {user_name} worker_chat 失败 (退出码: {result.returncode})")
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)
        return []
    user_messages = [line[4:] for line in result.stdout.splitlines() if line.startswith("MSG:")]
    return user_messages


def call_agent(user_name, requirement):
    # type: (str, str) -> Optional[dict]
    payload = json.dumps({
        "requirement": "使用兜底技能\n" + requirement,
        "userId": user_name,
        "sessionId": f"im-{user_name}",
    }).encode("utf-8")

    req = urllib.request.Request(
        AGENT_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=AGENT_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            print(f"[Agent] {user_name} 响应: status={body.get('status')}, result={str(body.get('result', ''))[:200]}")
            return body
    except urllib.error.URLError as e:
        print(f"[Agent] {user_name} 调用失败: {e}")
        return None


def process_user(user_name):
    # type: (str) -> None
    while True:
        print(f"[Process] {user_name} 开始处理")
        manager.mark_in_progress(user_name)

        user_messages = run_worker_chat(user_name)
        if not user_messages:
            print(f"[Process] {user_name} 无用户消息，处理结束")
            break

        requirement = "\n".join(user_messages)
        print(f"[Process] {user_name} 发送到 agent，需求: {requirement[:100]}")

        call_agent(user_name, requirement)

        if manager.check_and_clear_pending(user_name):
            print(f"[Process] {user_name} 有 pending 消息，立即重新处理")
            continue
        print(f"[Process] {user_name} 处理完成")
        break


def unreply_callback(user_name):
    # type: (str) -> None
    print(f"[Unreply] 检测到未回复 (用户: {user_name})")
    if not manager.enqueue(user_name):
        return

    def _worker():
        manager.acquire_slot()
        try:
            process_user(user_name)
        except Exception as e:
            print(f"[Unreply] {user_name} 执行异常: {e}")
        finally:
            manager.release_slot()
            next_user = manager.dequeue()
            if next_user:
                unreply_callback(next_user)

    threading.Thread(target=_worker, daemon=True).start()


def news_icon_callback(user_name):
    # type: (str) -> None
    print(f"[News Icon] 检测到 .news-icon (用户: {user_name})，直接处理")
    if _page is None:
        print("[News Icon] 页面未初始化")
        return

    page = _page
    with manager.lock_page():
        try:
            found = page.evaluate("""(userName) => {
                const cards = document.querySelectorAll('.base-item');
                for (const card of cards) {
                    const nameEl = card.querySelector('.visitor-name-text');
                    if (nameEl && nameEl.textContent.trim().includes(userName)) {
                        nameEl.click();
                        return true;
                    }
                }
                return false;
            }""", user_name)

            if not found:
                print(f"[News Icon] 找不到用户 {user_name}")
                return

            page.wait_for_selector('.visitor-chat .text-content span', timeout=10000)

            skill_options = page.locator('.visitorInfo-row .info-option')
            is_doudi = False
            for i in range(skill_options.count()):
                text = skill_options.nth(i).text_content() or ""
                if SKILL_GROUP_KEYWORD in text:
                    is_doudi = True
                    break

            if not is_doudi:
                print(f"[News Icon] 非兜底技能组，跳过")
                return

            messages = page.evaluate("""() => {
                const spans = Array.from(document.querySelectorAll('.visitor-chat .text-content span'));
                const markerIdx = spans.findIndex(s => s.textContent?.trim() === '以下是最新消息');
                const recent = markerIdx >= 0 ? spans.slice(markerIdx + 1) : spans.slice(-5);
                return recent.map(s => s.textContent?.trim()).filter(t => t);
            }""")

            if not messages:
                print("[News Icon] 无消息")
                return

            last_msg = messages[-1]

            if last_msg == "转人工":
                print('[News Icon] 最后一条是"转人工"，发送默认话术')
                editor = page.locator('.textarea-wrapper .my-tiny-editor.mce-content-body')
                if editor.count() == 0:
                    print("[News Icon] 找不到编辑器")
                    return
                editor.first.click()
                page.wait_for_timeout(300)
                page.keyboard.type(REPLY_TEXT)

                send_btns = page.locator('.textarea-wrapper .ant-btn')
                if send_btns.count() > 0:
                    send_btns.nth(send_btns.count() - 1).click()
                    print("[News Icon] 已发送回复")
            else:
                print(f"[News Icon] 最后一条不是转人工: {last_msg}")
        except Exception as e:
            print(f"[News Icon] 处理异常: {e}")


def run(playwright):
    # type: (Playwright) -> None
    global _page

    browser = playwright.chromium.launch(headless=False, args=["--start-maximized", "--remote-debugging-port=9222"])
    context = browser.new_context(no_viewport=True)
    page = context.new_page()
    _page = page

    page.expose_function("domMonitorCallback", dom_monitor_callback)
    page.expose_function("newsIconCallback", news_icon_callback)
    page.expose_function("unreplyCallback", unreply_callback)

    page.goto("https://iama.haier.net/?responseType=code&response_type=code&client_id=Ka05e2218d85efc6d&syncThirdToken=true&redirect_uri=https%3A%2F%2Fnesp.haier.net%2Fwebadmin%2F%23%2Flogin&state=aHR0cHM6Ly9pYW1hLmhhaWVyLm5ldA%3D%3D#login")
    page.get_by_role("textbox", name="请输入账号").click()
    page.get_by_role("textbox", name="请输入账号").fill("A0066459")
    page.get_by_role("textbox", name="-16位密码区分大小写").click()
    page.get_by_role("textbox", name="-16位密码区分大小写").fill("yuanh.2027")
    page.get_by_role("button", name="登 录").click()
    page.get_by_text("数字服务台").click()

    page.wait_for_url("**/webcustomer/**")

    monitor_js = """
    () => {
        if (window.__domMonitorStarted) return;
        window.__domMonitorStarted = true;

        const unreplySelector = '.base-item .unreply-time';
        const newsIconSelector = '.base-item .news-icon';
        const lastTextMap = new WeakMap();
        const triggeredSet = new WeakSet();

        function getUserName(baseItem) {
            if (!baseItem) return '';
            const nameEl = baseItem.querySelector('.visitor-name-text');
            return nameEl ? (nameEl.textContent?.trim() || '') : '';
        }

        // news-icon: MutationObserver 实时监控
        let hadNewsIcon = false;
        function checkNewsIcon() {
            const icons = document.querySelectorAll(newsIconSelector);
            const hasNow = icons.length > 0;
            if (hasNow && !hadNewsIcon) {
                const icon = icons[0];
                const baseItem = icon.closest('.base-item');
                window.newsIconCallback(getUserName(baseItem));
            }
            hadNewsIcon = hasNow;
        }

        const newsObserver = new MutationObserver(() => {
            checkNewsIcon();
        });
        newsObserver.observe(document.body, { childList: true, subtree: true });

        // unreply-time: 轮询 2 秒一次
        function checkUnreply() {
            const els = document.querySelectorAll(unreplySelector);
            els.forEach((el) => {
                const text = el.textContent?.trim();
                const prev = lastTextMap.get(el) || '';
                lastTextMap.set(el, text);
                if (text && !prev && !triggeredSet.has(el)) {
                    triggeredSet.add(el);
                    const baseItem = el.closest('.base-item');
                    window.unreplyCallback(getUserName(baseItem));
                }
                if (!text && triggeredSet.has(el)) {
                    triggeredSet.delete(el);
                }
            });
        }

        setInterval(() => {
            checkUnreply();
        }, 2000);

        checkNewsIcon();
        checkUnreply();
        const unreplyCount = document.querySelectorAll(unreplySelector).length;
        window.domMonitorCallback('监控已启动，news-icon(实时内联), unreply-time(2s轮询, ' + unreplyCount + '个), 队列(max """ + str(MAX_CONCURRENT) + """)');
    }
    """

    page.add_init_script(monitor_js)
    page.evaluate(monitor_js)

    while True:
        page.wait_for_timeout(1000)

    # ---------------------
    context.close()
    browser.close()


with sync_playwright() as playwright:
    run(playwright)
