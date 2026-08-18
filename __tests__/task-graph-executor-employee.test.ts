import { describe, it, expect } from 'bun:test';
import { TaskGraphExecutor, TaskExecutorFactory } from '../src/agents/task-graph-executor';
import { TaskQueue } from '../src/task-queue';
import { SessionStore } from '../src/memory/session-store';
import { ResultAggregator } from '../src/agents/result-aggregator';
import { EmployeeAgent } from '../src/agents/employee/agent';
import { EmployeeRegistry } from '../src/agents/employee/registry';
import type { EmployeeConfig } from '../src/agents/employee/json-types';
import type { EmployeeAgentDeps } from '../src/agents/employee/agent';
import type { Task } from '../src/types';

const mockDeps: EmployeeAgentDeps = {
  llm: {} as any,
  memoryService: {} as any,
  sessionStore: {} as any,
  skillRegistry: {
    getSkillMetadata: () => undefined,
  } as any,
};

function buildConfig(id: string, displayName: string): EmployeeConfig {
  return {
    employee: { id, displayName, enabled: true },
    capabilities: { llm: { provider: 'haier' } },
  };
}

function buildRegistry() {
  const reg = new EmployeeRegistry();
  reg.register(new EmployeeAgent(buildConfig('legal-assistant', '法务助理'), mockDeps));
  reg.register(new EmployeeAgent(buildConfig('it-ops-consultant', 'IT 运维'), mockDeps));
  reg.register(new EmployeeAgent(buildConfig('fallback-service-desk', '兜底总台'), mockDeps));
  return reg;
}

