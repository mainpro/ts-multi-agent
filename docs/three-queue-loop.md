# 三队列主循环:我们怎么落地 OpenClaw 的 steer/followUp/nextTurn

> 参考设计:[openclaw-why-smart.md §机制 1](../openclaw-why-smart.md#机制-1三队列主循环)
>
> 本文回答:**这三队列在我们这边对应哪些文件、哪些 API、哪些事件**,并用 4 个真实场景展示从入队到生效的完整链路。

---

## 一、一句话对照

| OpenClaw 概念 | 我们这边的实现 | 文件 |
|---|---|---|
| **steer 队列**(turn 边界实时注入) | `SteeringBuffer` + `consumeSteering` 闭包 + `onIterationStart` LLM 钩子 | `src/memory/steering-buffer.ts`、`src/agents/sub-agent.ts:680-704`、`src/llm/index.ts:921-927` |
| **followUp 队列**(请求级延迟合并) | `request_spawned` 事件 + `onTaskGraphCheckpoint` callback + `spawnMergedRequest` | `src/agents/main-agent.ts:715-844`、`src/agents/task-graph-executor.ts:336-353` |
| **nextTurn 复活循环**(模型以为结束后叫醒) | `ResumeFromBreakpoint` + `TaskReconstruct`(断点续执行)| `src/agents/main-agent.ts:693-700`、`src/task-queue/index.ts` |

外加 gate 层的 `shouldSteer()` 决策(`src/agents/main-agent.ts:126-137`)决定新消息走哪条队列。

---

## 二、机制 1:Steer 队列(turn 边界实时注入)

### 设计目标

用户在 Agent 还在跑(SubAgent 工具循环未结束)时发新消息 → **不打断当前轮次**,在下一轮 LLM 调用前以 user message 形式插入,LLM 自己判断怎么整合(改口、补充、放弃当前动作)。

### 落地点

```
入队侧                                  消费侧
┌─────────────┐     ┌─────────────────┐     ┌────────────────────────┐
│ /tasks/stream│ ──► │ SteeringBuffer  │ ──► │ SubAgent.consumeSteering│
│  shouldSteer │     │ (per-session   │     │ (onIterationStart 闭包) │
│  = true ?    │     │  Map<id, msg[]>)│     │        │                │
└─────────────┘     └─────────────────┘     └────────┴───────────────┘
                                                       │
                                                       ▼
                                          LLMClient.generateWithTools
                                          每轮 LLM 调用前回调注入
```

### 关键文件

| 文件 | 行号 | 作用 |
|---|---|---|
| `src/memory/steering-buffer.ts` | 全文(56 行) | per-session FIFO 队列 + enqueue/consume/peek/clear,内存不持久化 |
| `src/agents/sub-agent.ts` | 680-704 | `consumeSteering` 闭包定义,每次 LLM 调用前消费并 emit `request_steered` 事件 |
| `src/agents/sub-agent.ts` | 722 | 把 `consumeSteering` 作为第 7 参数传给 `llm.generateWithTools` |
| `src/llm/index.ts` | 921-927 | `onIterationStart` 钩子,在每轮 LLM 调用前回调(允许 push 到 trackedMessages) |
| `src/llm/interfaces.ts` | 24-26 | `onIterationStart` 接口注释:调用方在 turn 边界 push 消息(steer 语义) |
| `src/agents/sub-agent.ts` | 281-292 | `finally` 块:任务结束清掉残留 steer 消息(v4 修复,避免污染下次请求) |
| `src/agents/main-agent.ts` | 126-137 | `shouldSteer()`:判定新请求是否走 steer(有 running task 才走) |
| `src/api/index.ts` | 415-444 | `/tasks/stream` 入口:shouldSteer=true → 入队 → 返回 202 |

### 跟 OpenClaw 的差异

- OpenClaw 是一层 agent turn 循环,steer 是单层 FIFO。
- 我们是 SubAgent 多 turn(`llm.generateWithTools` 内部循环),steer 是 per-session FIFO,被 SubAgent 闭包捕获。

---

## 三、机制 2:FollowUp 队列(请求级 checkpoint 合并)

### 设计目标

**Steer 没消费掉**(SubAgent 工具循环已结束、任务完成或失败)的消息不会丢失——下次主 Agent 处理时,**先在 checkpoint 边界把这些消息合并成新请求**再执行,而不是丢给 LLM 强行解释。

### 落地点

```
                  Layer N 完成
                       │
                       ▼
            onCheckpoint callback
            (MainAgent.onTaskGraphCheckpoint)
                       │
              ┌────────┴────────┐
              │ pendingRequests │
              │ 长度 == 0 ?     │
              └────────┬────────┘
                  否   │   是
        ┌──────────────┴──────────────┐
        ▼                             ▼
   spawn R2(合并 R1.content +        return undefined(继续
   pending 内容) → saveSession       Layer N+1)
   → emit request_spawned
   → fire-and-forget process
        │
        ▼
   R1 返回 shouldStop: true
   → executeLayers 立即中断后续 layer
   → R1 状态 = 'checkpoint_reached'
   → R2 接管后续工作
```

### 关键文件

| 文件 | 行号 | 作用 |
|---|---|---|
| `src/agents/task-graph-executor.ts` | 336-353 | `executeLayers` 在 layer 之间调 `onCheckpoint` 回调;P0 修复支持 `shouldStop: true` 让 R1 让位 |
| `src/agents/main-agent.ts` | 715-776 | `onTaskGraphCheckpoint`:pending 非空 → 标记 R1 为 checkpoint_reached + 清理 R1 未启动 task + 触发 spawnMergedRequest + 返回 `shouldStop: true` |
| `src/agents/main-agent.ts` | 778-844 | `spawnMergedRequest`:drain pending → 合并内容 → 创建 R2 → `request_spawned` 事件 → fire-and-forget 调 `processRequirement` |
| `src/agents/main-agent.ts` | 109-111 | MainAgent 构造时把 `onTaskGraphCheckpoint` 注入 TaskGraphExecutor |
| `src/agents/main-agent.ts` | 1207-1227 | R1.processNormalRequirement 检测 `mergedAway`,跳过汇总走早返回 |
| `src/events/request-lifecycle.ts` | 30-31 | `request_spawned` 事件类型定义 |

### 跟 OpenClaw 的差异

- OpenClaw 是单 agent turn 循环 + followUp 队列在 turn 之间被消费。
- 我们是 DAG 多层 task 图,checkpoint 在 layer 之间;不是消息合并,是**整个新请求**的 spawn。

---

## 四、机制 3:NextTurn 复活(断点续执行)

### 设计目标

任务在 `waiting_user_input` 状态被持久化后,用户回复时不需要重头跑——**从断点 layer 恢复**,重新执行 SubAgent,传入之前的 conversationContext + completedToolCalls。

### 落地点

```
waiting_task 被用户回复触发
    │
    ▼
MainAgent.continueRequest
    │
    ├─► TaskQueue 还在(task 没被 GC)? ─► triggerProcess → pollTaskCompletion
    │
    └─► TaskQueue 已丢(进程重启)? ─► TaskQueue.reconstructTask(从 session.json 恢复) → pollTaskCompletion
                                    │
                                    ▼
                              executeSkill(传入
                                conversationContext,
                                completedToolCalls,
                                questionHistory)
                                    │
                                    ▼
                              复用历史 context,
                              LLM 看到完整对话,
                              不会重复 ask_user
```

### 关键文件

| 文件 | 行号 | 作用 |
|---|---|---|
| `src/agents/main-agent.ts` | 566-688 | `continueRequest` 主入口 |
| `src/agents/main-agent.ts` | 580-628 | 进程重启场景:从 `taskEntry` 重建 Task 对象,调用 `taskQueue.reconstructTask` |
| `src/agents/main-agent.ts` | 693-700 | `resumeFromBreakpoint`:委托给 `TaskGraphExecutor.resumeFromBreakpoint`(DAG 层中断恢复)|
| `src/agents/sub-agent.ts` | 414-466 | 断点续执行模式:用 `conversationContext` + `questionHistory` 重新拼 messages |
| `src/agents/sub-agent.ts` | 484 | `trackedToolCalls = [...completedToolCalls]` ← 历史 tool call 累积,避免重复执行已成功的工具 |
| `src/task-queue/index.ts` | (reconstructTask) | 从 session.json 持久化数据重建 Task 对象 |
| `src/agents/main-agent.ts` | 256-265 | waiting 状态 flush 到 session.json 时**不走防抖**,立即落盘 |

### 跟 OpenClaw 的差异

- OpenClaw 单 agent 复活时直接 re-enter `runLoop`,context 已经完整。
- 我们是 task 图,既支持 task 复活,也支持 layer 复活(`resumeFromBreakpoint` 走 `startLayerIdx`),更精细。

---

## 五、跟 Gate 的关系

三条队列不是平级,是**优先级分层**:

```
新用户请求到达 /tasks/stream
    │
    ▼
MainAgent.shouldSteer(userId, sessionId)
    │
    ├─► true(有 running task) ──► steer 队列 ──► SubAgent 下一轮 LLM 看到
    │
    ├─► false(主 Agent 还在 IntentRouter/没展开 task)
    │      └─► SessionGate.decide
    │             │
    │             ├─► queue ──► gate.pendingRequests 队列
    │             │              │
    │             │              └─► 任务图 layer 之间触发 onTaskGraphCheckpoint
    │             │                  └─► spawnMergedRequest(R2 合并 R1+pending)
    │             │
    │             └─► continue_waiting ──► 已有 task 在 waiting ──► continueRequest 路径
    │                                          └─► 断点续执行(NextTurn 复活)
    │
    └─► proceed ──► 正常 processRequirement
```

---

## 六、真实场景举例

### 场景 1:用户在 SubAgent 跑工具时"改口"(steer 触发)

```
时间线:
00:00  User → "帮我查一下 GEAM 系统怎么用"
00:01  MainAgent 分类意图为 skill_task → 选 employee=it-ops-consultant
00:01  MainAgent processRequirement → TaskGraphExecutor.executeLayers
00:02  Layer 0: SubAgent.execute(geam-qa)
            LLM iter 0: 决定 read SKILL.md
            → tool_calls=[read{path:'SKILL.md'}]
            [此时 SubAgent 还在等 read 返回]

00:03  User → "等等,我说的是 GEAM 凭证申请,不是查询用法"  ← 新请求
        POST /tasks/stream
        shouldSteer(userId, sessionId):
          - session.activeRequestId 存在 ✓
          - activeReq.status === 'processing' ✓
          - 至少一个 task.status === 'running' ✓
          → return true

        steeringBuffer.enqueue(sessionId, { content: "等等,我说的是 GEAM 凭证申请,不是查询用法" })
        → res.status(202).json({ steered: true })

00:04  read 返回 SKILL.md 内容
00:04  SubAgent 下一轮 LLM 调用前:
        onIterationStart(trackedMessages) 触发
        → consumeSteering(sessionId) → 取出 user 改口消息
        → trackedMessages.push({ role: 'user', content: '等等...' })
        → emit request_steered 事件

00:05  LLM iter 1: 看到 [原始需求 + read 结果 + 用户改口]
        → 自己判断:"用户改口了,应该是凭证申请流程"
        → 改去 read 凭证申请相关文档
```

**关键日志**:
```
{"module":"SubAgent","message":"steering 消息注入到 messages","sessionId":"...","taskId":"plan-...","content":"等等,我说的是..."}
{"module":"request-lifecycle","type":"request_steered","taskId":"plan-...","content":"等等..."}
```

---

### 场景 2:用户在 task 完成后立刻追问(走 pendingRequests → checkpoint 合并)

```
时间线:
00:00  User → "查一下 VPN 故障"
00:00  MainAgent 开始处理 R1
00:30  R1 Layer 0 完成(查到了 VPN 故障原因,准备 Layer 1 输出汇总)

00:31  User → "再查一下 OA 系统登录问题"  ← 新请求
        POST /tasks/stream
        shouldSteer(userId, sessionId):
          - activeReq.status === 'processing' ✓
          - task.status === 'running'?(正在 Layer 0 → 1 转换)✗
          → return false
        走 SessionGate.decide
          - session.activeRequestId !== null → queue 决策
        gate.enqueue → pendingRequests=[R2]
        → res.status(202).json({ queued: true })

00:35  R1 Layer 0 完成
        TaskGraphExecutor.executeLayers 在 layer 之间调 onCheckpoint
            → MainAgent.onTaskGraphCheckpoint
                → session.pendingRequests.length === 1(非零)
                → 标记 R1.status = 'checkpoint_reached'
                → 清理 R1 未启动 task
                → spawnMergedRequest(R1 内容 + pending 内容 → R2)
                → emit request_checkpoint + request_spawned
                → return { shouldStop: true }

00:35  executeLayers 收到 shouldStop:true → 立即中断,不再执行 Layer 1

00:35  R2 (合并请求) 开始 processRequirement
        → Layer 0 同时查 VPN + OA
        → Layer 1 汇总两条结果
```

**关键日志**:
```
{"module":"MainAgent","message":"checkpoint: removed R1 unstarted tasks","requestId":"req-...","removed":N,"completed":M}
{"module":"request-lifecycle","type":"request_checkpoint","requestId":"req-...","pendingCount":1}
{"module":"request-lifecycle","type":"request_spawned","requestId":"req-R2","parentRequestId":"req-R1"}
```

---

### 场景 3:SubAgent 调用 ask_user 等用户回复(NextTurn 复活)

```
时间线:
00:00  User → "帮我申请 GEAM 凭证查询权限"
00:01  IntentRouter: skill_task(geam-qa),confidence 0.97
00:02  SubAgent 启动,执行:
        iter 0: read SKILL.md
        iter 1: ask_user({ question: "请问您的工号?" })
        ← SubAgent 返回 status='waiting_user_input'
00:02  MainAgent 检测到 waitingTaskId:
        - sessionStore.updateTaskInRequest → status='waiting'
        - flushToDisk(立即落盘)
        - API 返回 type='question'
        → 用户看到问题气泡

[用户关掉浏览器,几小时后回来]

03:00  User → "我的工号是 EMP-12345"
        API 收到 answer,调用 continueRequest
        → task 在 TaskQueue 里(进程没重启) → task 已 reconstruct?
        → 实际触发:SubAgent 第二次 executeSkill
            传入 conversationContext=[之前的 messages]
                questionHistory=[{question:'工号?', answer:'EMP-12345'}]
                completedToolCalls=[read SKILL.md 的历史]
        → SubAgent 复用 context,LLM 看到自己的旧 ask + 用户回复
        → 继续往下跑(不再重复 ask_user)
```

**关键日志**:
```
{"module":"SubAgent","message":"断点续执行模式启动","contextLength":N,"questionHistoryCount":1}
{"module":"SubAgent","message":"已追加用户最新回复到对话上下文","answer":"EMP-12345"}
```

---

### 场景 4:进程重启后任务复活(NextTurn 复活 + 重建 Task)

```
[SubAgent waiting 状态被 flush 到 session.json]
[进程崩溃 / 重启]

重启后:
00:00  User → "我的工号是 EMP-12345"
        continueRequest 进入
        → TaskQueue 是内存的,重启后空了
        → TaskQueue.getTask(taskId) === undefined
        → MainAgent 从 session.json 读 taskEntry
        → TaskQueue.reconstructTask(taskEntry, answers, latestAnswer)
            重新构造 Task 对象 + 填 questionHistory
        → 自动填 params.latestUserAnswer = "EMP-12345"
        → pollTaskCompletion 监听 TaskQueue 事件
        → executeSkill(传入 conversationContext, completedToolCalls)
        → 跟场景 3 一样继续跑
```

**关键代码路径**:
```typescript
// src/agents/main-agent.ts:589-628
const task = this.taskQueue.getTask(taskEntry.taskId);
if (!task) {
  // 进程重启场景
  const reconstructed = this.taskQueue.reconstructTask(
    { taskId: taskEntry.taskId, content: taskEntry.content, skillName: taskEntry.skillName },
    answers,  // 从 session.json 恢复的问答
    question.answer || '',
  );
  // ... 填 params.conversationSummary
  return this.pollTaskCompletion(reconstructed.id, userId, sessionId, request);
}
```

---

## 七、对比 OpenClaw 完整对照表

| 维度 | OpenClaw | 我们 |
|---|---|---|
| 单 agent turn 循环 | `runLoop` 双层 while | **没有**。我们是 DAG 多 layer |
| steer 注入点 | turn 边界(LLM 调用前) | LLMClient.onIterationStart 钩子 ✓ 同 |
| followUp 注入点 | 模型"end"后(外层 while 重启) | DAG layer 之间 onCheckpoint callback ✓ 语义同 |
| nextTurn 复活 | 同一进程直接重入 runLoop | 跨进程:reconstructTask + executeSkill 复用 context ✓ 等价 |
| 持久化 | context 全内存 | waiting 状态立即 flush(session.json),进程崩溃可恢复 ✓ 更强 |
| 队列数据结构 | per-session FIFO Map | 同(SteeringBuffer) ✓ |
| 跨请求合并 | OpenClaw 没有显式合并 | 我们通过 onTaskGraphCheckpoint 把 R1+pending 合并成 R2 ✓ **额外能力** |

---

## 八、未做的部分 / 已知缺口

- **远程 followUp 队列**:目前 `pendingRequests` 是单进程 SessionGate,多实例部署时需要 Redis/Postgres 改造
- **steer 队列 TTL**:SteeringBuffer 不持久化,进程重启即丢,目前可接受(steer 是实时语义)
- **跨 session steer**:目前 steer 仅在同 session 内有效;OpenClaw 的 cross-session steer 没做
- **多层 followUp**:R2 让位给 R3 还没测过,理论上 `onTaskGraphCheckpoint` 会递归触发但要验证

---

## 九、关键路径速查

```
# Steer 入口
src/api/index.ts:415-444          # /tasks/stream 入口,shouldSteer 判定
src/memory/steering-buffer.ts     # 队列本身

# Steer 消费
src/agents/sub-agent.ts:680-704    # consumeSteering 闭包
src/llm/index.ts:921-927          # onIterationStart 钩子

# FollowUp 入口(pendingRequests)
src/agents/session-gate.ts        # gate.enqueue / gate.decide

# FollowUp 消费(checkpoint 合并)
src/agents/main-agent.ts:715-776  # onTaskGraphCheckpoint
src/agents/main-agent.ts:778-844  # spawnMergedRequest
src/agents/task-graph-executor.ts:336-353  # executeLayers 调 onCheckpoint

# NextTurn 复活
src/agents/main-agent.ts:566-688  # continueRequest
src/agents/main-agent.ts:693-700  # resumeFromBreakpoint
src/task-queue/index.ts            # reconstructTask
```