import { TaskGraphExecutor } from '../src/agents/task-graph-executor';
import { TaskQueue } from '../src/task-queue';
import { SessionStore } from '../src/memory/session-store';
import { ResultAggregator } from '../src/agents/result-aggregator';

describe('TaskGraphExecutor.executeTaskGraph partial failure', () => {
  it('returns hasPartialFailure=true when some tasks failed', async () => {
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }));

    const taskQueue = new TaskQueue(async () => {
      throw new Error('always fails');
    });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = {
      id: 'plan-1',
      requirement: 'test',
      nodes: [{
        taskId: 'plan-1-task-1',
        content: 'task 1',
        skillName: 'test-skill',
        dependencies: [],
      }],
      layers: [['plan-1-task-1']],
    };
    const req = { requestId: 'r1', content: 'r', status: 'processing', createdAt: '', updatedAt: '',
      suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null,
      tasks: [], result: null } as any;

    const result = await executor.executeTaskGraph(graph, 'sess-1', 'user-1', req);
    expect(result.data?.hasPartialFailure).toBe(true);
    expect(result.data?.failedTasks).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it('does not throw when failedTasks exists (new behavior)', async () => {
    // 上一条测试也验证了这点,但加一个 explicit 断言
    const llm = {} as any;
    const memSvc = {} as any;
    const sessionStore = {} as any;
    const resultAgg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }));

    const taskQueue = new TaskQueue(async () => { throw new Error('boom'); });
    const executor = new TaskGraphExecutor(taskQueue, resultAgg, sessionStore);

    const graph = {
      id: 'plan-1',
      requirement: 'test',
      nodes: [{
        taskId: 'plan-1-task-1',
        content: 'task 1',
        skillName: 'test-skill',
        dependencies: [],
      }],
      layers: [['plan-1-task-1']],
    };
    const req = { requestId: 'r1', content: 'r', status: 'processing', createdAt: '', updatedAt: '',
      suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null,
      tasks: [], result: null } as any;

    // 不应 throw
    await expect(executor.executeTaskGraph(graph, 'sess-1', 'user-1', req)).resolves.toBeDefined();
  });
});