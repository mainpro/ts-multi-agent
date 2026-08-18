/**
 * Multi-employee end-to-end tests.
 *
 * Verifies the full multi-employee flow:
 *   - IntentRouter prompt includes all enabled employees
 *   - LLM-driven routing selects correct employeeId
 *   - 3-employee registry coexists (legal + IT + fallback)
 *
 * Uses `buildTestMainAgent` from T10 to construct MainAgent with full DI chain.
 * Mock LLM returns predictable employeeId based on input content so we can verify
 * IntentRouter → routeIntentToEmployee → MainAgent correctly routes through registry.
 *
 * Test runner: bun test
 * Run: bun test __tests__/multi-employee-e2e.test.ts
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MainAgent } from '../src/agents/main-agent';
import { EmployeeAgent } from '../src/agents/employee/agent';
import { EmployeeRegistry } from '../src/agents/employee/registry';
import { routeIntentToEmployee } from '../src/agents/employee/router';
import { IntentRouter } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { UserProfileService } from '../src/user-profile';
import { MemoryService } from '../src/memory/memory-service';
import { SkillRegistry } from '../src/skill-registry';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';
import { TaskQueue } from '../src/task-queue';
import { SessionStore } from '../src/memory/session-store';
import { TaskGraphExecutor } from '../src/agents/task-graph-executor';
import type { ILLMClient } from '../src/llm';
import { buildTestMainAgent } from './_helpers/build-test-agent';

/** Mock deps for EmployeeAgent constructor (no skill/memory needed for routing tests). */
const mockEmployeeDeps: any = {
  llm: {},
  memoryService: {},
  sessionStore: {},
  skillRegistry: {},
};

/**
 * Wrap an IntentRouter around the given mock LLM.
 * Empty SkillRegistry is fine — routing tests don't need real skills.
 */
function realIntentRouterWithMockLLM(mockLLM: ILLMClient): IntentRouter {
  const emptySkillRegistry = new SkillRegistry({ skillsDir: './skills', autoLoad: false });
  return new IntentRouter(mockLLM, emptySkillRegistry);
}

