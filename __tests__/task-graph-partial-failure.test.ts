import { TaskGraphExecutor } from '../src/agents/task-graph-executor';
import { TaskQueue } from '../src/task-queue';
import { SessionStore } from '../src/memory/session-store';
import { ResultAggregator } from '../src/agents/result-aggregator';

describe('TaskGraphExecutor.executeTaskGraph partial failure', () => {
  it('returns hasPartialFailure=true when some tasks failed (partial)', async () => {
    // 场景:layer 0 有 2 个 task,t1 成功 + t2 失败 → 部分失败 → 返回 hasPartialFailure=true
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }));

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
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }));

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
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }));

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
});