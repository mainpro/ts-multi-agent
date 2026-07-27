# 全局错误处理架构设计

**作者**: Claude
**日期**: 2026-07-27
**状态**: 设计已批准,待实施

---

## Context

当前错误处理散落各处,格式不统一:

- **API 层**(54 个 try/catch,32 个 console.error):每个 endpoint 各自用 `res.status(4xx).json({ error, message, code })`,5+ 种格式并存
- **MainAgent**:最外层 try/catch 兜底,把任意错误归一为 `{ success: false, error: { type: 'FATAL', ... } }`,丢失原始错误分类
- **SubAgent**:`classifyError(error)` 用字符串匹配(`error.message.includes('timeout')`),忽略已有 `LLMError.type` 分类字段
- **IntentRouter**:catch 后返回 `{ intent: 'unclear', question: {...} }`,语义上是合法响应(用户可回答),但混在错误处理范畴里
- **ResultAggregator / TaskGraphExecutor**:把 `TaskError` 当 string 传递,失去类型安全和堆栈

诉求:**全面重构,统一 envelope 响应,AppError 类层级替代字符串匹配,API 中间件兜底**。

---

## 目标

```
分层错误处理(明确边界):
├── API 层(最外层) — 全局中间件,捕获所有未处理异常
│   ├── 生成 traceId,补 log.error
│   ├── AppError → envelope + HTTP statusCode
│   └── 其他 Error → envelope { success: false, error: { type: FATAL, code: INTERNAL_ERROR } }
├── MainAgent/SubAgent — 业务代码显式 throw AppError
│   ├── 已知业务失败 → throw new BusinessError / SkillError
│   ├── LLM 调用失败 → throw new LlmError(type, message)
│   └── 不再"吞"错误,不静默返回 { success: false }
└── LLM — LLMError 分类保留,由调用方决定是否升级为 AppError
```

---

## 架构

### 1. AppError 类层级

文件:`src/errors/app-error.ts`、`src/errors/llm-error.ts`、`src/errors/business-error.ts`、`src/errors/skill-error.ts`、`src/errors/config-error.ts`、`src/errors/index.ts`

```typescript
abstract class AppError extends Error {
  abstract readonly type: ErrorType;
  abstract readonly code: string;
  readonly statusCode: number = 500;
  readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    if (options?.cause) this.cause = options.cause;
  }
}

class LlmError extends AppError {
  readonly type = 'RETRYABLE' as const;
  constructor(
    public readonly llmErrorType: LLMErrorType,
    message: string,
    options?: { cause?: unknown; statusCode?: number }
  ) {
    super(message, options);
    this.code = `LLM_${llmErrorType}`;
    this.statusCode = options?.statusCode ?? this.mapStatusCode(llmErrorType);
  }
  private mapStatusCode(t: LLMErrorType): number {
    if (t === 'RATE_LIMIT') return 429;
    if (t === 'INVALID_KEY') return 401;
    if (t === 'TIMEOUT') return 504;
    if (t === 'CONTEXT_TOO_LONG' || t === 'OUTPUT_TOO_LONG') return 400;
    if (t === 'CANCELLED') return 499;
    return 502;
  }
}

class BusinessError extends AppError {
  readonly type = 'USER_ERROR' as const;
  constructor(code: string, message: string, options?: { statusCode?: number; cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.statusCode = options?.statusCode ?? 400;
  }
}

class SkillError extends AppError {
  readonly type = 'SKILL_ERROR' as const;
  constructor(code: string, message: string, options?: { statusCode?: number; cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.statusCode = options?.statusCode ?? 422;
  }
}

class ConfigError extends AppError {
  readonly type = 'FATAL' as const;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.statusCode = 500;
  }
}
```

### 2. envelope 响应

文件:`src/types/api-response.ts`

```typescript
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { type: ErrorType; code: string; message: string };
}
```

成功响应:`{ success: true, data: {...} }`
失败响应:`{ success: false, error: { type, code, message } }`
HTTP 状态码反映顶层分类(LlmError→429/504/502,BusinessError→400,SkillError→422,FATAL→500)。

### 3. errorToResponse 转换器

文件:`src/api/error-handler.ts`

```typescript
export function errorToResponse(error: unknown): {
  status: number;
  body: ApiResponse<null>;
} {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: {
        success: false,
        error: { type: error.type, code: error.code, message: error.message },
      },
    };
  }
  if (error instanceof Error) {
    return {
      status: 500,
      body: {
        success: false,
        error: { type: 'FATAL', code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      },
    };
  }
  return {
    status: 500,
    body: {
      success: false,
      error: { type: 'FATAL', code: 'UNKNOWN_ERROR', message: String(error) },
    },
  };
}
```

