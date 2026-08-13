/**
 * MainAgent employee config — Task 8 单元测试
 *
 * 覆盖:
 *  1. MainAgent 构造接受 MainAgentOptions.employee(并把 employee 存到 this.employee)
 *  2. processRequirement → IntentRouter.classify 调用时,persona 作为第 7 个参数传入
 *
 * 运行: bun test __tests__/main-agent-employee.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { MainAgent } from '../src/agents/main-agent';
import type { EmployeeConfig } from '../src/agents/employee/types';

const minimalEmployee: EmployeeConfig = {
  employee: { id: 'test-employee', displayName: 'Test Employee', enabled: true },
  capabilities: { llm: { provider: 'haier' } },
};

describe('MainAgent employee config', () => {
  test('构造时接受 employee: EmployeeConfig', () => {
    // 构造不报错即可(其他依赖传 mock)
    const ma = new MainAgent(
      {
        llm: {} as any,
        skillRegistry: {} as any,
        taskQueue: {} as any,
        intentRouter: {} as any,
        userProfileService: {} as any,
        memoryService: {} as any,
        dynamicContextBuilder: {} as any,
        sessionStore: {} as any,
        askAgent: {} as any,
        systemSkillLoader: {} as any,
        executorRegistry: {} as any,
      },
      { employee: minimalEmployee },
    );
    expect(ma).toBeDefined();
    // 私有字段访问
    expect((ma as any).employee).toBeDefined();
    expect((ma as any).employee.employee.id).toBe('test-employee');
  });

  test('persona 注入 IntentRouter.classify 调用', async () => {
    // 准备 mock deps,捕获 IntentRouter.classify 的 persona 参数
    let capturedPersona: any = undefined;
    const mockIntentRouter = {
      classify: async (...args: any[]) => {
        capturedPersona = args[6];  // persona 是第 7 个参数
        return { intent: 'small_talk', tasks: [], question: null };
      },
    } as any;
    const mockAskAgent = {
      handleUserInput: async () => ({ type: 'new_request', request: { requestId: 'r1', content: 'hi', status: 'processing', createdAt: '', updatedAt: '', suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null, tasks: [], result: null } }),
    } as any;

    const employeeWithPersona: EmployeeConfig = {
      ...minimalEmployee,
      persona: { prefix: '你是「${displayName}」,Test 员工', style: 'test style' },
    };

    const ma = new MainAgent(
      {
        llm: {} as any,
        skillRegistry: { getAllMetadata: () => [], getSkillMetadata: () => undefined, loadFullSkill: async () => null } as any,
        taskQueue: {} as any,
        intentRouter: mockIntentRouter,
        userProfileService: { loadProfile: async () => ({}), inferSystemFromText: () => null, updateProfile: async () => {}, setSkillsMetadata: () => {} } as any,
        memoryService: { saveUserMessage: async () => {}, loadUserMemory: async () => ({ episodicEntries: [] }), recall: async () => [], getL4: () => ({ listEntries: async () => [] }), saveAssistantMessage: async () => {}, summarizeRequest: async () => {}, buildContextPrompt: () => '', popLastAssistantMessage: async () => {} } as any,
        dynamicContextBuilder: { build: async () => '' } as any,
        sessionStore: { loadSession: async () => ({ requests: [], pendingRequests: [], activeRequestId: null }), addTaskToRequest: async () => {}, updateTaskInRequest: async () => {}, flushToDisk: async () => {}, saveExecutionProgress: async () => {}, completeRequest: async () => {}, failRequest: async () => {}, saveSession: async () => {} } as any,
        askAgent: mockAskAgent,
        systemSkillLoader: { isSystemCommand: () => false, extractCommandName: () => '', getCommand: () => null, getAllCommands: () => [] } as any,
        executorRegistry: { getExecutor: () => null } as any,
      },
      { employee: employeeWithPersona },
    );

    await ma.processRequirement('hello', undefined, 'u1', 's1');
    expect(capturedPersona).toBeDefined();
    expect(capturedPersona.prefix).toContain('Test 员工');
  });

  test('Task 8 fix: plan.tasks[i] 携带 _personaContext 和 allowedTools 喂给 buildTaskGraph', async () => {
    // 准备 mock IntentRouter,返回一个真实含 skillName 的 task(让 allowedTools 计算路径走完)。
    const mockIntentRouter = {
      classify: async () => ({
        intent: 'skill_task',
        confidence: 0.9,
        tasks: [
          { id: 'task-1', skillName: 'mock-skill', requirement: 'do something', dependencies: [] },
        ],
      }),
    } as any;
    const mockAskAgent = {
      handleUserInput: async () => ({
        type: 'new_request',
        request: {
          requestId: 'r1', content: 'go', status: 'processing',
          createdAt: '', updatedAt: '', suspendedAt: null, suspendedReason: null,
          questions: [], currentQuestion: null, tasks: [], result: null,
        },
      }),
    } as any;

    // skill metadata 声明的 allowedTools,会被 computeAllowedTools 与 employee.tools 求交集
    const mockSkillRegistry = {
      getAllMetadata: () => [],
      getSkillMetadata: () => ({ allowedTools: ['tool-a', 'tool-b'] }),
      loadFullSkill: async () => null,
    } as any;

    // 让 buildTaskGraph 捕获 plan 后立即抛 sentinel,跳过真执行路径(我们只关心 plan 上的字段)。
    let capturedPlan: any = null;
    class CapturedPlanError extends Error {
      constructor(public readonly plan: any) { super('CAPTURED_PLAN'); }
    }
    const mockTaskGraphExecutor = {
      buildTaskGraph: (plan: any) => {
        capturedPlan = plan;
        throw new CapturedPlanError(plan);
      },
      executeTaskGraph: async () => ({ success: true, data: { results: [] } }),
      onceTaskEvent: async () => ({ taskId: '', result: null, status: 'completed' }),
    } as any;

    const employeeWithPersona: EmployeeConfig = {
      ...minimalEmployee,
      persona: { prefix: '你是「${displayName}」,Test 员工', style: 'test style' },
      capabilities: {
        llm: { provider: 'haier' },
        // 员工 tool 黑名单:tool-b 不允许,与 skill 声明的 [tool-a, tool-b] 求交后只剩 tool-a
        tools: { denied: ['tool-b'] },
      },
    };

    const ma = new MainAgent(
      {
        llm: {} as any,
        skillRegistry: mockSkillRegistry,
        taskQueue: {
          on: () => () => {},
          off: () => {},
          addTask: () => {},
          getTask: () => undefined,
        } as any,
        intentRouter: mockIntentRouter,
        userProfileService: { loadProfile: async () => ({}), inferSystemFromText: () => null, updateProfile: async () => {}, setSkillsMetadata: () => {} } as any,
        memoryService: { saveUserMessage: async () => {}, loadUserMemory: async () => ({ episodicEntries: [] }), recall: async () => [], getL4: () => ({ listEntries: async () => [] }), saveAssistantMessage: async () => {}, summarizeRequest: async () => {}, buildContextPrompt: () => '', popLastAssistantMessage: async () => {} } as any,
        dynamicContextBuilder: { build: async () => '' } as any,
        sessionStore: { loadSession: async () => ({ requests: [], pendingRequests: [], activeRequestId: null }), addTaskToRequest: async () => {}, updateTaskInRequest: async () => {}, flushToDisk: async () => {}, saveExecutionProgress: async () => {}, completeRequest: async () => {}, failRequest: async () => {}, saveSession: async () => {} } as any,
        askAgent: mockAskAgent,
        systemSkillLoader: { isSystemCommand: () => false, extractCommandName: () => '', getCommand: () => null, getAllCommands: () => [] } as any,
        executorRegistry: { getExecutor: () => null } as any,
      },
      { employee: employeeWithPersona },
    );

    // 注入 mock 的 TaskGraphExecutor(直接替换实例字段,避免真跑)
    (ma as any).taskGraphExecutor = mockTaskGraphExecutor;

    // buildTaskGraph 抛 sentinel 终止后续执行路径(我们只关心 plan 上的字段)
    try {
      await ma.processRequirement('do something', undefined, 'u1', 's1');
    } catch (e: any) {
      // 忽略 sentinel 异常,只用于截断执行流
      if (e?.message !== 'CAPTURED_PLAN') throw e;
    }

    // 断言:buildTaskGraph 收到的 plan.tasks[i] 上挂了 _personaContext 和 allowedTools,
    // 这条链路才是 SubAgent.execute 真正读到的源头(RequestTask 上的字段不会传过去)。
    expect(capturedPlan).toBeDefined();
    expect(capturedPlan.tasks).toBeDefined();
    expect(capturedPlan.tasks.length).toBe(1);
    const taskDef = capturedPlan.tasks[0];
    expect(taskDef._personaContext).toBeDefined();
    expect(taskDef._personaContext.prefix).toContain('Test 员工');
    expect(taskDef._personaContext.style).toBe('test style');
    // skill 声明 [tool-a, tool-b] ∩ 员工 deny {tool-b} → 应只剩 tool-a
    expect(new Set(taskDef.allowedTools)).toEqual(new Set(['tool-a']));
  });
});
