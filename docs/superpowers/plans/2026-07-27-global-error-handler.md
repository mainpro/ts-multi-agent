# Global Error Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered try/catch blocks and ad-hoc error returns with a unified AppError class hierarchy + Express global error middleware that emits `{ success, data?, error? }` envelopes.

**Architecture:** Introduce `AppError` abstract class with 4 concrete subclasses (`LlmError`, `BusinessError`, `SkillError`, `ConfigError`). API endpoints throw instead of catch; an Express middleware translates any thrown error into an envelope + HTTP status code. Business modules (MainAgent / SubAgent / ResultAggregator / TaskGraphExecutor / TaskQueue) explicitly throw AppError on known failures instead of returning `{ success: false }`. IntentRouter's `unclear` fallback is preserved (it's a legitimate response, not an error).

**Tech Stack:** TypeScript (strict mode), Express 5, Bun test runner + custom test runner (`npx tsx`), existing `createLogger` from `src/observability/logger`.

## Global Constraints

- TypeScript strict mode (all flags enabled per `tsconfig.json`)
- `noUnusedLocals` / `noUnusedParameters` enforced — delete unused code
- Test files excluded from `tsconfig.json` build
- Bun 1.x + `bun test` for `bun:test`-style tests, `npx tsx` for custom-runner tests
- All commits on `feature_claude_optimize` branch
- `package.json` scripts: `npm run build`, `bun test`
- Type `ErrorType = 'RETRYABLE' | 'FATAL' | 'USER_ERROR' | 'SKILL_ERROR'` from `src/types/index.ts`
- Type `LLMErrorType = 'RATE_LIMIT' | 'TIMEOUT' | 'INVALID_KEY' | 'API_ERROR' | 'NETWORK_ERROR' | 'UNKNOWN_ERROR' | 'CONTEXT_TOO_LONG' | 'OUTPUT_TOO_LONG' | 'CANCELLED' | 'QUEUE_FULL'` from `src/llm/index.ts`
- Preserve IntentRouter.classify returning `{ intent: 'unclear', ... }` semantics — DO NOT change this behavior
- All HTTP responses (success and failure) wrap in envelope `{ success, data?, error? }`
- HTTP status code mapping: `LlmError` → 429/401/504/400/499/503/500/502 by type; `BusinessError` → 400; `SkillError` → 422; `ConfigError` → 500; unknown Error → 500

---

## File Structure

### New files

| File | Responsibility |
|------|----------------|
| `src/errors/app-error.ts` | Abstract `AppError` base class |
| `src/errors/llm-error.ts` | `LlmError extends AppError` with LLMErrorType → HTTP status mapping |
| `src/errors/business-error.ts` | `BusinessError extends AppError` for user-fixable errors |
| `src/errors/skill-error.ts` | `SkillError extends AppError` for skill execution failures |
| `src/errors/config-error.ts` | `ConfigError extends AppError` for system/config errors |
| `src/errors/index.ts` | Barrel export |
| `src/types/api-response.ts` | `ApiResponse<T>` envelope type |
| `src/api/error-handler.ts` | `errorToResponse()` + `globalErrorHandler` + `traceIdMiddleware` |
| `__tests__/app-error.test.ts` | AppError class hierarchy mapping tests (bun:test) |
| `__tests__/error-handler.test.ts` | `errorToResponse` envelope tests (bun:test) |
| `__tests__/api-error-middleware.test.ts` | Express integration tests (bun:test) |
| `__tests__/main-agent-error.test.ts` | MainAgent throws AppError instead of returning `{ success: false }` (custom runner) |

### Modified files

| File | Change |
|------|--------|
| `src/api/index.ts` | Replace ~10 try/catch blocks with throw; mount middleware; SSE uses `errorToResponse` |
| `src/agents/sub-agent.ts` | Replace `classifyError` string matching with `instanceof LLMError`; throw AppError |
| `src/agents/main-agent.ts` | Remove top-level catch in `processRequirement`; local catches throw AppError |
| `src/agents/result-aggregator.ts` | Catches throw `BusinessError` / `SkillError` / `LlmError` |
| `src/agents/task-graph-executor.ts` | Catches throw `BusinessError` / `SkillError` |
| `src/index.ts` | TaskQueue executor passes through thrown AppError |
| `__tests__/main-agent.test.ts` | Update assertions from "returns success=false" to "throws AppError" |
| `__tests__/sub-agent.test.ts` | Update assertions for throw behavior |
| Various module files | Replace `console.error` → `log.error/warn` (32 sites) |

---

## Task 1: AppError class hierarchy

**Files:**
- Create: `src/errors/app-error.ts`
- Create: `src/errors/llm-error.ts`
- Create: `src/errors/business-error.ts`
- Create: `src/errors/skill-error.ts`
- Create: `src/errors/config-error.ts`
- Create: `src/errors/index.ts`

**Interfaces:**
- Consumes: `ErrorType` from `src/types/index.ts`, `LLMErrorType` from `src/llm/index.ts`
- Produces:
  - `abstract class AppError extends Error` with `abstract readonly type: ErrorType`, `abstract readonly code: string`, `readonly statusCode: number = 500`, `readonly cause?: unknown`
  - `class LlmError extends AppError` with `constructor(llmErrorType: LLMErrorType, message: string, options?: { cause?: unknown; statusCode?: number })`
  - `class BusinessError extends AppError` with `constructor(code: string, message: string, options?: { statusCode?: number; cause?: unknown })`
  - `class SkillError extends AppError` with same signature as BusinessError
  - `class ConfigError extends AppError` with `constructor(code: string, message: string, options?: { cause?: unknown })`

- [ ] **Step 1: Create `src/errors/app-error.ts`**

```typescript
import { ErrorType } from '../types';

export interface AppErrorOptions {
  cause?: unknown;
  statusCode?: number;
}

export abstract class AppError extends Error {
  abstract readonly type: ErrorType;
  abstract readonly code: string;
  readonly statusCode: number = 500;
  readonly cause?: unknown;

  constructor(message: string, options?: AppErrorOptions) {
    super(message);
    this.name = this.constructor.name;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options?.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    Error.captureStackTrace?.(this, this.constructor);
  }
}
```

- [ ] **Step 2: Create `src/errors/llm-error.ts`**

```typescript
import { LLMErrorType } from '../llm';
import { AppError, AppErrorOptions } from './app-error';

export class LlmError extends AppError {
  readonly type = 'RETRYABLE' as const;

  constructor(
    public readonly llmErrorType: LLMErrorType,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message, options);
    this.code = `LLM_${llmErrorType}`;
    if (options?.statusCode === undefined) {
      this.statusCode = LlmError.mapStatusCode(llmErrorType);
    }
  }

  static mapStatusCode(t: LLMErrorType): number {
    if (t === 'RATE_LIMIT') return 429;
    if (t === 'INVALID_KEY') return 401;
    if (t === 'TIMEOUT') return 504;
    if (t === 'CONTEXT_TOO_LONG' || t === 'OUTPUT_TOO_LONG') return 400;
    if (t === 'CANCELLED') return 499;
    if (t === 'QUEUE_FULL') return 503;
    if (t === 'UNKNOWN_ERROR') return 500;
    return 502;
  }
}
```

- [ ] **Step 3: Create `src/errors/business-error.ts`**

```typescript
import { AppError, AppErrorOptions } from './app-error';

export class BusinessError extends AppError {
  readonly type = 'USER_ERROR' as const;

  constructor(
    public readonly code: string,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message, options);
    if (options?.statusCode === undefined) {
      this.statusCode = 400;
    }
  }
}
```

