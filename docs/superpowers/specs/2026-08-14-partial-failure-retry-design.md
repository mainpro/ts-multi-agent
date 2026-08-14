# Partial-Failure Retry Design

> **状态**: 草稿,待用户审阅  
> **作者**: Claude (via brainstorming)  
> **日期**: 2026-08-14  
> **范围**: 当 Task 失败时,引入有限重试 + 混合状态汇总 + 转人工 hook 预留

---

## 1. Context

### 1.1 问题

当前实现(`src/agents/task-graph-executor.ts:478-490`)对失败 task 的处理是**一失败即抛**:

```typescript
if (layerResult.failedTasks.length > 0) {
  throw new SkillError('TASK_GRAPH_EXECUTION_FAILED', ...);
}
```

后果:
- 任一 task 失败 → 整条 request 直接 fail,用户拿不到部分成功的结果
- 偶发的 LLM 超时 / 网络抖动也会让用户白跑一轮
- 用户无法区分"完全失败"和"部分成功 / 部分失败"

### 1.2 期望

- **失败 task 先重试**,最多 N 次(N 默认 2,可按员工配置)
- **重试耗尽仍失败** → 进入汇总阶段,告知用户哪些成功 / 哪些失败
- **转人工** hook 预留接口,当前 noop,后续可接工单系统

### 1.3 与现有架构的关系

- 不引入新的分布式组件
- 不改变 Master / Worker 拆分
- 不改变数字员工配置主入口,只是在 `employee.json` 增加 `capabilities.execution` 子段
- 不改变 4 层记忆 / DAG 调度 / Steer / Checkpoint 合并机制
- 现状"B-1: `taskResults[0]?.status` 取错位"问题在新设计中自然解决

---

## 2. Global Constraints

- **可重入性**: 任何 task 重试必须保持幂等(LLM 调用本来近似幂等,工具调用对 read 幂等、对 write/edit 必须依靠 task 自身的 idempotency key,本期不解决后者)
- **可观测性**: 重试事件必须产生独立结构化日志,不能淹没在原有 task 日志中
- **Feature flag**: 通过 `CONFIG.PARTIAL_FAILURE_ENABLED` 控制整体开关,默认 **true**(由 `process.env.PARTIAL_FAILURE_ENABLED !== 'false'` 解析)
- **Backwards compat**: 现有 2 份 `employees/*.json` 必须保持工作,只是新增 `capabilities.execution` 子段(可选)
- **不破坏现有契约**: `Request.status === 'completed'` 的语义**仍是"请求结束"**,新增 `Request.partialFailure: boolean` 标志区分纯成功 vs 部分失败
- **不自动重试业务错误**: `SKILL_NOT_FOUND` / `MISSING_SKILL` / `INVALID_KEY` / `BOOTSTRAP_FAILED` 等确定性错误不重试
- **不重试 AppError 中明确 `retryable: false` 标记的**:为未来更细粒度控制预留
- **不破坏 B-1 的修复方向**: 新设计下 rewriter gate 必须基于 `every(completed)` 而非单元素索引

---

## 3. Key Concepts

### 3.1 Partial Failure(部分失败)

请求内多个 task,部分成功部分失败,且失败 task 经过重试后仍失败。结果:返回用户一个混合摘要,标明哪些成功 / 哪些失败,**整条 request 不被标 failed**,但带 `partialFailure: true` 标志。

### 3.2 Retryable Error(可重试错误)

错误同时满足:
1. 错误类型属于配置的白名单(默认 `TIMEOUT` / `NETWORK_ERROR` / `API_ERROR` 且 `statusCode >= 500`)
2. 当前重试次数 < `maxRetries`

### 3.3 Non-Retryable Error(不可重试错误)

