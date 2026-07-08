# 浏览器操作技能设计方案

## 1. 概述

核心思路：**一个常驻后台的 daemon 进程持有 Playwright 浏览器实例**，持续监听页面事件（DOM 变化 / SSE 推送）。检测到事件后，daemon 通过 **HTTP POST `/tasks`**回调 Agent 系统，触发处理流程。Agent 分析事件后，调用 Worker 脚本通过 `connect_over_cdp` 接管同一个浏览器执行操作。

```
daemon（常驻后台）                  Agent 系统                      worker（短周期）
──────────────                      ──────────                     ───────────────
持有浏览器                            │                               │
登录 → 跳转 → 注入监听器               │                               │
开启 CDP 端口                         │                               │
循环监听 DOM/SSE...                  │                               │
  │                                  │                               │
  │  事件发生                         │                               │
  ├── POST /tasks ──────▶  创建 Task, MainAgent 处理                  │
  │  {requirement: "事件内容..."}      │                               │
  │                     Agent (LLM) 分析事件                           │
  │                     决策调用 worker                               │
  │                                  ├── bash: worker_xxx.py ────▶ connect_over_cdp()
  │                                  │                           操作同一浏览器
  │                                  │◀── 返回结果 JSON ─────────  输出 → 退出
  │                     评估结果                                     │
  │                     (daemon 继续监听, 浏览器不变)                  │
  │  下次事件...                      │
```

**系统无需任何改动**。API 层已提供 `POST /tasks` 接口，daemon 直接用 `requests.post()` 回调即可。

## 2. 架构概览

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           运作体系架构                                     │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────────┐                                                │
│  │  daemon.py (常驻后台)  │                                                │
│  │                      │      HTTP POST /tasks                          │
│  │  - Playwright 浏览器  │──────────────────────────────┐                 │
│  │  - 登录/跳转/监听     │                               │                 │
│  │  - CDP 端口 9222     │                               ▼                 │
│  │  - 事件→POST API回调  │                      ┌───────────────┐        │
│  └────────┬─────────────┘                      │  Agent System │        │
│           │                                    │               │        │
│           │                                    │ MainAgent     │        │
│           │   connect_over_cdp                 │  分析事件     │        │
│           │   (worker 操作)                     │  决策调度     │        │
│           │◄────────────────────────────────────│              │        │
│           │                                    │ SubAgent     │        │
│           │                                    │  执行worker  │        │
│           │                                    └──────┬────────┘        │
│           │                                           │                  │
│  ┌────────┴─────────────┐                             │ bash tool        │
│  │  worker_*.py         │◀────────────────────────────┘                  │
│  │  (一次性执行)         │                                               │
│  │                      │                                               │
│  │  connect_over_cdp()  │                                               │
│  │  → 操作 daemon 浏览器 │                                               │
│  │  → 输出JSON → 退出   │                                               │
│  └──────────────────────┘                                               │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

## 3. 脚本划分

```
skills/browser-agent/
├── SKILL.md                      ← 你编写：Agent 行为规范
├── scripts/
│   ├── daemon.py                 ← 常驻：启动浏览器 + 前置操作 + 注入监听 + HTTP 回调
│   ├── worker_navigate.py        ← worker: 页面跳转
│   ├── worker_extract.py         ← worker: 提取内容
│   ├── worker_click.py           ← worker: 点击元素
│   ├── worker_type.py            ← worker: 输入文字
│   ├── worker_search_kb.py       ← worker: 查找知识库（你的业务逻辑）
│   ├── worker_search_system.py   ← worker: 查找系统（你的业务逻辑）
│   ├── worker_forward_task.py    ← worker: 任务转发（你的业务逻辑）
│   └── worker_restart_daemon.py  ← worker: 重启 daemon
└── references/
    └── page-mapping.md           ← (可选) 页面结构说明
```

## 4. 脚本接口定义

### 4.1 daemon.py — 浏览器常驻 + HTTP 回调