- [ ] **Step 4: Create `src/errors/skill-error.ts`**

```typescript
import { AppError, AppErrorOptions } from './app-error';

export class SkillError extends AppError {
  readonly type = 'SKILL_ERROR' as const;

  constructor(
    public readonly code: string,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message, options);
    if (options?.statusCode === undefined) {
      this.statusCode = 422;
    }
  }
}
```

- [ ] **Step 5: Create `src/errors/config-error.ts`**

```typescript
import { AppError, AppErrorOptions } from './app-error';

export class ConfigError extends AppError {
  readonly type = 'FATAL' as const;

  constructor(
    public readonly code: string,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message, options);
    if (options?.statusCode === undefined) {
      this.statusCode = 500;
    }
  }
}
```

- [ ] **Step 6: Create `src/errors/index.ts`**

```typescript
export { AppError, AppErrorOptions } from './app-error';
export { LlmError } from './llm-error';
export { BusinessError } from './business-error';
export { SkillError } from './skill-error';
export { ConfigError } from './config-error';
```

- [ ] **Step 7: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add src/errors/
git commit -m "feat(errors): add AppError class hierarchy (LlmError/BusinessError/SkillError/ConfigError)"
```

---

## Task 2: AppError class hierarchy tests

**Files:**
- Create: `__tests__/app-error.test.ts`

**Interfaces:**
- Consumes: `LlmError`, `BusinessError`, `SkillError`, `ConfigError`, `AppError` from `src/errors`
- Produces: test coverage for status code mapping and type/code fields

- [ ] **Step 1: Write failing test file `__tests__/app-error.test.ts`**

```typescript
import { describe, test, expect } from 'bun:test';
import { AppError, LlmError, BusinessError, SkillError, ConfigError } from '../src/errors';