describe('TaskGraphExecutor 多员工路由', () => {
  it('task.employeeId 决定 executor 选择', async () => {
    // 模拟 2 个员工 + 1 个 fallback
    const reg = new EmployeeRegistry();
    const legal = new EmployeeAgent(buildConfig('legal-assistant', '法务助理'), mockDeps);
    const itOps = new EmployeeAgent(buildConfig('it-ops-consultant', 'IT 运维'), mockDeps);
    const fallback = new EmployeeAgent(buildConfig('fallback-service-desk', '兜底总台'), mockDeps);
    reg.register(legal);
    reg.register(itOps);
    reg.register(fallback);

    // Task 6 核心契约:ExecutorFactory 根据 task.employeeId 选 EmployeeAgent
    // 这是 Task 6 期望的"内部默认 factory"形式
    const factory = (task: Task) => {
      const empId = task.employeeId && reg.has(task.employeeId)
        ? task.employeeId
        : reg.defaultFallback().id;
      return reg.get(empId)!;
    };

    const task1: Task = {
      id: 't1', requirement: 'r1', skillName: 'fawu',
      dependencies: [], dependents: [], createdAt: new Date(),
      status: 'pending', retryCount: 0, employeeId: 'legal-assistant',
    };
    const task2: Task = {
      id: 't2', requirement: 'r2', skillName: 'ees-qa',
      dependencies: [], dependents: [], createdAt: new Date(),
      status: 'pending', retryCount: 0, employeeId: 'it-ops-consultant',
    };

    // 验证 factory 返回正确的 EmployeeAgent
    expect(factory(task1).id).toBe('legal-assistant');
    expect(factory(task2).id).toBe('it-ops-consultant');

    // 无 employeeId → fallback
    const taskNoEmp: Task = {
      id: 't3', requirement: 'r3', skillName: 'unknown',
      dependencies: [], dependents: [], createdAt: new Date(),
      status: 'pending', retryCount: 0,
    };
    expect(factory(taskNoEmp).id).toBe('fallback-service-desk');

    // task.employeeId 存在但 registry 中没有 → fallback
    const taskGhost: Task = { ...task1, employeeId: 'ghost-employee' };
    expect(factory(taskGhost).id).toBe('fallback-service-desk');

    // 关键的 Task 6 接口契约:Task 接口必须支持 employeeId?: string
    // (TypeScript 编译期已检查,运行时验证字段是否被识别)
    expect(task1.employeeId).toBe('legal-assistant');
  });

  it('executeTaskGraph 通过 task.employeeId 把每个 task 路由到正确 EmployeeAgent', async () => {
    // 完整集成:TaskGraphExecutor 拿到 node.employeeId,内部 wrap EmployeeAgent
    // 绑到 task.executor,TaskQueue 执行时调用正确的 EmployeeAgent.executeSubTask。
    //
    // 验证手段:用 monkey-patch 替换 EmployeeAgent.executeSubTask,记录每个
    // task 调用时的 binding 上下文(取 task.executor.__employeeId 即可)。
    // 这样不依赖真实 SubAgent 链路,只验证 TaskGraphExecutor 的路由决策是否正确。
    const reg = buildRegistry();

    // 覆盖 executeSubTask:返回签名 = TaskResult,从此不再深入 SubAgent
    const executedBy: Array<{ taskId: string; employeeId: string | undefined }> = [];
    for (const agent of reg.list()) {
      const fallbackAgent = reg.defaultFallback();
      void fallbackAgent;
      const orig = (agent as any).executeSubTask.bind(agent);
      (agent as any).executeSubTask = async (task: Task) => {
        const exec = task.executor as any;
        executedBy.push({ taskId: task.id, employeeId: exec?.__employeeId });
        // 返回合法 TaskResult,模拟完成
        void orig;
        return { success: true, data: { response: `done:${task.id}@${exec?.__employeeId}` } };
      };
    }

    // 重要:由于 executeSubTask 内的 employeeId 来自 task.executor.__employeeId,
    // 不依赖 SubAgent 真实执行成功。我们让 TaskQueue 走得是覆盖后的 executeSubTask。

    const taskQueue = new TaskQueue(async (task: Task) => {
      const exec = task.executor as any;
      // 我们的实现:被 wrap 的 executor 上有 __employeeId 标记
      const boundEmployeeId = exec?.__employeeId;
      // 直接调用被 wrap 的 executor —— 但 wrap 内部已改成调 executeSubTask,
      // 而 executeSubTask 已被覆盖,这样会回到上面的 stub
      return await exec(task);
    });

    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator({} as any, {} as any, sessionStore, async () => ({ success: true }), buildRegistry());

    // 关键:配置 employeeRegistry 选项
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore, {
      employeeRegistry: reg,
    });

    // 节点带 employeeId,task-1 走 legal,task-2 走 it-ops,task-3 不带 → fallback
    const graph = {
      id: 'plan-emp-1',
      requirement: 'multi-employee test',
      nodes: [
        { taskId: 'plan-emp-1-task-1', content: 'task 1', skillName: 'fawu', dependencies: [], employeeId: 'legal-assistant' },
        { taskId: 'plan-emp-1-task-2', content: 'task 2', skillName: 'ees-qa', dependencies: [], employeeId: 'it-ops-consultant' },
        { taskId: 'plan-emp-1-task-3', content: 'task 3', skillName: 'unknown', dependencies: [] },
      ],
      layers: [
        ['plan-emp-1-task-1', 'plan-emp-1-task-2', 'plan-emp-1-task-3'],
      ],
    };

    const req = {
      requestId: 'r-emp-1',
      content: 'multi-employee',
      status: 'processing',
      createdAt: '',
      updatedAt: '',
      suspendedAt: null,
      suspendedReason: null,
      questions: [],
      currentQuestion: null,
      tasks: [],
      result: null,
    } as any;

    const result = await executor.executeTaskGraph(graph, 'sess-1', 'user-1', req);

    expect(result.success).toBe(true);
    expect(executedBy).toHaveLength(3);

    const byId = new Map(executedBy.map(e => [e.taskId, e.employeeId]));
    expect(byId.get('plan-emp-1-task-1')).toBe('legal-assistant');
    expect(byId.get('plan-emp-1-task-2')).toBe('it-ops-consultant');
    expect(byId.get('plan-emp-1-task-3')).toBe('fallback-service-desk');
  });

  it('executeTaskGraph 未注入 employeeRegistry 时回退到外部 executorFactory(back-compat)', async () => {
    // 旧 TaskGraphExecutor 构造签名:options 不传 employeeRegistry,完全靠
    // 外部 executorFactory 参数。Task 6 不得破坏此契约。
    const taskQueue = new TaskQueue(async (task: Task) => {
      return { success: true, data: { response: `done:${task.id}` } };
    });

    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator({} as any, {} as any, sessionStore, async () => ({ success: true }), buildRegistry());

    // 不传 employeeRegistry 选项
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const factoryCalls: string[] = [];
    const externalFactory: TaskExecutorFactory = (task) => {
      factoryCalls.push(task.id);
      return undefined; // 让 TaskQueue 走 this.executor
    };

    const graph = {
      id: 'plan-noreg-1',
      requirement: 'back-compat',
      nodes: [
        { taskId: 'plan-noreg-1-task-1', content: 'task 1', skillName: 'x', dependencies: [] },
      ],
      layers: [['plan-noreg-1-task-1']],
    };

    const req = {
      requestId: 'r-noreg-1',
      content: 'back-compat',
      status: 'processing',
      createdAt: '',
      updatedAt: '',
      suspendedAt: null,
      suspendedReason: null,
      questions: [],
      currentQuestion: null,
      tasks: [],
      result: null,
    } as any;

    const result = await executor.executeTaskGraph(graph, 'sess-1', 'user-1', req, externalFactory);

    expect(result.success).toBe(true);
    expect(factoryCalls).toContain('plan-noreg-1-task-1'); // 外部 factory 仍被调用
  });
});