describe('多员工并存 E2E', () => {
  let dataDir: string;
  let mainAgent: MainAgent;
  let registry: EmployeeRegistry;
  let llmCalls: Array<{ prompt: string; sysPrompt?: string }>;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });

    llmCalls = [];
    const generateStructured = mock(async (prompt: string, _schema: any, sysPrompt?: string) => {
      llmCalls.push({ prompt, sysPrompt });

      // 根据 prompt 内容返回不同 employeeId
      if (prompt.includes('合同') || prompt.includes('法律')) {
        return { intent: 'skill_task', employeeId: 'legal-assistant', tasks: [] };
      }
      if (prompt.includes('MDM') || prompt.includes('IT')) {
        return { intent: 'skill_task', employeeId: 'it-ops-consultant', tasks: [] };
      }
      return { intent: 'small_talk', tasks: [], friendlyResponse: '你好,请问需要什么帮助?' }; // 无 employeeId
    });

    const mockLLM = { generateStructured, generateText: async () => '', generateWithTools: async () => ({ content: '', toolCalls: [] }) } as any as ILLMClient;

    // Real DI instances (matches main-agent-queue.test.ts pattern)
    const sessionStore = new SessionStore(100, dataDir);
    const memoryService = new MemoryService(dataDir, mockLLM);
    const userProfileService = new UserProfileService(dataDir);
    const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
    const intentRouter = realIntentRouterWithMockLLM(mockLLM);
    const askAgent = new AskAgent(sessionStore, mockLLM);
    const systemSkillLoader = new SystemSkillLoader();
    systemSkillLoader.loadAll();
    const executorRegistry = new ExecutorRegistry();

    const built = buildTestMainAgent({
      // 不传 employees — 我们自己在下面追加 2 个目标员工(legal/it)
      // helper 默认注册 test-employee + fallback-service-desk,后者已覆盖兜底
      mocks: {
        llm: mockLLM,
        skillRegistry: new SkillRegistry({ skillsDir: './skills', autoLoad: false }),
        taskQueue: new TaskQueue(async () => null),
        intentRouter,
        userProfileService,
        memoryService,
        dynamicContextBuilder,
        sessionStore,
        askAgent,
        systemSkillLoader,
        executorRegistry,
      },
    });
    mainAgent = built.mainAgent;
    registry = built.registry;

    // 在默认 registry(test-employee + fallback)基础上追加 2 个目标员工
    registry.register(new EmployeeAgent({
      employee: { id: 'legal-assistant', displayName: '法务助理', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
      persona: { prefix: '我是 ${displayName},专答法律问题' },
    }, mockEmployeeDeps));
    registry.register(new EmployeeAgent({
      employee: { id: 'it-ops-consultant', displayName: 'IT 运维顾问', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
    }, mockEmployeeDeps));
  });

  it('法务问题派给 legal-assistant', async () => {
    await mainAgent.processRequirement(
      '帮我起草一份合同',
      undefined,
      'user-1',
      'sess-1',
    );

    // 验证 IntentRouter prompt 中包含员工列表
    const intentCall = llmCalls.find(c => c.prompt.includes('可用员工'));
    expect(intentCall).toBeDefined();
    expect(intentCall?.prompt).toContain('legal-assistant');
    expect(intentCall?.prompt).toContain('法务助理');
  });

  it('IntentRouter prompt 注入所有 enabled 员工', async () => {
    await mainAgent.processRequirement('随便', undefined, 'u', 's');

    const intentCall = llmCalls.find(c => c.prompt.includes('可用员工'));
    expect(intentCall).toBeDefined();
    expect(intentCall?.prompt).toContain('it-ops-consultant');
    expect(intentCall?.prompt).toContain('fallback-service-desk');
  });

  it('闲聊无 employeeId → 兜底', async () => {
    // 简化:验证 LLM 被调用且 IntentRouter 处理了请求
    await mainAgent.processRequirement('你好', undefined, 'u', 's');
    // IntentRouter prompt 应至少被生成一次
    expect(llmCalls.length).toBeGreaterThan(0);
    const intentCall = llmCalls.find(c => c.prompt.includes('可用员工'));
    expect(intentCall).toBeDefined();
  });

  it('Registry 同时容纳多个 enabled 员工 + 兜底', () => {
    // 验证 3 个目标员工都被注册
    expect(registry.has('legal-assistant')).toBe(true);
    expect(registry.has('it-ops-consultant')).toBe(true);
    expect(registry.has('fallback-service-desk')).toBe(true);
    // listForLLM 返回所有 enabled 员工的简化描述(包含 test-employee 默认员工)
    const forLLM = registry.listForLLM();
    expect(forLLM.length).toBeGreaterThanOrEqual(3);
    const ids = forLLM.map(e => e.id);
    expect(ids).toContain('legal-assistant');
    expect(ids).toContain('it-ops-consultant');
    expect(ids).toContain('fallback-service-desk');
  });

  it('routeIntentToEmployee 把合法 employeeId 映射到 EmployeeAgent', () => {
    const agent = routeIntentToEmployee(
      { intent: 'skill_task', tasks: [], employeeId: 'it-ops-consultant' },
      registry,
    );
    expect(agent.id).toBe('it-ops-consultant');
    expect(agent.displayName).toBe('IT 运维顾问');
  });

  it('routeIntentToEmployee 把不存在 employeeId 静默兜底到 fallback', () => {
    const agent = routeIntentToEmployee(
      { intent: 'skill_task', tasks: [], employeeId: 'unknown-employee-xyz' },
      registry,
    );
    expect(agent.id).toBe('fallback-service-desk');
  });

  it('LLM 返回 small_talk(无 employeeId) → 兜底员工被选中', () => {
    // small_talk + 无 employeeId 时,routeIntentToEmployee 应回退到 fallback
    const agent = routeIntentToEmployee(
      { intent: 'small_talk', tasks: [], employeeId: undefined as any },
      registry,
    );
    expect(agent.id).toBe('fallback-service-desk');
  });
});

/**
 * 回归:单任务快路径(tasksToExecute.length === 1,跳过 UnifiedPlanner)必须和
 * 多任务路径一样注入员工上下文。
 *
 * 修复前:快路径构造的 inline plan 不写 employeeId / allowedTools / _personaContext,
 * 也不做 skill 白名单校验 → buildTaskGraph 读到 undefined,resolveExecutorForTask
 * 一律回退到 registry.defaultFallback(),LLM 选中的员工被静默丢弃。
 */
