import { describe, test, expect, beforeEach } from 'bun:test';
import { ResultAggregator } from '../src/agents/result-aggregator';
import { BusinessError, LlmError, SkillError } from '../src/errors';
import { EmployeeRegistry } from '../src/agents/employee/registry';
import { EmployeeAgent } from '../src/agents/employee/agent';
import type { EmployeeConfig } from '../src/agents/employee/json-types';
import type { ILLMClient } from '../src/llm';
import type { MemoryService } from '../src/memory/memory-service';
import type { SessionStore } from '../src/memory/session-store';
import type {
  Request, RequestTask, Session,
  Task, TaskResult, SkillExecutionResult, QAEntry,
} from '../src/types';

// Task 7: ResultAggregator 持有 EmployeeRegistry,旧 fixture 全部改为最小 registry
const mockEmployeeDeps: any = { llm: {}, memoryService: {}, sessionStore: {}, skillRegistry: {} };

function makeMinimalRegistry(): EmployeeRegistry {
  const reg = new EmployeeRegistry();
  reg.register(new EmployeeAgent({
    employee: { id: 'fallback-service-desk', displayName: '兜底', enabled: true },
    capabilities: { llm: { provider: 'haier' } },
  }, mockEmployeeDeps));
  return reg;
}

// ---------------------------------------------------------------------------
// Test doubles — lightweight fakes that satisfy the interfaces we exercise
// ---------------------------------------------------------------------------

function makeSession(requests: Request[]): Session {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requests,
    activeRequestId: null,
    pendingRequests: [],
  };
}

function makeRequestTask(overrides: Partial<RequestTask> = {}): RequestTask {
  return {
    taskId: 't-1',
    content: 'do thing',
    status: 'completed',
    skillName: 'demo-skill',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    questions: [],
    currentQuestion: null,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    requestId: 'req-1',
    content: 'orig requirement',
    status: 'processing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    suspendedAt: null,
    suspendedReason: null,
    questions: [],
    currentQuestion: null,
    tasks: [],
    result: null,
    ...overrides,
  };
}

function makeSkillData(overrides: Partial<SkillExecutionResult> = {}): SkillExecutionResult {
  return {
    response: 'hello from skill',
    status: 'completed',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: 't-1',
    requirement: 'do thing',
    dependencies: [],
    skillName: 'demo-skill',
    ...overrides,
  };
  if (!task.result) {
    task.result = { success: true, data: makeSkillData() };
  }
  return task;
}

interface FakeDeps {
  llmCalls: Array<{ prompt: string }>;
  savedMessages: Array<{ content: string; opts?: any }>;
  summarizeCalls: Array<any>;
  updates: Array<{ taskId: string; patch: any }>;
  completions: Array<{ requestId: string; result: string }>;
  session: Session;
  reclassifyReturn: TaskResult;
}

