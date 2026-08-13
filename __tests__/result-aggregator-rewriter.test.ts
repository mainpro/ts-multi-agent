import { describe, expect, test } from 'bun:test';
import { ResultAggregator } from '../src/agents/result-aggregator';
import type { ILLMClient } from '../src/llm';
import type { MemoryService } from '../src/memory/memory-service';
import type { SessionStore } from '../src/memory/session-store';
import type { ResultRewriter } from '../src/agents/employee/types';
import type { Request, TaskResult } from '../src/types';

// ---------------------------------------------------------------------------
// Test doubles — minimal fakes sufficient for ResultAggregator.summarizeResults
// ---------------------------------------------------------------------------

function makeRequest(): Request {
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
  };
}

function makeSession(req: Request) {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requests: [req],
    activeRequestId: null,
    pendingRequests: [],
  };
}

function makeDeps(llmReturn: { completed: boolean; summary: string }): {
  llm: ILLMClient;
  memoryService: MemoryService;
  sessionStore: SessionStore;
  onNeedsIntentReclassification: (r: Request, u: string, s: string) => Promise<TaskResult>;
} {
  const llm = {
    generateStructured: async () => llmReturn,
  } as unknown as ILLMClient;

  const memoryService = {
    saveAssistantMessage: async () => {},
    summarizeRequest: async () => {},
  } as unknown as MemoryService;

  const sessionStore = {
    updateTaskInRequest: async () => {},
    loadSession: async () => makeSession(makeRequest()),
    completeRequest: async () => {},
  } as unknown as SessionStore;

  const onNeedsIntentReclassification = async () =>
    ({ success: true, data: { response: '' } }) as TaskResult;

  return { llm, memoryService, sessionStore, onNeedsIntentReclassification };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('ResultAggregator resultRewriter', () => {
  test('no rewriter → summary passes through unchanged', async () => {
    const deps = makeDeps({ completed: true, summary: '原始答案' });
    const agg = new ResultAggregator(
      deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
    );
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案' }],
      'u1', 's1',
      makeRequest(),
    );
    expect(summary.summary).toBe('原始答案');
  });

  test('rewriter transform=append → summary gets value appended', async () => {
    const deps = makeDeps({ completed: true, summary: '原始答案' });
    const rewriter: ResultRewriter = {
      match: { status: 'completed' },
      transform: 'append',
      value: '\n\n---转人工',
    };
    const agg = new ResultAggregator(
      deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
      rewriter,
    );
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案', status: 'completed' }],
      'u1', 's1',
      makeRequest(),
    );
    expect(summary.summary).toBe('原始答案\n\n---转人工');
  });

  test('rewriter transform=replace → summary is replaced', async () => {
    const deps = makeDeps({ completed: true, summary: '原始答案' });
    const rewriter: ResultRewriter = {
      match: { status: 'completed' },
      transform: 'replace',
      value: '替换后的答案',
    };
    const agg = new ResultAggregator(
      deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
      rewriter,
    );
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案', status: 'completed' }],
      'u1', 's1',
      makeRequest(),
    );
    expect(summary.summary).toBe('替换后的答案');
  });

  test('rewriter transform=passthrough → summary unchanged', async () => {
    const deps = makeDeps({ completed: true, summary: '原始答案' });
    const rewriter: ResultRewriter = {
      transform: 'passthrough',
    };
    const agg = new ResultAggregator(
      deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
      rewriter,
    );
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案' }],
      'u1', 's1',
      makeRequest(),
    );
    expect(summary.summary).toBe('原始答案');
  });

  // CRITICAL REGRESSION TEST — Final Review Minor #1 fix
  // The gate must prevent rewriter from appending "转人工" suffixes to questions
  // (status='waiting_user_input'). Previously-fixed bug.
  test('status=waiting_user_input → rewriter does NOT apply (gate works)', async () => {
    const deps = makeDeps({ completed: true, summary: '问题内容: 请选择 A 还是 B?' });
    const rewriter: ResultRewriter = {
      match: { status: 'completed' },
      transform: 'append',
      value: '\n\n---转人工',
    };
    const agg = new ResultAggregator(
      deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
      rewriter,
    );
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '问题内容: 请选择 A 还是 B?', status: 'waiting_user_input' }],
      'u1', 's1',
      makeRequest(),
    );
    // Must NOT be appended — gate prevents rewriter when status is 'waiting_user_input'
    expect(summary.summary).toBe('问题内容: 请选择 A 还是 B?');
    expect(summary.summary).not.toContain('转人工');
  });

  test('rewriter with match.status=failed + status=completed → rewriter does NOT apply (no match)', async () => {
    const deps = makeDeps({ completed: true, summary: '原始答案' });
    const rewriter: ResultRewriter = {
      match: { status: 'failed' },
      transform: 'append',
      value: '\n\n---FAILED',
    };
    const agg = new ResultAggregator(
      deps.llm, deps.memoryService, deps.sessionStore, deps.onNeedsIntentReclassification,
      rewriter,
    );
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案', status: 'completed' }],
      'u1', 's1',
      makeRequest(),
    );
    expect(summary.summary).toBe('原始答案');
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // REGRESSION TEST (Task 9 review fix)
  // ──────────────────────────────────────────────────────────────────────────────
  // Bug: rewriter was applied AFTER saveAssistantMessage/completeRequest persisted
  // `judgment.summary`. User-visible response carried the suffix, but persisted
  // summary did not — replay would lose the suffix.
  //
  // This test asserts: the value persisted via saveAssistantMessage AND
  // completeRequest must equal the post-rewriter summary.
  // ──────────────────────────────────────────────────────────────────────────────
  test('rewriter is applied BEFORE persistence (saved message == returned summary)', async () => {
    const llm: ILLMClient = {
      generateStructured: async () => ({ completed: true, summary: '原始答案' }),
    } as unknown as ILLMClient;

    const savedMessages: Array<{ content: string; opts?: any }> = [];
    const completions: Array<{ requestId: string; result: string }> = [];

    const memoryService = {
      saveAssistantMessage: async (_u: string, _s: string, content: string, opts?: any) => {
        savedMessages.push({ content, opts });
      },
      summarizeRequest: async () => {},
    } as unknown as MemoryService;

    const sessionStore = {
      updateTaskInRequest: async () => {},
      loadSession: async () => makeSession(makeRequest()),
      completeRequest: async (_u: string, _s: string, requestId: string, result: string) => {
        completions.push({ requestId, result });
      },
    } as unknown as SessionStore;

    const rewriter: ResultRewriter = {
      match: { status: 'completed' },
      transform: 'append',
      value: '\n\n---转人工',
    };
    const agg = new ResultAggregator(
      llm, memoryService, sessionStore,
      async () => ({ success: true, data: { response: '' } }) as TaskResult,
      rewriter,
    );

    const returned = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案', status: 'completed' }],
      'u1', 's1',
      makeRequest(),
    );

    const expected = '原始答案\n\n---转人工';
    // Returned summary is post-rewriter
    expect(returned.summary).toBe(expected);
    // Persisted via saveAssistantMessage must match returned summary
    expect(savedMessages).toHaveLength(1);
    expect(savedMessages[0].content).toBe(expected);
    // Persisted via completeRequest must also match
    expect(completions).toHaveLength(1);
    expect(completions[0].result).toBe(expected);
    // And the LLM-emitted pre-rewrite value must NOT appear alone in persistence
    expect(savedMessages[0].content).not.toBe('原始答案');
    expect(completions[0].result).not.toBe('原始答案');
  });
});