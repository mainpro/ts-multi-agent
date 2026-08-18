import { describe, it, expect } from 'bun:test';
import { ResultAggregator } from '../src/agents/result-aggregator';
import { EmployeeRegistry } from '../src/agents/employee/registry';
import { EmployeeAgent } from '../src/agents/employee/agent';
import type { EmployeeConfig, EmployeeAgentDeps } from '../src/agents/employee/json-types';
import type { ILLMClient } from '../src/llm';
import type { MemoryService } from '../src/memory/memory-service';
import type { SessionStore } from '../src/memory/session-store';
import type { Request, TaskResult } from '../src/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const mockDeps: EmployeeAgentDeps = {
  llm: {} as any,
  memoryService: {} as any,
  sessionStore: {} as any,
  skillRegistry: {} as any,
};

const enabled = (id: string, displayName?: string): EmployeeConfig => ({
  employee: { id, displayName: displayName ?? id, enabled: true },
  capabilities: { llm: { provider: 'haier' } },
});

const fallback = (): EmployeeConfig => ({
  ...enabled('fallback-service-desk', '兜底总台'),
});

function makeDeps(): {
  llm: ILLMClient;
  memoryService: MemoryService;
  sessionStore: SessionStore;
} {
  const llm = {
    generateStructured: async () => ({ completed: true, summary: '原始摘要' }),
  } as unknown as ILLMClient;

  const memoryService = {
    saveAssistantMessage: async () => {},
    summarizeRequest: async () => {},
  } as unknown as MemoryService;

  const sessionStore = {
    completeRequest: async () => {},
    updateTaskInRequest: async () => {},
    loadSession: async () => ({
      sessionId: 'sess-1',
      userId: 'user-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requests: [],
      activeRequestId: null,
      pendingRequests: [],
    }),
  } as unknown as SessionStore;

  return { llm, memoryService, sessionStore };
}

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

const onNeedsIntentReclassification = async () =>
  ({ success: true, data: { response: '' } }) as TaskResult;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResultAggregator per-employee rewriter (Task 7)', () => {
  it('不同 task 携带不同 employeeId → 用对应员工的 rewriter', async () => {
    const reg = new EmployeeRegistry();
    reg.register(new EmployeeAgent({
      ...enabled('legal-assistant', '法务助理'),
      outputBehavior: { resultRewriter: { transform: 'append', value: '\n[法务尾注]' } },
    }, mockDeps));
    reg.register(new EmployeeAgent({
      ...enabled('it-ops-consultant', 'IT 运维'),
      outputBehavior: { resultRewriter: { transform: 'append', value: '\n[IT 尾注]' } },
    }, mockDeps));
    reg.register(new EmployeeAgent(fallback(), mockDeps));

    const deps = makeDeps();
    const agg = new ResultAggregator(
      deps.llm, deps.memoryService, deps.sessionStore,
      onNeedsIntentReclassification,
      reg,
    );

    // 单 task employeeId=legal-assistant → 应追加 [法务尾注],不应有 IT
    const results = [
      { taskId: 't1', skillName: 's', requirement: 'r', response: '合同已起草', status: 'completed', employeeId: 'legal-assistant' },
    ];

    const summary = await agg.summarizeResults('原需求', results, 'user-1', 'sess-1', makeRequest());
    expect(summary.summary).toContain('[法务尾注]');
    expect(summary.summary).not.toContain('[IT 尾注]');
  });

  it('task 无 employeeId 时用 fallback 员工的 rewriter', async () => {
    const reg = new EmployeeRegistry();
    reg.register(new EmployeeAgent({
      ...fallback(),
      outputBehavior: { resultRewriter: { transform: 'append', value: '\n[兜底尾注]' } },
    }, mockDeps));

    const deps = makeDeps();
    const agg = new ResultAggregator(
      deps.llm, deps.memoryService, deps.sessionStore,
      onNeedsIntentReclassification,
      reg,
    );

    // task 没有 employeeId → 走 fallback employee 的 rewriter
    const results = [
      { taskId: 't1', skillName: 's', requirement: 'r', response: '随便回复', status: 'completed' },
    ];

    const summary = await agg.summarizeResults('原需求', results, 'user-1', 'sess-1', makeRequest());
    expect(summary.summary).toContain('[兜底尾注]');
  });
});