**生命期**：后台常驻。事件发生时 POST `/tasks` 回调 Agent 系统，然后继续监听（不退出）。

**启动方式**（Agent 通过 bash 工具）：

```bash
nohup python scripts/daemon.py \
  --url "https://目标系统.com" \
  --cdp-port 9222 \
  --state-dir /tmp/browser-state-{sessionId} \
  --setup-script scripts/setup_login.py \
  --api-url "http://localhost:3000/tasks" \
  --skill "browser-agent" \
  --watch-css ".message-list,.notification-badge" \
  --watch-sse "new_message,task_update" \
  > /tmp/daemon-out.log 2>&1 &

echo $! > /tmp/daemon.pid
```

**输入参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `--url` | string | 目标页面 URL |
| `--cdp-port` | int | CDP 端口，默认 9222，Worker 通过此端口连接 |
| `--state-dir` | string | userDataDir 路径，持久化登录态 |
| `--setup-script` | string | (可选) 前置操作脚本，完成登录、跳转等 |
| `--api-url` | string | Agent 系统 `/tasks` 接口地址，默认 `http://localhost:3000/tasks` |
| `--skill` | string | 技能名称，放入 POST body 的 `skill` 字段，帮助 Agent 路由 |
| `--watch-css` | string | 监听的 CSS 选择器，逗号分隔 |
| `--watch-sse` | string | 监听的 SSE event type，逗号分隔 |
| `--poll-ms` | int | 轮询间隔毫秒，默认 500 |
| `--dedup-window` | int | 同一事件去重窗口秒数，默认 5 |

**HTTP 回调格式**（daemon → Agent）：

```python
# daemon 检测到事件后 POST 到 --api-url
POST /tasks
Content-Type: application/json

{
  "requirement": "浏览器事件: dom_change, 选择器 .message-list, 内容: 您好,关于产品XX...",
  "sessionId": "browser-agent-{uuid}",
  "metadata": {
    "source": "browser-daemon",
    "skill": "browser-agent",
    "event": {
      "type": "dom_change",
      "selector": ".message-list",
      "text": "您好,关于产品XX的价格...",
      "timestamp": "2026-07-07T10:00:00Z"
    },
    "cdp_port": 9222,
    "state_dir": "/tmp/browser-state-xxx",
    "daemon_pid": 12345
  }
}
```

**daemon 核心逻辑**：

1. 启动 Playwright，`launch_persistent_context(user_data_dir=state_dir)`，开启 CDP 端口
2. 执行 `--setup-script` 完成登录等前置操作
3. 通过 `page.add_init_script()` 注入内联监听 JS 代码（SSE 拦截 + MutationObserver）
4. 通过 `page.expose_function()` 暴露 `__reportEvent(type, data_json)` 回调
5. `__reportEvent` 的实现：构造 HTTP body，`requests.post(api_url, json=body)`，调用 Agent
6. 导航到 `--url`，打印 "ready" 到 stdout
7. 进入无限循环保持浏览器运行

### 4.2 Worker 脚本通用约定

所有 Worker 通过 `connect_over_cdp` 接管 daemon 的浏览器。Agent 从事件的 `metadata.cdp_port` 获取 CDP 端口。

**通用输入参数**：

| 参数 | 必需 | 说明 |
|------|------|------|
| `--cdp-port` | 是 | CDP 端口号，连到 daemon 的浏览器 |

**通用输出**（stdout JSON）：

```json
{"ok": true, "action": "search_kb", "result": {...}, "message": "..."}
{"ok": false, "action": "search_kb", "error": "TIMEOUT", "message": "..."}
```

**连接模式**：

```python
playwright = sync_playwright().start()
browser = playwright.chromium.connect_over_cdp(f"http://localhost:{cdp_port}")
page = browser.contexts[0].pages[0]
# 操作...
browser.close()      # 断开 CDP 连接，不关浏览器
playwright.stop()
```

### 4.3 各 Worker 脚本职责

