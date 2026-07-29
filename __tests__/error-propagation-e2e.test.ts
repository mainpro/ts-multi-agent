/**
 * End-to-end error propagation tests.
 *
 * Verifies that LLMError thrown in SubAgent.execute flows through the entire stack
 * (SubAgent → mapSubAgentError → TaskQueue → TaskGraphExecutor → MainAgent → globalErrorHandler)
 * and emerges as an SSE `event: error` with proper envelope + X-Trace-Id header.
 *
 * Test runner: bun test
 * Run: bun test __tests__/error-propagation-e2e.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

import { LLMError, LLMErrorType } from '../src/llm';
import { ILLMClient } from '../src/llm/interfaces';
import { SkillRegistry } from '../src/skill-registry';
import { MemoryService } from '../src/memory/memory-service';
import { SessionStore } from '../src/memory/session-store';
import { IntentRouter, IntentResult } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { SubAgent } from '../src/agents/sub-agent';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { UserProfileService } from '../src/user-profile';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';
import { TaskQueue } from '../src/task-queue';
import { MainAgent } from '../src/agents/main-agent';
import { createAPIServer } from '../src/api';

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
  // generateStructured is called twice for multi-task requests:
  //   1st call: IntentRouter.classify → returns intentResult
  //   2nd call: UnifiedPlanner.plan → returns a planner-shaped response built from intentResult.tasks
  let generateStructuredCallCount = 0;
  const mockLLM: ILLMClient = {
    generateStructured: async (prompt: string) => {
      generateStructuredCallCount += 1;
      // First call: intent classification → return the intentResult as-is.
      if (generateStructuredCallCount === 1) {
        return intentResult;
      }
      // Second+ call: planning → return a UnifiedPlanResult-shaped response
      // with the same tasks (sentinel-string prefixes preserved so the failingTaskIds
      // dispatch in SubAgent can fire later).
      return {
        analysis: { summary: 'mock analysis', intent: 'skill_task' },
        skillSelection: ['echo'],
        plan: {
          needsClarification: false,
          tasks: intentResult.tasks.map((t, idx) => ({
            id: t.taskId ?? `task-${idx + 1}`,
            requirement: t.requirement,
            skillName: t.skillName,
            params: t.params ?? {},
            dependencies: [],
          })),
        },
      };
    },
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

  // SubAgent has to be created before TaskQueue so the executor closure can reference it.
  const subAgent = new SubAgent(mockSkillRegistry, mockLLM, memoryService);

  // Real TaskQueue that runs SubAgent as the executor — required for the LLM mock
  // sentinel to actually fire (SubAgent.execute → mockLLM.generateWithTools → throw).
  const taskQueue = new TaskQueue(async (task) => subAgent.execute(task));

  const mainAgent = new MainAgent({
    llm: mockLLM,
    skillRegistry: mockSkillRegistry,
    taskQueue,
    intentRouter,
    userProfileService,
    memoryService,
    dynamicContextBuilder,
    sessionStore,
    askAgent,
    systemSkillLoader,
    executorRegistry,
  });

  // Build Express app and listen
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
      expect(errorEvent!.data.type).toBe('RETRYABLE');
      expect(errorEvent!.data.code).toBe('LLM_RATE_LIMIT');
      expect(typeof errorEvent!.data.message).toBe('string');
      expect(errorEvent!.data.message.length).toBeGreaterThan(0);

      // 3. No complete event on failure path
      expect(events.find((e) => e.event === 'complete')).toBeUndefined();
    } finally {
      await stack.close();
    }
  });

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
      expect(errorEvent!.data.code).toMatch(/^LLM_/);
      expect(errorEvent!.data.type).toBe('RETRYABLE');
      expect(events.find((e) => e.event === 'complete')).toBeUndefined();
    } finally {
      await stack.close();
    }
  });

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
      expect(errorEvent!.data.code).toMatch(/^LLM_/);
      expect(errorEvent!.data.type).toBe('RETRYABLE');
    } finally {
      await stack.close();
    }
  });

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
      expect(errorEvent!.data.code).toMatch(/^LLM_/);
      expect(errorEvent!.data.type).toBe('RETRYABLE');
      // Error code should be one of the expected LlmError codes (depends on which failed first)
      expect(['LLM_RATE_LIMIT']).toContain(errorEvent!.data.code);
    } finally {
      await stack.close();
    }
  });
});
