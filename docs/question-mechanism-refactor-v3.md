# 询问机制统一重构设计方案 v3

## 一、现有系统问题总结

### 1.1 数据模型问题

| # | 问题 | 影响 |
|---|------|------|
| D1 | 无 Request 概念 — 每次用户对话没有独立标识，无法追踪"这个请求处理到哪了" | 无法做请求级的状态管理、挂起、召回 |
| D2 | 询问机制分裂 — 主智能体用 `waitingStates`，子智能体用 `task.questionHistory`，两套独立结构 | 状态不一致，`confirm_system` 的 taskId 为空导致 bug |
| D3 | 会话上下文纯内存 — `SessionContextService` 进程重启即丢失 | 服务重启后丢失所有等待状态 |
| D4 | 对话历史扁平存储 — `conversations.json` 是消息数组，没有请求/任务的结构化信息 | 无法从历史中恢复请求上下文 |
| D5 | userId 兼作 sessionId — 一个用户只能有一个活跃会话 | 无法支持多窗口/多会话 |

### 1.2 运行机制问题

| # | 问题 | 影响 |
|---|------|------|
| R1 | 挂起/召回分散 — `waitingStates`（询问等待）和 `suspended tasks`（任务挂起）是两套独立机制 | 新请求发起时，旧的等待状态和挂起任务可能不一致 |
| R2 | 挂起任务无提示 — 用户发起新请求时，旧请求直接挂起，用户不知道 | 用户体验差 |
| R3 | 断点续执行不可靠 — system prompt 不包含最新 questionHistory（已修复但架构不优雅） | 依赖 prompt 拼接技巧，脆弱 |

---

## 二、核心设计：统一数据模型

### 2.1 存储结构

```
data/memory/{userId}/{sessionId}/session.json
```

每个文件是一个完整的 Session 对象，包含该会话的所有请求、任务、询问历史。

### 2.2 完整 JSON 结构

```jsonc
{
  // ===== 会话元信息 =====
  "sessionId": "sess-20260421-abc123",
  "userId": "user-001",
  "createdAt": "2026-04-21T09:30:00.000Z",
  "updatedAt": "2026-04-21T09:35:00.000Z",

  // ===== 请求列表（按时间倒序，最新的在前） =====
  "requests": [
    {
      // ===== 请求元信息 =====
      "requestId": "req-001",
      "content": "BCC系统中上传发票失败了",
      "status": "suspended",           // pending | processing | waiting | suspended | completed | failed
      "createdAt": "2026-04-21T09:30:00.000Z",
      "updatedAt": "2026-04-21T09:32:00.000Z",
      "suspendedAt": "2026-04-21T09:32:00.000Z",  // 仅 suspended 状态有值
      "suspendedReason": "用户发起了新请求",         // 仅 suspended 状态有值

      // ===== 询问记录（统一结构，主智能体和子智能体通用） =====
      "questions": [
        {
          "questionId": "q-001",
          "content": "请问是EES系统吗",
          "source": "main_agent",       // main_agent | sub_agent
          "taskId": null,               // 主智能体询问时为 null
          "skillName": null,            // 主智能体询问时为 null
          "answer": "不是",
          "answeredAt": "2026-04-21T09:31:00.000Z",
          "createdAt": "2026-04-21T09:30:05.000Z"
        }
      ],

      // ===== 当前等待的问题（仅 waiting 状态有值） =====
      "currentQuestion": null,

      // ===== 子任务列表 =====
      "tasks": [
        {
          "taskId": "task-001",
          "content": "查询BCC系统上传发票失败的原因",
          "status": "suspended",       // pending | running | completed | failed | suspended | waiting
          "skillName": "bcc-qa",
          "createdAt": "2026-04-21T09:30:10.000Z",
          "updatedAt": "2026-04-21T09:32:00.000Z",
          "result": null,

          // ===== 子任务自己的询问记录 =====
          "questions": [
            {
              "questionId": "q-002",
              "content": "是财务角色吗",
              "source": "sub_agent",
              "taskId": "task-001",
              "skillName": "bcc-qa",
              "answer": "是",
              "answeredAt": "2026-04-21T09:31:30.000Z",
              "createdAt": "2026-04-21T09:31:20.000Z"
            }
          ],

          // ===== 子任务当前等待的问题 =====
          "currentQuestion": null,

          // ===== 断点续执行上下文（不持久化到 JSON，仅在内存中） =====
          "conversationContext": null,     // LLM 对话历史
          "completedToolCalls": null       // 已完成的工具调用
        }
      ],

      // ===== 最终结果 =====
      "result": null
    }
  ],

  // ===== 当前活跃的请求 ID（用于快速查找） =====
  "activeRequestId": "req-002"
}
```

