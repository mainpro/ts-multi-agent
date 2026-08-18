import { TaskGraphExecutor } from '../src/agents/task-graph-executor';
import { TaskQueue } from '../src/task-queue';
import { SessionStore } from '../src/memory/session-store';
import { ResultAggregator } from '../src/agents/result-aggregator';
import { EmployeeRegistry } from '../src/agents/employee/registry';
import { EmployeeAgent } from '../src/agents/employee/agent';

// Task 7: ResultAggregator 持有 EmployeeRegistry,旧 fixture 改为构造 fallback 员工 registry
const mockEmployeeDeps: any = { llm: {}, memoryService: {}, sessionStore: {}, skillRegistry: {} };
function makeMinimalRegistry(): EmployeeRegistry {
  const reg = new EmployeeRegistry();
  reg.register(new EmployeeAgent({
    employee: { id: 'fallback-service-desk', displayName: '兜底', enabled: true },
    capabilities: { llm: { provider: 'haier' } },
  }, mockEmployeeDeps));
  return reg;
}

describe('TaskGraphExecutor.executeTaskGraph partial failure', () => {
  it('returns hasPartialFailure=true when some tasks failed (partial)', async () => {
    // 场景:layer 0 有 2 个 task,t1 成功 + t2 失败 → 部分失败 → 返回 hasPartialFailure=true
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), makeMinimalRegistry());

    const taskQueue = new TaskQueue(async (task: any) => {
      if (task.id === 'plan-1-task-1') return { success: true, data: { response: 'ok' } };
      throw new Error('boom');
    });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = {
      id: 'plan-1',
      requirement: 'test',
      nodes: [
        { taskId: 'plan-1-task-1', content: 'task 1', skillName: 'test-skill', dependencies: [] },
        { taskId: 'plan-1-task-2', content: 'task 2', skillName: 'test-skill', dependencies: [] },
      ],
      layers: [['plan-1-task-1', 'plan-1-task-2']],
    };
    const req = { requestId: 'r1', content: 'r', status: 'processing', createdAt: '', updatedAt: '',
      suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null,
      tasks: [], result: null } as any;

    const result = await executor.executeTaskGraph(graph, 'sess-1', 'user-1', req);
    expect(result.success).toBe(false);
    expect(result.data?.hasPartialFailure).toBe(true);
    expect(result.data?.failedTasks).toHaveLength(1);
    expect(result.data?.failedTasks[0].taskId).toBe('plan-1-task-2');
    expect(result.data?.results).toHaveLength(1);
    expect(result.data?.results[0].taskId).toBe('plan-1-task-1');
  });

  it('does not throw when partial failure exists', async () => {
    // 部分失败 → 不应 throw,应正常 resolve 返回 hasPartialFailure=true
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), makeMinimalRegistry());

    const taskQueue = new TaskQueue(async (task: any) => {
      if (task.id === 'plan-1-task-1') return { success: true, data: { response: 'ok' } };
      throw new Error('partial boom');
    });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = {
      id: 'plan-1',
      requirement: 'test',
      nodes: [
        { taskId: 'plan-1-task-1', content: 'task 1', skillName: 'test-skill', dependencies: [] },
        { taskId: 'plan-1-task-2', content: 'task 2', skillName: 'test-skill', dependencies: [] },
      ],
      layers: [['plan-1-task-1', 'plan-1-task-2']],
    };
    const req = { requestId: 'r1', content: 'r', status: 'processing', createdAt: '', updatedAt: '',
      suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null,
      tasks: [], result: null } as any;

    // 不应 throw
    await expect(executor.executeTaskGraph(graph, 'sess-1', 'user-1', req)).resolves.toBeDefined();
  });

  it('throws when ALL tasks failed (no partial)', async () => {
    // 场景:layer 0 有 2 个 task,两者都失败 → 全失败 → 应 throw(保留 error-propagation-e2e 等期望)
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), makeMinimalRegistry());

    const taskQueue = new TaskQueue(async () => {
      throw new Error('both tasks fail');
    });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = {
      id: 'plan-1',
      requirement: 'test',
      nodes: [
        { taskId: 'plan-1-task-1', content: 'task 1', skillName: 'test-skill', dependencies: [] },
        { taskId: 'plan-1-task-2', content: 'task 2', skillName: 'test-skill', dependencies: [] },
      ],
      layers: [['plan-1-task-1', 'plan-1-task-2']],
    };
    const req = { requestId: 'r1', content: 'r', status: 'processing', createdAt: '', updatedAt: '',
      suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null,
      tasks: [], result: null } as any;

    // 应 throw(SkillError 包裹)
    await expect(executor.executeTaskGraph(graph, 'sess-1', 'user-1', req)).rejects.toBeDefined();
  });

  it('failedTasks carry requirement for summary context', async () => {
    // 场景:layer 0 有 2 个 task,t1 成功 + t2 失败。
    // 期望:failedTasks[0].requirement 是失败 task 的 node.content,
    //     让 main-agent 汇总 LLM 能看到失败 task 的意图(避免混合状态时丢失 context)。
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), makeMinimalRegistry());

    const taskQueue = new TaskQueue(async (task: any) => {
      if (task.id === 'plan-1-task-1') return { success: true, data: { response: 'ok' } };
      throw new Error('boom');
    });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = {
      id: 'plan-1',
      requirement: 'test',
      nodes: [
        { taskId: 'plan-1-task-1', content: '任务 1 的成功需求', skillName: 'test-skill', dependencies: [] },
        { taskId: 'plan-1-task-2', content: '失败 task 的需求文本', skillName: 'test-skill', dependencies: [] },
      ],
      layers: [['plan-1-task-1', 'plan-1-task-2']],
    };
    const req = { requestId: 'r1', content: 'r', status: 'processing', createdAt: '', updatedAt: '',
      suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null,
      tasks: [], result: null } as any;

    const result = await executor.executeTaskGraph(graph, 'sess-1', 'user-1', req);
    expect(result.success).toBe(false);
    expect(result.data?.hasPartialFailure).toBe(true);
    expect(result.data?.failedTasks).toHaveLength(1);
    // P5 fix:失败 task 必须携带 requirement,否则汇总 LLM 看不到失败意图
    expect(result.data?.failedTasks[0].taskId).toBe('plan-1-task-2');
    expect(result.data?.failedTasks[0].requirement).toBe('失败 task 的需求文本');
  });
});

