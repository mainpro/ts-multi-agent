# 端到端错误传播集成测试设计

**作者**: Claude
**日期**: 2026-07-28
**状态**: 设计已批准,待实施

---

## Context

全局错误处理重构(17 任务 + 4 critical fixes + 2 important fixes)已实施完毕。剩余任务之一:**端到端错误传播集成测试**,覆盖 `LlmError` 从抛点到 HTTP 响应的完整链路。

当前测试覆盖:
- AppError 类层级映射 ✓(`__tests__/app-error.test.ts`)
- `errorToResponse` envelope ✓(`__tests__/error-handler.test.ts`)
- Express middleware 与 envelope ✓(`__tests__/api-error-middleware.test.ts`)
- MainAgent throw 行为(getSessionHistory 单一路径)`__tests__/main-agent.test.ts` MA-E01/MA-E02
- SubAgent throw 行为 ✓(`__tests__/sub-agent.test.ts` 适配后)

缺失的测试覆盖:
- **LlmError 从 SubAgent.execute → mapSubAgentError → TaskQueue → MainAgent → globalErrorHandler → SSE error event 完整路径**
- **多任务场景下 TaskGraphExecutor 错误传播**(t1 失败 → t2/t3 跳过;t2 中间失败 → t3 不执行;t1/t2 并行都失败 → 取 first failedTask)
- **traceId 跨 HTTP 边界传递**(从 `traceIdMiddleware` 到 SSE `X-Trace-Id` header)

---

## 目标

写一个集成测试文件 `__tests__/error-propagation-e2e.test.ts`,包含 4 个测试场景,验证完整错误传播链路。

**约束**(已与用户确认):
- 范围: 仅 HTTP 同步路径(走 POST /tasks/stream SSE)
- 注入点: SubAgent 内部(LLMClient 抛 LLMError)
- IntentRouter mock: 直接 mock 它返回 `skill_task`(跳过 LLM 分类)
- 测试架构: 完整 spin up Express server(真实 HTTP + 真实 SSE)
- 场景: 1 单任务 + 3 多任务变体(2a 第一个失败 / 2b 中间失败 / 2c 并行都失败)

---

## 架构

### 1. 测试文件

**位置**: `__tests__/error-propagation-e2e.test.ts`

**测试框架**: `bun:test`(与 `api-error-middleware.test.ts` 一致)

### 2. 工厂函数 `buildStackedAgent`

```typescript
interface StackedAgentOpts {
  /** 哪些 taskId 触发 LLM 抛错;默认空(全部成功) */
  failingTaskIds?: Set<string>;
  /** 抛出的 LLMErrorType;默认 'RATE_LIMIT' */
  llmErrorType?: LLMErrorType;
  /** IntentRouter 返回的意图结果;默认单任务 skill_task */
  intentResult?: IntentResult;
}

async function buildStackedAgent(opts: StackedAgentOpts): Promise<{
  mainAgent: MainAgent;
  url: string;
  close: () => Promise<void>;
  dataDir: string;
}>;
```

**构造顺序**:

1. 临时 dataDir: `path.join(os.tmpdir(), 'ma-e2e-{ts}-{rand}')`,mkdir `memory` 子目录
2. **Mock LLMClient**:
   - `generateStructured(prompt, schema)` → 返回 `opts.intentResult`(默认 `{intent:'skill_task', confidence:0.9, tasks:[{taskId:'t1', requirement:'...', skillName:'echo', intent:'skill_task'}]}`)
   - `generateText(prompt, system)` → 检查 prompt 是否包含 taskId(用 task context 注入),如果在 `failingTaskIds` 中,抛 `new LLMError(opts.llmErrorType, msg, statusCode)`
   - 其他方法返回安全默认(`generateWithTools` → 空)
3. **Mock SkillRegistry**:
   - `getAllMetadata()` → 返回单个 'echo' 技能 metadata
   - `loadFullSkill('echo')` → 返回 minimal Skill
   - `hasSkill(name)` → 永远 true