- `INVALID_KEY`(API key 错了重试无用)
- `SKILL_NOT_FOUND` / `MISSING_SKILL`(确定性错误)
- `BOOTSTRAP_FAILED` / `CONFIG_ERROR`(配置问题)
- `CONTEXT_TOO_LONG` / `OUTPUT_TOO_LONG`(压缩逻辑会处理,不属于 task retry 范畴)
- `CANCELLED` / `QUEUE_FULL`(用户取消或资源耗尽)
- 不在白名单的 `API_ERROR`

### 3.4 Transfer-to-Human Hook(转人工钩子)

签名: `(taskResults: TaskResult[]) => boolean`

- 输入:汇总阶段的 task 列表(含成功 + 失败)
- 输出: 是否需要触发转人工
- 默认实现: noop `() => false`
- 调用时机: `summarizeResults` 内,生成 summary 之后、写库之前
- **本期不实现真实转人工**,只预留接口

### 3.5 Feature Flag

`CONFIG.PARTIAL_FAILURE_ENABLED: boolean`(默认 `true`)

- `false`: 行为完全同现状,失败立即抛
- `true`: 启用重试 + 汇总 + transfer hook

---

## 4. Configuration Schema

### 4.1 新增 `Capabilities.execution` 子段

`src/agents/employee/json-types.ts`:

```typescript
export const ExecutionSchema = z.object({
  /** 单 task 最大重试次数(不含首次执行) */
  maxRetries: z.number().int().min(0).max(10).optional().default(2),
  /** 可重试错误类型白名单 */
  retryableErrorTypes: z.array(z.string()).optional()
    .default(['TIMEOUT', 'NETWORK_ERROR', 'API_ERROR']),
  /** transfer-to-human hook(当前 noop) */
  transferOnPartialFailure: z.boolean().optional().default(false),
});

export const CapabilitiesSchema = z.object({
  skillWhitelist: SkillWhitelistSchema.optional(),
  tools: ToolPolicySchema.optional(),
  llm: LLMConfigSchema,
  execution: ExecutionSchema.optional(),  // 新增
});
```

### 4.2 Task 扩展

`src/types/index.ts` Task interface:

```typescript
interface Task {
  // ... 既有字段
  
  /** 主智能体注入的 maxRetries(来自 employee.execution.maxRetries) */
  maxRetries?: number;
  
  /** 可重试错误类型(来自 employee.execution.retryableErrorTypes) */
  retryableErrorTypes?: string[];
  
  /** 当前已重试次数 */
  retryCount?: number;
}
```

`retryCount` 字段已存在,补全类型。

### 4.3 Request 扩展

```typescript
interface Request {
  // ... 既有字段
  
  /** 部分失败标志:即使有 task 失败,只要经过重试+汇总就 true */
  partialFailure?: boolean;
  
  /** 失败 task ID 列表(供前端展示 + 转人工用) */
  failedTaskIds?: string[];
}
```

### 4.4 SessionStore 新增方法

```typescript
class SessionStore {
  /** 标记 request 完成(可能伴随 partialFailure) */
  async completeRequestWithResult(
    userId: string,
    sessionId: string,
    requestId: string,
    result: string,
    options?: { partialFailure?: boolean; failedTaskIds?: string[] },
  ): Promise<void>;
}
```

或保留现有 `completeRequest`,加 `markPartialFailure` 辅助方法。**待 plan 阶段决定**。

### 4.5 CONFIG 新增

```typescript
export const CONFIG = {
  // ... 既有
  PARTIAL_FAILURE_ENABLED: process.env.PARTIAL_FAILURE_ENABLED !== 'false',
};
```

### 4.6 现有 employee JSON 兼容

`legal-assistant.json` 和 `it-ops-consultant.json` 不强制改:
- 不配 `capabilities.execution` → 用 schema 默认值(`maxRetries=2` / 重试 LLM 临时错)
- 行为对用户透明,只是失败时多 2 次重试机会

---

## 5. Architecture

### 5.1 模块职责