### 2.3 状态机

#### 请求状态 (RequestStatus)

```
                    用户发起新请求
                         │
                         ▼
  ┌──────────┐    ┌───────────┐
  │ pending  │───>│ processing │
  └──────────┘    └─────┬─────┘
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
        ┌─────────┐ ┌───────┐ ┌──────────┐
        │ waiting │ │completed│ │  failed  │
        └────┬────┘ └───────┘ └──────────┘
             │
      用户回复
             │
      ┌──────┴──────┐
      ▼             ▼
┌───────────┐ ┌───────────┐
│ processing│ │ suspended │  ← 用户切换话题
└───────────┘ └─────┬─────┘
                    │
              用户再次提起
                    │
                    ▼
              ┌───────────┐
              │ processing│  ← 召回恢复
              └───────────┘
```

#### 任务状态 (TaskStatus) — 保持不变

```
pending → running → completed / failed / suspended / waiting
suspended → pending  (召回恢复)
waiting → pending    (用户回复后继续)
```

### 2.4 状态一致性规则

| 事件 | 请求状态 | 任务状态 | 说明 |
|------|---------|---------|------|
| 用户发起新请求 | processing | pending | 正常流程 |
| 子智能体需要询问 | waiting | waiting | 请求和任务都进入等待 |
| 用户回复（延续） | processing | pending | 继续执行 |
| 用户回复（新话题） | suspended | suspended | 旧请求和任务都挂起 |
| 新请求创建时 | processing | pending | 新请求开始 |
| 挂起请求被召回 | processing | pending | 恢复执行 |
| 所有任务完成 | completed | completed | 请求完成 |
| 任意任务失败（不可重试） | failed | failed | 请求失败 |

**核心原则**：请求状态是任务状态的聚合。请求的状态由其所有子任务的状态决定：
- 所有任务 completed → 请求 completed
- 任意任务 failed（不可重试）→ 请求 failed
- 任意任务 waiting → 请求 waiting
- 请求被用户切换 → 请求 suspended，所有进行中的任务也 suspended

---

## 三、核心组件设计

### 3.1 SessionStore — 会话持久化存储

**职责**：读写 `data/memory/{userId}/{sessionId}/session.json`

```typescript
// src/memory/session-store.ts

interface SessionStore {
  // 读写会话
  loadSession(userId: string, sessionId: string): Promise<Session>;
  saveSession(userId: string, sessionId: string, session: Session): Promise<void>;

  // 请求级操作
  getActiveRequest(userId: string, sessionId: string): Promise<Request | null>;
  getWaitingRequest(userId: string, sessionId: string): Promise<Request | null>;
  getSuspendedRequests(userId: string, sessionId: string): Promise<Request[]>;

  // 便捷方法
  createRequest(userId: string, sessionId: string, content: string): Promise<Request>;
  updateRequest(userId: string, sessionId: string, requestId: string, updates: Partial<Request>): Promise<void>;
  addQuestion(userId: string, sessionId: string, requestId: string, question: QAEntry): Promise<void>;
  answerQuestion(userId: string, sessionId: string, requestId: string, questionId: string, answer: string): Promise<void>;
}
```

