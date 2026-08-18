/**
 * 测试 helper: 构造带 EmployeeRegistry 的 MainAgent。
 *
 * 默认注册 2 个员工:
 *   - test-employee           主测试员工(白名单空,所有 skill 允许)
 *   - fallback-service-desk   兜底(defaultFallback() 要求必备)
 *
 * 测试可传 overrides 添加额外员工或自定义配置 / 依赖。
 */
import { MainAgent, MainAgentDependencies } from '../../src/agents/main-agent';
import { EmployeeAgent, EmployeeAgentDeps } from '../../src/agents/employee/agent';
import { EmployeeRegistry } from '../../src/agents/employee/registry';
import type { EmployeeConfig } from '../../src/agents/employee/json-types';

export function buildTestMainAgent(overrides: {
  employees?: Array<{ id: string; config: EmployeeConfig }>;
  mocks?: Partial<MainAgentDependencies>;
} = {}): { mainAgent: MainAgent; registry: EmployeeRegistry } {
  const registry = new EmployeeRegistry();

  const baseConfig: EmployeeConfig = {
    employee: { id: 'test-employee', displayName: '测试员工', enabled: true },
    capabilities: { llm: { provider: 'haier' } },
  };
  registry.register(new EmployeeAgent(baseConfig, mockEmployeeDeps));

  registry.register(new EmployeeAgent({
    employee: { id: 'fallback-service-desk', displayName: '兜底', enabled: true },
    capabilities: { llm: { provider: 'haier' } },
  }, mockEmployeeDeps));

  for (const emp of overrides.employees ?? []) {
    registry.register(new EmployeeAgent(emp.config, mockEmployeeDeps));
  }

  const mainAgent = new MainAgent({
    llm: mockLLM,
    skillRegistry: mockSkillRegistry,
    taskQueue: mockTaskQueue,
    intentRouter: mockIntentRouter,
    userProfileService: mockUserProfile,
    memoryService: mockMemory,
    dynamicContextBuilder: mockDynamicContext,
    sessionStore: mockSessionStore,
    askAgent: mockAskAgent,
    systemSkillLoader: mockSystemSkill,
    executorRegistry: mockExecutorRegistry,
    employeeRegistry: registry,
    ...overrides.mocks,
  });

  return { mainAgent, registry };
}

const mockEmployeeDeps: EmployeeAgentDeps = {
  llm: {} as any,
  memoryService: {} as any,
  sessionStore: {} as any,
  skillRegistry: {} as any,
};

const mockLLM: any = {};
const mockSkillRegistry: any = {};
const mockTaskQueue: any = {};
const mockIntentRouter: any = {};
const mockUserProfile: any = {};
const mockMemory: any = {};
const mockDynamicContext: any = {};
const mockSessionStore: any = {};
const mockAskAgent: any = {};
const mockSystemSkill: any = {};
const mockExecutorRegistry: any = {};