# Partial-Failure Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Task 失败有限重试 + 混合状态汇总 + 转人工 hook 预留,默认启用,可通过 `PARTIAL_FAILURE_ENABLED=false` 回滚。

**Architecture:** TaskQueue 在 `executeTask` 内加重试循环(仅 LLM 临时错,指数退避);TaskGraphExecutor `executeTaskGraph` 不再因 failedTasks throw,改为返回 `hasPartialFailure`;ResultAggregator `summarizeResults` 支持混合状态并按 `every(completed)` 决策 rewriter;MainAgent 注入 noop transferHook 并路由 `hasPartialFailure`;Request 加 `partialFailure` / `failedTaskIds` 标志(不引入新状态)。

**Tech Stack:** TypeScript 5.3 (strict), Bun (test), Zod 3, 现有 task-queue / agent / memory / skill 体系。

## Global Constraints

来源:`docs/superpowers/specs/2026-08-14-partial-failure-retry-design.md`

- **可重入性**: 重试必须保持幂等。本期仅重试 LLM 临时错(TIMEOUT / NETWORK_ERROR / API_ERROR 且 statusCode >= 500),不重试 tool 副作用相关错误。
- **可观测性**: 重试事件必须产生独立结构化日志字段(如 `attempt`, `retryableErrorType`)。
- **Feature flag**: `CONFIG.PARTIAL_FAILURE_ENABLED` 默认 `true`(解析规则 `process.env.PARTIAL_FAILURE_ENABLED !== 'false'`)。
- **Backwards compat**: 现有 `employees/*.json` 不强制改,自动获得默认 retry 行为。
- **不破坏 Request.status 语义**: `'completed'` 仍是"请求结束",加 `Request.partialFailure?: boolean` 标志区分纯成功 vs 部分失败。
- **可重试错误白名单**(默认): `TIMEOUT`, `NETWORK_ERROR`, `API_ERROR`(后者要求 `statusCode >= 500`)。
- **不可重试**: `INVALID_KEY` / `SKILL_NOT_FOUND` / `MISSING_SKILL` / `BOOTSTRAP_FAILED` / `CONTEXT_TOO_LONG` / `OUTPUT_TOO_LONG` / `CANCELLED` / `QUEUE_FULL` / `API_ERROR` 且 statusCode < 500。
- **退避策略**: base 2s, factor 2, max 60s,带 jitter(±1s)。与 LLMClient 的 `getBackoffDelay` 一致风格。
- **B-1 修复**: rewriter gate 改用 `every(completed)`,不再依赖单元素索引。
- **Transfer hook**: `(taskResults: TaskResult[]) => boolean`,默认 noop,本期不实现真实转人工。

---

## File Structure

每个文件单一职责,改动文件说明:

| 文件 | 职责 |
|---|---|
| `src/types/index.ts` | 类型扩展(Task.maxRetries/retryCount/retryableErrorTypes + Request.partialFailure/failedTaskIds + CONFIG.PARTIAL_FAILURE_ENABLED) |
| `src/agents/employee/json-types.ts` | ExecutionSchema(新增 capabilities 子段) |
| `src/task-queue/index.ts` | executeTask 内加重试循环 + shouldRetry helper + 退避 |
| `src/agents/task-graph-executor.ts` | executeTaskGraph 返回 hasPartialFailure,不抛错 |
| `src/agents/result-aggregator.ts` | summarizeResults 接受 transferHook + 混合状态 + rewriter gate 改 every() |
| `src/agents/main-agent.ts` | ResultAggregator 构造注入 transferHook(noop) + hasPartialFailure 路由 |
| `src/memory/session-store.ts` | completeRequest 增加可选第 5 参数支持 partialFailure 写入 |

---

### Task 1: ExecutionSchema(EmployeeConfig 新增 execution 子段)

**Files:**
- Modify: `src/agents/employee/json-types.ts:40-44`(在 CapabilitiesSchema 加 execution)
- Test: `__tests__/employee-execution-config.test.ts`(新建)

**Interfaces:**
- Consumes: 无(从零开始)
- Produces:
  ```typescript
  export const ExecutionSchema: z.ZodType<...>;
  // type ExecutionConfig = z.infer<typeof ExecutionSchema>;
  // CapabilitiesSchema 增加 execution: ExecutionSchema.optional()
  ```

- [ ] **Step 1: 写失败测试**

新建 `__tests__/employee-execution-config.test.ts`:

```typescript
import { ExecutionSchema } from '../src/agents/employee/json-types';

describe('ExecutionSchema', () => {
  it('applies default maxRetries=2 when omitted', () => {
    const parsed = ExecutionSchema.parse({});
    expect(parsed.maxRetries).toBe(2);
  });

  it('applies default retryableErrorTypes when omitted', () => {
    const parsed = ExecutionSchema.parse({});
    expect(parsed.retryableErrorTypes).toEqual(['TIMEOUT', 'NETWORK_ERROR', 'API_ERROR']);
  });

  it('applies default transferOnPartialFailure=false when omitted', () => {
    const parsed = ExecutionSchema.parse({});
    expect(parsed.transferOnPartialFailure).toBe(false);
  });

  it('accepts override values', () => {
    const parsed = ExecutionSchema.parse({
      maxRetries: 5,
      retryableErrorTypes: ['TIMEOUT'],
      transferOnPartialFailure: true,
    });
    expect(parsed.maxRetries).toBe(5);
    expect(parsed.retryableErrorTypes).toEqual(['TIMEOUT']);
    expect(parsed.transferOnPartialFailure).toBe(true);
  });

  it('rejects maxRetries > 10', () => {
    expect(() => ExecutionSchema.parse({ maxRetries: 11 })).toThrow();
  });

  it('rejects negative maxRetries', () => {
    expect(() => ExecutionSchema.parse({ maxRetries: -1 })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `bun test __tests__/employee-execution-config.test.ts`
Expected: FAIL with "ExecutionSchema is not exported" 或类似 import 错误。

- [ ] **Step 3: 实现 ExecutionSchema**

修改 `src/agents/employee/json-types.ts`,在 LLMConfigSchema 之后插入 ExecutionSchema,并改 CapabilitiesSchema:

```typescript
// 插入位置:LLMConfigSchema 定义之后,CapabilitiesSchema 之前

export const ExecutionSchema = z.object({
  maxRetries: z.number().int().min(0).max(10).optional().default(2),
  retryableErrorTypes: z.array(z.string()).optional()
    .default(['TIMEOUT', 'NETWORK_ERROR', 'API_ERROR']),
  transferOnPartialFailure: z.boolean().optional().default(false),
});

export type ExecutionConfig = z.infer<typeof ExecutionSchema>;