**存储策略**：
- 每次状态变更都写入磁盘（`JSON.stringify` + `fs.writeFile`）
- `conversationContext` 和 `completedToolCalls` 不持久化（太大、仅内存使用），保存时过滤掉
- 文件名固定为 `session.json`

### 3.2 RequestManager — 请求状态管理器

**职责**：管理请求的生命周期，确保状态一致性

```typescript
// src/agents/request-manager.ts

class RequestManager {
  constructor(private sessionStore: SessionStore, private llm: LLMClient) {}

  /**
   * 处理用户输入的入口
   *
   * 核心逻辑：
   * 1. 检查是否有等待的请求 → 轻量判断延续性
   * 2. 检查是否有挂起的请求 → 提示用户是否召回
   * 3. 都没有 → 创建新请求
   */
  async handleUserInput(
    userId: string,
    sessionId: string,
    userInput: string
  ): Promise<HandleResult>;

  /**
   * 创建新请求
   * 如果有活跃请求，先挂起它
   */
  async createRequest(
    userId: string,
    sessionId: string,
    content: string
  ): Promise<Request>;

  /**
   * 挂起当前活跃请求
   * 同时挂起所有进行中的子任务
   */
  async suspendActiveRequest(
    userId: string,
    sessionId: string,
    reason: string
  ): Promise<Request | null>;

  /**
   * 召回挂起的请求
   * 恢复请求和所有子任务的状态
   */
  async recallRequest(
    userId: string,
    sessionId: string,
    requestId: string
  ): Promise<Request>;

  /**
   * 轻量判断用户输入是否是对等待问题的延续回答
   */
  async judgeContinuation(
    question: QAEntry,
    userInput: string
  ): Promise<ContinuationResult>;
}
```

**`handleUserInput` 完整流程**：

```
用户输入
  │
  ▼
检查是否有等待的请求 (getWaitingRequest)
  │
  ├── 有等待请求
  │     │
  │     ├── 轻量判断 isContinuation(question, userInput)
  │     │     │
  │     │     ├── YES → 回答问题，继续执行
  │     │     │         → answerQuestion()
  │     │     │         → 请求状态: waiting → processing
  │     │     │         → 任务状态: waiting → pending
  │     │     │         → 返回 { type: 'continue', request }
  │     │     │
  │     │     └── NO → 挂起当前请求，创建新请求
  │     │               → suspendActiveRequest()
  │     │               → createRequest()
  │     │               → 返回 { type: 'new_request', request }
  │     │
  ├── 无等待请求
  │     │
  │     ├── 检查挂起的请求 (getSuspendedRequests)
  │     │     │
  │     │     ├── 有挂起请求
  │     │     │     │
  │     │     │     ├── 轻量判断 shouldRecall(suspendedRequest, userInput)
  │     │     │     │     │
  │     │     │     │     ├── YES → 提示用户："您之前有类似的请求还在进行中：{request.content}，是否继续执行？"
  │     │     │     │     │         → 返回 { type: 'recall_prompt', request, suspendedRequest }
  │     │     │     │     │         （前端展示确认对话框，用户确认后调用 recallRequest）
  │     │     │     │     │
  │     │     │     │     └── NO → 创建新请求
  │     │     │     │               → createRequest()
  │     │     │     │               → 返回 { type: 'new_request', request }
  │     │     │     │
  │     │     │     └── 无挂起请求 → 创建新请求
  │     │     │                       → createRequest()
  │     │     │                       → 返回 { type: 'new_request', request }
  │     │     │
  │     └── ...
  └── ...
```

### 3.3 统一询问机制

**核心思想**：不管是主智能体问的还是子智能体问的，都是 `QAEntry`，存储在对应层级的 `questions` 数组中。