function makeDeps(session: Session): {
  deps: { llm: ILLMClient; memoryService: MemoryService; sessionStore: SessionStore; onNeedsIntentReclassification: any };
  state: FakeDeps;
} {
  const state: FakeDeps = {
    llmCalls: [],
    savedMessages: [],
    summarizeCalls: [],
    updates: [],
    completions: [],
    session,
    reclassifyReturn: { success: true, data: { response: 'redirected' } },
  };

  const llm: ILLMClient = {
    generateStructured: async (prompt: string) => {
      state.llmCalls.push({ prompt });
      return { completed: true, summary: 'final summary' };
    },
  } as unknown as ILLMClient;

  const memoryService = {
    saveAssistantMessage: async (userId: string, sessionId: string, content: string, opts?: any) => {
      state.savedMessages.push({ content, opts });
    },
    summarizeRequest: async (args: any) => {
      state.summarizeCalls.push(args);
    },
  } as unknown as MemoryService;

  const sessionStore = {
    updateTaskInRequest: async (
      _u: string, _s: string, _r: string, taskId: string, patch: any,
    ) => {
      state.updates.push({ taskId, patch });
    },
    loadSession: async () => state.session,
    completeRequest: async (_u: string, _s: string, requestId: string, result: string) => {
      state.completions.push({ requestId, result });
    },
  } as unknown as SessionStore;

  const onNeedsIntentReclassification = async () => state.reclassifyReturn;

  return {
    deps: { llm, memoryService, sessionStore, onNeedsIntentReclassification },
    state,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('ResultAggregator', () => {
  describe('createQAEntry', () => {
    test('builds a QAEntry with unique id and sub_agent source', () => {
      const request = makeRequest();
      const session = makeSession([request]);
      const { deps } = makeDeps(session);
      const agg = new ResultAggregator(
        deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );

      const skillData = makeSkillData({
        status: 'waiting_user_input',
        question: { type: 'skill_question', content: 'Pick one' },
      });

      const qa = agg.createQAEntry(skillData, 't-1', 'demo-skill');

      expect(qa.source).toBe('sub_agent');
      expect(qa.taskId).toBe('t-1');
      expect(qa.skillName).toBe('demo-skill');
      expect(qa.content).toBe('Pick one');
      expect(qa.answer).toBeNull();
      expect(qa.answeredAt).toBeNull();
      expect(typeof qa.questionId).toBe('string');
      expect(qa.questionId.startsWith('q-')).toBe(true);
    });

    test('preserves metadata from skillData.question', () => {
      const session = makeSession([makeRequest()]);
      const { deps } = makeDeps(session);
      const agg = new ResultAggregator(
        deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );
      const skillData = makeSkillData({
        question: { type: 'skill_question', content: 'Q?', metadata: { choices: ['a', 'b'] } },
      });
      const qa = agg.createQAEntry(skillData, 't-1', null);
      expect(qa.metadata).toEqual({ choices: ['a', 'b'] });
      expect(qa.skillName).toBeNull();
    });
  });

  describe('handleTaskCompletion — waiting_user_input', () => {
    test('emits a question result and updates task with QAEntry', async () => {
      const request = makeRequest({ tasks: [makeRequestTask({ taskId: 't-1' })] });
      const session = makeSession([request]);
      const { deps, state } = makeDeps(session);
      const agg = new ResultAggregator(
        deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );

      const task = makeTask({
        id: 't-1',
        result: {
          success: true,
          data: makeSkillData({
            status: 'waiting_user_input',
            question: { type: 'skill_question', content: 'need input' },
          }),
        },
      });

      const out = await agg.handleTaskCompletion(task, 'user-1', 'sess-1', request, 'plan-7');

      expect(out.success).toBe(true);
      expect((out.data as any).type).toBe('question');
      expect(state.updates).toHaveLength(1);
      expect(state.updates[0].patch.status).toBe('waiting');
      expect(state.updates[0].patch.currentQuestion?.content).toBe('need input');
      expect(state.savedMessages).toHaveLength(1);
      expect(state.savedMessages[0].content).toBe('need input');
    });
  });

  describe('handleTaskCompletion — needs_intent_reclassification', () => {
    test('delegates to the injected reclassification callback', async () => {
      const session = makeSession([makeRequest()]);
      const { deps, state } = makeDeps(session);
      const agg = new ResultAggregator(
        deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );
      const task = makeTask({
        result: {
          success: true,
          data: makeSkillData({
            status: 'needs_intent_reclassification',
            response: '',
          }),
        },
      });
      const out = await agg.handleTaskCompletion(task, 'u', 's', makeRequest());
      expect(out).toEqual(state.reclassifyReturn);
    });
  });

  describe('handleTaskCompletion — single task completes request', () => {
    test('writes assistant memory, completes request, kicks off summary', async () => {
      const task: RequestTask = makeRequestTask({ taskId: 't-1', status: 'completed' });
      const request = makeRequest({ tasks: [task] });
      const session = makeSession([request]);
      const { deps, state } = makeDeps(session);
      const agg = new ResultAggregator(
        deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );

      const t = makeTask({
        id: 't-1',
        skillName: 'demo-skill',
        result: { success: true, data: makeSkillData({ response: 'the answer' }) },
      });

      const out = await agg.handleTaskCompletion(t, 'user-1', 'sess-1', request);

      expect(out.success).toBe(true);
      expect(state.savedMessages).toHaveLength(1);
      expect(state.savedMessages[0].content).toBe('the answer');
      expect(state.completions).toHaveLength(1);
      expect(state.completions[0]).toEqual({ requestId: 'req-1', result: 'the answer' });
    });

    test('returns the task result unchanged on the happy path', async () => {
      const task = makeRequestTask({ taskId: 't-1' });
      const request = makeRequest({ tasks: [task] });
      const session = makeSession([request]);
      const { deps } = makeDeps(session);
      const agg = new ResultAggregator(
        deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );
      const t = makeTask({ id: 't-1', result: { success: true, data: makeSkillData({ response: 'r' }) } });
      const out = await agg.handleTaskCompletion(t, 'u', 's', request);
      expect(out).toEqual({ success: true, data: makeSkillData({ response: 'r' }) });
    });
  });

  describe('summarizeResults', () => {
    test('combines multiple task responses into one LLM prompt and returns judgment', async () => {
      const request = makeRequest();
      const session = makeSession([request]);
      const { deps, state } = makeDeps(session);
      const agg = new ResultAggregator(
        deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );

      const results = [
        { taskId: 't-1', skillName: 'a', requirement: 'req1', response: 'ans1', status: 'completed' },
        { taskId: 't-2', skillName: 'b', requirement: 'req2', response: 'ans2', status: 'completed' },
      ];
      const out = await agg.summarizeResults('orig', results, 'u', 's', request);

      expect(out).toEqual({
        completed: true,
        summary: 'final summary',
        failedTaskIds: [],
        transferTriggered: false,
      });
      expect(state.llmCalls).toHaveLength(1);
      expect(state.llmCalls[0].prompt).toContain('ans1');
      expect(state.llmCalls[0].prompt).toContain('ans2');
      expect(state.completions[0]).toEqual({ requestId: 'req-1', result: 'final summary' });
    });

    test('handles empty taskResults by still calling the LLM', async () => {
      const request = makeRequest();
      const session = makeSession([request]);
      const { deps, state } = makeDeps(session);
      const agg = new ResultAggregator(
        deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );
      const out = await agg.summarizeResults('orig', [], 'u', 's', request);
      expect(out.completed).toBe(true);
      expect(state.llmCalls).toHaveLength(1);
      expect(state.completions).toHaveLength(1);
    });

    test('skips completion when LLM judges not completed', async () => {
      const request = makeRequest();
      const session = makeSession([request]);
      const { deps, state } = makeDeps(session);
      const llm: ILLMClient = {
        generateStructured: async () => ({ completed: false, summary: 'need more' }),
      } as unknown as ILLMClient;
      const agg = new ResultAggregator(
        llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );

      const out = await agg.summarizeResults('orig',
        [{ taskId: 't-1', skillName: 'a', requirement: 'r', response: 'partial' }],
        'u', 's', request);

      expect(out.completed).toBe(false);
      expect(state.completions).toHaveLength(0);
      expect(state.savedMessages).toHaveLength(0);
    });

    test('wraps non-AppError LLM failures into BusinessError SUMMARIZATION_FAILED', async () => {
      const session = makeSession([makeRequest()]);
      const { deps } = makeDeps(session);
      const llm: ILLMClient = {
        generateStructured: async () => { throw new Error('boom'); },
      } as unknown as ILLMClient;
      const agg = new ResultAggregator(
        llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
        makeMinimalRegistry(),
      );
      await expect(
        agg.summarizeResults('orig', [{ taskId: 't-1', skillName: 'a', requirement: 'r', response: 'x' }],
          'u', 's', makeRequest()),
      ).rejects.toThrow(BusinessError);
    });
  });
});