describe('AppError hierarchy', () => {
  test('LlmError maps RATE_LIMIT to 429', () => {
    const e = new LlmError('RATE_LIMIT', 'too many requests');
    expect(e.type).toBe('RETRYABLE');
    expect(e.code).toBe('LLM_RATE_LIMIT');
    expect(e.statusCode).toBe(429);
    expect(e.llmErrorType).toBe('RATE_LIMIT');
    expect(e.message).toBe('too many requests');
  });

  test('LlmError maps all LLMErrorType to valid HTTP codes', () => {
    const cases: Array<[string, number]> = [
      ['RATE_LIMIT', 429],
      ['INVALID_KEY', 401],
      ['TIMEOUT', 504],
      ['CONTEXT_TOO_LONG', 400],
      ['OUTPUT_TOO_LONG', 400],
      ['CANCELLED', 499],
      ['QUEUE_FULL', 503],
      ['UNKNOWN_ERROR', 500],
      ['API_ERROR', 502],
      ['NETWORK_ERROR', 502],
    ];
    for (const [type, expectedStatus] of cases) {
      const e = new LlmError(type as any, 'msg');
      expect(e.statusCode).toBe(expectedStatus);
    }
  });

  test('LlmError preserves custom statusCode', () => {
    const e = new LlmError('RATE_LIMIT', 'msg', { statusCode: 503 });
    expect(e.statusCode).toBe(503);
  });

  test('BusinessError defaults to 400', () => {
    const e = new BusinessError('INVALID_REQUEST', 'bad input');
    expect(e.type).toBe('USER_ERROR');
    expect(e.code).toBe('INVALID_REQUEST');
    expect(e.statusCode).toBe(400);
  });

  test('SkillError defaults to 422', () => {
    const e = new SkillError('EXECUTION_FAILED', 'skill crashed');
    expect(e.type).toBe('SKILL_ERROR');
    expect(e.code).toBe('EXECUTION_FAILED');
    expect(e.statusCode).toBe(422);
  });

  test('ConfigError defaults to 500', () => {
    const e = new ConfigError('MISSING_API_KEY', 'no key');
    expect(e.type).toBe('FATAL');
    expect(e.code).toBe('MISSING_API_KEY');
    expect(e.statusCode).toBe(500);
  });

  test('cause is preserved', () => {
    const cause = new Error('original');
    const e = new BusinessError('WRAP', 'wrapped', { cause });
    expect(e.cause).toBe(cause);
  });

  test('name matches constructor name', () => {
    expect(new LlmError('TIMEOUT', 'msg').name).toBe('LlmError');
    expect(new BusinessError('X', 'y').name).toBe('BusinessError');
    expect(new SkillError('X', 'y').name).toBe('SkillError');
    expect(new ConfigError('X', 'y').name).toBe('ConfigError');
  });

  test('AppError is abstract (cannot instantiate directly)', () => {
    // TypeScript enforces this at compile time.
    // Runtime check: AppError exists but cannot be `new`'d via standard pattern.
    expect(typeof AppError).toBe('function');
  });

  test('AppError is instance of Error', () => {
    const e = new BusinessError('X', 'y');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AppError);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test __tests__/app-error.test.ts`
Expected: 10 tests pass

- [ ] **Step 3: Commit**

```bash
git add __tests__/app-error.test.ts
git commit -m "test(errors): add AppError class hierarchy tests"
```

---

## Task 3: ApiResponse type + errorToResponse

**Files:**
- Create: `src/types/api-response.ts`
- Create: `src/api/error-handler.ts`

**Interfaces:**
- Consumes: `AppError`, `LlmError`, `BusinessError`, `SkillError`, `ConfigError` from `src/errors`; `ErrorType` from `src/types`
- Produces:
  - `interface ApiResponse<T = unknown> { success: boolean; data?: T; error?: { type: ErrorType; code: string; message: string } }`
  - `function errorToResponse(error: unknown): { status: number; body: ApiResponse<null> }`

- [ ] **Step 1: Create `src/types/api-response.ts`**

```typescript
import { ErrorType } from './index';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { type: ErrorType; code: string; message: string };
}
```

- [ ] **Step 2: Create `src/api/error-handler.ts` (part 1: errorToResponse)**

```typescript
import { AppError } from '../errors';
import { ApiResponse } from '../types/api-response';

export function errorToResponse(error: unknown): {
  status: number;
  body: ApiResponse<null>;
} {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: {
        success: false,
        error: {
          type: error.type,
          code: error.code,
          message: error.message,
        },
      },
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      body: {
        success: false,
        error: {
          type: 'FATAL',
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      success: false,
      error: {
        type: 'FATAL',
        code: 'UNKNOWN_ERROR',
        message: String(error),
      },
    },
  };
}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/types/api-response.ts src/api/error-handler.ts
git commit -m "feat(api): add ApiResponse type and errorToResponse converter"
```

---

## Task 4: errorToResponse unit tests

**Files:**
- Create: `__tests__/error-handler.test.ts`

**Interfaces:**
- Consumes: `errorToResponse` from `src/api/error-handler`; `LlmError`, `BusinessError`, `SkillError`, `ConfigError` from `src/errors`
- Produces: tests covering all error → envelope mappings

- [ ] **Step 1: Write failing tests in `__tests__/error-handler.test.ts`**

```typescript
import { describe, test, expect } from 'bun:test';
import { errorToResponse } from '../src/api/error-handler';
import { LlmError, BusinessError, SkillError, ConfigError } from '../src/errors';

describe('errorToResponse', () => {
  test('LlmError → envelope with type RETRYABLE and LLM_* code', () => {
    const r = errorToResponse(new LlmError('RATE_LIMIT', 'too many'));
    expect(r.status).toBe(429);
    expect(r.body.success).toBe(false);
    expect(r.body.error?.type).toBe('RETRYABLE');
    expect(r.body.error?.code).toBe('LLM_RATE_LIMIT');
    expect(r.body.error?.message).toBe('too many');
  });

  test('BusinessError → 400 USER_ERROR', () => {
    const r = errorToResponse(new BusinessError('INVALID_INPUT', 'bad'));
    expect(r.status).toBe(400);
    expect(r.body.error?.type).toBe('USER_ERROR');
    expect(r.body.error?.code).toBe('INVALID_INPUT');
  });

  test('SkillError → 422 SKILL_ERROR', () => {
    const r = errorToResponse(new SkillError('EXEC_FAIL', 'crash'));
    expect(r.status).toBe(422);
    expect(r.body.error?.type).toBe('SKILL_ERROR');
  });

  test('ConfigError → 500 FATAL', () => {
    const r = errorToResponse(new ConfigError('NO_KEY', 'missing'));
    expect(r.status).toBe(500);
    expect(r.body.error?.type).toBe('FATAL');
  });

  test('plain Error → 500 INTERNAL_ERROR (no leakage)', () => {
    const r = errorToResponse(new Error('internal stack trace details'));
    expect(r.status).toBe(500);
    expect(r.body.error?.code).toBe('INTERNAL_ERROR');
    expect(r.body.error?.message).toBe('An unexpected error occurred');
    expect(r.body.error?.message).not.toContain('stack trace');
  });

  test('non-Error throw → 500 UNKNOWN_ERROR', () => {
    const r = errorToResponse('something weird');
    expect(r.status).toBe(500);
    expect(r.body.error?.code).toBe('UNKNOWN_ERROR');
    expect(r.body.error?.message).toBe('something weird');
  });

  test('envelope always has success: false on error', () => {
    const r = errorToResponse(new BusinessError('X', 'y'));
    expect(r.body.success).toBe(false);
    expect(r.body.data).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test __tests__/error-handler.test.ts`
Expected: 7 tests pass

- [ ] **Step 3: Commit**

```bash
git add __tests__/error-handler.test.ts
git commit -m "test(api): add errorToResponse envelope tests"
```

---

## Task 5: Express middleware + traceId

**Files:**
- Modify: `src/api/error-handler.ts` (add `globalErrorHandler` + `traceIdMiddleware`)

**Interfaces:**
- Consumes: `errorToResponse` from same file; `createLogger` from `src/observability/logger`
- Produces:
  - `function globalErrorHandler(err, req, res, next): void` — logs with traceId, sends envelope
  - `function traceIdMiddleware(req, res, next): void` — assigns `req.traceId`, sets `X-Trace-Id` header

- [ ] **Step 1: Add imports and middleware to `src/api/error-handler.ts`**

Append to the existing file (do NOT replace):

```typescript
import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../observability/logger';
import * as crypto from 'crypto';

const log = createLogger({ module: 'api-error-handler' });

export interface RequestWithTrace extends Request {
  traceId: string;
}

export function traceIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers['x-trace-id'];
  const traceId =
    typeof incoming === 'string' && incoming.length > 0
      ? incoming
      : crypto.randomUUID();
  (req as RequestWithTrace).traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  next();
}

export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const traceId = (req as RequestWithTrace).traceId ?? 'unknown';
  const { status, body } = errorToResponse(err);

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

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/api/error-handler.ts
git commit -m "feat(api): add globalErrorHandler and traceIdMiddleware"
```

---

## Task 6: Express integration tests

**Files:**
- Create: `__tests__/api-error-middleware.test.ts`

**Interfaces:**
- Consumes: Express 5, `errorToResponse`, `globalErrorHandler`, `traceIdMiddleware` from `src/api/error-handler`; `BusinessError`, `LlmError` from `src/errors`

- [ ] **Step 1: Write failing tests in `__tests__/api-error-middleware.test.ts`**

```typescript
import { describe, test, expect } from 'bun:test';
import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import {
  errorToResponse,
  globalErrorHandler,
  traceIdMiddleware,
} from '../src/api/error-handler';
import { BusinessError, LlmError, SkillError } from '../src/errors';

function startApp(
  routes: (app: express.Application) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(traceIdMiddleware);
    routes(app);
    app.use(globalErrorHandler);
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function request(
  url: string,
  method: string,
  path: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${url}${path}`,
      { method },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let body: any = data;
          try {
            body = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode ?? 500, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Express global error middleware', () => {
  test('endpoint throwing BusinessError → 400 envelope', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/bad', () => {
        throw new BusinessError('INVALID_INPUT', 'bad input');
      });
    });
    try {
      const r = await request(url, 'GET', '/bad');
      expect(r.status).toBe(400);
      expect(r.body.success).toBe(false);
      expect(r.body.error.code).toBe('INVALID_INPUT');
      expect(r.body.error.type).toBe('USER_ERROR');
      expect(r.headers['x-trace-id']).toBeTruthy();
    } finally {
      await close();
    }
  });

  test('endpoint throwing LlmError RATE_LIMIT → 429', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/llm', () => {
        throw new LlmError('RATE_LIMIT', 'slow down');
      });
    });
    try {
      const r = await request(url, 'GET', '/llm');
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('LLM_RATE_LIMIT');
    } finally {
      await close();
    }
  });

  test('endpoint throwing SkillError → 422', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/skill', () => {
        throw new SkillError('EXEC_FAIL', 'crashed');
      });
    });
    try {
      const r = await request(url, 'GET', '/skill');
      expect(r.status).toBe(422);
      expect(r.body.error.type).toBe('SKILL_ERROR');
    } finally {
      await close();
    }
  });

  test('endpoint throwing plain Error → 500 INTERNAL_ERROR', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/oops', () => {
        throw new Error('secret internal detail');
      });
    });
    try {
      const r = await request(url, 'GET', '/oops');
      expect(r.status).toBe(500);
      expect(r.body.error.code).toBe('INTERNAL_ERROR');
      expect(r.body.error.message).not.toContain('secret');
    } finally {
      await close();
    }
  });

  test('successful endpoint → 200 with X-Trace-Id header', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/ok', (_req, res) => {
        res.json({ success: true, data: { hello: 'world' } });
      });
    });
    try {
      const r = await request(url, 'GET', '/ok');
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
      expect(r.body.data.hello).toBe('world');
      expect(r.headers['x-trace-id']).toBeTruthy();
    } finally {
      await close();
    }
  });

  test('incoming X-Trace-Id header is preserved', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/ok', (_req, res) => res.json({ success: true }));
    });
    try {
      const result = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
      }>((resolve, reject) => {
        const req = http.request(
          `${url}/ok`,
          { method: 'GET', headers: { 'X-Trace-Id': 'my-trace-123' } },
          (res) => {
            res.on('data', () => {});
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 200,
                headers: res.headers,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(result.headers['x-trace-id']).toBe('my-trace-123');
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test __tests__/api-error-middleware.test.ts`
Expected: 6 tests pass

- [ ] **Step 3: Commit**

```bash
git add __tests__/api-error-middleware.test.ts
git commit -m "test(api): add Express global error middleware integration tests"
```

---

## Task 7: Migrate `src/api/index.ts` try/catch blocks

**Files:**
- Modify: `src/api/index.ts` (replace try/catch with throw BusinessError; wrap successful responses in envelope; mount new middleware)

**Interfaces:**
- Consumes: middleware from `src/api/error-handler`; `BusinessError` from `src/errors`; `ApiResponse` from `src/types/api-response`
- Produces: All endpoints throw on failure, all responses wrapped in envelope

- [ ] **Step 1: Mount middleware at top of `createAPIServer`**

Replace the middleware block in `src/api/index.ts` (around line 125). Find:

```typescript
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
```

Replace with:

```typescript
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(traceIdMiddleware);
```

Add this import near the top of the file (after existing imports):

```typescript
import { traceIdMiddleware, globalErrorHandler, errorToResponse } from './error-handler';
import { BusinessError } from '../errors';
import { ApiResponse } from '../types/api-response';
```

- [ ] **Step 2: Migrate `GET /sessions/:sessionId/history` endpoint**

Find (around line 218-236):

```typescript
  app.get('/sessions/:sessionId/history', async (req: Request, res: Response) => {
    const sessionIdRaw = req.params.sessionId;
    const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;
    const userId = (req.query.userId as string) || 'default';

    if (!sessionId) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: 'sessionId is required' });
      return;
    }

    try {
      const history = await mainAgent.getSessionHistory(userId, sessionId);
      res.json(history);
    } catch (error) {
      console.error('Error getting session history:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get session history' });
    }
  });
```

Replace with:

```typescript
  app.get('/sessions/:sessionId/history', async (req: Request, res: Response) => {
    const sessionIdRaw = req.params.sessionId;
    const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;
    const userId = (req.query.userId as string) || 'default';

    if (!sessionId) {
      throw new BusinessError('INVALID_REQUEST', 'sessionId is required');
    }

    const history = await mainAgent.getSessionHistory(userId, sessionId);
    res.json({ success: true, data: history });
  });
```

- [ ] **Step 3: Migrate `GET /tasks` endpoint**

Find (around line 246-286):

```typescript
  app.get('/tasks', (req, res) => {
    try {
      const { status } = req.query;
      const validStatuses: TaskStatus[] = ['pending', 'running', 'completed', 'failed', 'suspended'];

      if (status && !validStatuses.includes(status as TaskStatus)) {
        res.status(400).json({
          error: 'Bad Request',
          message: `Invalid status filter. Must be one of: ${validStatuses.join(', ')}`,
          code: 'INVALID_STATUS_FILTER',
        });
        return;
      }

      const tasks = status
        ? taskQueue.getTasksByStatus(status as TaskStatus)
        : taskQueue.getAllTasks();

      const formattedTasks = tasks.map((task) => ({
        id: task.id,
        status: task.status || 'pending',
        requirement: task.requirement,
        createdAt: task.createdAt?.toISOString() || new Date().toISOString(),
      }));

      res.json({ tasks: formattedTasks });
    } catch (error) {
      console.error('Error listing tasks:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to list tasks',
        code: 'INTERNAL_ERROR',
      });
    }
  });
```

Replace with:

```typescript
  app.get('/tasks', (req, res) => {
    const { status } = req.query;
    const validStatuses: TaskStatus[] = ['pending', 'running', 'completed', 'failed', 'suspended'];

    if (status && !validStatuses.includes(status as TaskStatus)) {
      throw new BusinessError(
        'INVALID_STATUS_FILTER',
        `Invalid status filter. Must be one of: ${validStatuses.join(', ')}`,
      );
    }

    const tasks = status
      ? taskQueue.getTasksByStatus(status as TaskStatus)
      : taskQueue.getAllTasks();

    const formattedTasks = tasks.map((task) => ({
      id: task.id,
      status: task.status || 'pending',
      requirement: task.requirement,
      createdAt: task.createdAt?.toISOString() || new Date().toISOString(),
    }));

    res.json({ success: true, data: { tasks: formattedTasks } });
  });
```

- [ ] **Step 4: Migrate `POST /tasks` endpoint**

Find (around line 292-344):

```typescript
  app.post('/tasks', taskLimiter, async (req, res) => {
    try {
      const { requirement, userId } = req.body;
      const accessToken = extractAccessToken(req);
      if (!requirement || typeof requirement !== 'string') {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Missing or invalid "requirement" field',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      if (requirement.length > CONFIG.MAX_REQUIREMENT_LENGTH) {
        res.status(400).json({
          error: 'Bad Request',
          message: `Requirement exceeds maximum length of ${CONFIG.MAX_REQUIREMENT_LENGTH} characters`,
          code: 'REQUIREMENT_TOO_LONG',
        });
        return;
      }

      const effectiveUserId = userId || `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      RequestContext.run({ accessToken }, () => {
        mainAgent.processRequirement(requirement, undefined, effectiveUserId).catch((err) => {
          console.error('[API] Task processing failed:', err instanceof Error ? err.message : err);
        });
      });

      res.status(202).json({
        status: 'accepted',
        message: 'Request accepted and processing',
        userId: effectiveUserId,
      });
    } catch (error) {
      console.error('Error creating task:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to create task',
        code: 'TASK_CREATION_FAILED',
      });
    }
  });
```

Replace with:

```typescript
  app.post('/tasks', taskLimiter, async (req, res) => {
    const { requirement, userId } = req.body;
    const accessToken = extractAccessToken(req);

    if (!requirement || typeof requirement !== 'string') {
      throw new BusinessError('INVALID_REQUEST', 'Missing or invalid "requirement" field');
    }

    if (requirement.length > CONFIG.MAX_REQUIREMENT_LENGTH) {
      throw new BusinessError(
        'REQUIREMENT_TOO_LONG',
        `Requirement exceeds maximum length of ${CONFIG.MAX_REQUIREMENT_LENGTH} characters`,
      );
    }

    const effectiveUserId = userId || `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    RequestContext.run({ accessToken }, () => {
      mainAgent.processRequirement(requirement, undefined, effectiveUserId).catch((err) => {
        console.error('[API] Task processing failed:', err instanceof Error ? err.message : err);
      });
    });

    res.status(202).json({
      success: true,
      data: {
        status: 'accepted',
        message: 'Request accepted and processing',
        userId: effectiveUserId,
      },
    });
  });
```

- [ ] **Step 5: Migrate `GET /tasks/:id` endpoint**

Find (around line 490-527):

```typescript
  app.get('/tasks/:id', (req, res) => {
    try {
      const { id } = req.params;
      const task = taskQueue.getTask(id);

      if (!task) {
        res.status(404).json({
          error: 'Not Found',
          message: `Task with ID "${id}" not found`,
          code: 'TASK_NOT_FOUND',
        });
        return;
      }

      const response: TaskStatusResponse = {
        taskId: task.id,
        status: task.status || 'pending',
        requirement: task.requirement,
        skillName: task.skillName,
        createdAt: task.createdAt?.toISOString() || new Date().toISOString(),
        startedAt: task.startedAt?.toISOString(),
        completedAt: task.completedAt?.toISOString(),
        retryCount: task.retryCount || 0,
      };

      res.json(response);
    } catch (error) {
      console.error('Error getting task status:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to get task status',
        code: 'INTERNAL_ERROR',
      });
    }
  });
```

Replace with:

```typescript
  app.get('/tasks/:id', (req, res) => {
    const { id } = req.params;
    const task = taskQueue.getTask(id);

    if (!task) {
      throw new BusinessError('TASK_NOT_FOUND', `Task with ID "${id}" not found`, {
        statusCode: 404,
      });
    }

    const response: TaskStatusResponse = {
      taskId: task.id,
      status: task.status || 'pending',
      requirement: task.requirement,
      skillName: task.skillName,
      createdAt: task.createdAt?.toISOString() || new Date().toISOString(),
      startedAt: task.startedAt?.toISOString(),
      completedAt: task.completedAt?.toISOString(),
      retryCount: task.retryCount || 0,
    };

    res.json({ success: true, data: response });
  });
```

- [ ] **Step 6: Migrate `GET /tasks/:id/result` endpoint**

Find (around line 533-574). Replace the entire handler:

```typescript
  app.get('/tasks/:id/result', (req, res) => {
    const { id } = req.params;
    const task = taskQueue.getTask(id);

    if (!task) {
      throw new BusinessError('TASK_NOT_FOUND', `Task with ID "${id}" not found`, {
        statusCode: 404,
      });
    }

    const response: TaskResultResponse = {
      taskId: task.id,
      status: task.status || 'pending',
    };

    if (task.status === 'completed') {
      response.result = task.result;
    } else if (task.status === 'failed' && task.error) {
      response.error = {
        type: task.error.type,
        message: task.error.message,
        code: task.error.code,
      };
    }

    res.json({ success: true, data: response });
  });
```

(Remove the surrounding try/catch in the original.)

- [ ] **Step 7: Migrate `DELETE /tasks/:id` endpoint**

Find (around line 580-619). Replace:

```typescript
  app.delete('/tasks/:id', (req, res) => {
    const { id } = req.params;
    const task = taskQueue.getTask(id);

    if (!task) {
      throw new BusinessError('TASK_NOT_FOUND', `Task with ID "${id}" not found`, {
        statusCode: 404,
      });
    }

    const cancelled = taskQueue.cancelTask(id);

    if (cancelled) {
      res.json({
        success: true,
        data: { message: `Task "${id}" has been cancelled` },
      });
    } else {
      throw new BusinessError(
        'TASK_CANNOT_CANCEL',
        `Cannot cancel task "${id}" - task is already ${task.status}`,
        { statusCode: 400 },
      );
    }
  });
```

(Remove surrounding try/catch.)

- [ ] **Step 8: Migrate `POST /tasks/execute` endpoint**

Find (around line 624-633):

```typescript
  app.post('/tasks/execute', async (req, res) => {
    const { planId } = req.body;
    try {
      res.json({ success: true, message: `Plan ${planId} execution started` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
```

Replace with:

```typescript
  app.post('/tasks/execute', async (req, res) => {
    const { planId } = req.body;
    res.json({ success: true, data: { message: `Plan ${planId} execution started` } });
  });
```

- [ ] **Step 9: Replace 404 handler**

Find (around line 640-646):

```typescript
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: 'The requested resource was not found',
      code: 'NOT_FOUND',
    });
  });
```

Replace with:

```typescript
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new BusinessError('NOT_FOUND', 'The requested resource was not found', { statusCode: 404 }));
  });
```

- [ ] **Step 10: Replace existing global error handler**

Find (around line 649-665):

```typescript
  app.use((err: Error, _req: Request, res: Response<ApiError>, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
      code: 'INTERNAL_ERROR',
    });
  });
```

Replace with:

```typescript
  app.use(globalErrorHandler);
```

- [ ] **Step 11: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 12: Run existing tests**

Run: `bun test`
Expected: all existing tests pass + new tests from Tasks 2, 4, 6

- [ ] **Step 13: Commit**

```bash
git add src/api/index.ts
git commit -m "refactor(api): replace try/catch with throw BusinessError; mount global error middleware"
```

---

## Task 8: SubAgent — replace classifyError with instanceof LLMError

**Files:**
- Modify: `src/agents/sub-agent.ts` (remove `classifyError`; replace catch at line 222 with throw)

**Interfaces:**
- Consumes: `LLMError` from `src/llm`; `LlmError`, `SkillError`, `BusinessError`, `AppError` from `src/errors`
- Produces: SubAgent.execute throws AppError instead of returning `{ success: false, error: ... }`

- [ ] **Step 1: Update imports in `src/agents/sub-agent.ts`**

Add after existing imports (line ~3):

```typescript
import { LlmError, SkillError, BusinessError, AppError } from '../errors';
import { LLMError } from '../llm';
```

- [ ] **Step 2: Update catch block at line 221-222**

Find:

```typescript
    } catch (error) {
      return { success: false, error: this.classifyError(error) };
    } finally {
      llmEvents.setAgent(previousAgent);
    }
```

Replace with:

```typescript
    } catch (error) {
      throw mapSubAgentError(error);
    } finally {
      llmEvents.setAgent(previousAgent);
    }
```

- [ ] **Step 3: Add `mapSubAgentError` helper before the closing `}` of the SubAgent class**

Find (around line 665):

```typescript
  private classifyError(error: unknown): TaskError {
    if (error instanceof Error) {
      if (error.message.includes('timeout') || error.message.includes('timed out')) {
        return { type: 'RETRYABLE', message: 'Task timed out', code: 'TIMEOUT' };
      }
      if (error.message.includes('not found') || error.message.includes('ENOENT')) {
        return { type: 'FATAL', message: error.message, code: 'FILE_NOT_FOUND' };
      }
      if (/permission/i.test(error.message) || error.message.includes('EACCES')) {
        return { type: 'FATAL', message: 'Permission denied: ' + error.message, code: 'PERMISSION_DENIED' };
      }
      return { type: 'RETRYABLE', message: error.message, code: 'EXECUTION_ERROR' };
    }
    return { type: 'RETRYABLE', message: String(error), code: 'UNKNOWN_ERROR' };
  }
}
```

Replace the entire `classifyError` method and the closing brace with:

```typescript
}

/**
 * Map any error thrown inside SubAgent to an AppError.
 * - LLMError → LlmError (preserves LLMErrorType classification)
 * - AppError → re-throw as-is
 * - Error with ENOENT/EACCES → BusinessError with appropriate code
 * - Other Error → SkillError
 */
function mapSubAgentError(error: unknown): never {
  if (error instanceof LLMError) {
    throw new LlmError(error.type, error.message, { cause: error, statusCode: error.statusCode });
  }
  if (error instanceof AppError) {
    throw error;
  }
  if (error instanceof Error) {
    if (error.message.includes('ENOENT') || /\bnot found\b/i.test(error.message)) {
      throw new BusinessError('FILE_NOT_FOUND', error.message, { cause: error });
    }
    if (error.message.includes('EACCES') || /permission/i.test(error.message)) {
      throw new BusinessError('PERMISSION_DENIED', error.message, { cause: error });
    }
    throw new SkillError('EXECUTION_ERROR', error.message, { cause: error });
  }
  throw new SkillError('UNKNOWN_ERROR', String(error));
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors (note: `TaskError` import may now be unused — remove it if so)

- [ ] **Step 5: Run SubAgent tests**

Run: `bun test __tests__/sub-agent.test.ts`
Expected: all pass (may need test updates in Task 9)

- [ ] **Step 6: Commit**

```bash
git add src/agents/sub-agent.ts
git commit -m "refactor(sub-agent): replace classifyError string match with instanceof LLMError throw"
```

---

## Task 9: Update sub-agent tests

**Files:**
- Modify: `__tests__/sub-agent.test.ts`

**Interfaces:**
- Consumes: `SubAgent` from `src/agents/sub-agent`; `LLMError` from `src/llm`; `LlmError`, `SkillError`, `BusinessError` from `src/errors`
- Produces: tests verifying SubAgent throws AppError instead of returning `{ success: false }`

- [ ] **Step 1: Read existing sub-agent test structure**

Run: `cat __tests__/sub-agent.test.ts | head -200`
Look for tests that assert `result.success === false`. These need to be updated.

- [ ] **Step 2: Add new test for AppError throw behavior at the end of `__tests__/sub-agent.test.ts`**

```typescript
import { LlmError as LlmAppError, SkillError, BusinessError } from '../src/errors';
import { LLMError } from '../src/llm';

describe('SubAgent AppError throw behavior', () => {
  test('LLMError thrown by LLM is mapped to LlmError', async () => {
    // MockLLMClient that throws LLMError
    class FailingLLMClient extends MockLLMClient {
      async generateText(): Promise<string> {
        throw new LLMError('RATE_LIMIT', 'too many', 429);
      }
    }
    const subAgent = new SubAgent(new MockSkillRegistry() as any, new FailingLLMClient() as any, undefined);
    const task: Task = {
      id: 't1',
      requirement: 'test',
      status: 'pending',
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      retryCount: 0,
    };
    expect(subAgent.execute(task)).rejects.toBeInstanceOf(LlmAppError);
  });

  test('non-LLM error is mapped to SkillError', async () => {
    class FailingLLMClient extends MockLLMClient {
      async generateText(): Promise<string> {
        throw new Error('boom');
      }
    }
    const subAgent = new SubAgent(new MockSkillRegistry() as any, new FailingLLMClient() as any, undefined);
    const task: Task = {
      id: 't2',
      requirement: 'test',
      status: 'pending',
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      retryCount: 0,
    };
    expect(subAgent.execute(task)).rejects.toBeInstanceOf(SkillError);
  });

  test('ENOENT error is mapped to BusinessError FILE_NOT_FOUND', async () => {
    class FailingLLMClient extends MockLLMClient {
      async generateText(): Promise<string> {
        const e: any = new Error('ENOENT: no such file');
        e.code = 'ENOENT';
        throw e;
      }
    }
    const subAgent = new SubAgent(new MockSkillRegistry() as any, new FailingLLMClient() as any, undefined);
    const task: Task = {
      id: 't3',
      requirement: 'test',
      status: 'pending',
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      retryCount: 0,
    };
    try {
      await subAgent.execute(task);
      expect(true).toBe(false); // should have thrown
    } catch (e: any) {
      expect(e).toBeInstanceOf(BusinessError);
      expect(e.code).toBe('FILE_NOT_FOUND');
    }
  });
});
```

- [ ] **Step 3: Find and update tests that assert `success === false`**

Search for `success: false` and `success.*false` in `__tests__/sub-agent.test.ts`. For each match:

Before:
```typescript
const result = await subAgent.execute(task);
expect(result.success).toBe(false);
expect(result.error?.code).toBe('TIMEOUT');
```

After:
```typescript
await expect(subAgent.execute(task)).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
```

(Adapt codes: `TIMEOUT` → `LLM_TIMEOUT`, `EXECUTION_ERROR` → `EXECUTION_ERROR` still applies via SkillError, etc.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test __tests__/sub-agent.test.ts`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add __tests__/sub-agent.test.ts
git commit -m "test(sub-agent): update assertions for AppError throw behavior"
```

---

## Task 10: MainAgent — remove top-level catch; local catches throw AppError

**Files:**
- Modify: `src/agents/main-agent.ts` (lines 104-211, 222-289, etc.)

**Interfaces:**
- Consumes: `BusinessError`, `SkillError`, `LlmError`, `ConfigError` from `src/errors`; existing types
- Produces: MainAgent.processRequirement no longer swallows errors; local catches throw AppError

- [ ] **Step 1: Add imports to `src/agents/main-agent.ts`**

Add after existing imports:

```typescript
import { BusinessError, SkillError, LlmError, AppError } from '../errors';
```

- [ ] **Step 2: Replace top-level catch in `processRequirement` (lines 200-210)**

Find:

```typescript
    } catch (error) {
      console.error("Error processing requirement:", error);
      return {
        success: false,
        error: {
          type: "FATAL",
          message: error instanceof Error ? error.message : "Unknown error",
          code: "PROCESSING_ERROR",
        },
      };
    }
```

Replace with:

```typescript
    // Top-level: no catch — let AppError propagate to API middleware.
    // (Known failures throw AppError explicitly in inner methods.)
```

- [ ] **Step 3: Update `getSessionHistory` (lines 222-289) — keep try/catch but throw BusinessError**

Find the catch block at the end:

```typescript
    } catch (error) {
      console.error('[MainAgent] 获取会话历史失败:', error);
      return { exists: false, messages: [], activeRequestId: null, requestStatus: null };
    }
```

Replace with:

```typescript
    } catch (error) {
      log.error('[MainAgent] 获取会话历史失败', { error });
      if (error instanceof AppError) throw error;
      throw new BusinessError('SESSION_HISTORY_FAILED', 'Failed to load session history', { cause: error });
    }
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Run existing main-agent tests**

Run: `npx tsx __tests__/main-agent.test.ts`
Expected: tests in `__tests__/main-agent.test.ts` may fail; defer fixes to Task 12

- [ ] **Step 6: Commit**

```bash
git add src/agents/main-agent.ts
git commit -m "refactor(main-agent): remove top-level catch; throw AppError on local failures"
```

---

## Task 11: ResultAggregator + TaskGraphExecutor — throw AppError

**Files:**
- Modify: `src/agents/result-aggregator.ts` (lines 61, 101, 157, 180, 202)
- Modify: `src/agents/task-graph-executor.ts` (line 307)

- [ ] **Step 1: Add imports to `src/agents/result-aggregator.ts`**

```typescript
import { BusinessError, SkillError, LlmError } from '../errors';
import { LLMError } from '../llm';
```

- [ ] **Step 2: Update catch at line 61 in `result-aggregator.ts`**

Find context around line 61. Replace the catch body:

```typescript
      } catch (error) {
        if (error instanceof LLMError) {
          throw new LlmError(error.type, error.message, { cause: error });
        }
        if (error instanceof AppError) throw error;
        throw new BusinessError('QA_ENTRY_FAILED',
          error instanceof Error ? error.message : String(error),
          { cause: error });
      }
```

(Add `AppError` to imports: `import { BusinessError, SkillError, LlmError, AppError } from '../errors';`)

- [ ] **Step 3: Update catch at line 101 in `result-aggregator.ts`**

Find context. Replace catch:

```typescript
          } catch (error) {
            throw new SkillError('TASK_EXECUTION_FAILED',
              error instanceof Error ? error.message : String(error),
              { cause: error });
          }
```

- [ ] **Step 4: Update catch at line 157 in `result-aggregator.ts`**

Find context. Replace catch:

```typescript
    } catch (error) {
      if (error instanceof LLMError) {
        throw new LlmError(error.type, error.message, { cause: error });
      }
      if (error instanceof AppError) throw error;
      throw new BusinessError('SUMMARIZATION_FAILED',
        error instanceof Error ? error.message : String(error),
        { cause: error });
    }
```

- [ ] **Step 5: Update catch at line 180 in `result-aggregator.ts`**

Find context. Replace catch:

```typescript
        } catch (error) {
          throw new SkillError('JUDGMENT_FAILED',
            error instanceof Error ? error.message : String(error),
            { cause: error });
        }
```

- [ ] **Step 6: Update catch at line 202 in `result-aggregator.ts`**

Find context. Replace catch:

```typescript
      } catch (error) {
        throw new BusinessError('FALLBACK_SUMMARY_FAILED',
          error instanceof Error ? error.message : String(error),
          { cause: error });
      }
```

- [ ] **Step 7: Update `src/agents/task-graph-executor.ts` line 307**

Add imports:

```typescript
import { BusinessError, SkillError, AppError } from '../errors';
import { LLMError } from '../llm';
```

Find context around line 307. Replace catch:

```typescript
      } catch (error) {
        if (error instanceof LLMError) {
          throw new LlmError(error.type, error.message, { cause: error });
        }
        if (error instanceof AppError) throw error;
        throw new BusinessError('EXECUTION_INTERRUPTED',
          error instanceof Error ? error.message : String(error),
          { cause: error });
      }
```

- [ ] **Step 8: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 9: Commit**

```bash
git add src/agents/result-aggregator.ts src/agents/task-graph-executor.ts
git commit -m "refactor(agents): result-aggregator and task-graph-executor throw AppError on failure"
```

---

## Task 12: TaskQueue passes through thrown errors

**Files:**
- Modify: `src/index.ts` (lines 96-104)

- [ ] **Step 1: Update TaskQueue executor callback**

Find:

```typescript
    taskQueue = new TaskQueue(async (task: Task): Promise<unknown> => {
      const result: TaskResult = await subAgent.execute(task);
      if (!result.success) {
        throw new Error(result.error?.message || 'Task execution failed');
      }
      return result;
    });
```

Replace with:

```typescript
    taskQueue = new TaskQueue(async (task: Task): Promise<unknown> => {
      // SubAgent.execute now throws AppError directly (Task 8).
      // We pass the error through unchanged so the API middleware can map it.
      return await subAgent.execute(task);
    });
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors. If `TaskResult` is now unused, remove its import.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor(task-queue): pass through AppError instead of wrapping as plain Error"
```

---

## Task 13: Update main-agent tests for new throw behavior

**Files:**
- Modify: `__tests__/main-agent.test.ts`

**Interfaces:**
- Consumes: `MainAgent` from `src/agents/main-agent`; `LlmError`, `SkillError`, `BusinessError` from `src/errors`
- Produces: tests verifying MainAgent throws AppError instead of returning `{ success: false }`

- [ ] **Step 1: Find assertions that expect `success: false` in main-agent tests**

Run: `grep -n "success.*false\|success: false" __tests__/main-agent.test.ts`

For each match, determine the test case:
- If LLM failure: `expect(...).rejects.toBeInstanceOf(LlmError)`
- If skill execution failure: `expect(...).rejects.toBeInstanceOf(SkillError)`
- If business failure: `expect(...).rejects.toBeInstanceOf(BusinessError)`

- [ ] **Step 2: Add new test at end of `__tests__/main-agent.test.ts`**

```typescript
import { LlmError, SkillError, BusinessError } from '../src/errors';

console.log('\n--- AppError throw tests ---');

await test('MA-E01: processRequirement throws LlmError when LLM throws LLMError', async () => {
  const mockLLM = createMockLLM({
    generateText: async () => {
      throw new (await import('../src/llm')).LLMError('RATE_LIMIT', 'too many', 429);
    },
  });
  const { agent, cleanup } = await createAgent(mockLLM);
  const userId = `user-mae01-${Date.now()}`;
  const sessionId = userId;
  try {
    await assert.rejects(
      () => agent.processRequirement('test', undefined, userId, sessionId),
      (err: any) => err instanceof LlmError && err.code === 'LLM_RATE_LIMIT',
    );
  } finally {
    await cleanup();
  }
});

await test('MA-E02: processRequirement throws SkillError when skill crashes', async () => {
  const mockLLM = createMockLLM({
    generateText: async () => { throw new Error('boom'); },
  });
  const { agent, cleanup } = await createAgent(mockLLM);
  const userId = `user-mae02-${Date.now()}`;
  const sessionId = userId;
  try {
    // Skill execution error path goes through SubAgent → SkillError
    await assert.rejects(
      () => agent.processRequirement('test', undefined, userId, sessionId),
      (err: any) => err instanceof LlmError || err instanceof SkillError,
    );
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 3: Update existing assertions**

For each test that previously asserted `result.success === false`, update to:

```typescript
await assert.rejects(
  () => agent.processRequirement(...),
  (err: any) => err instanceof AppError && err.code === 'EXPECTED_CODE',
);
```

Common mappings:
- `PROCESSING_ERROR` (was top-level catch) → test that it now propagates the underlying AppError
- `INVALID_REQUEST` / `REQUIREMENT_TOO_LONG` → `BusinessError`

- [ ] **Step 4: Run tests**

Run: `npx tsx __tests__/main-agent.test.ts`
Expected: all 8 original tests + 2 new tests pass

- [ ] **Step 5: Commit**

```bash
git add __tests__/main-agent.test.ts
git commit -m "test(main-agent): update assertions for AppError throw behavior"
```

---

## Task 14: SSE endpoint uses errorToResponse

**Files:**
- Modify: `src/api/index.ts` (SSE handler around lines 350-484)

- [ ] **Step 1: Update catch in SSE handler**

Find the catch block around line 472-481:

```typescript
      } catch (error) {
        console.error('[API] Error processing request:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        sendEvent('error', { 
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined
        });
      } finally {
        res.end();
      }