```typescript
// src/types/index.ts

/** 统一的询问条目 */
interface QAEntry {
  questionId: string;          // 唯一 ID
  content: string;             // 问题内容
  source: 'main_agent' | 'sub_agent';  // 来源
  taskId: string | null;       // 关联的任务 ID（主智能体询问时为 null）
  skillName: string | null;    // 关联的技能名（主智能体询问时为 null）
  answer: string | null;       // 用户回答（等待时为 null）
  answeredAt: string | null;   // 回答时间
  createdAt: string;           // 创建时间
}
```

**询问流程**：

```
需要询问
  │
  ├── 主智能体需要询问（如 confirm_system）
  │     │
  │     ├── 创建 QAEntry { source: 'main_agent', taskId: null }
  │     ├── 添加到 request.questions[]
  │     ├── 设置 request.currentQuestion = QAEntry
  │     ├── 请求状态 → waiting
  │     └── 返回问题给用户
  │
  └── 子智能体需要询问（如 skill_question）
        │
        ├── 创建 QAEntry { source: 'sub_agent', taskId: task.id }
        ├── 添加到 request.tasks[i].questions[]
        ├── 同时添加到 request.questions[]（请求级也记录一份，方便查看）
        ├── 设置 request.tasks[i].currentQuestion = QAEntry
        ├── 设置 request.currentQuestion = QAEntry（请求级也标记）
        ├── 请求状态 → waiting，任务状态 → waiting
        └── 返回问题给用户
```

**用户回复流程**：

```
用户回复
  │
  ├── RequestManager.judgeContinuation() → YES
  │     │
  │     ├── 更新 QAEntry.answer = userInput
  │     ├── 清除 request.currentQuestion
  │     ├── 清除 task.currentQuestion（如果有）
  │     ├── 请求状态 → processing
  │     ├── 任务状态 → pending
  │     └── 继续执行（主智能体或子智能体）
  │
  └── NO → 挂起当前请求，创建新请求
```

---

## 四、LLM 系统提示词集成

### 4.1 将 Session JSON 注入到系统提示词

在主智能体和子智能体的系统提示词中，注入当前 Session 的结构化摘要（不是完整 JSON，而是格式化的文本）。

**主智能体系统提示词追加内容**：

```
## 当前会话状态

### 活跃请求
- 请求ID: req-002
- 内容: "BCC系统中上传发票失败了"
- 状态: processing
- 询问历史:
  1. [主智能体] "请问是EES系统吗" → "不是"
- 子任务:
  - task-001 [bcc-qa] running
    - 询问历史:
      1. [子智能体] "是财务角色吗" → "是"

### 挂起的请求
- 请求ID: req-001
- 内容: "我要申请GEAM凭证查询权限"
- 状态: suspended
- 挂起原因: 用户发起了新请求
```

**子智能体系统提示词追加内容**：

```
## 当前任务上下文

### 所属请求
- 请求ID: req-002
- 请求内容: "BCC系统中上传发票失败了"

### 询问历史（请勿重复询问）
1. [子智能体] "是财务角色吗" → "是"

### 已完成的执行步骤（请勿重复执行）
1. 工具: conversation-get → 找到3条相关对话
```

### 4.2 构建函数

