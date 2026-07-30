# Request Queue & Merge — Design Spec

**Date:** 2026-07-29
**Status:** Draft — pending user review
**Branch:** `feature_claude_optimize`

## Problem

当前 `POST /tasks/stream` 每次调用都会立即启动一个独立的 `processRequirement`,没有并发控制。用户在前端连续输入多句话时:

- 多个请求**并行执行**,各自走完整流程(IntentRouter → Planner → TaskGraph → ResultAggregator)
- L1 会话内存被多个调用并发写,产生竞态
- 前端收到多个独立的 SSE 流,需要自己合并/排序
- LLM 看不到"用户其实是想追加/修正前一句",可能给出割裂的回答

## Goal

实现"延迟合并"(deferred merge)模式:

- 同一 session 同时**只有一个** active request 在执行
- 用户后续输入的请求进入 **pending 队列**,不立即执行
- 当 active request 到达**安全检查点**时,将其关闭并 spawn 一个新的 request,该 request 的 `requirement` 合并了原 request 的内容 + 所有 pending 请求的内容
- 新 request 看到完整 session 历史,**自然 re-plan**(不会重复已完成的任务)
- 所有事件通过**同一个 SSE 流**发送,前端按顺序渲染

## Non-Goals

- **不实现多 request 并行执行** —— 明确选择单线程串行 + 合并
- **不修改 continueRequest(用户回答 waiting_user_input 后的继续执行)逻辑** —— 该路径独立于本特性
- **不修改断点续传 / 进程重启恢复路径** —— 那是另一套机制
- **不引入新的前端框架** —— 本特性对前端的契约是 SSE 事件扩展 + 可选的"草稿层"UI 模式
- **不解决 LLM 跨 request 关联的语义质量问题** —— 仅保证 LLM 看到完整上下文,具体推理效果由 LLM 自身决定

## Locked Design Decisions

| 决策 | 选项 | 理由 |
|------|------|------|
| 合并语义 | **R2.requirement = R1.requirement + "\n\n---\n\n" + pending.map(p => p.requirement).join("\n\n---\n\n")** | 显式冗余,防止 LLM 丢失 R1 的目标;统一分隔符便于前端解析 |
| 检查点让出时机 | **等当前 task 完成后让出** | 不强制 abandon,避免 Skill 半成品 |
| SSE 流 | **同一流**(R1 建立的连接全程复用) | 前端无需多连接管理 |
| 多次排队 | **累积,一次性 spawn 一个 R2** | 避免多次 re-plan |
| waiting_user_input | **不是检查点**,用户回答走 `continueRequest`,不 spawn | 区分断点续传 vs 队列 spawn |

## Architecture

### 状态机扩展

**`RequestStatus` 新增**:

```typescript
export type RequestStatus =
  | 'pending'         // 保留:已创建未开始(目前未使用,保留兼容)
  | 'processing'      // 保留:正在执行
  | 'waiting'         // 保留:等用户输入(waiting_user_input)
  | 'suspended'       // 保留:挂起(用户主动中断等)
  | 'completed'       // 保留:已完成
  | 'failed'          // 保留:失败
  | 'checkpoint_reached';  // 新增:到达合并检查点,已 closed,后续被新 request 接管
```

**`Session` 新增字段**:

```typescript
export interface Session {
  sessionId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  requests: Request[];
  activeRequestId: string | null;
  pendingRequests: PendingRequest[];  // 新增:FIFO 队列
}

export interface PendingRequest {
  /** 客户端生成的临时 ID,用于前端追踪草稿 */
  draftId: string;
  /** 用户原始消息(未经合并) */
  requirement: string;
  /** 接收时间 */
  enqueuedAt: string;
  /** 是否带图 */
  hasImage: boolean;
}
```

### 生命周期流程