| 脚本 | 职责 | 特有参数 | 输出 result |
|------|------|----------|------------|
| `worker_navigate.py` | 跳转页面 | `--url` | `{"title":"...","url":"..."}` |
| `worker_extract.py` | 提取元素内容 | `--selector`, `--format`(text/screenshot) | `{"content":"...","format":"text"}` |
| `worker_click.py` | 点击元素 | `--selector` | `{"clicked":".btn"}` |
| `worker_type.py` | 输入文字 | `--selector`, `--text` | `{"typed":"..."}` |
| `worker_search_kb.py` | 查找知识库 | `--query` | `{"matches":[...],"total":5}` |
| `worker_search_system.py` | 查找系统 | `--query` | `{"matches":[...]}` |
| `worker_search_user.py` | 查找用户 | `--query` | `{"matches":[...]}` |
| `worker_forward_task.py` | 转发任务 | `--target`, `--content` | `{"forwarded_to":"..."}` |
| `worker_restart_daemon.py` | 重启 daemon | `--pid-file` | `{"restarted":true}` |

## 5. 时序图

```
daemon.py      浏览器       POST /tasks      Agent(LLM)        worker         用户
   │              │              │               │               │              │
   │  启动浏览器   │              │               │               │              │
   │─────────────▶│              │               │               │              │
   │  登录+跳转   │              │               │               │              │
   │  注入监听器   │              │               │               │              │
   │  [CDP:9222]  │              │               │               │              │
   │              │              │               │               │              │
   │────────── 事件发生 ─────────│               │               │              │
   │              │              │               │               │              │
   │  POST /tasks │              │               │               │              │
   │  {requirement│              │               │               │              │
   │   :"事件:...",│              │               │               │              │
   │   metadata:  │              │               │               │              │
   │   {cdp:9222}}│              │               │               │              │
   │──────────────▶              │               │               │              │
   │              │         创建Task            │               │              │
   │              │         MainAgent处理        │               │              │
   │              │                             │               │              │
   │              │                        [LLM 分析事件]         │              │
   │              │                         "新消息,产品咨询"     │              │
   │              │                         → 先提取完整内容      │              │
   │              │                             │               │              │
   │              │                             │ bash:worker_extract          │
   │              │                             │ --cdp-port=9222              │
   │              │                             │ --selector=".msg-content"───▶│
   │              │                             │               │              │
   │              │◀── connect_over_cdp ────────│               │ connect_over │
   │              │── 提取innerText ───────────▶               │              │
   │              │                             │               │              │
   │              │                             │ {"ok":true,    │              │
   │              │                             │  "content":"..."}            │
   │              │                             │◀──────────────────────────────
   │              │                             │               │              │
   │              │                        [LLM 分析完整内容]    │              │
   │              │                         "产品XX价格查询"     │              │
   │              │                         → 查找知识库         │              │
   │              │                             │               │              │
   │              │                             │ bash:worker_search_kb        │
   │              │                             │ --cdp-port=9222              │
   │              │                             │ --query="产品XX 价格"────────▶│
   │              │                             │               │              │
   │              │◀── connect_over_cdp ────────│               │ connect_over │
   │              │── 搜索知识库 ──────────────▶│               │              │
   │              │                             │               │              │
   │              │                             │ {"ok":true,    │              │
   │              │                             │  "result":{...}}             │
   │              │                             │◀──────────────────────────────
   │              │                             │               │              │
   │              │                        [LLM 评估结果]        │              │
   │              │                         "已找到,告知用户"    │              │
   │              │                             │               │              │
   │              │                             │──────────────▶│  告知用户    │
   │              │                             │               │  价格信息    │
   │              │                             │               │              │
   │  [继续监听]   │              │               │               │              │
   │              │              │               │               │              │
   │  ··· 下一次事件 ···          │               │               │              │
```

## 6. 流程图

### 6.1 Agent 决策循环