```typescript
// src/prompts/session-context-prompt.ts

function buildSessionPrompt(session: Session): string {
  const parts: string[] = ['## 当前会话状态'];

  // 活跃请求
  const activeRequest = session.requests.find(r => r.requestId === session.activeRequestId);
  if (activeRequest) {
    parts.push('### 活跃请求');
    parts.push(`- 请求ID: ${activeRequest.requestId}`);
    parts.push(`- 内容: "${activeRequest.content}"`);
    parts.push(`- 状态: ${activeRequest.status}`);

    if (activeRequest.questions.length > 0) {
      parts.push('- 询问历史:');
      activeRequest.questions.forEach((q, i) => {
        const source = q.source === 'main_agent' ? '主智能体' : '子智能体';
        parts.push(`  ${i + 1}. [${source}] "${q.content}" → "${q.answer || '(等待回答)'}"`);
      });
    }

    if (activeRequest.tasks.length > 0) {
      parts.push('- 子任务:');
      activeRequest.tasks.forEach(t => {
        parts.push(`  - ${t.taskId} [${t.skillName}] ${t.status}`);
        if (t.questions.length > 0) {
          t.questions.forEach((q, i) => {
            parts.push(`    - 询问历史${i + 1}: "${q.content}" → "${q.answer || '(等待回答)'}"`);
          });
        }
      });
    }
  }

  // 挂起的请求
  const suspendedRequests = session.requests.filter(r => r.status === 'suspended');
  if (suspendedRequests.length > 0) {
    parts.push('### 挂起的请求');
    suspendedRequests.forEach(r => {
      parts.push(`- 请求ID: ${r.requestId}`);
      parts.push(`- 内容: "${r.content}"`);
      parts.push(`- 挂起原因: ${r.suspendedReason}`);
    });
  }

  return parts.join('\n');
}
```

---

## 五、完整运作流程

### 5.1 正常流程（无询问）

```
用户: "帮我查一下BCC系统的发票"
  │
  ▼
API: POST /tasks/stream { userId, sessionId, requirement }
  │
  ▼
MainAgent.processRequirement()
  │
  ├── RequestManager.handleUserInput()
  │     ├── 无等待请求
  │     ├── 无挂起请求
  │     └── 创建新请求 req-001 { status: 'processing' }
  │         → session.json 写入磁盘
  │
  ├── IntentRouter.classify() → skill_task, bcc-qa
  │
  ├── 创建任务 task-001 → 添加到 req-001.tasks[]
  │     → session.json 写入磁盘
  │
  ├── TaskQueue.execute(task-001)
  │     ├── SubAgent.execute()
  │     ├── 子智能体完成，返回结果
  │     └── task-001.status = 'completed'
  │         → session.json 写入磁盘
  │
  ├── 所有任务完成 → req-001.status = 'completed'
  │     → session.json 写入磁盘
  │
  └── 返回结果给用户
```

### 5.2 子智能体询问流程

```
用户: "帮我申请GEAM凭证查询权限"
  │
  ▼
创建请求 req-001 { status: 'processing' }
  │
  ▼
IntentRouter → skill_task, geam-qa
  │
  ▼
创建任务 task-001 → 执行
  │
  ▼
子智能体: "请问您的岗位是财务岗吗？"
  │
  ├── 创建 QAEntry { source: 'sub_agent', taskId: 'task-001' }
  ├── 添加到 req-001.questions[] 和 task-001.questions[]
  ├── req-001.currentQuestion = QAEntry
  ├── req-001.status = 'waiting'
  ├── task-001.status = 'waiting'
  ├── 保存 conversationContext 到内存（task-001.conversationContext）
  └── session.json 写入磁盘
  │
  ▼
返回问题给用户
```

### 5.3 用户回复（延续）流程

```
用户: "是的"
  │
  ▼
RequestManager.handleUserInput()
  │
  ├── 检测到等待请求 req-001
  ├── ContinuationJudge.judge(question, "是的") → YES
  │
  ├── 更新 QAEntry.answer = "是的"
  ├── 清除 req-001.currentQuestion
  ├── 清除 task-001.currentQuestion
  ├── req-001.status = 'processing'
  ├── task-001.status = 'pending'
  ├── task-001.params.latestUserAnswer = "是的"
  └── session.json 写入磁盘
  │
  ▼
TaskQueue 重新执行 task-001
  │
  ├── SubAgent.execute(task-001)
  │     ├── 检测到 task-001.conversationContext（断点续执行）
  │     ├── 重新构建 system prompt（包含最新询问历史）
  │     ├── 恢复对话上下文 + 追加用户回复
  │     └── 继续执行...
  │
  ├── 子智能体完成 → task-001.status = 'completed'
  ├── req-001.status = 'completed'
  └── 返回结果给用户
```