```
[HTTP POST /tasks/stream]
  ↓
[SessionGate.enqueueOrExecute(userId, sessionId, requirement, image)]
  ↓
  ┌─ session.activeRequestId === null → 直接进入 processRequirement
  └─ session.activeRequestId !== null → push 到 pendingRequests,return
  ↓
[HTTP 返回 202 Accepted + { status: 'queued', draftId, position }]
   (注:HTTP 立即返回,不阻塞,不创建 SSE 流的占位 — SSE 由 R1 的原连接持续推送)
  ↓
[当 active request 到达检查点]
  ↓
[MainAgent.onCheckpoint(requestId, completedTaskIds)]
  ↓
  1. 将当前 request.status 置为 'checkpoint_reached'
  2. session.activeRequestId = null
  3. 检查 session.pendingRequests.length
     - 0 → 不 spawn,流程结束(等下一个用户输入)
     - > 0 → 进入 spawnMergedRequest
  ↓
[spawnMergedRequest(userId, sessionId, parentRequestId, pendingRequests)]
  ↓
  1. 从 pendingRequests 弹出所有项(FIFO)
  2. 合并 requirement:
     combined = parentRequest.content + "\n\n---\n\n" + pending.map(p => p.requirement).join("\n\n---\n\n")
  3. 创建新 Request{ requestId: newId, content: combined, parentRequestId, status: 'processing', ... }
  4. session.activeRequestId = newId
  5. session.pendingRequests = []
  6. 通过 LLMEventBus.emit('request_spawned', { parentRequestId, newRequestId, draftIds })
  7. 调用 processRequirement(combined, ...) — 内部走完整 IntentRouter → Planner → TaskGraph 流程
```

### 检查点定义

**检查点 = 系统可以安全关闭当前 request 并 spawn 新 request 的位置**。标准:

1. 没有正在执行的 LLM 流式响应(避免浪费已花的 token)
2. 没有 Skill 在写文件/调外部 API(避免半成品)
3. 没有未 ack 的 TaskQueue 任务(避免 dependent 任务卡死)

**具体位置**:

| 检查点 | 触发位置 | 代码 |
|--------|---------|------|
| IntentRouter.classify 返回后 | 进入 Planner 之前 | `src/agents/main-agent.ts` `processRequirement` 步骤 2 后 |
| UnifiedPlanner.plan 返回后 | 进入 TaskGraph 之前 | `src/agents/main-agent.ts` `processNormalRequirement` 早期 |
| 每个 Task 完成时 | Layer 间 | `src/agents/task-graph-executor.ts` `executeLayers` 循环末尾 |

**显式 NOT 检查点**:

| 位置 | 为什么不检查点 |
|------|--------------|
| 任意 LLM 流式调用中途 | token 已花,中断 = 浪费 |
| Skill 执行中 | 文件半成品、连接未关 |
| `waiting_user_input` 状态 | 走 `continueRequest`,**不 spawn** |
| TaskQueue 调度中 | dependent 任务卡死 |

### waiting_user_input 特殊处理

`continueRequest(userId, sessionId, request, question)` 是**断点续传**路径,本特性**不修改**。

但需要明确:当 session 处于 `activeRequestId.status === 'waiting'` 时,新用户输入的语义是"回答问题",不是"追加新需求":

```
session.activeRequestId != null AND session.requests[activeRequestId].status === 'waiting'
  → 走 AskAgent.handleUserInput(已有逻辑) → continueRequest
  → 不进入 pending 队列,不触发 spawn
```

只有当 `status === 'processing'` 时,新输入才进入 pending 队列(`checkpoint_reached` 状态下 `activeRequestId` 已被置 null,新输入走"无 active"分支直接执行)。

## SSE 事件契约

### 新增事件

#### `request_queued`

服务端接收新消息后,如果进入 pending 队列,**立即发送**到 R1 的 SSE 连接(同一流)。

```typescript
{
  event: 'request_queued',
  data: {
    draftId: string,
    position: number,        // 队列位置(>= 1)
    enqueuedAt: string,
    mergedOnCheckpoint: true, // 恒为 true(说明会在检查点合并)
  }
}
```