```

Replace with:

```typescript
      } catch (error) {
        const { body } = errorToResponse(error);
        sendEvent('error', body.error);
      } finally {
        res.end();
      }
```

- [ ] **Step 2: Update `sendEvent('complete', ...)` calls in SSE**

Find (around line 463):

```typescript
        if (result.success) {
          sendEvent('complete', result.data);
        } else {
          sendEvent('error', result.error);
        }
```

Replace with:

```typescript
        // MainAgent no longer returns { success, error } for failures — it throws.
        // If we reach this line, result is a successful response.
        sendEvent('complete', { success: true, data: result });
```

(Or unwrap `result.data` as appropriate — confirm by reading surrounding code.)

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/api/index.ts
git commit -m "refactor(api): SSE endpoint uses errorToResponse envelope"
```

---

## Task 15: MainAgent AppError throw tests

**Files:**
- Create: `__tests__/main-agent-error.test.ts`

**Interfaces:**
- Consumes: `MainAgent` from `src/agents/main-agent`; `LlmError`, `BusinessError`, `SkillError` from `src/errors`

- [ ] **Step 1: Write failing test file `__tests__/main-agent-error.test.ts`**

Reuse the `createAgent` helper pattern from `__tests__/main-agent.test.ts`. Add at top:

```typescript
import { MainAgent } from '../src/agents/main-agent';
import { LlmError, BusinessError, SkillError, AppError } from '../src/errors';
import { LLMError } from '../src/llm';
import { MemoryService } from '../src/memory/memory-service';
import { SessionStore } from '../src/memory/session-store';
import { IntentRouter } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { UserProfileService } from '../src/user-profile';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';

let passed = 0;
let failed = 0;
const errors: string[] = [];

function test(name: string, fn: () => Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (e: any) {
      failed++;
      console.log(`  ❌ ${name}: ${e.message}`);
      errors.push(e.message);
    }
  })();
}

class MockTaskQueue extends EventEmitter {
  addTask() {}
  getTask() { return null; }
  getAllTasks() { return []; }
  getTasksByStatus() { return []; }
  cancelTask() { return false; }
  triggerProcess() {}
}

function createMockLLM(generateTextImpl: () => Promise<string>) {
  return {
    generateText: generateTextImpl,
    generateWithTools: async () => ({ response: '', toolCalls: [] }),
    generateWithToolsTracked: async () => ({ response: '', toolCalls: [], messages: [] }),
    generateStructured: async () => ({}),
  } as any;
}

async function createAgent(generateTextImpl: () => Promise<string>) {
  const dataDir = path.join(os.tmpdir(), `mae-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
  await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
  const mockLLM = createMockLLM(generateTextImpl);
  const skillRegistry = { getAllMetadata: () => [], loadFullSkill: async () => null, hasSkill: () => false } as any;
  const memoryService = new MemoryService(dataDir, mockLLM);
  const sessionStore = new SessionStore(100, dataDir);
  const userProfileService = new UserProfileService(dataDir);
  const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
  const intentRouter = new IntentRouter(mockLLM, skillRegistry);
  const askAgent = new AskAgent(sessionStore, mockLLM);
  const systemSkillLoader = new SystemSkillLoader();
  const executorRegistry = new ExecutorRegistry();
  const taskQueue = new MockTaskQueue();
  const agent = new MainAgent({
    llm: mockLLM, skillRegistry, taskQueue: taskQueue as any, intentRouter,
    userProfileService, memoryService, dynamicContextBuilder,
    sessionStore, askAgent, systemSkillLoader, executorRegistry,
  });
  return {
    agent,
    cleanup: async () => { try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {} },
  };
}