### 4. Express 全局错误中间件

文件:`src/api/error-handler.ts`(同文件,导出 `globalErrorHandler`)

```typescript
export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const traceId = (req as any).traceId ?? 'unknown';
  const { status, body } = errorToResponse(err);

  // 业务代码已 log 上下文,中间件补 traceId + 请求元信息
  log.error('Request failed', {
    traceId,
    method: req.method,
    path: req.path,
    status,
    errType: err instanceof AppError ? err.constructor.name : 'Unknown',
    errMessage: err instanceof Error ? err.message : String(err),
  });

  res.status(status).json(body);
}
```

### 5. traceId middleware

文件:`src/api/error-handler.ts`(同文件,导出 `traceIdMiddleware`)

```typescript
export function traceIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = (req.headers['x-trace-id'] as string) || crypto.randomUUID();
  (req as any).traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  next();
}
```

### 6. 路由迁移原则

每个 endpoint 的 catch 块删除,业务失败用 `throw new AppError(...)` 替代。

**改造前**:
```typescript
app.get('/sessions/:sessionId/history', async (req, res) => {
  if (!sessionId) {
    res.status(400).json({ error: 'INVALID_REQUEST', message: '...' });
    return;
  }
  try {
    const history = await mainAgent.getSessionHistory(...);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'INTERNAL_ERROR', ... });
  }
});
```

**改造后**:
```typescript
app.get('/sessions/:sessionId/history', async (req, res) => {
  if (!sessionId) {
    throw new BusinessError('INVALID_REQUEST', 'sessionId is required');
  }
  const history = await mainAgent.getSessionHistory(...);
  res.json({ success: true, data: history });
});
```

### 7. MainAgent / SubAgent / ResultAggregator 内部错误流

**SubAgent 改造**:
- 删除 `classifyError(error)` 字符串匹配
- catch 块用 `instanceof LLMError` 升级为 `LlmError`
- 其他错误 throw `SkillError('EXECUTION_ERROR', ...)`
- 不再返回 `{ success: false, error: ... }`,改 throw

**MainAgent 改造**:
- `processRequirement` 顶层不 catch,业务代码 throw AppError
- 局部 catch(已知失败)用 throw BusinessError/SkillError
- 已知合法响应(small_talk、unclear、confirm_system)正常返回 envelope

**ResultAggregator 改造**:
- `summarizeResults` catch: throw `LlmError` 或 `BusinessError('SUMMARIZATION_FAILED', ...)`
- `handleTaskCompletion` catch: throw `SkillError('TASK_EXECUTION_FAILED', ...)`

**TaskGraphExecutor 改造**:
- `executeLayers` catch: throw `BusinessError('EXECUTION_INTERRUPTED', ...)` 或 `SkillError`

### 8. SSE 流式响应

```typescript
app.post('/tasks/stream', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  // ...

  try {
    const result = await mainAgent.processRequirement(...);
    sendEvent('complete', { success: true, data: result.data });
  } catch (error) {
    const { body } = errorToResponse(error);
    sendEvent('error', body.error);
  } finally {
    res.end();
  }
});
```

### 9. IntentRouter 不变

`classify` 仍 catch LLM 错误,返回 `{ intent: 'unclear', question: {...} }` —— 这是合法响应,不是错误。**保留现状**。

### 10. 日志策略

- **业务代码**:`log.warn` / `log.error` 记业务上下文,不附 traceId
- **API 中间件**:catch 时记 `log.error` 含 `traceId / method / path / status / errType / errMessage`
- **traceId 生成**:traceIdMiddleware 在最早期挂载
- **API 响应头**:X-Trace-Id

替换 32 处 `console.error` → `log.error({...}, 'context')`,替换 ~50 处 `console.log` → `log.info`/`log.debug`。

---

## 数据流

### 成功路径

```
HTTP Request
  → traceId middleware(生成 traceId,挂 X-Trace-Id)
  → endpoint 业务代码(成功 → res.json({ success: true, data }))
  → 200 OK
```

### 业务失败路径

```
HTTP Request
  → traceId middleware
  → endpoint 校验 throw new BusinessError('INVALID_REQUEST', ...)
  → globalErrorHandler(errorToResponse)
  → res.status(400).json({ success: false, error: { type, code, message } })
  → log.error({ traceId, path, status, ... })
```

### LLM 失败路径