**前端行为**:显示草稿态气泡(等待中,标识"已收到,正在合并"),**不写入 L4 历史**。

#### `request_checkpoint`

R1 到达检查点,标记为 `checkpoint_reached`,即将 spawn R2。

```typescript
{
  event: 'request_checkpoint',
  data: {
    requestId: string,        // R1.id
    checkpointAt: string,     // ISO timestamp
    pendingCount: number,     // 即将合并的 pending 数
    completedTaskCount: number,
  }
}
```

**前端行为**:R1 的气泡标记为"已完成(部分)"(灰色/对勾)。

#### `request_spawned`

新 R2 创建,即将开始处理。

```typescript
{
  event: 'request_spawned',
  data: {
    requestId: string,         // R2.id
    parentRequestId: string,   // R1.id
    draftIds: string[],        // 所有被合并的草稿 ID
    requirementPreview: string,// 合并后的 requirement 前 200 字符(供前端预览)
  }
}
```

**前端行为**:把所有 `draftId` 对应的草稿气泡"提升"为对话层气泡,然后立即收到 `start` 事件。

### 现有事件流(新场景下)

```
[已连接 SSE]
event: start                  (R1 开始)
event: reasoning * N          (R1 思考过程)
event: ...                    (R1 处理)
event: request_queued         (R2 到达,进入 pending)
event: ...                    (R1 继续处理)
event: request_checkpoint     (R1 到达检查点)
event: request_spawned        (R2 spawn)
event: start                  (R2 开始)
event: reasoning * N          (R2 思考)
event: ...                    (R2 处理)
event: complete               (R2 完成)
```

## API Changes

### `POST /tasks/stream`

**请求体新增字段**(全部可选):

```typescript
interface SubmitTaskRequest {
  requirement: string;
  userId?: string;
  sessionId?: string;
  image?: string;
  draftId?: string;        // 新增:客户端生成的草稿 ID,用于追踪
}
```

**响应变化**:

| 场景 | 旧行为 | 新行为 |
|------|--------|--------|
| 无 active request | 200 + SSE 流开始 | **不变** |
| 有 active request | (不存在此场景) | **202 + JSON body** `{ status: 'queued', draftId, position }`,**不开新 SSE** |

HTTP 202 路径只返回 JSON,不建立 SSE 流。所有事件通过 R1 已建立的 SSE 推送。

### 新增内部 API(无外部 HTTP 暴露)

```typescript
// MainAgent 上的私有方法
class MainAgent {
  /** 检查点回调:由 TaskGraphExecutor 在层间调用 */
  private async onTaskGraphCheckpoint(
    requestId: string,
    completedTaskIds: string[],
  ): Promise<void>;

  /** Spawn 合并后的新 request */
  private async spawnMergedRequest(
    userId: string,
    sessionId: string,
    parentRequestId: string,
    pendingRequests: PendingRequest[],
  ): Promise<Request>;
}
```

## UX Behavior

### 草稿层 vs 对话层

前端把消息展示分成两层:

**草稿层**(local state,不持久化):
- 用户输入但**未合并**的消息
- 显示在输入框上方,标记"等待合并中"
- 收到 `request_spawned` 事件后,清空草稿层

**对话层**(L4 历史 + 后端推送):
- 已合并/已处理的请求气泡
- 通过 SSE `start` / `complete` / `error` 事件自然产生

### 用户感知时间线

```
T+0s    用户输入 "查一下报销流程"           → 立即出现对话层气泡(等 R1 处理)
T+0.1s  R1 开始执行                       → reasoning 事件
T+1.5s  用户输入 "还有差旅标准"            → 出现草稿层气泡"等待合并中"
T+1.6s  (立即)收到 request_queued 事件     → 草稿层气泡标记"已入队"
T+3.0s  R1 到达任务图检查点                → request_checkpoint + request_spawned
T+3.0s  草稿层气泡提升到对话层              → 与 R1 的后续输出合并渲染
T+3.0s  R2 开始执行                        → reasoning 事件
T+5.0s  R2 完成                           → complete 事件
```