```
                         ┌─────────────┐
                         │  用户启动    │
                         │  "开始监听"  │
                         └──────┬──────┘
                                │
                                ▼
                   ┌────────────────────────┐
                   │ Agent 启动 daemon.py    │
                   │ nohup daemon.py ... &   │
                   │ 记录 PID                │
                   └────────────┬───────────┘
                                │
                                ▼
                   ┌────────────────────────┐
                   │ daemon 就绪后输出 ready │
                   │ Agent 告知用户:已就绪   │
                   │                        │
                   │ daemon 开始监听,        │
                   │ 事件触发→POST /tasks    │
                   └────────────┬───────────┘
                                │
                    ╔═══════════╧═══════════╗
                    ║  daemon 检测到事件      ║
                    ║  POST /tasks 触发本循环 ║
                    ╚═══════════╤═══════════╝
                                │
                                ▼
                   ┌────────────────────────┐
                   │ Agent 收到事件          │
                   │ 解析 metadata.event     │
                   │ - type: dom/sse?        │
                   │ - selector: 哪个元素?    │
                   │ - text: 内容摘要        │
                   └────────────┬───────────┘
                                │
                                ▼
                   ┌────────────────────────┐
                   │ 信息是否足够分析决策?    │
                   └────────────┬───────────┘
                                │
                   ┌────────────┴────────────┐
                   ▼                         ▼
            ┌───────────┐            ┌──────────────┐
            │ 足够:      │            │ 不够:        │
            │ 直接进入   │            │ worker_extract│
            │ 分析决策   │            │ --selector=X  │
            └─────┬─────┘            │ 获取完整内容   │
                  │                  └──────┬───────┘
                  │                         │
                  └──────────┬──────────────┘
                             │
                             ▼
                ┌────────────────────────┐
                │ LLM 分析内容            │
                │ - 这条信息是什么?        │
                │ - 紧急程度?             │
                │ - 需要采取什么行动?      │
                └────────────┬───────────┘
                             │
                             ▼
                ┌────────────────────────┐
                │ 决策: 选择操作          │
                └────────────┬───────────┘
                             │
        ┌────────┬───────────┼───────────┬──────────┐
        ▼        ▼           ▼           ▼          ▼
   ┌────────┐┌────────┐┌──────────┐┌────────┐┌──────────┐
   │查知识库││查系统  ││任务转发  ││页面操作││ 不确定   │
   │        ││        ││          ││        ││ →ask_user│
   └───┬────┘└───┬────┘└────┬─────┘└───┬────┘└────┬─────┘
       │         │          │          │          │
       ▼         ▼          ▼          ▼          │
   ┌────────┐┌────────┐┌──────────┐┌────────┐    │
   │worker  ││worker  ││worker    ││worker  │    │
   │_search ││_search ││_forward  ││_click/ │    │
   │_kb     ││_system ││_task     ││_nav/   │    │
   │        ││        ││          ││_extract│    │
   └───┬────┘└───┬────┘└────┬─────┘└───┬────┘    │
       │         │          │          │         │
       ▼         ▼          ▼          ▼         │
   ┌──────────────────────────────────────┐     │
   │ Agent 评估 Worker 返回结果            │◀────┘
   │ - 成功 → 告知用户 → 等待下次事件      │
   │ - 失败 → 分析原因 → 重试/告知/重启   │
   │ - 需更多操作 → 继续调用 worker       │
   └──────────────────┬───────────────────┘
                      │
                      ▼
              ┌───────────────┐
              │ 等待下次事件   │
              │ (daemon 继续   │
              │  监听,Agent    │
              │  等待 POST     │
              │  /tasks 回调)  │
              └───────────────┘
```

### 6.2 daemon 内部循环

```
                  ┌─────────────┐
                  │  启动        │
                  └──────┬──────┘
                         │
                         ▼
                ┌─────────────────┐
                │ 启动浏览器       │
                │ 执行 setup-script│
                │ 注入监听JS代码  │
                │ 开启 CDP 端口    │
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ 导航到目标页面   │
                │ 打印 "ready"    │
                └────────┬────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  事件循环（无限）     │
              │                      │
              │  page.wait_for_timeout│
              │  (保持事件循环活跃)   │
              │                      │
              │  监听器触发 →        │
              │  __reportEvent() →   │
              │  POST /tasks         │
              │  → 继续循环          │
              └──────────────────────┘
```