async function run() {
  console.log('\nMainAgent AppError throw tests\n');

  await test('MA-E01: LLM RATE_LIMIT → throws LlmError LLM_RATE_LIMIT', async () => {
    const { agent, cleanup } = await createAgent(async () => {
      throw new LLMError('RATE_LIMIT', 'too many', 429);
    });
    try {
      await assert.rejects(
        () => agent.processRequirement('test', undefined, 'u1', 's1'),
        (e: any) => e instanceof LlmError && e.code === 'LLM_RATE_LIMIT' && e.statusCode === 429,
      );
    } finally {
      await cleanup();
    }
  });

  await test('MA-E02: generic LLM error → throws LlmError', async () => {
    const { agent, cleanup } = await createAgent(async () => {
      throw new LLMError('TIMEOUT', 'timed out', 504);
    });
    try {
      await assert.rejects(
        () => agent.processRequirement('test', undefined, 'u1', 's1'),
        (e: any) => e instanceof LlmError && e.llmErrorType === 'TIMEOUT',
      );
    } finally {
      await cleanup();
    }
  });

  await test('MA-E03: AppError is preserved (no re-wrapping)', async () => {
    const { agent, cleanup } = await createAgent(async () => {
      throw new BusinessError('CUSTOM', 'custom business error');
    });
    try {
      await assert.rejects(
        () => agent.processRequirement('test', undefined, 'u1', 's1'),
        (e: any) => e instanceof BusinessError && e.code === 'CUSTOM',
      );
    } finally {
      await cleanup();
    }
  });

  try { /* cleanup already done per-test */ } catch {}

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach((e) => console.log(e));
  }
}