## State Persistence

`pendingRequests` 必须在 session.json 中持久化(否则进程重启后丢失)。

**SessionStore 兼容**:在 `loadSession` 内对加载的 JSON 做字段补齐——缺失 `pendingRequests` 时初始化为 `[]`,避免旧 session 文件反序列化后字段为 undefined 导致后续 `.length` / `.push` 报错。

**TaskQueue 在 spawn 时清空**:R1 关闭时,未执行的 R1 剩余 task 从 TaskQueue 移除(由 TaskGraphExecutor 在检查点清理)。

## Edge Cases & Failure Modes

### 1. R1 失败 → pending 怎么办?

R1 throw AppError 时(走 `globalErrorHandler`):
- R1.status = 'failed'
- session.activeRequestId = null
- pending 队列**保留**(用户的输入没丢)
- 下次用户输入或主动刷新时,如果 pending 非空,自动 spawn R2(合并原 R1.content + 所有 pending)

### 2. 客户端断开后重新连接

前端重连时调 `GET /sessions/:userId/:sessionId`(已有)获取:
- `activeRequestId` 当前在不在 processing
- `pendingRequests` 内容

如果 reconnect 时 pending 非空且 active 为空,前端可选择:
- 手动触发"立即合并"(POST 空 requirement 或专用 endpoint)
- 等待用户输入第三条消息时自动合并

### 3. 同一 session 跨实例(分布式)

本特性对分布式不感知(依赖既有的 session 锁机制,见 `deferred-distributed-memory-storage` 备忘)。如果将来引入多实例,pending 队列的读写需要走共享存储(同 L4 路径)。

### 4. R1 卡在 waiting_user_input 时,R2 到达

按"waiting_user_input 不是检查点"原则:**R2 也进入 pending 队列**,等用户回答 R1 后:
- 用户回答走 `continueRequest(R1)` → R1 继续
- R1 到达下一个 task 完成检查点 → 检查 pending(此时含 R2) → spawn R2

也就是说,**用户必须先回答 R1 的问题,才能"消化"R2**。这是有意为之:不打断当前上下文。

### 5. R1 内容已被 R2 引用,且 R2 处理时引用了 R1.taskId

不允许。R2 启动时,R1 的 task graph **整体作废**(LLM re-plan)。R2 看到的是 session 历史 + 合并后的 requirement,不会引用 R1 的 `taskId`。

### 6. 极端 pending 累积

如果 R1 跑 10 分钟,R2~R10 陆续到达:
- 全部进 pending
- R1 检查点到达 → spawn R2 时合并所有 10 条 requirement
- R2 的 requirement 会很长,token 开销大

**缓解**:设置 `MAX_PENDING_REQUESTS = 10`,超出后新请求返回 503 + 提示"会话繁忙,请稍候"。

## Test Strategy

### 单元测试

| 用例 | 验证 |
|------|------|
| `enqueueOrExecute`:无 active request | 直接进入 processRequirement |
| `enqueueOrExecute`:有 active request | 进入 pending,返回 draftId |
| `enqueueOrExecute`:active 但 status=waiting | 走 AskAgent.handleUserInput,不进 pending |
| `onTaskGraphCheckpoint`:pending 为空 | 只关闭 R1,等下一个输入 |
| `onTaskGraphCheckpoint`:pending 1 个 | spawn R2,requirement 正确合并 |
| `onTaskGraphCheckpoint`:pending 多个 | spawn R2,合并所有 pending |
| `spawnMergedRequest` 合并格式 | parent.content + "\n\n---\n\n" + draft1 + "\n\n---\n\n" + draft2 |

### 集成测试(e2e,扩展现有 `error-propagation-e2e.test.ts`)