```
HTTP Request
  → traceId middleware
  → endpoint 调用 mainAgent.processRequirement
  → MainAgent → SubAgent.executeSkill → LLM 抛 LLMError('RATE_LIMIT', ...)
  → SubAgent catch → throw new LlmError('RATE_LIMIT', ..., { cause: error })
  → 异常向上冒泡
  → globalErrorHandler(errorToResponse)
  → res.status(429).json({ success: false, error: { type: 'RETRYABLE', code: 'LLM_RATE_LIMIT', ... } })
```

---

## 迁移顺序(每步独立可提交)

| Step | 内容 | 文件 | 测试 |
|------|------|------|------|
| 1 | 基础类型 | `src/errors/`(4 文件)+ `src/types/api-response.ts` | `tsc --noEmit` |
| 2 | API 中间件 | `src/api/error-handler.ts` + 替换 `src/api/index.ts` try/catch | 现有 endpoint 测试 |
| 3 | SubAgent 改造 | `src/agents/sub-agent.ts` | 新增/改 sub-agent 测试 |
| 4 | MainAgent + ResultAggregator + TaskGraphExecutor 改造 | 3 个 agent 文件 | 调整 main-agent.test.ts 断言 |
| 5 | SSE + traceId | `src/api/index.ts` SSE + traceId middleware | 端到端 |
| 6 | 日志统一 | 32 处 console.error → log | 不期望行为变化 |
| 7 | 清理 | 删除冗余 try/catch、console | 测试通过 |

---

## 测试策略

### 新增测试

- `__tests__/app-error.test.ts`:AppError 各类层级 statusCode/code/type 映射正确性
- `__tests__/error-handler.test.ts`:`errorToResponse` 对各类型输入产生正确 envelope
- `__tests__/api-error-middleware.test.ts`:express 集成测试,各 endpoint 抛 AppError 时中间件正确响应
- `__tests__/main-agent-error.test.ts`:MainAgent.processRequirement 在 LLM 抛错时 throw LlmError

### 调整测试

- `__tests__/main-agent.test.ts`:从「期望返回 success=false」改为「期望 throws AppError」
- `__tests__/intent-router.test.ts`:验证 IntentRouter 仍返回 unclear(行为不变)
- `__tests__/session-store.test.ts`:不变

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| MainAgent 改造破坏 main-agent.test.ts | 调整断言而非删除测试 |
| SSE 响应格式变化,前端不兼容 | envelope `{ success: true, data }` 向后兼容现有 success=true 分支 |
| 隐式 try/catch 的 silent fallback | 移除时 audit 每个 catch,确认非业务必要 |
| traceId 性能 | 每个请求生成 UUID,~0.01ms,不在 hot path |
| LlmError → HTTP statusCode 映射与现有 LLMError 字段冲突 | LlmError 继承自 AppError,优先用 AppError.statusCode,LLMError.statusCode 作为输入 |
| 现有 endpoint 行为变化 | Step 2 改完先跑所有测试,再继续 Step 3+ |

---

## 验收清单

- [ ] `src/errors/` 5 个文件(AppError + 4 子类 + index)
- [ ] `src/types/api-response.ts` 导出 `ApiResponse<T>`
- [ ] `src/api/error-handler.ts` 导出 `errorToResponse / globalErrorHandler / traceIdMiddleware`
- [ ] `src/api/index.ts` 替换 ~10 处 try/catch,改为 throw AppError
- [ ] 所有 endpoint 返回 envelope `{ success, data?, error? }`
- [ ] HTTP 状态码反映 AppError.type(LlmError→429/504/502,BusinessError→400,SkillError→422,FATAL→500)
- [ ] MainAgent/SubAgent 不再"吞"错误,内部 throw AppError
- [ ] SubAgent catch 用 `instanceof LLMError` 替代字符串匹配
- [ ] IntentRouter 仍 catch 返回 unclear(行为不变)
- [ ] traceId 在每个请求生成,X-Trace-Id 响应头
- [ ] 32 处 console.error → log.error/warn
- [ ] LlmError.type 直接传递 LLMErrorType,HTTP statusCode 自动映射
- [ ] 所有现有测试通过 + 新增测试通过
- [ ] `tsc --noEmit` 0 错误

---

## 验证方法

每步完成后:
1. `tsc --noEmit` 检查编译
2. `bun test` 跑全部测试
3. 启动服务 `npm start`,curl `/health` 验证
4. 提交测试任务 `POST /tasks` 验证完整错误路径(成功 + 业务失败 + LLM 失败)
5. 检查响应头 `X-Trace-Id` 存在
6. 检查响应 body 是 envelope 格式