## 7. 事件去重

daemon 的 MutationObserver 可能对同一个变化触发多次回调（例如新增多个兄弟节点）。daemon 内部维护一个简单的去重窗口：

```
同一 (event_type, selector, text前100字符) 组合，
在 --dedup-window 秒内不重复 POST
```

## 8. 现有系统约束

| 约束项 | 当前值 | 状态 |
|--------|--------|------|
| POST /tasks 无鉴权 | - | daemon 可以直接 POST，无问题 |
| bash 工具同步阻塞 | `await` 进程退出 | worker 是短周期脚本，无问题 |
| bash 工具 timeout | 默认 30s，可覆盖 | worker 执行秒级，无问题 |
| daemon 后台运行 | `nohup ... &` | bash 立即返回 PID，无问题 |
| LLM 工具调用迭代 | 10 轮 | 每次事件处理 4-6 轮，足够 |
| 并发任务 | 最多 5 个 | 多个事件同时 POST 会被排队 |

**系统无需任何改动。** 全部复用现有的 `POST /tasks` + `bash` + `nohup` 能力。

## 9. 脚本实现要点

### 9.1 daemon.py

```python
import json, sys, argparse, time, requests
from playwright.sync_api import sync_playwright

SEEN_EVENTS = {}  # (type, selector, text_hash) -> timestamp

def should_dedup(event_type, selector, text, window_sec):
    key = (event_type, selector, hash(text[:100]) if text else "")
    now = time.time()
    if key in SEEN_EVENTS and now - SEEN_EVENTS[key] < window_sec:
        return True
    SEEN_EVENTS[key] = now
    return False

def post_to_agent(api_url, skill, event, cdp_port, state_dir, daemon_pid):
    body = {
        "requirement": f"[浏览器事件] {event['type']}: {event.get('selector','')} - {event.get('text','')[:500]}",
        "sessionId": f"browser-agent-{daemon_pid}",
        "metadata": {
            "source": "browser-daemon",
            "skill": skill,
            "event": event,
            "cdp_port": cdp_port,
            "state_dir": state_dir,
            "daemon_pid": daemon_pid,
        },
    }
    try:
        r = requests.post(api_url, json=body, timeout=5)
        print(f"[daemon] POST /tasks → {r.status_code}", file=sys.stderr)
    except Exception as e:
        print(f"[daemon] POST failed: {e}", file=sys.stderr)

def main():
    args = parse_args()

    playwright = sync_playwright().start()
    context = playwright.chromium.launch_persistent_context(
        user_data_dir=args.state_dir,
        headless=True,
        args=[f"--remote-debugging-port={args.cdp_port}"],
    )
    page = context.pages[0] if context.pages else context.new_page()

    # 1. 前置操作
    if args.setup_script:
        exec(open(args.setup_script).read(), {"page": page, "context": context})

    # 2. 注入监听代码（SSE 拦截 + MutationObserver）
    inject_js = get_monitor_js(args.watch_css, args.watch_sse)
    page.add_init_script(inject_js)

    # 3. 暴露回调
    pid = os.getpid()

    def handle_event(type_str: str, data_json: str):
        event = json.loads(data_json)
        if should_dedup(type_str, event.get("selector", ""),
                        event.get("text", ""), args.dedup_window):
            return
        event["timestamp"] = datetime.now().isoformat()
        post_to_agent(args.api_url, args.skill, event,
                      args.cdp_port, args.state_dir, pid)

    page.expose_function("__reportEvent", handle_event)

    # 4. 导航
    page.goto(args.url)
    print(f"[daemon] ready, cdp={args.cdp_port}, pid={pid}", file=sys.stderr, flush=True)

    # 5. 保持运行
    while True:
        page.wait_for_timeout(args.poll_ms)
```

