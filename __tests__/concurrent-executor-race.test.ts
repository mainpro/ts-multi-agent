/**
 * P3 race fix 验证:per-task executor 注入替代 process-global setExecutor。
 *
 * 修复前 setExecutor 是 process-global 字段,跨请求并发时 A 会被 B 覆盖,
 * 导致 R1 的 task 跑出 R2 路由的员工回复。
 *
 * 修复后 task 在入队时绑定自己的 executor,跨请求并发不会互相覆盖。
 *
 * 覆盖:
 *  1. 同一 TaskQueue 上并发请求,每个 task 跑自己的 executor(核心 race)
 *  2. 未传 executorFactory 时,fall back 到 TaskQueue 自己的 executor(back-compat)
 *  3. factory 返回 undefined 时,fall back 到 TaskQueue 默认 executor
 *  4. 即使中途 setExecutor 被覆盖,per-task executor 仍正确
 *  5. 多 layer DAG 内每个 task 都用 factory 创建的独立 executor
 */
import { describe, test, expect } from 'bun:test';
import { TaskQueue } from '../src/task-queue';
import { TaskGraphExecutor, TaskExecutorFactory } from '../src/agents/task-graph-executor';
import { TaskGraph } from '../src/types';

function makeRequest(id: string): any {
  return {
    requestId: id,
    content: id,
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

function makeSingleTaskGraph(id: string, taskId: string): TaskGraph {
  return {
    id,
    requirement: id,
    nodes: [{ taskId, content: id, skillName: 'echo', dependencies: [], params: {} }],
    layers: [[taskId]],
  };
}

describe('P3 race fix: per-task executor 注入', () => {
  // 静音 sessionStore 噪声(测试不写真 sessionStore,TaskGraphExecutor finally 块会打 warn)
  const silentSessionStore: any = {
    updateTaskInRequest: async () => undefined,
    saveExecutionProgress: async () => undefined,
  };

  test('同一 TaskQueue 上并发请求,每个 task 跑自己的 executor (核心 race)', async () => {
    const executedBy: string[] = [];
    const taskQueue = new TaskQueue(async () => ({ ok: true })); // default 不该被用

    const executor = new TaskGraphExecutor(taskQueue, {} as any, silentSessionStore);

    const factoryA: TaskExecutorFactory = (task) => async () => {
      executedBy.push(`A:${task.id}`);
      return { success: true, data: { response: 'A-resp' } };
    };
    const factoryB: TaskExecutorFactory = (task) => async () => {
      executedBy.push(`B:${task.id}`);
      return { success: true, data: { response: 'B-resp' } };
    };

    const graphA = makeSingleTaskGraph('A', 'A-1');
    const graphB = makeSingleTaskGraph('B', 'B-1');

    // 并发跑两个独立请求,各自带 factory
    await Promise.all([
      executor.executeTaskGraph(graphA, 'sA', 'uA', makeRequest('rA'), factoryA),
      executor.executeTaskGraph(graphB, 'sB', 'uB', makeRequest('rB'), factoryB),
    ]);

    // 关键断言:每个 task 跑自己的 factory,没串台
    expect(executedBy).toContain('A:A-1');
    expect(executedBy).toContain('B:B-1');
    expect(executedBy.length).toBe(2);
  });

  test('未传 executorFactory 时,fall back 到 TaskQueue 自己的 executor (back-compat)', async () => {
    const defaultExecCalls: string[] = [];
    const taskQueue = new TaskQueue(async (task) => {
      defaultExecCalls.push(`default:${task.id}`);
      return { success: true, data: { response: 'default' } };
    });

    const executor = new TaskGraphExecutor(taskQueue, {} as any, silentSessionStore);

    const graph = makeSingleTaskGraph('p', 'p-1');
    await executor.executeTaskGraph(graph, 's1', 'u1', makeRequest('r1'));

    expect(defaultExecCalls).toEqual(['default:p-1']);
  });

  test('factory 返回 undefined 时,fall back 到 TaskQueue 默认 executor', async () => {
    const defaultExecCalls: string[] = [];
    const taskQueue = new TaskQueue(async (task) => {
      defaultExecCalls.push(`default:${task.id}`);
      return { success: true, data: { response: 'default' } };
    });

    const executor = new TaskGraphExecutor(taskQueue, {} as any, silentSessionStore);

    const graph = makeSingleTaskGraph('p', 'p-1');
    const factory: TaskExecutorFactory = () => undefined; // 故意不提供
    await executor.executeTaskGraph(graph, 's1', 'u1', makeRequest('r1'), factory);

    expect(defaultExecCalls).toEqual(['default:p-1']);
  });

  test('中途 setExecutor 覆盖 default,per-task executor 仍跑自己的 (旧 race 模拟)', async () => {
    const executedBy: string[] = [];
    const taskQueue = new TaskQueue(async () => ({ ok: true })); // default 不该被用

    const executor = new TaskGraphExecutor(taskQueue, {} as any, silentSessionStore);

    const factoryA: TaskExecutorFactory = (task) => async () => {
      executedBy.push(`A:${task.id}`);
      return { success: true, data: { response: 'A-resp' } };
    };
    const factoryB: TaskExecutorFactory = (task) => async () => {
      executedBy.push(`B:${task.id}`);
      return { success: true, data: { response: 'B-resp' } };
    };

    const graphA = makeSingleTaskGraph('A', 'A-1');
    const graphB = makeSingleTaskGraph('B', 'B-1');

    // 模拟"setExecutor 在执行中途被第三调用覆盖"
    const promiseA = executor.executeTaskGraph(graphA, 'sA', 'uA', makeRequest('rA'), factoryA);
    const promiseB = executor.executeTaskGraph(graphB, 'sB', 'uB', makeRequest('rB'), factoryB);

    // 在两个请求进行时调用 setExecutor(模拟旧 race)
    setImmediate(() => {
      taskQueue.setExecutor(async (task) => {
        executedBy.push(`BAD:${task.id}`);  // 不该出现
        return { success: true, data: { response: 'BAD' } };
      });
    });

    await Promise.all([promiseA, promiseB]);

    // 关键:不该出现 BAD: 前缀(说明 per-task executor 没被 setExecutor 覆盖)
    expect(executedBy.filter(s => s.startsWith('BAD:'))).toEqual([]);
    expect(executedBy).toContain('A:A-1');
    expect(executedBy).toContain('B:B-1');
  });

  test('多 layer DAG,每个 task 绑定独立的 executor 闭包(闭包变量隔离)', async () => {
    const executedBy: string[] = [];
    const taskQueue = new TaskQueue(async () => ({ ok: true }));

    const executor = new TaskGraphExecutor(taskQueue, {} as any, silentSessionStore);

    // factory 通过闭包变量 routeTo 区分每个 task 跑哪个 executor
    const factory: TaskExecutorFactory = (task) => {
      const routeTo = task.id.startsWith('G-a') ? 'X' : 'Y';
      return async () => {
        executedBy.push(`${routeTo}:${task.id}`);
        return { success: true, data: { response: `${routeTo}-resp` } };
      };
    };

    const graph: TaskGraph = {
      id: 'G',
      requirement: 'g',
      nodes: [
        { taskId: 'G-a1', content: 'a1', skillName: 'echo', dependencies: [], params: {} },
        { taskId: 'G-a2', content: 'a2', skillName: 'echo', dependencies: ['G-a1'], params: {} },
        { taskId: 'G-b1', content: 'b1', skillName: 'echo', dependencies: [], params: {} },
        { taskId: 'G-b2', content: 'b2', skillName: 'echo', dependencies: ['G-b1', 'G-a2'], params: {} },
      ],
      layers: [['G-a1', 'G-b1'], ['G-a2'], ['G-b2']],
    };

    await executor.executeTaskGraph(graph, 's1', 'u1', makeRequest('r1'), factory);

    // 关键:每个 task 跑自己的闭包(G-a* → X,G-b* → Y)
    expect(executedBy.sort()).toEqual([
      'X:G-a1',
      'X:G-a2',
      'Y:G-b1',
      'Y:G-b2',
    ]);
  });

  test('并发 10 个独立请求,每个 task 用各自 factory,无串台', async () => {
    const executedBy: string[] = [];
    const taskQueue = new TaskQueue(async () => ({ ok: true }));

    const executor = new TaskGraphExecutor(taskQueue, {} as any, silentSessionStore);

    const N = 10;
    const promises = Array.from({ length: N }, (_, i) => {
      const id = `R${i}`;
      const factory: TaskExecutorFactory = (task) => async () => {
        executedBy.push(`${id}:${task.id}`);
        return { success: true, data: { response: `${id}-resp` } };
      };
      const graph = makeSingleTaskGraph(id, `${id}-1`);
      return executor.executeTaskGraph(graph, `s${i}`, `u${i}`, makeRequest(id), factory);
    });

    await Promise.all(promises);

    // 关键:每个 task 跑自己的 request 的 executor,无串台
    expect(executedBy.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(executedBy).toContain(`R${i}:R${i}-1`);
    }
  });
});