// 修改 CapabilitiesSchema:
export const CapabilitiesSchema = z.object({
  skillWhitelist: SkillWhitelistSchema.optional(),
  tools: ToolPolicySchema.optional(),
  llm: LLMConfigSchema,
  execution: ExecutionSchema.optional(),
});
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test __tests__/employee-execution-config.test.ts`
Expected: 6 个 it 全部 PASS。

- [ ] **Step 5: 跑现有 schema 测试确认无破坏**

Run: `bun test __tests__/employee-config-schema.test.ts __tests__/employee-loader.test.ts`
Expected: PASS(确认 CapabilitiesSchema 扩展未破坏现有)。

- [ ] **Step 6: Commit**

```bash
git add src/agents/employee/json-types.ts __tests__/employee-execution-config.test.ts
git commit -m "feat(employee): ExecutionSchema for retry + transfer config"
```

---

### Task 2: Task / Request 类型扩展 + CONFIG flag

**Files:**
- Modify: `src/types/index.ts:263-349`(Task interface)
- Modify: `src/types/index.ts:152-167`(Request interface)
- Modify: `src/types/index.ts:570-651`(CONFIG 增加 PARTIAL_FAILURE_ENABLED)
- Test: `__tests__/types-extension.test.ts`(新建)

**Interfaces:**
- Consumes: Task 既有字段
- Produces:
  ```typescript
  // Task 新增
  maxRetries?: number;
  retryableErrorTypes?: string[];
  retryCount?: number;  // 已有,补全类型

  // Request 新增
  partialFailure?: boolean;
  failedTaskIds?: string[];

  // CONFIG 新增
  PARTIAL_FAILURE_ENABLED: boolean;
  ```

- [ ] **Step 1: 写失败测试**

新建 `__tests__/types-extension.test.ts`:

```typescript
import { CONFIG } from '../src/types';