### 9.2 Worker 模板

```python
import json, sys, argparse
from playwright.sync_api import sync_playwright

def output(data: dict):
    print(json.dumps(data, ensure_ascii=False))
    sys.stdout.flush()

def main():
    args = parse_args()  # --cdp-port, 及其他业务参数
    playwright = sync_playwright().start()
    browser = playwright.chromium.connect_over_cdp(f"http://localhost:{args.cdp_port}")
    page = browser.contexts[0].pages[0]

    try:
        # ====== 你的业务操作 ======

        # ====== 结束 ======
        output({"ok": True, "action": "xxx", "result": {...}})
    except Exception as e:
        output({"ok": False, "action": "xxx", "error": type(e).__name__, "message": str(e)})
    finally:
        browser.close()
        playwright.stop()
```

## 10. SKILL.md 编写要点

```yaml
---
name: browser-agent
description: >-
  浏览器操作技能。daemon 监听 DOM/SSE 事件，通过 HTTP POST /tasks 回调 Agent，
  Agent 分析后调用 worker 脚本通过 CDP 接管浏览器执行业务操作。
allowedTools:
  - bash
  - read
  - ask_user
---
```

SKILL.md 应包含：

1. **脚本清单**：daemon.py + 各 worker 的参数和输出格式
2. **启动流程**：`nohup daemon.py ... &` → 记录 PID，告知用户已就绪
3. **事件解读**：如何从 `metadata.event` 中提取 `type`/`selector`/`text`，判断信息是否足够
4. **决策规则表**（你定义）：

   | 事件特征 | 操作 | Worker |
   |----------|------|--------|
   | `dom_change` + `.message-list` | 提取完整内容 → 分析 → 查知识库 | extract → search_kb |
   | `dom_change` + `.notification-badge` | 提取通知内容 → 分析 | extract → 决策 |
   | `sse_event` + `new_message` | 解析 data → 决策 | 直接分析或 extract |
   | `sse_event` + `task_update` | 查找系统/转发 | search_system / forward_task |
   | 内容不明确 | 询问用户 | ask_user |

5. **异常处理**：
   - daemon POST 失败 → daemon 内部会重试（stderr 会有日志）
   - worker 连接 CDP 失败 → daemon 可能已死，调用 `worker_restart_daemon.py`
   - worker 操作失败 → 分析错误类型，告知用户或重试
6. **元数据透传**：Agent 调用 worker 时从 `metadata.cdp_port` 取 CDP 端口

## 11. 总结

```
skills/browser-agent/
├── SKILL.md                    ← 你编写：Agent 行为规范
├── scripts/
│   ├── daemon.py               ← 你编写：常驻监听 + HTTP 回调（内含监听JS注入）
│   ├── setup_login.py          ← 你编写：前置操作(登录/跳转)
│   ├── worker_extract.py       ← 你编写
│   ├── worker_click.py         ← 你编写
│   ├── worker_type.py          ← 你编写
│   ├── worker_navigate.py      ← 你编写
│   ├── worker_search_kb.py     ← 你编写
│   ├── worker_search_system.py ← 你编写
│   ├── worker_forward_task.py  ← 你编写
│   └── worker_restart_daemon.py← 你编写
└── references/
    └── ...                     ← 可选
```

**核心运作逻辑**：

```
daemon 持有浏览器 + 监听 DOM/SSE
    ↓ (事件发生)
daemon POST /tasks {requirement, metadata: {cdp_port, event, ...}}
    ↓
MainAgent 创建 Task → SubAgent 处理
    ↓
LLM 分析事件 → 决策 → 调用 worker --cdp-port=9222
    ↓
worker connect_over_cdp() → 操作浏览器 → 返回 JSON → 退出
    ↓
Agent 评估结果 → 告知用户 → 等待 daemon 下一次 POST
    ↓
daemon 继续监听（浏览器从未关闭）
```

**系统无需任何改动。** 全部复用现有 `POST /tasks` + `bash` + `nohup` 能力。