4. **真实依赖链**(因为这些是稳定的、不依赖 LLM):
   - `new UserProfileService(dataDir)`
   - `new MemoryService(dataDir, mockLLM)`
   - `new SessionStore(100, dataDir)`
   - `new IntentRouter(mockLLM, mockSkillRegistry)` — 但 `generateStructured` mock 后 IntentRouter 直接返回注入的 intentResult
   - `new DynamicContextBuilder(memoryService)`
   - `new AskAgent(sessionStore, mockLLM)`
   - `new SystemSkillLoader()` + `loadAll()`
   - `new ExecutorRegistry()`
   - `new MainAgent({ llm: mockLLM, ..., 全部依赖 })`
5. **Mock TaskQueue**(继承 EventEmitter,提供 `addTask`/`getTask`/`cancelTask` stub)
6. **Express app**:`createAPIServer(mainAgent, mockSkillRegistry, mockTaskQueue)` — 用真实生产 wiring
7. **`app.listen(0, ...)`** 获取 random port
8. **返回 `{ mainAgent, url, close, dataDir }`**

**close 函数**:
```typescript
const close = async () => {
  await new Promise<void>(r => server.close(() => r()));
  try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {}
};
```

### 3. HTTP/SSE 辅助函数

```typescript
async function postStreamExpectEvents(
  url: string,
  body: object,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  events: Array<{ event: string; data: any }>;
}>;
```

**实现**:
- `http.request` 发 POST,`Content-Type: application/json`,body JSON 序列化
- 设置超时 30s(测试不应该超过这个时间)
- 解析 `text/event-stream` 响应:
  - 累积 buffer,按 `\n` 切分
  - 解析 `event: <name>` 和 `data: <json>`,组合成 `{event, data}`
  - 数据可能跨多个 chunk,需要 buffer 累积
- 连接关闭或收到所有事件后 resolve

**复用 `__tests__/api-error-middleware.test.ts` 的 `request()` 辅助函数** 的模式,扩展支持 SSE 流解析。

### 4. 4 个测试场景

#### 场景 1:单任务 LlmError RATE_LIMIT 完整路径

```typescript
test('E2E-1: 单任务 LLM RATE_LIMIT → SSE error event with LlmError envelope + X-Trace-Id', async () => {
  const stack = await buildStackedAgent({
    failingTaskIds: new Set(['t1']),
    llmErrorType: 'RATE_LIMIT',
  });
  try {
    const { status, headers, events } = await postStreamExpectEvents(stack.url, {
      requirement: '帮我查一下报销',
      userId: 'u1',
    });

    // HTTP SSE 协议:无论成功失败 status 都是 200,事件通过 stream 传
    expect(status).toBe(200);

    // 1. TraceId 验证
    expect(headers['x-trace-id']).toBeTruthy();
    expect(headers['x-trace-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    // 2. SSE error event 验证
    const errorEvent = events.find(e => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.data).toBeDefined();
    expect(errorEvent.data.type).toBe('RETRYABLE');
    expect(errorEvent.data.code).toBe('LLM_RATE_LIMIT');
    expect(typeof errorEvent.data.message).toBe('string');
    expect(errorEvent.data.message.length).toBeGreaterThan(0);

    // 3. 失败路径不发送 complete
    const completeEvent = events.find(e => e.event === 'complete');
    expect(completeEvent).toBeUndefined();
  } finally {
    await stack.close();
  }
});
```

#### 场景 2a: 多任务第一个失败