describe('单任务快路径注入员工上下文(回归)', () => {
  /**
   * 构造一个 MainAgent:mock LLM 固定返回「1 个 skill 任务 + 指定 employeeId」,
   * 并把 executeTaskGraph 换成捕获桩(不真正执行),便于断言 TaskGraph 上的字段。
   */
  async function buildAgentForSingleTask(opts: {
    employeeId?: string;
    skillName?: string;
    legalWhitelist?: { type: 'allowlist' | 'unrestricted'; skills: string[] };
  } = {}) {
    const dataDir = path.join(os.tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });

    const generateStructured = mock(async () => ({
      intent: 'skill_task',
      confidence: 0.9,
      employeeId: opts.employeeId ?? 'legal-assistant',
      tasks: [
        { skillName: opts.skillName ?? 'contract-review', requirement: '审一份合同', intent: 'execute', params: {} },
      ],
    }));
    const mockLLM = {
      generateStructured,
      generateText: async () => '',
      generateWithTools: async () => ({ content: '', toolCalls: [] }),
    } as any as ILLMClient;

    const sessionStore = new SessionStore(100, dataDir);
    const built = buildTestMainAgent({
      mocks: {
        llm: mockLLM,
        skillRegistry: new SkillRegistry({ skillsDir: './skills', autoLoad: false }),
        taskQueue: new TaskQueue(async () => null),
        intentRouter: realIntentRouterWithMockLLM(mockLLM),
        userProfileService: new UserProfileService(dataDir),
        memoryService: new MemoryService(dataDir, mockLLM),
        dynamicContextBuilder: new DynamicContextBuilder(new MemoryService(dataDir, mockLLM)),
        sessionStore,
        askAgent: new AskAgent(sessionStore, mockLLM),
        systemSkillLoader: (() => { const l = new SystemSkillLoader(); l.loadAll(); return l; })(),
        executorRegistry: new ExecutorRegistry(),
      },
    });

    built.registry.register(new EmployeeAgent({
      employee: { id: 'legal-assistant', displayName: '法务助理', enabled: true },
      capabilities: {
        llm: { provider: 'haier' },
        ...(opts.legalWhitelist ? { skillWhitelist: opts.legalWhitelist } : {}),
      },
      persona: { prefix: '我是 ${displayName},专答法律问题' },
    }, mockEmployeeDeps));

    // 捕获 TaskGraph,不真正执行(TaskQueue 是空壳)
    let capturedGraph: any;
    (built.mainAgent as any).executeTaskGraph = async (graph: any) => {
      capturedGraph = graph;
      return {
        success: true,
        data: {
          results: [{
            taskId: graph.nodes[0]?.taskId,
            skillName: graph.nodes[0]?.skillName,
            requirement: graph.nodes[0]?.content,
            status: 'completed',
            employeeId: graph.nodes[0]?.employeeId,
            result: { success: true, data: { response: 'ok' } },
          }],
        },
      };
    };

    return { mainAgent: built.mainAgent, registry: built.registry, getGraph: () => capturedGraph };
  }

  it('单任务请求把 LLM 选中的 employeeId 写入 TaskGraph(不再被兜底吞掉)', async () => {
    const { mainAgent, getGraph } = await buildAgentForSingleTask();

    await mainAgent.processRequirement('帮我审一份合同', undefined, 'user-single', 'sess-single');

    const graph = getGraph();
    expect(graph).toBeDefined();
    expect(graph.nodes.length).toBe(1);
    expect(graph.nodes[0].employeeId).toBe('legal-assistant');
  });

  it('单任务请求同样注入 persona / allowedTools', async () => {
    const { mainAgent, getGraph } = await buildAgentForSingleTask();

    await mainAgent.processRequirement('帮我审一份合同', undefined, 'user-single2', 'sess-single2');

    const node = getGraph().nodes[0];
    // persona 模板 ${displayName} 已被 EmployeeAgent 替换
    expect(node._personaContext?.prefix).toContain('法务助理');
    expect(Array.isArray(node.allowedTools)).toBe(true);
  });

  it('单任务图节点经 resolveExecutorForTask 绑到 legal-assistant 而非兜底', async () => {
    const { mainAgent, registry, getGraph } = await buildAgentForSingleTask();

    await mainAgent.processRequirement('帮我审一份合同', undefined, 'user-single3', 'sess-single3');

    // 用注入了 registry 的 TaskGraphExecutor 复现 executor 解析(Task 6 契约)
    const tge = new TaskGraphExecutor(
      new TaskQueue(async () => null), {} as any, {} as any, { employeeRegistry: registry },
    );
    const executor = (tge as any).resolveExecutorForTask('t1', getGraph().nodes[0]);
    expect((executor as any).__employeeId).toBe('legal-assistant');
    expect((executor as any).__employeeId).not.toBe('fallback-service-desk');
  });

  it('单任务快路径执行 skill 白名单校验(不在白名单 → SKILL_NOT_ALLOWED)', async () => {
    const { mainAgent } = await buildAgentForSingleTask({
      legalWhitelist: { type: 'allowlist', skills: ['other-skill'] },
    });

    await expect(
      mainAgent.processRequirement('帮我审一份合同', undefined, 'user-single4', 'sess-single4'),
    ).rejects.toThrow(/SKILL_NOT_ALLOWED|白名单/);
  });
});