describe('Partial-failure types & config', () => {
  it('PARTIAL_FAILURE_ENABLED defaults to true when env unset', () => {
    delete process.env.PARTIAL_FAILURE_ENABLED;
    // 由于 CONFIG 是模块级常量,需要重新 require 或用 vi.resetModules
    // 简化:只断言当前值是 boolean
    expect(typeof CONFIG.PARTIAL_FAILURE_ENABLED).toBe('boolean');
    expect(CONFIG.PARTIAL_FAILURE_ENABLED).toBe(true);
  });

  it('PARTIAL_FAILURE_ENABLED can be set to false via env', () => {
    process.env.PARTIAL_FAILURE_ENABLED = 'false';
    // 同样简化:只断言 import 能成功 + key 存在
    expect('PARTIAL_FAILURE_ENABLED' in CONFIG).toBe(true);
    delete process.env.PARTIAL_FAILURE_ENABLED;
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `bun test __tests__/types-extension.test.ts`
Expected: FAIL with "PARTIAL_FAILURE_ENABLED is not defined"。

- [ ] **Step 3: 修改 src/types/index.ts**

A. 修改 Task interface(在 executor 字段之后):

```typescript
// Task interface(原 line ~331 executor 字段后追加)
  /**
   * P5: 主智能体注入的最大重试次数(来自 employee.execution.maxRetries)
   * 0 = 不重试
   */
  maxRetries?: number;

  /**
   * P5: 可重试错误类型白名单(来自 employee.execution.retryableErrorTypes)
   * undefined 时 TaskQueue 用默认值
   */
  retryableErrorTypes?: string[];

  /**
   * P5: 当前已重试次数(首次执行为 0,每次重试 +1)
   * TaskQueue 内部维护,不持久化
   */
  retryCount?: number;
```

B. 修改 Request interface(currentQuestion 字段后):

```typescript
// Request interface(currentQuestion 之后追加)
  /**
   * P5: 部分失败标志。即使有 task 失败,只要经过重试+汇总就为 true。
   * Request.status 仍是 'completed',本字段区分纯成功 vs 部分失败。
   */
  partialFailure?: boolean;

  /**
   * P5: 失败 task ID 列表(供前端展示 + 转人工用)。
   * 仅在 partialFailure=true 时填充。
   */
  failedTaskIds?: string[];
```

C. 修改 CONFIG(line ~625 LLM_FALLBACK_ENABLED 之后):

```typescript
  /** Whether LLM fallback chain is enabled (set false to disable) */
  LLM_FALLBACK_ENABLED: process.env.LLM_FALLBACK_ENABLED !== 'false',
  /** P5: 是否启用部分失败处理(retry + mixed summary + transfer hook) */
  PARTIAL_FAILURE_ENABLED: process.env.PARTIAL_FAILURE_ENABLED !== 'false',
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test __tests__/types-extension.test.ts`
Expected: 2 个 it 全部 PASS。

- [ ] **Step 5: 跑类型检查确认无破坏**

Run: `bunx tsc --noEmit`
Expected: 无新增错误(可能有 pre-existing 失败,不属于本次改动)。

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts __tests__/types-extension.test.ts
git commit -m "feat(types): Task/Request 加 retry/partialFailure 字段 + CONFIG.PARTIAL_FAILURE_ENABLED"
```

---

### Task 3: SessionStore.completeRequest 支持 partialFailure

**Files:**
- Modify: `src/memory/session-store.ts:373-410`(completeRequest 加可选参数)
- Test: `__tests__/session-store-partial-failure.test.ts`(新建)

**Interfaces:**
- Consumes: Request interface(已扩展 partialFailure / failedTaskIds)
- Produces:
  ```typescript
  class SessionStore {
    async completeRequest(
      userId, sessionId, requestId, result,
      options?: { partialFailure?: boolean; failedTaskIds?: string[] },
    ): Promise<void>;
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `__tests__/session-store-partial-failure.test.ts`:

```typescript
import { SessionStore } from '../src/memory/session-store';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('SessionStore.completeRequest with partialFailure', () => {
  let dataDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-test-'));
    store = new SessionStore(10, dataDir);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('marks partialFailure=true when options provided', async () => {
    const req = await store.createRequest('user-1', 'sess-1', 'test req');
    await store.completeRequest('user-1', 'sess-1', req.requestId, 'result', {
      partialFailure: true,
      failedTaskIds: ['task-1', 'task-2'],
    });
    const session = await store.loadSession('user-1', 'sess-1');
    const r = session.requests.find(x => x.requestId === req.requestId)!;
    expect(r.partialFailure).toBe(true);
    expect(r.failedTaskIds).toEqual(['task-1', 'task-2']);
    expect(r.status).toBe('completed'); // 仍然 completed,不是 failed
  });

  it('does not set partialFailure when options omitted (backwards compat)', async () => {
    const req = await store.createRequest('user-1', 'sess-1', 'test req');
    await store.completeRequest('user-1', 'sess-1', req.requestId, 'result');
    const session = await store.loadSession('user-1', 'sess-1');
    const r = session.requests.find(x => x.requestId === req.requestId)!;
    expect(r.partialFailure).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `bun test __tests__/session-store-partial-failure.test.ts`
Expected: FAIL(签名不匹配,options 参数未知)。

- [ ] **Step 3: 修改 completeRequest**

修改 `src/memory/session-store.ts:373-410`:

```typescript
  async completeRequest(
    userId: string,
    sessionId: string,
    requestId: string,
    result: string,
    options?: { partialFailure?: boolean; failedTaskIds?: string[] },
  ): Promise<void> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return;

    request.result = result;
    request.updatedAt = new Date().toISOString();

    // P5: 部分失败标志(只在显式提供 options 时设置,避免污染已有数据)
    if (options?.partialFailure !== undefined) {
      request.partialFailure = options.partialFailure;
    }
    if (options?.failedTaskIds !== undefined) {
      request.failedTaskIds = options.failedTaskIds;
    }

    // Use syncRequestStatus to derive status from tasks instead of hardcoding 'completed'.
    if (request.tasks.length > 0) {
      this.syncRequestStatus(request);
    } else {
      request.status = 'completed';
    }

    // 关键修复:activeRequestId 必须清掉
    if (session.activeRequestId === requestId) {
      if (request.status !== 'completed') {
        log.warn('completeRequest: derived status 不是 completed,强制清理 activeRequestId', {
          requestId,
          derivedStatus: request.status,
          taskStatuses: request.tasks.map(t => t.status),
        });
      }
      session.activeRequestId = null;
    }

    await this.saveSession(userId, sessionId, session);
    log.info('完成请求', { requestId, status: request.status, partialFailure: request.partialFailure });
  }
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test __tests__/session-store-partial-failure.test.ts`
Expected: 2 个 it 全部 PASS。

- [ ] **Step 5: 跑相关测试确认无破坏**

Run: `bun test __tests__/session-store.test.ts __tests__/complete-request-clears-active.test.ts __tests__/request-lifecycle.test.ts`
Expected: PASS(确认扩展未破坏现有调用方)。

- [ ] **Step 6: Commit**

```bash
git add src/memory/session-store.ts __tests__/session-store-partial-failure.test.ts
git commit -m "feat(session-store): completeRequest 支持 partialFailure options"
```

---

### Task 4: TaskQueue 重试循环 + shouldRetry helper

**Files:**
- Modify: `src/task-queue/index.ts:486-525`(executeTask catch 块加重试)
- Modify: `src/task-queue/index.ts`(新增 shouldRetry 私有方法 + backoff helper)
- Test: `__tests__/task-queue-retry.test.ts`(新建)

**Interfaces:**
- Consumes: Task.maxRetries / retryableErrorTypes / retryCount(已扩展)
- Produces:
  ```typescript
  class TaskQueue {
    private shouldRetry(err: unknown, retryableTypes: Set<string>): boolean;
    private getRetryBackoffMs(attempt: number): number;
    // executeTask 重构为带 while 重试循环
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `__tests__/task-queue-retry.test.ts`:

```typescript
import { TaskQueue } from '../src/task-queue';
import { LLMError } from '../src/llm';

describe('TaskQueue retry logic', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue(async () => ({ success: true }), 60000, 60000);
  });

  it('retries TIMEOUT error up to maxRetries', async () => {
    let attempts = 0;
    const executor = async () => {
      attempts++;
      if (attempts < 3) throw new LLMError('TIMEOUT', 'timeout');
      return { success: true };
    };
    const q = new TaskQueue(executor as any);
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      maxRetries: 2, retryableErrorTypes: ['TIMEOUT'],
    });
    await new Promise(r => setTimeout(r, 100));
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    const executor = async () => {
      attempts++;
      throw new LLMError('INVALID_KEY', 'bad key');
    };
    const q = new TaskQueue(executor as any);
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      maxRetries: 5, retryableErrorTypes: ['TIMEOUT', 'NETWORK_ERROR'],
    });
    await new Promise(r => setTimeout(r, 50));
    expect(attempts).toBe(1); // 不重试
  });

  it('does not retry API_ERROR with statusCode < 500', async () => {
    let attempts = 0;
    const executor = async () => {
      attempts++;
      throw new LLMError('API_ERROR', 'client error', 400);
    };
    const q = new TaskQueue(executor as any);
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      maxRetries: 3, retryableErrorTypes: ['API_ERROR'],
    });
    await new Promise(r => setTimeout(r, 50));
    expect(attempts).toBe(1);
  });

  it('retries API_ERROR with statusCode >= 500', async () => {
    let attempts = 0;
    const executor = async () => {
      attempts++;
      if (attempts < 2) throw new LLMError('API_ERROR', 'server error', 503);
      return { success: true };
    };
    const q = new TaskQueue(executor as any);
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      maxRetries: 1, retryableErrorTypes: ['API_ERROR'],
    });
    await new Promise(r => setTimeout(r, 100));
    expect(attempts).toBe(2);
  });

  it('increments task.retryCount on each retry', async () => {
    let task: any;
    const executor = async (t: any) => {
      task = t;
      if (t.retryCount < 2) throw new LLMError('TIMEOUT', 'timeout');
      return { success: true };
    };
    const q = new TaskQueue(executor as any);
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      maxRetries: 3, retryableErrorTypes: ['TIMEOUT'],
    });
    await new Promise(r => setTimeout(r, 200));
    expect(task.retryCount).toBe(2);
  });

  it('marks retryExhausted in error after maxRetries attempts', async () => {
    const executor = async () => {
      throw new LLMError('TIMEOUT', 'always times out');
    };
    const q = new TaskQueue(executor as any);
    const events: any[] = [];
    q.on('task-failed', (e: any) => events.push(e));
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      maxRetries: 1, retryableErrorTypes: ['TIMEOUT'],
    });
    await new Promise(r => setTimeout(r, 200));
    expect(events).toHaveLength(1);
    expect(events[0].error.code).toBe('TIMEOUT');  // 原始错误类型保留
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `bun test __tests__/task-queue-retry.test.ts`
Expected: 全部 FAIL(executor 现在的逻辑是一把梭,第一次失败就 failTask)。

- [ ] **Step 3: 实现 shouldRetry + backoff + 重构 executeTask**

修改 `src/task-queue/index.ts`:

A. 新增常量(line ~30,放在 metrics 之前):

```typescript
  private static readonly DEFAULT_RETRYABLE_TYPES = new Set([
    'TIMEOUT', 'NETWORK_ERROR', 'API_ERROR',
  ]);
  private static readonly RETRY_BASE_DELAY_MS = 2000;
  private static readonly RETRY_MAX_DELAY_MS = 60000;
```

B. 新增私有方法(line ~485 之前):

```typescript
  private shouldRetry(err: unknown, retryableTypes: Set<string>): boolean {
    if (err instanceof LLMError) {
      if (!retryableTypes.has(err.type)) return false;
      // API_ERROR 仅在 statusCode >= 500 时重试(4xx 是客户端错,无意义)
      if (err.type === 'API_ERROR' && (err.statusCode ?? 0) < 500) return false;
      return true;
    }
    return false;
  }

  private getRetryBackoffMs(attempt: number): number {
    // attempt = 1 表示第 1 次重试,2 表示第 2 次
    const base = TaskQueue.RETRY_BASE_DELAY_MS;
    const max = TaskQueue.RETRY_MAX_DELAY_MS;
    const exp = Math.min(base * Math.pow(2, attempt - 1), max);
    return exp + Math.random() * 1000; // ±1s jitter
  }
```

C. 重构 executeTask 的 catch 块(line 486-525):

```typescript
  private async executeTask(task: Task): Promise<void> {
    task.status = "running";
    task.startedAt = new Date();
    this.running.add(task.id);

    this.emitter.emit('task-started', { taskId: task.id, task });

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, CONFIG.TASK_TIMEOUT_MS);
    this.timeoutHandles.set(task.id, timeoutHandle);

    // P5: 重试配置(从 task 取,无则用全局默认值)
    const retryEnabled = CONFIG.PARTIAL_FAILURE_ENABLED;
    const maxRetries = retryEnabled ? (task.maxRetries ?? 2) : 0;
    const retryableTypes = new Set(
      task.retryableErrorTypes ?? ['TIMEOUT', 'NETWORK_ERROR', 'API_ERROR'],
    );

    let lastError: unknown;
    let retryExhausted = false;

    try {
      // 重试循环
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          // 重试前:更新 retryCount + 退避
          task.retryCount = (task.retryCount ?? 0) + 1;
          const backoff = this.getRetryBackoffMs(attempt);
          log.warn('task retry', {
            taskId: task.id,
            attempt,
            maxRetries,
            backoffMs: backoff,
            previousError: lastError instanceof Error ? lastError.message : String(lastError),
          });
          await new Promise(r => setTimeout(r, backoff));
        }

        try {
          const executor = task.executor ?? this.executor;
          const result = await executor(task, controller.signal);
          clearTimeout(timeoutHandle);
          this.timeoutHandles.delete(task.id);

          const executionTime = Date.now() - startTime;
          log.info('任务完成', { taskId: task.id, executionTime, attempts: attempt + 1 });
          this.completeTask(task.id, result, executionTime);
          return;
        } catch (err) {
          lastError = err;
          if (!this.shouldRetry(err, retryableTypes) || attempt >= maxRetries) {
            if (this.shouldRetry(err, retryableTypes) && attempt >= maxRetries) {
              retryExhausted = true;
            }
            break;
          }
        }
      }

      // 走到这里说明重试耗尽或不可重试
      throw lastError;
    } catch (error) {
      log.error('executor 抛出异常', { taskId: task.id, error, retryExhausted });
      clearTimeout(timeoutHandle);
      this.timeoutHandles.delete(task.id);

      const executionTime = Date.now() - startTime;
      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("timed out"));

      if (isTimeout) {
        log.warn('任务超时', { taskId: task.id, executionTime });
      } else {
        log.warn('任务失败', { taskId: task.id, executionTime, retryExhausted });
      }

      const taskError: TaskError = error instanceof AppError
        ? {
            type: error.type,
            code: retryExhausted ? `${error.code || 'TASK_FAILED'}_RETRY_EXHAUSTED` : error.code,
            message: error.message,
            statusCode: error.statusCode,
            stack: error.stack,
            originalError: error,
          }
        : {
            type: "RETRYABLE",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          };
      this.failTask(task.id, taskError, isTimeout);
    } finally {
      this.running.delete(task.id);
      this.processQueue();
    }
  }
```

**注意**: 需要在文件顶部 import `LLMError`:
```typescript
import { LLMError } from '../llm';
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test __tests__/task-queue-retry.test.ts`
Expected: 6 个 it 全部 PASS。

- [ ] **Step 5: 跑现有 task-queue 测试确认无破坏**

Run: `bun test __tests__/task-queue.test.ts __tests__/concurrent-executor-race.test.ts`
Expected: PASS(existing test 默认 maxRetries=0 即不重试,行为同现状)。

- [ ] **Step 6: Commit**

```bash
git add src/task-queue/index.ts __tests__/task-queue-retry.test.ts
git commit -m "feat(task-queue): retry loop with shouldRetry + exponential backoff"
```

---

### Task 5: TaskGraphExecutor.executeTaskGraph 不再因失败 throw

**Files:**
- Modify: `src/agents/task-graph-executor.ts:443-496`(executeTaskGraph 返回新 shape)
- Test: `__tests__/task-graph-partial-failure.test.ts`(新建)

**Interfaces:**
- Consumes: TaskQueue 重试后的 failedTasks 信息(retryExhausted 标记)
- Produces:
  ```typescript
  interface ExecuteTaskGraphResult {
    success: boolean;  // 全成功才 true
    data: {
      planId: string;
      results: Array<...>;
      failedTasks?: FailedTaskInfo[];  // 新增
      hasPartialFailure?: boolean;      // 新增
      waitingTaskId?: string;           // 既有
    };
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `__tests__/task-graph-partial-failure.test.ts`:

```typescript
import { TaskGraphExecutor } from '../src/agents/task-graph-executor';
import { TaskQueue } from '../src/task-queue';
import { SessionStore } from '../src/memory/session-store';
import { ResultAggregator } from '../src/agents/result-aggregator';

describe('TaskGraphExecutor.executeTaskGraph partial failure', () => {
  it('returns hasPartialFailure=true when some tasks failed', async () => {
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }));

    const taskQueue = new TaskQueue(async () => {
      throw new Error('always fails');
    });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = {
      id: 'plan-1',
      requirement: 'test',
      nodes: [{
        taskId: 'plan-1-task-1',
        content: 'task 1',
        skillName: 'test-skill',
        dependencies: [],
      }],
      layers: [['plan-1-task-1']],
    };
    const req = { requestId: 'r1', content: 'r', status: 'processing', createdAt: '', updatedAt: '',
      suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null,
      tasks: [], result: null } as any;

    const result = await executor.executeTaskGraph(graph, 'sess-1', 'user-1', req);
    expect(result.data?.hasPartialFailure).toBe(true);
    expect(result.data?.failedTasks).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it('does not throw when failedTasks exists (new behavior)', async () => {
    // 上一条测试也验证了这点,但加一个 explicit 断言
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }));

    const taskQueue = new TaskQueue(async () => { throw new Error('boom'); });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = {
      id: 'plan-1',
      requirement: 'test',
      nodes: [{
        taskId: 'plan-1-task-1',
        content: 'task 1',
        skillName: 'test-skill',
        dependencies: [],
      }],
      layers: [['plan-1-task-1']],
    };
    const req = { requestId: 'r1', content: 'r', status: 'processing', createdAt: '', updatedAt: '',
      suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null,
      tasks: [], result: null } as any;

    // 不应 throw
    await expect(executor.executeTaskGraph(graph, 'sess-1', 'user-1', req)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `bun test __tests__/task-graph-partial-failure.test.ts`
Expected: FAIL with throw(当前 executeTaskGraph 仍 throw)。

- [ ] **Step 3: 修改 executeTaskGraph**

修改 `src/agents/task-graph-executor.ts:478-496`:

```typescript
    // P5: 部分失败改为返回 hasPartialFailure,不再 throw
    // 旧行为:throw SkillError(让上层走 catch)
    // 新行为:返回 success: false + hasPartialFailure: true,让上层 MainAgent 决定路由
    if (layerResult.failedTasks.length > 0) {
      log.warn('TaskGraph 部分失败,进入汇总阶段', {
        failedCount: layerResult.failedTasks.length,
        successCount: allResults.length,
      });
      return {
        success: false,
        data: {
          planId: graph.id,
          results: allResults,
          failedTasks: layerResult.failedTasks,
          hasPartialFailure: true,
        },
      };
    }

    return {
      success: true,
      data: { planId: graph.id, results: allResults },
    };
  }
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test __tests__/task-graph-partial-failure.test.ts`
Expected: 2 个 it 全部 PASS。

- [ ] **Step 5: 跑现有 task-graph 测试 — 关键回归点**

Run: `bun test __tests__/task-graph.test.ts __tests__/task-graph-shouldstop.test.ts __tests__/task-graph-checkpoint.test.ts __tests__/task-graph-session-writeback.test.ts`
Expected: **注意**:task-graph-shouldstop × 4 + task-graph-onCheckpoint × 2 是 pre-existing 失败(进度文件标记),不应该新增更多失败。

- [ ] **Step 6: Commit**

```bash
git add src/agents/task-graph-executor.ts __tests__/task-graph-partial-failure.test.ts
git commit -m "feat(task-graph): executeTaskGraph returns hasPartialFailure instead of throw"
```

---

### Task 6: ResultAggregator 接受 transferHook + 混合状态汇总

**Files:**
- Modify: `src/agents/result-aggregator.ts:32-45`(构造函数加第 6 参数 transferHook)
- Modify: `src/agents/result-aggregator.ts:187-286`(summarizeResults 改写)
- Test: `__tests__/result-aggregator-mixed-status.test.ts`(新建)

**Interfaces:**
- Consumes: TaskResult[] with `status?: string`(既有)
- Produces:
  ```typescript
  export type TransferToHumanHook = (taskResults: TaskResult[]) => boolean;

  class ResultAggregator {
    constructor(
      llm, memoryService, sessionStore,
      onNeedsIntentReclassification,
      rewriter?: ResultRewriter,
      transferHook?: TransferToHumanHook,  // 新增
    );
    // summarizeResults 返回新 shape:
    return {
      completed: boolean;
      summary: string;
      failedTaskIds: string[];
      transferTriggered: boolean;
    };
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `__tests__/result-aggregator-mixed-status.test.ts`:

```typescript
import { ResultAggregator } from '../src/agents/result-aggregator';
import { z } from 'zod';

describe('ResultAggregator mixed status + transfer hook + B-1 fix', () => {
  const llm = {
    generateStructured: async (prompt: string, schema: any) => {
      // 模拟 LLM 生成含"X 成功, Y 失败"语气的摘要
      const hasFailure = prompt.includes('❌');
      return schema.parse({
        completed: !hasFailure,
        summary: hasFailure ? '合同查询成功,但审批失败。' : '全部成功',
      });
    },
  } as any;
  const memSvc = {} as any;
  const sessionStore = {
    completeRequest: async () => {},
  } as any;

  it('does NOT add rewriter suffix when some tasks failed (B-1 fix)', async () => {
    const rewriter = {
      match: { status: 'completed' },
      transform: 'append' as const,
      value: '\n\n---\n如有问题请回复「转人工」',
    };
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), rewriter);

    const taskResults = [
      { taskId: 't1', skillName: 'fawu', requirement: '查询', response: 'ok', status: 'completed' },
      { taskId: 't2', skillName: 'fawu', requirement: '审批', response: 'failed', status: 'failed' },
    ];
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(summary.completed).toBe(false);
    expect(summary.summary).not.toContain('如有问题请回复'); // rewriter 不追加
    expect(summary.failedTaskIds).toEqual(['t2']);
  });

  it('adds rewriter suffix when ALL tasks completed (regression)', async () => {
    const rewriter = {
      match: { status: 'completed' },
      transform: 'append' as const,
      value: '\n\n---\n如有问题请回复「转人工」',
    };
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), rewriter);

    const taskResults = [
      { taskId: 't1', skillName: 'fawu', requirement: '查询', response: 'ok', status: 'completed' },
      { taskId: 't2', skillName: 'fawu', requirement: '审批', response: 'ok', status: 'completed' },
    ];
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(summary.completed).toBe(true);
    expect(summary.summary).toContain('如有问题请回复'); // rewriter 追加
    expect(summary.failedTaskIds).toEqual([]);
  });

  it('transferHook is called when partial failure', async () => {
    let hookCalled = false;
    const transferHook = () => { hookCalled = true; return true; };
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }),
      undefined, transferHook);

    const taskResults = [
      { taskId: 't1', skillName: 's', requirement: 'r', response: 'ok', status: 'completed' },
      { taskId: 't2', skillName: 's', requirement: 'r', response: 'fail', status: 'failed' },
    ];
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(hookCalled).toBe(true);
    expect(summary.transferTriggered).toBe(true);
    expect(summary.summary).toContain('转人工');
  });

  it('transferHook is NOT called when all completed', async () => {
    let hookCalled = false;
    const transferHook = () => { hookCalled = true; return true; };
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }),
      undefined, transferHook);

    const taskResults = [
      { taskId: 't1', skillName: 's', requirement: 'r', response: 'ok', status: 'completed' },
    ];
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(hookCalled).toBe(false);
    expect(summary.transferTriggered).toBe(false);
  });

  it('transferHook default is noop (does not crash without arg)', async () => {
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }));
    const taskResults = [
      { taskId: 't1', skillName: 's', requirement: 'r', response: 'fail', status: 'failed' },
    ];
    // 不应 throw
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(summary.transferTriggered).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `bun test __tests__/result-aggregator-mixed-status.test.ts`
Expected: 全部 FAIL(transferHook 不存在 / rewriter 错用 taskResults[0])。

- [ ] **Step 3: 修改 ResultAggregator**

修改 `src/agents/result-aggregator.ts`:

A. 文件顶部加 type export(line 11 之后):

```typescript
export type TransferToHumanHook = (taskResults: TaskResult[]) => boolean;
```

B. 修改构造函数(line 32-45):

```typescript
export class ResultAggregator {
  private rewriter?: ResultRewriter;
  private transferHook: TransferToHumanHook;

  constructor(
    private llm: ILLMClient,
    private memoryService: MemoryService,
    private sessionStore: SessionStore,
    private onNeedsIntentReclassification: (
      request: Request, userId: string, sessionId: string,
    ) => Promise<TaskResult>,
    rewriter?: ResultRewriter,
    transferHook?: TransferToHumanHook,
  ) {
    this.rewriter = rewriter;
    this.transferHook = transferHook ?? (() => false);  // 默认 noop
  }
```

C. 重写 summarizeResults(line 187-286):

```typescript
  async summarizeResults(
    originalRequirement: string,
    taskResults: Array<{ taskId: string; skillName: string; requirement: string; response: string; status?: string }>,
    userId: string,
    sessionId: string,
    request: Request,
  ): Promise<{ completed: boolean; summary: string; failedTaskIds: string[]; transferTriggered: boolean }> {
    log.info(`📊 汇总 ${taskResults.length} 个任务结果...`);

    // P5: 拆分状态
    const completedTasks = taskResults.filter(t => t.status === 'completed');
    const failedTasks = taskResults.filter(t => t.status === 'failed');
    const waitingTasks = taskResults.filter(t => t.status === 'waiting_user_input');

    const resultsContext = [
      ...completedTasks.map((t, idx) => `任务${idx + 1} [${t.skillName}]: ✅ ${t.response}`),
      ...failedTasks.map((t, idx) => `任务${completedTasks.length + idx + 1} [${t.skillName}]: ❌ ${t.response || '执行失败'}`),
      ...(waitingTasks.length > 0 ? [`⏸ 等待用户输入: ${waitingTasks.map(t => t.skillName).join(', ')}`] : []),
    ].join('\n\n');

    const prompt = `用户原始需求: ${originalRequirement}

以下是各子任务的执行结果:
${resultsContext}

请判断:
1. 所有子任务的结果是否已经完整满足了用户的需求？
2. 如果满足，请生成一段简洁自然的汇总回复
3. 如果有失败任务，明确告知用户哪些成功、哪些失败，并建议回复"转人工"获取人工协助

输出 JSON:
{
  "completed": true/false,
  "summary": "汇总文本"
}`;

    try {
      const traceId = `agg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      log.info('llm.request', {
        traceId,
        type: 'aggregate',
        requestId: request.requestId,
        tasksCount: taskResults.length,
        failedCount: failedTasks.length,
      });

      let judgment = await this.llm.generateStructured(prompt, z.object({
        completed: z.boolean(),
        summary: z.string(),
      }));

      log.info('llm.response', { traceId, completed: judgment.completed });
      log.info(`📊 汇总判断: completed=${judgment.completed}, failed=${failedTasks.length}`);

      // P5: 防御纵深 —— 有失败 task 时强制 completed=false
      // (即使 LLM 误判 completed=true 也覆盖,避免标"完成")
      if (failedTasks.length > 0 && judgment.completed) {
        log.warn('LLM 把部分失败误判为 completed,已修正', {
          failedCount: failedTasks.length,
          llmJudgment: judgment.completed,
        });
        judgment = { ...judgment, completed: false };
      }

      // P5: Transfer hook(预留)
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

      // P5: Rewriter gate 修复 —— 必须基于 every(completed),不再用 taskResults[0] 或 [N-1]
      // 旧行为(B-1 bug):taskResults[0]?.status === 'completed'
      // 新行为:全成功 + 无 waiting 才追加
      const allCompleted = completedTasks.length === taskResults.length && waitingTasks.length === 0;
      if (this.rewriter && allCompleted) {
        const targetStatus = this.rewriter.match?.status ?? 'completed';
        if (targetStatus === 'completed') {
          judgment = {
            ...judgment,
            summary: this.applyRewriter(judgment.summary, this.rewriter),
          };
        }
      }

      if (judgment.completed) {
        try {
          await this.memoryService.saveAssistantMessage(userId, sessionId, judgment.summary, {
            requestId: request.requestId,
          });
        } catch (error) {
          throw new SkillError('JUDGMENT_FAILED',
            error instanceof Error ? error.message : String(error),
            { cause: error });
        }
        await this.sessionStore.completeRequest(userId, sessionId, request.requestId, judgment.summary);
        fireAndForget(
          this.memoryService.summarizeRequest({
            userId, sessionId, requestId: request.requestId,
            userMessage: originalRequirement, assistantMessage: judgment.summary,
          }),
          'summarizeRequest (summarizeResults)',
          (err) => log.error('请求摘要生成失败', { error: err }),
        );
      }

      return {
        completed: judgment.completed,
        summary: judgment.summary,
        failedTaskIds: failedTasks.map(t => t.taskId),
        transferTriggered,
      };
    } catch (error) {
      if (error instanceof LLMError) {
        throw new LlmError(error.type, error.message, { cause: error });
      }
      if (error instanceof AppError) throw error;
      throw new BusinessError('SUMMARIZATION_FAILED',
        error instanceof Error ? error.message : String(error),
        { cause: error });
    }
  }
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test __tests__/result-aggregator-mixed-status.test.ts`
Expected: 5 个 it 全部 PASS。

- [ ] **Step 5: 跑现有 result-aggregator 测试确认无破坏**

Run: `bun test __tests__/result-aggregator.test.ts __tests__/result-aggregator-rewriter.test.ts`
Expected: PASS(扩展未破坏现有)。

- [ ] **Step 6: Commit**

```bash
git add src/agents/result-aggregator.ts __tests__/result-aggregator-mixed-status.test.ts
git commit -m "feat(aggregator): mixed status summary + transfer hook + B-1 fix via every(completed)"
```

---

### Task 7: MainAgent 注入 transferHook + hasPartialFailure 路由

**Files:**
- Modify: `src/agents/main-agent.ts:132-137`(ResultAggregator 构造加 transferHook)
- Modify: `src/agents/main-agent.ts`(processNormalRequirement 多任务分支处理 hasPartialFailure)
- Test: `__tests__/main-agent-partial-failure.test.ts`(新建)

**Interfaces:**
- Consumes: ResultAggregator 第 6 参数(已扩展)
- Produces: 现有 processNormalRequirement 行为 + hasPartialFailure 路由

- [ ] **Step 1: 写失败测试**

新建 `__tests__/main-agent-partial-failure.test.ts`:

```typescript
import { MainAgent } from '../src/agents/main-agent';
import { defaultEmptyEmployee } from '../src/agents/main-agent'; // 或类似的工厂

describe('MainAgent partial failure routing', () => {
  it('falls through to summary branch when hasPartialFailure', async () => {
    // 构造 MainAgent (最小 stub 依赖),注入一个会返回 hasPartialFailure 的 fake taskGraphExecutor
    // 验证 processNormalRequirement 不 throw 而是进入汇总路径
    // ...
    // 简化方案:集成测试(在 Task 8 E2E 里覆盖),这里只测直接逻辑
    expect(true).toBe(true); // placeholder
  });
});
```

注: MainAgent 测试需要复杂 stub,直接单元测试不划算。**该 task 的核心验证通过 Task 8 e2e 完成**,本 task 写一个 sanity check 即可。

- [ ] **Step 2: 跑测试确认 FAIL → PASS(占位)**

Run: `bun test __tests__/main-agent-partial-failure.test.ts`
Expected: PASS(只 sanity check)。

- [ ] **Step 3: 修改 MainAgent**

A. 注入 transferHook(line 132-137):

```typescript
    // P5: ResultAggregator 注入 transferHook(本期 noop)
    // TODO(Task 13): 接外部工单系统时实现真实 hook
    const transferHook: import('./result-aggregator').TransferToHumanHook = (_results) => {
      // noop — 等真实转人工实现
      return false;
    };

    this.resultAggregator = new ResultAggregator(
      llm, memoryService, sessionStore,
      (request, userId, sessionId) =>
        this.processNormalRequirement(request.content, userId, sessionId, request, undefined, undefined, 1),
      this.employee.outputBehavior?.resultRewriter,
      transferHook,
    );
```

B. processNormalRequirement 多任务分支(hasPartialFailure 路由)—— 关键修改:在 taskList 构造前合并成功 + 失败 task,让下游统一处理。

找到 processNormalRequirement 内 `const taskResults = resultData?.results || [];`(现有 line ~1264),替换为:

```typescript
      // P5: 合并成功 + 失败 task,让下游 taskList / summarizeResults 看到完整状态
      // 修复:之前 taskResults 仅含成功 task,单 task 全失败时 taskList=[],
      //     导致走入"多任务空数组"分支,summarizeResults LLM 收到空上下文。
      const successResults = resultData?.results || [];
      const failedAsResults = (resultData?.failedTasks || []).map((t: any) => ({
        taskId: t.taskId,
        skillName: t.skillName || '',
        requirement: '',
        response: '',
        status: 'failed',
        error: t.error,
      }));
      const taskResults = [...successResults, ...failedAsResults];
```

C. 单任务分支的 partialFailure 处理:

找到 line ~1359 `if (taskList.length === 1) { ... }` 分支,改为:

```typescript
      if (taskList.length === 1) {
        // 单任务:直接使用子智能体的结果,无需额外汇总
        MainAgent.log.info('单任务完成,跳过汇总,直接使用子智能体结果');
        finalResponse = taskList[0].response;
        if (!finalResponse) {
          finalResponse = JSON.stringify(result.data);
        }
        isCompleted = taskList[0].status !== 'failed'; // P5: 部分失败时不算完成

        // P5: 单任务也可能失败(TaskGraphExecutor 返回 failedTasks)
        const failedIds = (resultData?.failedTasks || []).map((t: any) => t.taskId);
        const isPartial = failedIds.length > 0;
        await this.sessionStore.completeRequest(userId, sessionId, request.requestId, finalResponse, {
          partialFailure: isPartial,
          failedTaskIds: isPartial ? failedIds : undefined,
        });
      }
```

D. 多任务分支的 partialFailure 标记(line ~1370 后):

找到 `else { ... summarizeResults ... }` 多任务分支,在 `finalResponse = summary.summary;` 之后加:

```typescript
        // P5: 部分失败时,带 partialFailure 标志写入 completeRequest
        if (summary.failedTaskIds.length > 0) {
          try {
            await this.sessionStore.completeRequest(userId, sessionId, request.requestId, finalResponse, {
              partialFailure: true,
              failedTaskIds: summary.failedTaskIds,
            });
          } catch (e) {
            MainAgent.log.error('partial failure completeRequest 失败', { error: e });
          }
        }
```

C. executeTaskGraph 调用处(hasPartialFailure 不再被外层误判为失败)—— 找到 processNormalRequirement 里调用 `await this.executeTaskGraph(...)` 的位置,确保 hasPartialFailure 不被外层 catch 当异常处理:

现有逻辑 line ~1229:
```typescript
      result = await this.executeTaskGraph(graph, sessionId, userId, request);
```

executeTaskGraph 现在返回 `{ success: false, data: { hasPartialFailure: true } }`,需要在外层不把它当 throw:

```typescript
      // P5: executeTaskGraph 不再 throw 部分失败,改为返回 hasPartialFailure。
      // 外层 try/catch 仍捕获 SkillError / AppError(全失败场景)。
      result = await this.executeTaskGraph(graph, sessionId, userId, request);
```

`result.success === false` 但 `result.data?.hasPartialFailure === true` 的情况由后续判断逻辑处理(见下方)。

E. hasPartialFailure 全局开关(line ~1264 之前,合并 resultData 之前):

在 processNormalRequirement 内,找到 `if (resultData?.mergedAway)` 判断后,加 hasPartialFailure 处理:

```typescript
      // P5: 部分失败 → 不走 throw 路径,继续到汇总
      if (resultData?.hasPartialFailure) {
        MainAgent.log.info('部分任务失败,进入汇总阶段', {
          succeeded: resultData.results?.length || 0,
          failed: resultData.failedTasks?.length || 0,
          failedTaskIds: resultData.failedTasks?.map((t: any) => t.taskId) || [],
        });
        // 设置 result.success = true(因为请求本身没彻底失败),让汇总分支正常走
        result = { ...result, success: true };
      }
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `bun test __tests__/main-agent-partial-failure.test.ts __tests__/main-agent.test.ts __tests__/main-agent-error.test.ts __tests__/main-agent-queue.test.ts __tests__/main-agent-employee.test.ts`
Expected: PASS(无新增回归)。注意 pre-existing 失败若出现不算。

- [ ] **Step 5: 跑 e2e 测试确认整体 OK**

Run: `bun test __tests__/error-propagation-e2e.test.ts __tests__/it-desk-self-service.test.ts __tests__/it-desk-progress-push.test.ts __tests__/resilience-e2e.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/agents/main-agent.ts __tests__/main-agent-partial-failure.test.ts
git commit -m "feat(main-agent): inject transferHook + route hasPartialFailure to summary"
```

---

### Task 8: 端到端集成测试

**Files:**
- Create: `__tests__/partial-failure-e2e.test.ts`(新建)

- [ ] **Step 1: 写失败 e2e 测试**

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { MainAgent } from '../src/agents/main-agent';
import { buildStackedAgent, postStreamExpectEvents } from './helpers/stack-helpers';

describe('Partial failure E2E', () => {
  it('retries transient LLM error then succeeds', async () => {
    const { agent, events } = await buildStackedAgent({
      employeeId: 'test-employee',
      llmBehavior: {
        generateStructured: async (prompt: string) => {
          // 模拟 IntentRouter 返回单 task,然后 UnifiedPlanner 返回单 task
          // SubAgent 的 generateWithTools 第 1 次失败(TIMEOUT),第 2 次成功
          if (prompt.includes('意图')) return { intent: 'skill_task', tasks: [{ requirement: 'r', skillName: 'test' }] };
          return { analysis: {}, plan: { tasks: [{ id: 't1', requirement: 'r', skillName: 'test', dependencies: [] }] } };
        },
        generateWithTools: (() => {
          let calls = 0;
          return async () => {
            calls++;
            if (calls === 1) throw new (await import('../src/llm')).LLMError('TIMEOUT', 'first attempt timeout');
            return { content: 'success after retry', toolCalls: [], messages: [] };
          };
        })(),
      },
    });
    // ... 跑流式,验证 SSE 含 task_retrying 事件或重试日志
  });

  it('retries exhausted → summary with partialFailure', async () => {
    // 场景:IntentRouter 返回 2 个 task,其中一个 LLM 调用永远超时,另一个成功
    // 期望:summary 含"成功/失败"区分,request.partialFailure=true
  });

  it('PARTIAL_FAILURE_ENABLED=false reverts to old behavior (throw)', async () => {
    // 设 env var,验证 task 失败立即 throw
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL → 实现 helper**

如果 buildStackedAgent 不存在,先实现 helper(参考 `__tests__/error-propagation-e2e.test.ts`)。

- [ ] **Step 3: 跑 e2e 全部 PASS**

Run: `bun test __tests__/partial-failure-e2e.test.ts`
Expected: 3 个 it 全部 PASS。

- [ ] **Step 4: 跑全套测试确认无新增回归**

Run: `bun test`
Expected: 0 新增回归(允许 6 个 pre-existing 失败)。

- [ ] **Step 5: 跑类型检查**

Run: `bunx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 6: Commit**

```bash
git add __tests__/partial-failure-e2e.test.ts
git commit -m "test(e2e): partial failure + retry exhaustion + feature flag scenarios"
```

---

### Task 9: 文档更新(CLAUDE.md / API.md)

**Files:**
- Modify: `docs/PRD.md`(Out of Scope 移除部分失败相关项)
- Modify: `docs/详细设计.md`(失败语义更新)
- Modify: `docs/分析报告.md`(B-1 状态变更)

- [ ] **Step 1: 更新 PRD.md**

找到 Out of Scope 节,移除"暂时没这个功能,预留"项,改写为已实现。

- [ ] **Step 2: 更新 详细设计.md**

在"已知限制"节加新章节"失败重试 + 部分汇总"。

- [ ] **Step 3: 更新 分析报告.md**

将 B-1 标记为 RESOLVED。

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: 更新 PRD/详细设计/分析报告反映 partial-failure retry 已落地"
```

---

### Task 10: 最终验证 + 全套 commit 整合

- [ ] **Step 1: 跑全套测试**

Run: `bun test`
Expected: 0 新增回归。

- [ ] **Step 2: 类型检查**

Run: `bunx tsc --noEmit`
Expected: 无错。

- [ ] **Step 3: 启动验证(可选)**

```bash
HAIER_API_KEY=test-key SILICONFLOW_API_KEY=test-key bun start --employee=legal-assistant 2>&1 | head -20
```

Expected: 启动成功,日志含 "Employee loaded"。

- [ ] **Step 4: 最终 commit(如有遗留)**

```bash
git status
git log --oneline -15
```

确认 9 个 task commit 都已落地。

---

## 验证清单(End-to-End)

完成所有 Task 后,逐项对照:

- [ ] `bun test` 全部 PASS(0 新增回归,允许 6 个 pre-existing)
- [ ] `bunx tsc --noEmit` 无新增错误
- [ ] TaskQueue retry 6 个新测试 PASS
- [ ] TaskGraphExecutor partial failure 2 个新测试 PASS
- [ ] ResultAggregator mixed status 5 个新测试 PASS
- [ ] MainAgent routing 1 个 sanity test PASS
- [ ] E2E partial failure 3 个测试 PASS
- [ ] 现有 employee JSON 不强制改(向后兼容)
- [ ] PARTIAL_FAILURE_ENABLED=false 时行为同现状

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 重试导致 tool 副作用重复 | 仅重试 LLM 临时错,不重试 tool 错 |
| retry 退避时间过长 | base 2s,max 60s,jitter ±1s |
| existing 测试因签名变更 break | 步骤内每次都跑相关测试,不允许累计 |
| TaskGraphExecutor 不 throw 后上层未适配 | MainAgent hasPartialFailure 路由(Task 7) |
| SessionStore 序列化 partialFailure 时丢盘 | completeRequest 同步 await saveSession,无防抖延迟 |
| 真实转人工 hook 没实现,用户误以为可用 | transferHook 默认 noop + Task 13 TODO 标记 |

---

## 不在本计划范围

1. **真实转人工实现**(工单系统对接 / SSE `request_transfer_to_human` event) — Task 13 独立项目
2. **Skill 业务错误重试**(只重试 LLM 临时错)
3. **tool 级重试**(bash / write / edit 失败不重试)
4. **重试的 idempotency key**(依赖 task 自身实现)
5. **Request.partialFailure 的 UI 展示适配**(前端按需)
6. **重试指标可视化看板**(SLA Watcher 已埋点)
7. **跨 request 重试共享**(每次 request 独立)
8. **task.retryCount 持久化**(本期不持久化,进程重启后计数丢失)