### 5.4 用户切换话题（挂起 + 新请求）流程

```
（接 5.2，用户正在等待回答"请问您的岗位是财务岗吗？"）

用户: "EES系统怎么登录不了"
  │
  ▼
RequestManager.handleUserInput()
  │
  ├── 检测到等待请求 req-001
  ├── ContinuationJudge.judge(question, "EES系统怎么登录不了") → NO
  │
  ├── 挂起 req-001
  │     ├── req-001.status = 'suspended'
  │     ├── req-001.suspendedReason = '用户发起了新请求'
  │     ├── task-001.status = 'suspended'
  │     └── 清除 currentQuestion
  │
  ├── 创建新请求 req-002 { status: 'processing', content: "EES系统怎么登录不了" }
  │
  └── session.json 写入磁盘
  │
  ▼
IntentRouter → skill_task, ees-qa
  │
  ▼
创建任务 task-002 → 执行...
```

### 5.5 挂起请求召回流程

```
（接 5.4，req-001 已挂起，req-002 正在执行或已完成）

用户: "对了，GEAM权限那个还没弄完"
  │
  ▼
RequestManager.handleUserInput()
  │
  ├── 无等待请求
  ├── 检测到挂起请求 req-001
  ├── TaskRecaller.shouldRecall(req-001, "对了，GEAM权限那个还没弄完") → YES
  │
  ├── 返回 { type: 'recall_prompt', message: '您之前有类似的请求还在进行中："我要申请GEAM凭证查询权限"，是否继续执行？' }
  │
  ▼
（前端展示确认对话框）
  │
  ├── 用户点击"是"
  │     │
  │     ▼
  │   API: POST /tasks/stream { userId, sessionId, requirement, recallRequestId: 'req-001' }
  │     │
  │     ▼
  │   RequestManager.recallRequest('req-001')
  │     ├── req-001.status = 'processing'
  │     ├── task-001.status = 'pending'
  │     ├── session.activeRequestId = 'req-001'
  │     └── session.json 写入磁盘
  │     │
  │     ▼
  │   TaskQueue 重新执行 task-001（断点续执行）
  │
  └── 用户点击"否"
        │
        ▼
      创建新请求，正常流程
```

---

## 六、组件变更清单

### 6.1 新增文件

| 文件 | 职责 |
|------|------|
| `src/memory/session-store.ts` | 会话 JSON 读写（`data/memory/{userId}/{sessionId}/session.json`） |
| `src/agents/request-manager.ts` | 请求生命周期管理（创建、挂起、召回、状态一致性） |
| `src/prompts/session-context-prompt.ts` | 将 Session JSON 转为 LLM 系统提示词 |

### 6.2 重构文件

| 文件 | 变更 |
|------|------|
| `src/types/index.ts` | 新增 `Session`, `Request`, `RequestStatus`, `QAEntry`, `HandleResult`；废弃 `WaitingState` |
| `src/agents/main-agent.ts` | 使用 `RequestManager` 替代 `waitingStates`；所有状态变更通过 `SessionStore` 持久化 |
| `src/agents/sub-agent.ts` | 询问时通过 `RequestManager` 记录 `QAEntry`；断点续执行从 `SessionStore` 读取上下文 |
| `src/memory/memory-service.ts` | 从 `SessionStore` 读取对话历史（替代 `ConversationMemoryService`） |
| `src/memory/session-context.ts` | 简化为 `SessionStore` 的内存缓存层（或废弃） |
| `src/prompts/main-agent.ts` | 注入 Session 上下文到系统提示词 |
| `src/prompts/sub-agent.ts` | 注入当前请求和任务的询问历史到系统提示词 |
| `src/api/index.ts` | 新增 `recallRequestId` 参数；返回值包含 `requestId`；新增召回确认 SSE 事件 |
| `src/index.ts` | 初始化 `SessionStore` 和 `RequestManager`，注入到 `MainAgent` |