```
TaskQueue.executeTask                       [重试循环]
    ├─ 调 executor(task, signal)
    ├─ catch err
    │   ├─ 判断 isRetryable(err, retryableTypes)
    │   │   ├─ true 且 attempt < maxRetries → sleep(backoff),retry
    │   │   ├─ true 但 attempt = maxRetries → 标记 retryExhausted,继续 failTask
    │   │   └─ false → failTask
    │   └─ failDependents(cascade 强依赖,弱依赖跳过)
    └─ 失败信息含 retryExhausted: true

TaskGraphExecutor.executeTaskGraph         [不因失败抛]
    ├─ executeLayers
    ├─ 即使 failedTasks.length > 0 也返回 results
    │   └─ data = { results, failedTasks, hasPartialFailure: true }
    └─ 全成功才 success: true

MainAgent.processNormalRequirement         [混合状态路由]
    ├─ result.success = false 且 hasPartialFailure
    │   └─ 不 throw,走"汇总 + 转人工"分支
    ├─ result.data.failedTasks.length > 0
    │   └─ recordFailure (但 request.status 仍 completed + partialFailure=true)
    └─ result.data.waitingTaskId
        └─ 同现状(waiting 分支)

ResultAggregator.summarizeResults         [混合状态摘要]
    ├─ 拆分 completedTasks / failedTasks / waitingTasks
    ├─ LLM 看到全部 task + 状态,生成诚实摘要
    ├─ 调用 transferHook(taskResults),如果 true → summary 追加转人工提示
    ├─ 调用 rewriter(若配置):
    │   ├─ 旧逻辑:基于 taskResults[0]? 或 taskResults[N-1]?
    │   └─ 新逻辑:completedTasks.length === taskResults.length && waitingTasks.length === 0
    └─ request.partialFailure = failedTasks.length > 0
```

### 5.2 Transfer Hook 注入

```typescript
// src/agents/result-aggregator.ts
export type TransferToHumanHook = (taskResults: TaskResult[]) => boolean;

class ResultAggregator {
  constructor(
    llm, memoryService, sessionStore,
    onNeedsIntentReclassification,
    rewriter?,
    transferHook?: TransferToHumanHook,  // 新增 6th 参数
  ) {
    this.transferHook = transferHook ?? (() => false);  // 默认 noop
  }
}

// src/agents/main-agent.ts (构造时)
// TODO(Task 13): 接外部工单系统时实现真实 hook
const transferHook = (results) => {
  // 当前 noop,留 hook 点位
  return false;
};

this.resultAggregator = new ResultAggregator(
  llm, memoryService, sessionStore,
  onReclassify,
  this.employee.outputBehavior?.resultRewriter,
  transferHook,
);
```

### 5.3 失败重试 + 汇总的完整链路

```
SubAgent.execute(task) 抛 LLMError('TIMEOUT')
    ↓
TaskQueue.executeTask 第 1 次 catch
    ├─ isRetryable: true(TIMEOUT 在白名单)
    ├─ retryCount = 0 < maxRetries = 2
    └─ sleep(2s),task.retryCount = 1,重新调 executor

[重试成功 → completeTask 正常完成]

OR

TaskQueue.executeTask 第 2 次 catch (retryCount=2 = maxRetries)
    ├─ isRetryable: true 但 attempt 已耗尽
    └─ failTask(taskId, error, isTimeout=false, retryExhausted=true)

executeLayers 把该 task 推入 failedTasks
    ↓
executeTaskGraph 检测 failedTasks.length > 0
    ├─ 不再 throw
    ├─ return { success: false, data: { results, failedTasks, hasPartialFailure: true } }
    └─ 调用方根据 hasPartialFailure 决定路径
        ↓
MainAgent 走汇总分支
    ├─ summarizeResults(taskResults with mix statuses)
    │   ├─ LLM 生成: "合同查询成功,审批提交失败(LLM 超时)"
    │   ├─ transferHook(...) → false (当前 noop)
    │   ├─ rewriter 不追加(因为 !allCompleted)
    │   └─ 返回 { completed: false, summary, failedTaskIds }
    ├─ sessionStore.completeRequestWithResult(..., { partialFailure: true, failedTaskIds })
    └─ saveAssistantMessage(partial summary)
        ↓
用户看到: 包含成功 + 失败信息的混合摘要
```

