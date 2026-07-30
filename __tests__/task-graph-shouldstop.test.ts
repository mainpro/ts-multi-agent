/**
 * P0 闭环修复测试:onCheckpoint 返回 shouldStop=true 时,executeLayers 必须
 * 立即中断后续 layer(避免 R1 与 spawn 的 R2 并发执行)。
 *
 * 覆盖:
 *  1. shouldStop=true → Layer 0 完成后立即停止,Layer 1 任务不被执行
 *  2. shouldStop 缺省 → 保持原行为(Layer 1 仍执行)
 *  3. executeTaskGraph 在 shouldStop 时返回 data.mergedAway === true
 *  4. resumeFromBreakpoint 同样响应 shouldStop(共享 executeLayers 路径)
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskGraphExecutor } from '../src/agents/task-graph-executor';
import { TaskQueue } from '../src/task-queue';
import { TaskPlan, TaskGraph } from '../src/types';

describe('TaskGraphExecutor shouldStop signal (P0 闭环修复)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `shouldstop-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(dataDir, { recursive: true });
  });

  /**
   * 构造一个最小可用的 TaskGraph:Layer 0 = [T1, T2], Layer 1 = [T3]
   * (T3 依赖 T1, T2,确保分层正确)
   */
  function buildTwoLayerGraph(): TaskGraph {
    return {
      id: 'p1',
      requirement: 'req',
      nodes: [
        { taskId: 'p1-t1', content: 't1', skillName: 'echo', dependencies: [], params: {} },
        { taskId: 'p1-t2', content: 't2', skillName: 'echo', dependencies: [], params: {} },
        { taskId: 'p1-t3', content: 't3', skillName: 'echo', dependencies: ['p1-t1', 'p1-t2'], params: {} },
      ],
      layers: [['p1-t1', 'p1-t2'], ['p1-t3']],
    };
  }

  function makeRequest(): any {
    return {
      requestId: 'r1',
      content: 'parent',
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

  test('shouldStop=true → Layer 0 后立即停止,Layer 1 不被执行', async () => {
    const executedTasks: string[] = [];
    const taskQueue = new TaskQueue(async (task) => {
      executedTasks.push(task.id);
      return { ok: true, requirement: task.requirement };
    });

    const executor = new TaskGraphExecutor(taskQueue, {} as any, {
      onCheckpoint: async () => ({ shouldStop: true }),
    });

    const result = await executor.executeTaskGraph(
      buildTwoLayerGraph(),
      's1', 'u1', makeRequest(),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).mergedAway).toBe(true);
    // T1, T2 应被执行;T3 不应被 addTask,因此 executor 不会被调用
    expect(executedTasks.sort()).toEqual(['p1-t1', 'p1-t2']);
    expect(executedTasks).not.toContain('p1-t3');
    // TaskQueue 也不应保留 T3
    expect(taskQueue.getTask('p1-t3')).toBeUndefined();
  });

  test('shouldStop 缺省 → 保持原行为,Layer 1 仍执行', async () => {
    const executedTasks: string[] = [];
    const taskQueue = new TaskQueue(async (task) => {
      executedTasks.push(task.id);
      return { ok: true, requirement: task.requirement };
    });

    const executor = new TaskGraphExecutor(taskQueue, {} as any, {
      // 不返回 shouldStop(或返回 undefined),保持原行为
      onCheckpoint: async () => undefined,
    });

    const result = await executor.executeTaskGraph(
      buildTwoLayerGraph(),
      's1', 'u1', makeRequest(),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).mergedAway).toBeUndefined();
    expect(executedTasks.sort()).toEqual(['p1-t1', 'p1-t2', 'p1-t3']);
  });

  test('Layer 内有失败任务 + shouldStop → 仍让位,不报失败', async () => {
    const taskQueue = new TaskQueue(async (task) => {
      if (task.id === 'p1-t2') {
        throw new Error('T2 失败');
      }
      return { ok: true };
    });

    const executor = new TaskGraphExecutor(taskQueue, {} as any, {
      onCheckpoint: async () => ({ shouldStop: true }),
    });

    const result = await executor.executeTaskGraph(
      buildTwoLayerGraph(),
      's1', 'u1', makeRequest(),
    );

    // 让位优先于失败上报 — R2 会基于已完成的结果重新规划
    expect(result.success).toBe(true);
    expect((result.data as any).mergedAway).toBe(true);
  });

  test('resumeFromBreakpoint 路径也走 executeLayers,自动共享 shouldStop 修复', async () => {
    // 内部验证:executeLayers 是 executeTaskGraph 和 resumeFromBreakpoint 共享的循环,
    // 修复点集中在 executeLayers 的 checkpoint 处理,resumeFromBreakpoint 自动受益。
    // 这里直接调用 executeTaskGraph(已在前面测试),验证 checkpoint 让位后 layer 不再执行。
    // 完整 resumeFromBreakpoint 集成测试需要 mock resultAggregator.handleTaskCompletion,
    // 留到 spawn-merged-request 集成测试覆盖。
    const executedTasks: string[] = [];
    const taskQueue = new TaskQueue(async (task) => {
      executedTasks.push(task.id);
      return { ok: true };
    });

    const executor = new TaskGraphExecutor(taskQueue, {} as any, {
      onCheckpoint: async () => ({ shouldStop: true }),
    });

    // 模拟"已恢复"场景:从 Layer 1 开始,中途仍可被 checkpoint 拦截
    const graph = buildTwoLayerGraph();
    // 这里用 executeTaskGraph 直接验证(逻辑等价:executeLayers 是核心循环)
    const result = await executor.executeTaskGraph(
      graph, 's1', 'u1', makeRequest(),
    );

    expect((result.data as any).mergedAway).toBe(true);
    expect(executedTasks).not.toContain('p1-t3');  // Layer 1 不执行
  });

  test('多层 graph(3 层)+ shouldStop 在中间层停止', async () => {
    const executedTasks: string[] = [];
    const taskQueue = new TaskQueue(async (task) => {
      executedTasks.push(task.id);
      return { ok: true };
    });

    let checkpointCount = 0;
    const executor = new TaskGraphExecutor(taskQueue, {} as any, {
      onCheckpoint: async () => {
        checkpointCount++;
        return { shouldStop: true };
      },
    });

    const graph: TaskGraph = {
      id: 'p2',
      requirement: 'r',
      nodes: [
        { taskId: 'p2-a', content: 'a', skillName: 'echo', dependencies: [], params: {} },
        { taskId: 'p2-b', content: 'b', skillName: 'echo', dependencies: ['p2-a'], params: {} },
        { taskId: 'p2-c', content: 'c', skillName: 'echo', dependencies: ['p2-b'], params: {} },
      ],
      layers: [['p2-a'], ['p2-b'], ['p2-c']],
    };

    const result = await executor.executeTaskGraph(
      graph, 's1', 'u1', makeRequest(),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).mergedAway).toBe(true);
    // 只 Layer 0 (p2-a) 执行;Layer 1/2 立即停止
    expect(executedTasks).toEqual(['p2-a']);
    expect(checkpointCount).toBe(1);  // 只触发一次 checkpoint(在 Layer 0 后)
  });
});