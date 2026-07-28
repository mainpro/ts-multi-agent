# End-to-End Error Propagation Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write an integration test file `__tests__/error-propagation-e2e.test.ts` that verifies the full error propagation path: `LLMError` thrown in `SubAgent.execute` → `mapSubAgentError` → `TaskQueue` → `TaskGraphExecutor` → `MainAgent.processNormalRequirement` → `globalErrorHandler` → SSE `event: error` + `X-Trace-Id` header.

**Architecture:** Spin up a real Express server on a random port for each test, construct a full DI dependency chain (MemoryService, SessionStore, IntentRouter, SubAgent, TaskGraphExecutor, MainAgent) with a temp dataDir. Mock `LLMClient` to throw `LLMError` based on a sentinel string in the prompt. Mock `SkillRegistry` to return a trivial skill. Send real `POST /tasks/stream` HTTP requests, parse SSE event stream.

**Tech Stack:** TypeScript (strict), bun:test, Node `http` module, Express 5, existing `createAPIServer` from `src/api/index.ts`.

## Global Constraints

- TypeScript strict mode (all flags per `tsconfig.json`)
- `noUnusedLocals` / `noUnusedParameters` enforced
- Test runner: `bun test` (per package.json)
- No production code changes — only add `__tests__/error-propagation-e2e.test.ts`
- HTTP status always 200 for SSE (per SSE protocol); error info flows through `event: error`
- Each test uses fresh `dataDir` (under `os.tmpdir()`) and `try/finally close` pattern
- Test time budget: < 5s total for all 4 tests
- Sentinel-string dispatch: `LLMClient.generateWithTools` parses messages and checks for `'task-{id}:'` prefix to identify which task triggered the call; throws `LLMError` if `id` is in `failingTaskIds`
- Express server listens on port 0 (random) — no port collisions

---

## File Structure

### New files

| File | Responsibility |
|------|----------------|
| `__tests__/error-propagation-e2e.test.ts` | 4 end-to-end test scenarios + factory function + SSE parser |

### Modified files

None. This plan is purely additive.

---

## Task 1: Build stacked agent factory (single-task scenario)

**Files:**
- Create: `__tests__/error-propagation-e2e.test.ts`

**Interfaces:**
- Consumes:
  - `LLMClient`, `LLMError`, `LLMErrorType` from `src/llm/index.ts`
  - `IntentResult` from `src/routers/intent-router.ts`
  - `MainAgent`, `MainAgentDependencies` from `src/agents/main-agent.ts`
  - `MemoryService` from `src/memory/memory-service.ts`
  - `SessionStore` from `src/memory/session-store.ts`
  - `IntentRouter` from `src/routers/intent-router.ts`
  - `AskAgent` from `src/agents/ask-agent.ts`
  - `DynamicContextBuilder` from `src/context/dynamic-context.ts`
  - `UserProfileService` from `src/user-profile/index.ts`
  - `SystemSkillLoader`, `ExecutorRegistry` from `src/system-skills/index.ts`
  - `SkillRegistry` from `src/skill-registry/index.ts`
  - `createAPIServer` from `src/api/index.ts`
  - `EventEmitter` from Node `events`
- Produces:
  - `buildStackedAgent(opts)` factory function
  - `postStreamExpectEvents(url, body)` SSE parser
  - 4 test scenarios

- [ ] **Step 1: Create test file with imports, factory skeleton, and stub for the first test**