| 用例 | 验证 |
|------|------|
| 用户连续两条消息:R1 + R2 串行执行 | R2 在 R1 任务图检查点后启动,看到 R1 完整上下文 |
| R2 在 R1 中途到达,R1 已完成 2/5 task | R2 看到 R1 的 2 个已完成 task 结果,re-plan 出新的 task graph(不重复已完成) |
| R1 进入 waiting_user_input,R2 到达 | R2 进 pending;用户回答 R1 后 R1 继续到检查点,才 spawn R2 |
| R1 失败(throw LlmError),pending 还在 | 下次输入时 spawn R2(合并 R1.content + pending) |

### SSE 事件时序测试

捕获完整事件流,断言顺序:

```
[connection 1]
event: start (R1)
event: reasoning
event: request_queued (draftId=d2)
event: ...
event: request_checkpoint (R1)
event: request_spawned (parentRequestId=R1, draftIds=[d2])
event: start (R2)
event: complete (R2)
```

## Risks & Mitigations

| 风险 | 影响 | 缓解 |
|------|------|------|
| 合并 requirement 太长,触发 token 上限 | LLM 调用失败 | 监控 merged.requirement 长度,> 4000 字符时截断最早的 pending |
| R1 checkpoint 后 LLM 重新分类意图错误 | 用户体验差 | 前端展示 requirementPreview,允许用户手动"取消合并"(未来) |
| TaskQueue 在 checkpoint 未清理 R1 剩余 task | 内存泄漏,旧 task 干扰 R2 | `onTaskGraphCheckpoint` 中显式清理未启动的 R1 task |
| SessionStore 防抖 100ms 写入,pending 数据丢失 | 进程崩溃时 pending 没保存 | pending 写入同步(不走防抖),与 session 主状态一起落盘 |
| LLM 看到合并后的 requirement 但忽略 R1 context | 用户体验倒退 | 现有 LLM 推理能力范围内,文档明确"建议每条 requirement ≤ 500 字符" |

## Open Questions

无。本次设计中所有决策已锁定。

## Migration & Rollout

1. **Type 迁移**:`RequestStatus` 新增 `'checkpoint_reached'`;`Session` 新增 `pendingRequests`。编译期会暴露所有未处理的位置。
2. **SessionGate 实现**:新增 `src/agents/session-gate.ts`,封装"入队 or 执行"判断逻辑。
3. **TaskGraphExecutor 回调**:在 `executeLayers` 层间加入 checkpoint 触发点(回调到 MainAgent)。
4. **SSE 事件**:在 `src/api/index.ts` 中扩展事件类型。
5. **前端契约**:不强制前端实现草稿层,但事件已就绪,前端可渐进式采用。

## Files To Touch (预估)

| 文件 | 变更类型 |
|------|---------|
| `src/types/index.ts` | RequestStatus 扩展 + Session 新字段 |
| `src/memory/session-store.ts` | 新增 pendingRequests 读写方法 + 迁移兼容 |
| `src/agents/main-agent.ts` | 新增 SessionGate 调用 + onTaskGraphCheckpoint + spawnMergedRequest |
| `src/agents/task-graph-executor.ts` | executeLayers 中加入 checkpoint 回调 |
| `src/api/index.ts` | POST /tasks/stream 区分 200/202 + 新 SSE 事件 |
| `src/events/llm-events.ts`(若有) | 新事件类型定义 |
| `__tests__/request-queue-merge.test.ts` | 新增单元 + e2e 测试 |

## Success Criteria

- ✅ 单条消息流程行为不变(无 active 时直接处理)
- ✅ 多条消息自动合并到下一个 R1 检查点后的 R2
- ✅ waiting_user_input 流程不受影响(走 continueRequest)
- ✅ 进程重启后 pending 不丢
- ✅ R1 失败后 pending 保留,下次自动合并
- ✅ 所有事件通过同一 SSE 流推送,顺序正确
- ✅ 单元测试覆盖所有决策点,集成测试覆盖关键场景