```typescript
test('E2E-2a: 多任务 t1 失败 → t2/t3 不执行', async () => {
  const stack = await buildStackedAgent({
    failingTaskIds: new Set(['t1']),
    intentResult: {
      intent: 'skill_task',
      confidence: 0.9,
      tasks: [
        { taskId: 't1', requirement: 'A', skillName: 'echo', intent: 'skill_task' },
        { taskId: 't2', requirement: 'B', skillName: 'echo', intent: 'skill_task', params: { ref: '$t1.result' } },
        { taskId: 't3', requirement: 'C', skillName: 'echo', intent: 'skill_task' },
      ],
    },
  });
  try {
    const { events, headers } = await postStreamExpectEvents(stack.url, {
      requirement: 'multi task',
      userId: 'u1',
    });
    const errorEvent = events.find(e => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.data.code).toMatch(/^LLM_/);
    expect(headers['x-trace-id']).toBeTruthy();
  } finally {
    await stack.close();
  }
});
```

#### 场景 2b: 多任务中间失败

```typescript
test('E2E-2b: 多任务 t1 成功 → t2 失败 → 依赖 t2 的 t3 不执行', async () => {
  const stack = await buildStackedAgent({
    failingTaskIds: new Set(['t2']),
    intentResult: {
      intent: 'skill_task',
      confidence: 0.9,
      tasks: [
        { taskId: 't1', requirement: 'A', skillName: 'echo', intent: 'skill_task' },
        { taskId: 't2', requirement: 'B', skillName: 'echo', intent: 'skill_task' },
        { taskId: 't3', requirement: 'C', skillName: 'echo', intent: 'skill_task', params: { ref: '$t2.result' } },
      ],
    },
  });
  try {
    const { events } = await postStreamExpectEvents(stack.url, {
      requirement: 'multi task with mid failure',
      userId: 'u1',
    });
    const errorEvent = events.find(e => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.data.code).toMatch(/^LLM_/);
  } finally {
    await stack.close();
  }
});
```

#### 场景 2c: 多任务并行都失败

```typescript
test('E2E-2c: 多任务 t1/t2 并行执行 → 都失败 → first failedTask error reported', async () => {
  const stack = await buildStackedAgent({
    failingTaskIds: new Set(['t1', 't2']),
    intentResult: {
      intent: 'skill_task',
      confidence: 0.9,
      tasks: [
        { taskId: 't1', requirement: 'A', skillName: 'echo', intent: 'skill_task' },
        { taskId: 't2', requirement: 'B', skillName: 'echo', intent: 'skill_task' },
      ],
    },
  });
  try {
    const { events } = await postStreamExpectEvents(stack.url, {
      requirement: 'parallel both fail',
      userId: 'u1',
    });
    const errorEvent = events.find(e => e.event === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.data.code).toMatch(/^LLM_/);
    // 验证 first failedTask 错误被选中(t1 或 t2)
    expect(['LLM_RATE_LIMIT']).toContain(errorEvent.data.code);
  } finally {
    await stack.close();
  }
});
```

### 5. 验证要点(每个测试)

1. **HTTP status**: 200(SSE 协议固定)
2. **X-Trace-Id header**: 存在 + UUID v4 格式
3. **SSE error event**:
   - `event === 'error'`
   - `data.type === 'RETRYABLE'`(LlmError.type 继承自 AppError.type)
   - `data.code` 以 `'LLM_'` 开头(LlmError.code 格式)
   - `data.message` 是非空字符串
4. **No complete event**: 失败路径不发送 `event: complete`

### 6. 数据隔离

- 每个 test 用 `Date.now() + Math.random()` 生成唯一 dataDir
- `close()` 同时关闭 server + `fs.rm(dataDir, {recursive: true, force: true})`
- 测试间无状态污染

---

## 数据流(场景 1 为例)