### 6.3 废弃/删除

| 文件/概念 | 处理 |
|-----------|------|
| `src/agents/continuation-judge.ts` | 合并到 `RequestManager` 中（作为私有方法） |
| `src/agents/task-recaller.ts` | 合并到 `RequestManager` 中（作为私有方法） |
| `waitingStates: Map<string, WaitingState>` | 废弃，由 `SessionStore` + `Request` 替代 |
| `SessionContextService` 的 `tempVariables` | 废弃，由 `Request` 的结构化字段替代 |
| `ConversationMemoryService` | 废弃，由 `SessionStore` 替代 |

---

## 七、API 变更

### 7.1 请求参数

```typescript
// POST /tasks/stream
interface SubmitTaskRequest {
  requirement: string;
  image?: string;
  userId: string;
  sessionId: string;            // 必填（之前被忽略）
  recallRequestId?: string;     // 新增：召回指定的挂起请求
}
```

### 7.2 SSE 事件新增

```
// 召回确认提示
event: recall_prompt
data: {
  "type": "recall_prompt",
  "message": "您之前有类似的请求还在进行中：\"我要申请GEAM凭证查询权限\"，是否继续执行？",
  "suspendedRequest": {
    "requestId": "req-001",
    "content": "我要申请GEAM凭证查询权限",
    "suspendedAt": "2026-04-21T09:32:00.000Z"
  }
}

// 请求状态变更
event: request_update
data: {
  "requestId": "req-001",
  "status": "waiting",
  "message": "请问您的岗位是财务岗吗？"
}
```

### 7.3 响应增强

```typescript
// event: complete
data: {
  "message": "...",
  "results": [...],
  "type": "skill_task",
  "requestId": "req-001",       // 新增
  "requestStatus": "completed"  // 新增
}
```

---

## 八、实施计划

### 阶段 1：数据层（1 天）

1. 更新 `src/types/index.ts` — 新增所有类型定义
2. 创建 `src/memory/session-store.ts` — 会话 JSON 读写
3. 创建 `src/prompts/session-context-prompt.ts` — Session → LLM 提示词

### 阶段 2：请求管理（1 天）

4. 创建 `src/agents/request-manager.ts` — 合并 ContinuationJudge + TaskRecaller
5. 单元测试 RequestManager 的状态转换

### 阶段 3：主智能体适配（1 天）

6. 重构 `src/agents/main-agent.ts` — 使用 RequestManager
7. 适配 `src/prompts/main-agent.ts` — 注入 Session 上下文

### 阶段 4：子智能体适配（0.5 天）

8. 适配 `src/agents/sub-agent.ts` — 询问通过 RequestManager 记录
9. 适配 `src/prompts/sub-agent.ts` — 注入请求/任务上下文

### 阶段 5：记忆系统适配（0.5 天）

10. 重构 `src/memory/memory-service.ts` — 从 SessionStore 读取
11. 简化 `src/memory/session-context.ts`

### 阶段 6：API 层适配（0.5 天）

12. 更新 `src/api/index.ts` — 新增参数和 SSE 事件
13. 更新 `src/index.ts` — 初始化新组件

### 阶段 7：集成测试（1 天）

14. 端到端测试所有流程
15. 清理废弃代码

**总计：约 5 天**

---

## 九、风险和缓解

| 风险 | 缓解措施 |
|------|---------|
| 频繁写磁盘影响性能 | SessionStore 使用内存缓存 + 防抖写入（100ms 内合并多次写入） |
| Session JSON 过大（conversationContext） | conversationContext 不持久化，仅保存在内存中 |
| 前端需要改造以支持 recall_prompt | SSE 事件是增量新增，不影响现有前端 |
| userId/sessionId 之前被混用 | API 层强制要求 sessionId，不再用 userId 兼用 |
| 旧数据格式不兼容 | SessionStore.loadSession() 增加迁移逻辑，自动转换旧格式 |