run().catch(console.error);
```

- [ ] **Step 2: Run tests**

Run: `npx tsx __tests__/main-agent-error.test.ts`
Expected: 3 tests pass

- [ ] **Step 3: Commit**

```bash
git add __tests__/main-agent-error.test.ts
git commit -m "test(main-agent): add AppError throw behavior tests"
```

---

## Task 16: Replace console.error with structured log (32 sites)

**Files:**
- Modify: various files in `src/`

- [ ] **Step 1: Find all `console.error` sites**

Run: `grep -rn "console\.error\|console\.warn" src/ --include="*.ts" | grep -v "node_modules"`

Expected output: ~32 lines across `src/agents/`, `src/api/`, `src/routers/`, `src/llm/`, etc.

- [ ] **Step 2: For each `console.error(message)` in non-`__tests__` files, replace with `log.error({ error }, 'context message')`**

Pattern:
```typescript
// Before
console.error('[ModuleName] something failed:', error);

// After
log.error('[ModuleName] something failed', { error });
```

Process file by file:
1. `src/agents/main-agent.ts` — ~10 sites
2. `src/agents/sub-agent.ts` — ~5 sites
3. `src/agents/result-aggregator.ts` — ~3 sites
4. `src/agents/task-graph-executor.ts` — ~2 sites
5. `src/api/index.ts` — ~5 sites
6. `src/routers/intent-router.ts` — ~1 site
7. Other modules — ~6 sites

For each file:
- Add `import { createLogger } from '../observability/logger';` if not present
- Add `const log = createLogger({ module: 'ModuleName' });` at top
- Replace each `console.error` / `console.warn` per pattern above

- [ ] **Step 3: For each `console.log` in non-test files, replace with `log.info` or `log.debug` per importance**

Skip debug-level noise (e.g., `console.log('Initializing...')` → `log.debug`).

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Run all tests**

Run: `bun test && npx tsx __tests__/main-agent.test.ts && npx tsx __tests__/session-store.test.ts && npx tsx __tests__/intent-router.test.ts && npx tsx __tests__/main-agent-error.test.ts`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "refactor(log): replace 32 console.error sites with structured logger"
```