```
POST /tasks/stream {requirement:'帮我查一下报销'}
  ↓
traceIdMiddleware (生成 UUID,设 X-Trace-Id header)
  ↓
mainAgent.processRequirement
  ↓ (内部)
IntentRouter.classify → 调用 mockLLM.generateStructured
  ↓
mockLLM 返回 {intent:'skill_task', tasks:[t1]}
  ↓
MainAgent.processNormalRequirement
  ↓
TaskGraphExecutor.executeTaskGraph
  ↓
SubAgent.execute(task t1)
  ↓
mockLLM.generateText (LLM 在 t1 context 中)
  ↓ throws LLMError('RATE_LIMIT', '...', 429)
mapSubAgentError (sub-agent.ts)
  ↓ throws new LlmError('RATE_LIMIT', '...', {cause, statusCode:429})
TaskQueue executor 透传 throw
  ↓
TaskGraphExecutor.executeLayers catch (line 313-322)
  ↓ throws new LlmError(error.type, error.message, {cause: error})
MainAgent.processNormalRequirement catch (line 795-806)
  ↓ throws error (AppError re-throw unchanged)
POST /tasks/stream try/catch (api/index.ts:446-451)
  ↓
errorToResponse(error)
  ↓ returns {status:429, body:{success:false, error:{type:'RETRYABLE', code:'LLM_RATE_LIMIT', message:'...'}}}
sendEvent('error', body.error)
  ↓
SSE 流: event: error\ndata: {"type":"RETRYABLE","code":"LLM_RATE_LIMIT","message":"..."}
```

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| IntentRouter 内部 catch 吞掉 LLM 错误 | mock IntentRouter 返回 skill_task 跳过它 |
| TaskGraphExecutor 顶层 catch 吞掉错误 | 已经在 final-review 修复;测试验证修复有效 |
| SubAgent 内部其他 catch(judgeContinuation、vision-client)吞错 | generateText 失败 throw,不走这些路径 |
| Mock TaskQueue 不支持真实执行 | 不影响 — 我们要验证的是错误传播,不是任务执行 |
| 测试时间过长 | 4 个 test × ~500ms = ~2s,可接受 |
| SkillRegistry 真实 loadAll 可能失败 | 不调用 loadAll,直接 mock hasSkill true |
| IntentRouter 调用 LLM 即使 mock 也可能慢 | generateStructured 直接 return,不延迟 |

---

## 验收清单

- [ ] `__tests__/error-propagation-e2e.test.ts` 创建
- [ ] 4 个测试场景全部通过(bun test)
- [ ] 每个测试验证 X-Trace-Id + SSE error event + no complete event
- [ ] 每个 test 用 try/finally 清理 dataDir + server
- [ ] `npx tsc --noEmit` 0 错误
- [ ] 不修改任何生产代码
- [ ] 测试时间 < 5s

---

## 验证方法

1. **基础运行**:
   ```bash
   bun test __tests__/error-propagation-e2e.test.ts
   ```
   预期: 4 passed, 0 failed

2. **集成验证**:
   ```bash
   bun test   # 全套
   ```
   预期: 全套通过,0 失败

3. **类型检查**:
   ```bash
   npx tsc --noEmit
   ```
   预期: 0 错误

4. **真实启动冒烟测试**(可选):
   ```bash
   npm start &
   curl -X POST http://localhost:3000/tasks/stream \
     -H 'Content-Type: application/json' \
     -d '{"requirement":"test"}'
   ```
   预期: SSE 流含 error event(因为没有 skill registry)

---

## 已知缺口(本 spec 不覆盖)

- **BusinessError / SkillError / ConfigError 路径**:类似 LlmError 但需要不同 mock 策略(不需要 mock SkillRegistry)。本 spec 仅 LlmError,因 final-review 已涵盖其他类型。
- **traceId 在 mainAgent 内部传播**:目前 `traceIdMiddleware` 只在 HTTP 层注入,mainAgent 内部日志用 `createLogger` 无 traceId。如未来需要 mainAgent 日志也带 traceId,需用 AsyncLocalStorage 单独设计。
- **错误响应体嵌套**:SSE error event 当前是 `{type, code, message}` 三个字段,而非完整 envelope `{success: false, error: {...}}`。Reviewer 在 final review 中标记为 Important(已解决:用 `body.error` 提取,envelope 在 HTTP error 路径下仍是完整 `{success, error}`)。