describe('TaskGraphExecutor.resumeFromBreakpoint partial failure', () => {
  // 构造已恢复断点:layer 0 已完成 1 个 task,layer 1 有 2 个 task 待执行。
  // layer-1 task 的 dependencies 显式置空,因为它们的依赖项(task-1)只存在于
  // completedResults 而不在 TaskQueue.tasks(findReadyTasks 会因 dep 不存在而无法 ready)。
  // 我们的目标是验证 resumeFromBreakpoint 的 partial-failure contract 行为,
  // 不是验证依赖求解,因此空 deps 是合理的。
  function buildResumedGraphWithLayer1() {
    return {
      id: 'plan-resume-1',
      requirement: 'resume test',
      nodes: [
        // layer 0:已完成的 resumed task(只存在于 completedResults)
        { taskId: 'plan-resume-1-task-1', content: 'task 1', skillName: 'test-skill', dependencies: [] },
        // layer 1:两个新 task,空 deps(避免对 task-1 的 TaskQueue 依赖)
        { taskId: 'plan-resume-1-task-2', content: 'task 2', skillName: 'test-skill', dependencies: [] },
        { taskId: 'plan-resume-1-task-3', content: 'task 3', skillName: 'test-skill', dependencies: [] },
      ],
      layers: [
        ['plan-resume-1-task-1'],
        ['plan-resume-1-task-2', 'plan-resume-1-task-3'],
      ],
    };
  }

  function makeResumedReq(graph: any, completedResults: Record<string, any>): any {
    return {
      requestId: 'r-resume-1',
      content: 'resume',
      status: 'processing',
      createdAt: '',
      updatedAt: '',
      suspendedAt: null,
      suspendedReason: null,
      questions: [],
      currentQuestion: null,
      tasks: [],
      result: null,
      executionProgress: {
        currentLayerIndex: 1,  // 从 layer 1 开始执行(layer 0 已完成)
        completedResults,
        taskGraph: graph,
      },
    } as any;
  }

  it('resumeFromBreakpoint returns hasPartialFailure on partial failure', async () => {
    // 场景:layer 0 已恢复 1 个成功 task → layer 1 中 1 成功 + 1 失败
    // 期望:返回 success=true + hasPartialFailure=true(走汇总)
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), makeMinimalRegistry());

    const taskQueue = new TaskQueue(async (task: any) => {
      // task-1 已从 completedResults 恢复,不应再执行
      // layer 1: task-2 成功、task-3 失败
      if (task.id === 'plan-resume-1-task-2') {
        return { success: true, data: { response: 'layer1-ok' } };
      }
      if (task.id === 'plan-resume-1-task-3') {
        throw new Error('resume partial boom');
      }
      throw new Error(`unexpected task: ${task.id}`);
    });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = buildResumedGraphWithLayer1();
    const completedResults = {
      'plan-resume-1-task-1': { response: 'layer0-ok' },
    };
    const req = makeResumedReq(graph, completedResults);

    const result = await executor.resumeFromBreakpoint(
      'user-1', 'sess-1', req,
      { questionId: '', content: '', source: 'user_answer', taskId: null, skillName: null, answer: null, answeredAt: null, createdAt: new Date().toISOString() } as any,
    );

    // 部分失败:不 throw,返回 hasPartialFailure=true
    expect(result.success).toBe(true);
    expect(result.data?.hasPartialFailure).toBe(true);
    expect(result.data?.failedTasks).toHaveLength(1);
    expect(result.data?.failedTasks[0].taskId).toBe('plan-resume-1-task-3');
    // allResults 包含 resumed task-1 + new task-2
    expect(result.data?.results).toHaveLength(2);
    const resultTaskIds = result.data?.results?.map((r: any) => r.taskId).sort();
    expect(resultTaskIds).toEqual(['plan-resume-1-task-1', 'plan-resume-1-task-2']);
  });

  it('resumeFromBreakpoint throws when ALL failed on the resumed layers', async () => {
    // 场景:layer 0 已恢复 1 个成功 task → layer 1 中两个都失败
    // 期望:total = failedTasks.length + allResults.length → 部分失败
    // 但要触发全失败,需要 resumed 层 0 没有成功(layer 0 全部失败)。
    // 这里模拟更严苛场景:让 resumed 的"已恢复 task"实际在 layer 1 也参与执行,并全部失败。
    // 简化:直接构造一个 layer 0 全失败的 resume:completedResults 为空,layer 1 也全失败
    // → totalTasks = 2 + 0 = 2,但 failedTasks = 2 → throw。
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), makeMinimalRegistry());

    const taskQueue = new TaskQueue(async () => {
      throw new Error('all resume tasks fail');
    });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = buildResumedGraphWithLayer1();
    // completedResults 为空 → layer 1 执行时两个 task 都失败
    const req = makeResumedReq(graph, {});

    // 应 throw(SkillError 保留 error-propagation-e2e 期望的错误事件路径)
    await expect(
      executor.resumeFromBreakpoint(
        'user-1', 'sess-1', req,
        { questionId: '', content: '', source: 'user_answer', taskId: null, skillName: null, answer: null, answeredAt: null, createdAt: new Date().toISOString() } as any,
      )
    ).rejects.toBeDefined();
  });
});