Write `__tests__/error-propagation-e2e.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { EventEmitter } from 'events';

import { LLMClient, LLMError, LLMErrorType, llmEvents } from '../src/llm';
import { ILLMClient } from '../src/llm/interfaces';
import { SkillRegistry } from '../src/skill-registry';
import { MemoryService } from '../src/memory/memory-service';
import { SessionStore } from '../src/memory/session-store';
import { IntentRouter, IntentResult } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { UserProfileService } from '../src/user-profile';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';
import { TaskQueue } from '../src/task-queue';
import { MainAgent } from '../src/agents/main-agent';

interface StackedAgentOpts {
  /** Which taskIds should trigger LLM failure. Empty = all succeed. */
  failingTaskIds?: Set<string>;
  /** LLMErrorType to throw. Default 'RATE_LIMIT'. */
  llmErrorType?: LLMErrorType;
  /** IntentResult returned by IntentRouter mock. */
  intentResult?: IntentResult;
}

interface StackedAgent {
  mainAgent: MainAgent;
  url: string;
  close: () => Promise<void>;
  dataDir: string;
}

/**
 * Build a full MainAgent + Express server stack for end-to-end testing.
 * Each call returns a fresh stack with its own temp dataDir.
 */
async function buildStackedAgent(opts: StackedAgentOpts): Promise<StackedAgent> {
  const dataDir = path.join(
    os.tmpdir(),
    `ma-e2e-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
  );
  await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });

  const failingTaskIds = opts.failingTaskIds ?? new Set<string>();
  const llmErrorType: LLMErrorType = opts.llmErrorType ?? 'RATE_LIMIT';
  const defaultIntentResult: IntentResult = {
    intent: 'skill_task',
    confidence: 0.9,
    tasks: [
      { taskId: 't1', requirement: 'task-t1: 帮我查一下', skillName: 'echo', intent: 'skill_task' },
    ],
  };
  const intentResult = opts.intentResult ?? defaultIntentResult;

  // Mock LLMClient
  const mockLLM: ILLMClient = {
    generateStructured: async () => intentResult,
    generateText: async () => '',
    generateWithTools: async (messages: any) => {
      // Sentinel-string dispatch: check which task's prompt this is for.
      const promptText = JSON.stringify(messages);
      for (const failingId of failingTaskIds) {
        if (promptText.includes(`task-${failingId}:`)) {
          throw new LLMError(llmErrorType, `mock failure for ${failingId}`, 429);
        }
      }
      return { content: 'echo', toolCalls: [] };
    },
    generateWithToolsTracked: async () => ({ content: '', toolCalls: [], messages: [] }),
  } as any;

  // Mock SkillRegistry
  const mockSkillRegistry = {
    getAllMetadata: () => [
      { name: 'echo', description: 'echo skill', metadata: {}, allowedTools: [] } as any,
    ],
    loadFullSkill: async () => ({
      name: 'echo',
      description: 'echo',
      body: 'echo',
      metadata: {},
      allowedTools: [],
    }),
    hasSkill: () => true,
    scanSkills: async () => ['echo'],
    startWatch: () => {},
    stopWatch: () => {},
    getSkillCount: () => 1,
    getSkillNames: () => ['echo'],
    getSkillMetadata: () => ({ name: 'echo', description: 'echo' }) as any,
  } as any;

  // Construct full DI chain
  const memoryService = new MemoryService(dataDir, mockLLM);
  const sessionStore = new SessionStore(100, dataDir);
  const userProfileService = new UserProfileService(dataDir);
  const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
  const intentRouter = new IntentRouter(mockLLM, mockSkillRegistry);
  const askAgent = new AskAgent(sessionStore, mockLLM);
  const systemSkillLoader = new SystemSkillLoader();
  systemSkillLoader.loadAll();
  const executorRegistry = new ExecutorRegistry();

  const mainAgent = new MainAgent({
    llm: mockLLM,
    skillRegistry: mockSkillRegistry,
    taskQueue: new EventEmitter() as any, // placeholder, replaced below
    intentRouter,
    userProfileService,
    memoryService,
    dynamicContextBuilder,
    sessionStore,
    askAgent,
    systemSkillLoader,
    executorRegistry,
  });

  // Mock TaskQueue with required EventEmitter interface
  const taskQueue = new EventEmitter() as any;
  taskQueue.addTask = () => {};
  taskQueue.getTask = () => null;
  taskQueue.getAllTasks = () => [];
  taskQueue.getTasksByStatus = () => [];
  taskQueue.cancelTask = () => false;
  taskQueue.getMetrics = () => ({ tasksCompleted: 0, tasksFailed: 0, tasksTimedOut: 0, averageExecutionTime: 0, totalExecutionTime: 0 });
  taskQueue.getRunningCount = () => 0;
  taskQueue.clear = () => {};
  taskQueue.triggerProcess = () => {};

  // Inject the real taskQueue into mainAgent by replacing the placeholder
  (mainAgent as any).taskQueue = taskQueue;

  // Build Express app and listen
  const { createAPIServer } = await import('../src/api');
  const app = createAPIServer(mainAgent, mockSkillRegistry, taskQueue);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;

  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {}
  };

  return { mainAgent, url, close, dataDir };
}

/**
 * POST to /tasks/stream and parse the SSE event stream.
 * Returns HTTP status, response headers, and all events.
 */