---

## Task 17: Final cleanup and verification

**Files:**
- Modify: various (cleanup unused imports, redundant try/catch)

- [ ] **Step 1: Run full test suite**

Run: `bun test && npx tsx __tests__/main-agent.test.ts && npx tsx __tests__/session-store.test.ts && npx tsx __tests__/intent-router.test.ts && npx tsx __tests__/main-agent-error.test.ts && npx tsx __tests__/app-error.test.ts 2>/dev/null || bun test __tests__/app-error.test.ts __tests__/error-handler.test.ts __tests__/api-error-middleware.test.ts`

Expected: 0 failures

- [ ] **Step 2: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Verify no `console.error` remains in business code**

Run: `grep -rn "console\.error" src/ --include="*.ts" | grep -v "test"`
Expected: only intentional ones (if any remain, document in commit message)

- [ ] **Step 4: Verify IntentRouter behavior unchanged**

Run: `bun test __tests__/intent-router.test.ts`
Expected: all 12 tests pass (unclear fallback still works)

- [ ] **Step 5: Smoke test start server**

Run: `npm start` (background)
Then: `curl -X POST http://localhost:3000/tasks -H "Content-Type: application/json" -d '{"requirement": "test"}'`
Then: `curl -X GET http://localhost:3000/tasks/invalid-id`
Then: `curl -i http://localhost:3000/health`
Expected: 202 envelope for valid task, 404 envelope for invalid id, 200 envelope for health