---

## 6. Data Flow

### 6.1 重试流程

```
TaskQueue.executeTask(task) {
  const maxRetries = task.maxRetries ?? this.defaultMaxRetries;
  const retryableTypes = new Set(task.retryableErrorTypes ?? this.defaultRetryableTypes);
  let attempt = 0;
  
  while (true) {
    if (attempt > 0) {
      task.retryCount = (task.retryCount ?? 0) + 1;
      const backoffMs = 2000 * Math.pow(2, attempt - 1) + Math.random() * 1000;  // 2s, 4s, 8s...
      log.warn('task retry', { taskId, attempt, backoffMs });
      await sleep(backoffMs);
    }
    
    try {
      const result = await this.executor(task, signal);
      return this.completeTask(taskId, result, Date.now() - startTime);
    } catch (err) {
      if (this.shouldRetry(err, retryableTypes) && attempt < maxRetries) {
        attempt++;
        continue;
      }
      const retryExhausted = this.shouldRetry(err, retryableTypes) && attempt >= maxRetries;
      const taskError = this.buildTaskError(err, retryExhausted);
      return this.failTask(taskId, taskError, isTimeout);
    }
  }
}

private shouldRetry(err: unknown, retryableTypes: Set<string>): boolean {
  if (err instanceof LLMError) {
    if (!retryableTypes.has(err.type)) return false;
    if (err.type === 'API_ERROR' && (err.statusCode ?? 0) < 500) return false;
    return true;
  }
  // AppError retryable 标记(预留)
  if (err instanceof AppError && (err as any).retryable === false) return false;
  return false;
}
```

### 6.2 summarizeResults 混合状态

```typescript
async summarizeResults(...): Promise<{
  completed: boolean;
  summary: string;
  failedTaskIds: string[];
  transferTriggered: boolean;
}> {
  const completedTasks = taskResults.filter(t => t.status === 'completed');
  const failedTasks = taskResults.filter(t => t.status === 'failed');
  const waitingTasks = taskResults.filter(t => t.status === 'waiting_user_input');
  
  // 1. 让 LLM 看清楚状态生成诚实摘要
  const prompt = `
用户原始需求: ${originalRequirement}

任务执行情况:
${completedTasks.map((t, i) => `✅ [${i+1}] ${t.skillName}: ${t.response.slice(0, 300)}`).join('\n')}
${failedTasks.map((t, i) => `❌ [${completedTasks.length+i+1}] ${t.skillName}: ${t.error?.message || '执行失败'}`).join('\n')}
${waitingTasks.length > 0 ? `\n⏸ 等待用户输入: ${waitingTasks.map(t => t.skillName).join(', ')}` : ''}

请生成汇总回复,要求:
1. 明确告诉用户哪些任务成功、哪些失败(基于上述列表)
2. 对失败任务简要说明原因
3. 如有失败,建议用户回复"转人工"获取人工协助
  `.trim();
  
  let judgment = await this.llm.generateStructured(prompt, z.object({
    completed: z.boolean(),
    summary: z.string(),
  }));
  
  // 2. 防御纵深:有失败 task → completed 必须 false
  if (failedTasks.length > 0 && judgment.completed) {
    judgment = { ...judgment, completed: false };
    log.warn('LLM 把部分失败误判为 completed,已修正', { failedCount: failedTasks.length });
  }
  
  // 3. Transfer hook(预留)
  let transferTriggered = false;
  if (failedTasks.length > 0 && this.transferHook) {
    transferTriggered = this.transferHook(taskResults);
    if (transferTriggered) {
      judgment = {
        ...judgment,
        summary: `${judgment.summary}\n\n> 💡 检测到部分任务执行失败,如需人工协助请回复"转人工"。`,
      };
    }
  }
  
  // 4. Rewriter gate(修复 B-1):只有全成功 + 无 waiting 才追加"转人工"尾注
  const allCompleted = completedTasks.length === taskResults.length && waitingTasks.length === 0;
  if (this.rewriter && allCompleted) {
    judgment = {
      ...judgment,
      summary: this.applyRewriter(judgment.summary, this.rewriter),
    };
  }
  
  // 5. 落库:即使是部分失败,也要保存 assistant message
  try {
    await this.memoryService.saveAssistantMessage(userId, sessionId, judgment.summary, {
      requestId: request.requestId,
    });
  } catch (error) { /* ... */ }
  
  // 6. Request 状态:成功 / 部分失败都标 completed + partialFailure
  await this.sessionStore.completeRequest(userId, sessionId, request.requestId, judgment.summary);
  // 注意:completeRequest 内部需要支持 partialFailure 标志
  // 详细写入方案见 plan 阶段
  
  return {
    completed: judgment.completed,
    summary: judgment.summary,
    failedTaskIds: failedTasks.map(t => t.taskId),
    transferTriggered,
  };
}
```