async function postStreamExpectEvents(
  url: string,
  body: object,
  timeoutMs = 10000,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  events: Array<{ event: string; data: any }>;
}> {
  return new Promise((resolve, reject) => {
    const bodyJson = JSON.stringify(body);
    const req = http.request(
      `${url}/tasks/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyJson),
        },
      },
      (res) => {
        const events: Array<{ event: string; data: any }> = [];
        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          // Parse SSE: events are separated by \n\n, fields by \n
          let sepIdx;
          while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            const eventObj: { event?: string; data?: string } = {};
            for (const line of raw.split('\n')) {
              if (line.startsWith('event: ')) eventObj.event = line.slice(7).trim();
              else if (line.startsWith('data: ')) eventObj.data = line.slice(6).trim();
            }
            if (eventObj.event) {
              let parsed: any = eventObj.data;
              try { parsed = JSON.parse(eventObj.data!); } catch {}
              events.push({ event: eventObj.event, data: parsed });
            }
          }
        });

        res.on('end', () => {
          resolve({ status: res.statusCode ?? 200, headers: res.headers, events });
        });

        res.on('error', reject);
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`SSE stream timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(bodyJson);
    req.end();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('End-to-end error propagation', () => {
  test('E2E-1: single task LLM RATE_LIMIT → SSE error event with LlmError envelope + X-Trace-Id', async () => {
    const stack = await buildStackedAgent({
      failingTaskIds: new Set(['t1']),
      llmErrorType: 'RATE_LIMIT',
    });
    try {
      const { status, headers, events } = await postStreamExpectEvents(stack.url, {
        requirement: '帮我查一下报销',
        userId: 'u1',
      });

      expect(status).toBe(200);

      // 1. X-Trace-Id header is a UUID v4
      expect(headers['x-trace-id']).toBeTruthy();
      expect(headers['x-trace-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // 2. SSE error event with envelope fields
      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.data.type).toBe('RETRYABLE');
      expect(errorEvent.data.code).toBe('LLM_RATE_LIMIT');
      expect(typeof errorEvent.data.message).toBe('string');
      expect(errorEvent.data.message.length).toBeGreaterThan(0);

      // 3. No complete event on failure path
      expect(events.find((e) => e.event === 'complete')).toBeUndefined();
    } finally {
      await stack.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `bun test __tests__/error-propagation-e2e.test.ts`
Expected: 1 passed, 0 failed

If the test fails:
- Check that the mock LLM sentinel dispatch works (verify the prompt sent to `generateWithTools` contains `'task-t1:'`)
- Check that the express server is reachable and the SSE stream closes
- Inspect actual events in the test output to debug

- [ ] **Step 3: Commit**

```bash
git add __tests__/error-propagation-e2e.test.ts
git commit -m "test(e2e): add single-task LlmError propagation test (E2E-1)"
```

---

## Task 2: Add multi-task scenarios (E2E-2a, E2E-2b, E2E-2c)

**Files:**
- Modify: `__tests__/error-propagation-e2e.test.ts` (append 3 more test scenarios to the `describe` block)

**Interfaces:**
- Consumes: `buildStackedAgent`, `postStreamExpectEvents` from Task 1
- Produces: 3 new test scenarios covering multi-task error propagation

- [ ] **Step 1: Add E2E-2a test (first task fails, dependents skipped)**

Append to the `describe` block:

```typescript
  test('E2E-2a: multi-task t1 fails → dependent t2/t3 do not execute', async () => {
    const stack = await buildStackedAgent({
      failingTaskIds: new Set(['t1']),
      intentResult: {
        intent: 'skill_task',
        confidence: 0.9,
        tasks: [
          { taskId: 't1', requirement: 'task-t1: A', skillName: 'echo', intent: 'skill_task' },
          { taskId: 't2', requirement: 'task-t2: B', skillName: 'echo', intent: 'skill_task', params: { ref: '$t1.result' } },
          { taskId: 't3', requirement: 'task-t3: C', skillName: 'echo', intent: 'skill_task' },
        ],
      },
    });
    try {
      const { headers, events } = await postStreamExpectEvents(stack.url, {
        requirement: 'multi task first fails',
        userId: 'u1',
      });
      expect(headers['x-trace-id']).toBeTruthy();

      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.data.code).toMatch(/^LLM_/);
      expect(errorEvent.data.type).toBe('RETRYABLE');
      expect(events.find((e) => e.event === 'complete')).toBeUndefined();
    } finally {
      await stack.close();
    }
  });
```

- [ ] **Step 2: Add E2E-2b test (middle task fails, downstream skipped)**

Append:

```typescript
  test('E2E-2b: multi-task t1 ok → t2 fails → t3 dependent on t2 is skipped', async () => {
    const stack = await buildStackedAgent({
      failingTaskIds: new Set(['t2']),
      intentResult: {
        intent: 'skill_task',
        confidence: 0.9,
        tasks: [
          { taskId: 't1', requirement: 'task-t1: A', skillName: 'echo', intent: 'skill_task' },
          { taskId: 't2', requirement: 'task-t2: B', skillName: 'echo', intent: 'skill_task' },
          { taskId: 't3', requirement: 'task-t3: C', skillName: 'echo', intent: 'skill_task', params: { ref: '$t2.result' } },
        ],
      },
    });
    try {
      const { events } = await postStreamExpectEvents(stack.url, {
        requirement: 'multi task middle fails',
        userId: 'u1',
      });

      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.data.code).toMatch(/^LLM_/);
      expect(errorEvent.data.type).toBe('RETRYABLE');
    } finally {
      await stack.close();
    }
  });
```

- [ ] **Step 3: Add E2E-2c test (two parallel tasks both fail, first failedTask reported)**

Append:

```typescript
  test('E2E-2c: parallel t1/t2 both fail → first failedTask error propagated', async () => {
    const stack = await buildStackedAgent({
      failingTaskIds: new Set(['t1', 't2']),
      intentResult: {
        intent: 'skill_task',
        confidence: 0.9,
        tasks: [
          { taskId: 't1', requirement: 'task-t1: A', skillName: 'echo', intent: 'skill_task' },
          { taskId: 't2', requirement: 'task-t2: B', skillName: 'echo', intent: 'skill_task' },
        ],
      },
    });
    try {
      const { events } = await postStreamExpectEvents(stack.url, {
        requirement: 'parallel both fail',
        userId: 'u1',
      });

      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.data.code).toMatch(/^LLM_/);
      expect(errorEvent.data.type).toBe('RETRYABLE');
      // Error code should be one of the expected LlmError codes (depends on which failed first)
      expect(['LLM_RATE_LIMIT']).toContain(errorEvent.data.code);
    } finally {
      await stack.close();
    }
  });
```

- [ ] **Step 4: Run all 4 tests**

Run: `bun test __tests__/error-propagation-e2e.test.ts`
Expected: 4 passed, 0 failed

If any test fails:
- For E2E-2a/2b/2c: the parallel/multi-task path may have different behavior. Check whether `TaskGraphExecutor.executeLayers` throws a `SkillError` (which has different code shape) instead of `LlmError`. If so, adjust the `data.code` regex to match either pattern, or inspect which error is actually thrown and update assertions.
- For E2E-2c specifically: parallel execution may surface only one failure depending on ordering; the assertion `expect(['LLM_RATE_LIMIT']).toContain(...)` already accommodates this.

- [ ] **Step 5: Verify no regressions in other test suites**

Run: `bun test`
Expected: All previously passing tests still pass (only the new file is added).

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add __tests__/error-propagation-e2e.test.ts
git commit -m "test(e2e): add multi-task error propagation scenarios (E2E-2a/b/c)"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ Section 1 (file location, framework) → Task 1 Step 1
- ✅ Section 2 (`buildStackedAgent` factory) → Task 1 Step 1
- ✅ Section 3 (`postStreamExpectEvents` SSE parser) → Task 1 Step 1
- ✅ Section 4 (4 test scenarios) → Task 1 Step 1 (E2E-1) + Task 2 Steps 1-3 (E2E-2a/b/c)
- ✅ Section 5 (validation points per test) → Embedded in each test's assertions
- ✅ Section 6 (data isolation) → `try/finally close` + unique dataDir per test

**2. Placeholder scan:**
- No "TBD", "TODO", or vague instructions. Every step has exact code.

**3. Type consistency:**
- `buildStackedAgent` signature consistent between Task 1 and Task 2.
- `postStreamExpectEvents` signature consistent.
- `LLMError`, `LLMErrorType`, `ILLMClient`, `IntentResult` imports verified against actual exports.

**Risk noted in plan**: E2E-2a/2b/2c may surface a `SkillError` instead of `LlmError` because `TaskGraphExecutor.executeLayers` catches and rethrows as `SkillError`. The plan's Step 4 includes a debug instruction to inspect actual `data.code` and adjust assertions if needed. This is a real possibility flagged in the spec's "Risks and Mitigations" section.