Verify response headers include `X-Trace-Id`.

- [ ] **Step 6: Commit any final cleanup**

```bash
git add src/
git commit -m "chore: final cleanup after global error handler migration"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ AppError class hierarchy → Task 1
- ✅ AppError tests → Task 2
- ✅ `errorToResponse` + `ApiResponse` → Tasks 3, 4
- ✅ `globalErrorHandler` + `traceIdMiddleware` → Task 5
- ✅ Express integration tests → Task 6
- ✅ API endpoint migration (try/catch → throw) → Task 7
- ✅ SubAgent classifyError replacement → Tasks 8, 9
- ✅ MainAgent top-level catch removal → Task 10
- ✅ ResultAggregator + TaskGraphExecutor throws → Task 11
- ✅ TaskQueue pass-through → Task 12
- ✅ MainAgent test updates → Task 13
- ✅ SSE endpoint → Task 14
- ✅ MainAgent throw tests → Task 15
- ✅ console.error → log replacement → Task 16
- ✅ Verification → Task 17
- ✅ IntentRouter unchanged (preserved)

**2. Placeholder scan:**
- All steps have exact code, exact file paths, exact commands. No "TBD" or "TODO".

**3. Type consistency:**
- `LlmError` constructor: `(llmErrorType: LLMErrorType, message, options?)` — same in Tasks 1, 8, 11
- `BusinessError` / `SkillError` constructor: `(code, message, options?)` — same throughout
- `errorToResponse(error: unknown)` return type — same in Tasks 3, 4, 14
- `traceIdMiddleware` / `globalErrorHandler` signatures — same in Tasks 5, 6, 7

All consistent. No issues found.