### 6.3 Request 状态写入

```typescript
// src/memory/session-store.ts (新增方法)
async completeRequestWithResult(
  userId: string,
  sessionId: string,
  requestId: string,
  result: string,
  options?: { partialFailure?: boolean; failedTaskIds?: string[] },
): Promise<void> {
  // ... 类似现有 completeRequest,但支持 options.partialFailure
}
```

或者改造现有 `completeRequest` 加 optional 第 5 参数。**方案选择待 plan 阶段**。

---

## 7. State Machine

### 7.1 Request 状态(扩展)

```
[New] → processing ──┬─→ waiting (ask_user)
                      ├─→ completed + partialFailure?: false (全成功,本次新增标记)
                      │                ↓ partialFailure=true (部分失败,本次新增)
                      ├─→ failed (致命错误,如 SKILL_NOT_ALLOWED / 全 task 都 failed)
                      ├─→ suspended (用户主动挂起)
                      └─→ checkpoint_reached (R1 让位给 R2)
```

### 7.2 Task 状态(不变)

```
[New] → pending → running → completed
                   ├─→ failed (含 retryExhausted 信息)
                   ├─→ waiting → pending (续传)
                   └─→ suspended → pending (召回)
```

---

## 8. Backwards Compatibility

### 8.1 Feature Flag 控制

`src/types/index.ts`:
```typescript
export const CONFIG = {
  // ... 既有
  PARTIAL_FAILURE_ENABLED: process.env.PARTIAL_FAILURE_ENABLED !== 'false',
};
```

默认 `true`(用户已经决定启用),可通过环境变量关回:
```bash
PARTIAL_FAILURE_ENABLED=false bun start --employee=...
```

### 8.2 现有测试

- 47 个 test file + 6 个 pre-existing 失败
- 期望: 0 个新增回归
- 重点关注:
  - `__tests__/task-graph.test.ts`
  - `__tests__/result-aggregator.test.ts`
  - `__tests__/main-agent.test.ts`
  - `__tests__/concurrent-executor-race.test.ts`
  - `__tests__/error-propagation-e2e.test.ts`
  - `__tests__/it-desk-*.test.ts`

### 8.3 现有 employee JSON

`legal-assistant.json` / `it-ops-consultant.json`:
- 不强制改
- 不配 `capabilities.execution` → 用 schema 默认值
- 行为差异: 失败 task 多 2 次重试机会

### 8.4 现有 API

`/tasks/stream` 响应格式:
- 新增事件 `task_retrying` (在重试时 emit)
- `complete` event payload 增加 `partialFailure?: boolean` 和 `failedTaskIds?: string[]`

---

## 9. Testing Strategy

### 9.1 单元测试

新增 / 修改:
- `__tests__/task-queue-retry.test.ts`: 测试重试循环(成功路径 / 重试耗尽 / 不可重试 / 退避)
- `__tests__/result-aggregator-mixed-status.test.ts`: 测试混合状态汇总
- `__tests__/employee-execution-config.test.ts`: 测试 schema 默认值 + override

