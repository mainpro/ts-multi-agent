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
});
