/**
 * MainAgent employee registry — Task 5 单元测试
 *
 * 覆盖:
 *  1. 构造时持 employeeRegistry,不持 employee 字段(从旧 MainAgentOptions.employee 迁移到 deps.employeeRegistry)
 *  2. 依赖缺 employeeRegistry 时构造抛错
 *
 * 运行: bun test __tests__/main-agent-employee.test.ts
 */
import { describe, it, expect } from 'bun:test';
import { MainAgent } from '../src/agents/main-agent';
import { EmployeeAgent } from '../src/agents/employee/agent';
import { EmployeeRegistry } from '../src/agents/employee/registry';

const mockDeps: any = {};
const mockLLM: any = {};
const mockRegistry: any = {};
const mockTaskQueue: any = {};
const mockIntentRouter: any = {};
const mockUserProfile: any = {};
const mockMemory: any = {};
const mockDynamicContext: any = {};
const mockSessionStore: any = {};
const mockAskAgent: any = {};
const mockSystemSkill: any = {};
const mockExecutorRegistry: any = {};

describe('MainAgent 多员工并存', () => {
  let mainAgent: MainAgent;
  let registry: EmployeeRegistry;

  // 每个 case 各自构造,避免 describe 内共享导致 mutation 污染
  function buildAgent(): { agent: MainAgent; registry: EmployeeRegistry } {
    const reg = new EmployeeRegistry();
    reg.register(new EmployeeAgent({
      employee: { id: 'legal-assistant', displayName: '法务助理', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
    }, mockDeps));
    reg.register(new EmployeeAgent({
      employee: { id: 'fallback-service-desk', displayName: '兜底服务台', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
    }, mockDeps));

    const agent = new MainAgent({
      llm: mockLLM,
      skillRegistry: mockRegistry,
      taskQueue: mockTaskQueue,
      intentRouter: mockIntentRouter,
      userProfileService: mockUserProfile,
      memoryService: mockMemory,
      dynamicContextBuilder: mockDynamicContext,
      sessionStore: mockSessionStore,
      askAgent: mockAskAgent,
      systemSkillLoader: mockSystemSkill,
      executorRegistry: mockExecutorRegistry,
      employeeRegistry: reg,
    } as any);

    return { agent, registry: reg };
  }

  it('构造时持 employeeRegistry,不持 employee 字段', () => {
    const built = buildAgent();
    mainAgent = built.agent;
    registry = built.registry;
    // 新字段存在
    expect((mainAgent as any).employeeRegistry).toBe(registry);
    // 旧字段已移除
    expect((mainAgent as any).employee).toBeUndefined();
  });

  it('依赖缺 employeeRegistry 时构造抛错', () => {
    expect(() => new MainAgent({
      llm: mockLLM,
      skillRegistry: mockRegistry,
      taskQueue: mockTaskQueue,
      intentRouter: mockIntentRouter,
      userProfileService: mockUserProfile,
      memoryService: mockMemory,
      dynamicContextBuilder: mockDynamicContext,
      sessionStore: mockSessionStore,
      askAgent: mockAskAgent,
      systemSkillLoader: mockSystemSkill,
      executorRegistry: mockExecutorRegistry,
      // 故意不传 employeeRegistry
    } as any)).toThrow(/employeeRegistry/);
  });
});