### 9.2 集成测试

- `__tests__/partial-failure-e2e.test.ts`: 测试完整链路
  - 场景 1: SubAgent 失败 → 重试成功 → 正常完成
  - 场景 2: SubAgent 持续失败 → 重试耗尽 → 进入汇总 + partialFailure=true
  - 场景 3: 多 task,部分失败 → 摘要含成功失败说明 + request.partialFailure=true
  - 场景 4: PARTIAL_FAILURE_ENABLED=false → 行为同现状(回归)

### 9.3 端到端验证清单

- [ ] `bun test` 全部 PASS(0 新增回归)
- [ ] `bunx tsc --noEmit` 无新增错误
- [ ] `bun start --employee=legal-assistant` 启动正常
- [ ] 重试场景可观察:日志含 `task retry` event
- [ ] 部分失败场景可观察:summary 含"X 成功, Y 失败",request 标 partialFailure

---

## 10. Migration Path

### 10.1 数据迁移

无 schema 迁移,因为:
- Task / Request 加的是可选字段
- employee JSON 加的是可选子段
- SessionStore 加的是可选参数

### 10.2 配置迁移

无强制迁移。两份现有员工 JSON 不动,自动获得默认 retry 行为。

### 10.3 代码迁移顺序

详见后续 plan 文件。

---

## 11. Risks

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| **重试导致 tool 副作用重复**(write/edit) | 中 | 用户数据不一致 | 文档说明;本期限制重试错误类型(LLM 临时错);不在 skill 业务错误上重试 |
| **重试风暴**:同一 task 永久错误快速重试 | 低 | LLM quota 浪费 | maxRetries 上限 10;不可重试错误立即 fail |
| **summarizeResults 的 LLM 调用本身可能失败** | 中 | 部分失败时用户拿不到任何结果 | 与现状一致,失败抛 BusinessError |
| **transfer hook 误触发** | 极低 | UX 打扰 | 当前默认 noop,后续实现时配触发条件(失败 task 数 / 严重程度) |
| **Request.partialFailure 字段被旧代码忽略** | 低 | 数据一致性 | 显式 schema 校验;e2e 测试覆盖 |
| **sessionStore 写入 partialFailure 时丢盘** | 极低 | 同 sessionStore 现有防抖问题 | completeRequest 立即 flushToDisk(waiting 路径已采用) |

---

## 12. Out of Scope

明确**不**做的事情:

1. **真实的转人工实现**(工单系统对接 / SSE `request_transfer_to_human` event)
2. **Skill 业务错误的重试**(只重试 LLM 临时错)
3. **tool 级重试**(bash / write / edit 失败不重试)
4. **重试的 idempotency key**(依赖 task 自身实现,本期不强制)
5. **Request.partialFailure 的特殊 UI 处理**(前端按需适配)
6. **重试指标的可视化**(SLA Watcher 已埋点,但暂无看板)
7. **跨 request 的重试共享**(每次 request 独立重试,不跨 session)

---

## 13. Open Questions(留 plan 阶段决定)

1. `sessionStore.completeRequest` 加 optional 第 5 参数 vs 新增 `completeRequestWithResult` 方法?
2. 重试退避的 base delay 和 max delay 各是多少?
3. `task.retryCount` 是否在 `SessionStore` 持久化(便于跨进程恢复)?
4. 重试期间 task 事件总线是否需要单独的 `task_retrying` event?

---

## 14. 关键引用

- 相关代码: `src/task-queue/index.ts`, `src/agents/task-graph-executor.ts`, `src/agents/result-aggregator.ts`, `src/agents/main-agent.ts`, `src/memory/session-store.ts`, `src/agents/employee/json-types.ts`
- 前序重构: `docs/superpowers/specs/2026-08-13-digital-employee-redesign-design.md`(数字员工重构)
- B-1 bug 修复:见 `docs/分析报告.md`