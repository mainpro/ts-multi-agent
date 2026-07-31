/**
 * TaskGraphExecutor 回写 task 状态到 session 测试
 *
 * 覆盖:
 *  - 成功任务回写 status='completed'
 *  - 失败任务回写 status='failed'
 *  - 回写后 syncRequestStatus 推出 'completed'(而非 'processing')
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../src/memory/session-store';
import { TaskQueue } from '../src/task-queue';
import { TaskGraphExecutor } from '../src/agents/task-graph-executor';
import { ResultAggregator } from '../src/agents/result-aggregator';
import { Request, TaskGraph, TaskGraphNode } from '../src/types';

describe('TaskGraphExecutor 回写 task 状态', () => {
  let dataDir: string;
  let sessionStore: SessionStore;
  let taskQueue: TaskQueue;
  let executor: TaskGraphExecutor;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `tgw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(dataDir, { recursive: true });
    sessionStore = new SessionStore(100, dataDir);
  });

  function buildRequest(id: string): Request {
    const now = new Date().toISOString();
    return {
      requestId: id,
      content: 'test req',
      status: 'processing',
      createdAt: now,
      updatedAt: now,
      suspendedAt: null,
      suspendedReason: null,
      questions: [],
      currentQuestion: null,
      tasks: [],
      result: null,
    };
  }

  function buildGraph(planId: string, taskIds: string[]): TaskGraph {
    const nodes: TaskGraphNode[] = taskIds.map((id, idx) => ({
      taskId: `${planId}-${id}`,
      content: `task ${idx + 1}`,
      skillName: 'echo',
      dependencies: idx === 0 ? [] : [`${planId}-${taskIds[idx - 1]}`],
      params: {},
    }));
    return {
      id: planId,
      requirement: 'test',
      nodes,
      layers: taskIds.map(id => [`${planId}-${id}`]),
    };
  }

  test('单任务成功 → session.tasks[0].status = completed', async () => {
    taskQueue = new TaskQueue(async () => ({
      data: { response: 'hello', status: 'completed' },
    }));
    const resultAggregator = new ResultAggregator(
      {} as any, sessionStore, sessionStore, () => Promise.resolve({} as any),
    );
    executor = new TaskGraphExecutor(taskQueue, resultAggregator, sessionStore);

    const userId = 'u1';
    const sessionId = 's1';
    const session = await sessionStore.loadSession(userId, sessionId);
    const request = buildRequest('req-1');
    session.requests.push(request);
    session.activeRequestId = request.requestId;
    await sessionStore.saveSession(userId, sessionId, session);

    // 先添加 task 到 session(模拟 processNormalRequirement 的行为)
    await sessionStore.addTaskToRequest(userId, sessionId, request.requestId, {
      taskId: 'plan-1-task-1',
      content: 'task 1',
      status: 'pending',
      skillName: 'echo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      questions: [],
      currentQuestion: null,
    });

    const graph = buildGraph('plan-1', ['task-1']);
    await executor.executeTaskGraph(graph, sessionId, userId, request);

    const after = await sessionStore.loadSession(userId, sessionId);
    expect(after.requests[0].tasks[0].status).toBe('completed');
    // 关键:syncRequestStatus 现在能推出 'completed'(而非 'processing'),
    // 让 completeRequest 走完正确路径(activeRequestId 由 MainAgent.completeRequest 清,
    // 这里只验证 task 状态回写正确)
  });

  test('失败任务 → session.tasks[0].status = failed', async () => {
    taskQueue = new TaskQueue(async () => {
      throw new Error('boom');
    });
    const resultAggregator = new ResultAggregator(
      {} as any, sessionStore, sessionStore, () => Promise.resolve({} as any),
    );
    executor = new TaskGraphExecutor(taskQueue, resultAggregator, sessionStore);

    const userId = 'u2';
    const sessionId = 's2';
    const session = await sessionStore.loadSession(userId, sessionId);
    const request = buildRequest('req-2');
    session.requests.push(request);
    session.activeRequestId = request.requestId;
    await sessionStore.saveSession(userId, sessionId, session);

    await sessionStore.addTaskToRequest(userId, sessionId, request.requestId, {
      taskId: 'plan-2-task-1',
      content: 'task 1',
      status: 'pending',
      skillName: 'echo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      questions: [],
      currentQuestion: null,
    });

    const graph = buildGraph('plan-2', ['task-1']);

    try {
      await executor.executeTaskGraph(graph, sessionId, userId, request);
    } catch (e) {
      // 预期抛出 SkillError
    }

    const after = await sessionStore.loadSession(userId, sessionId);
    expect(after.requests[0].tasks[0].status).toBe('failed');
  });

  test('多任务:部分成功部分失败 → 每个 task 状态正确回写', async () => {
    let callCount = 0;
    taskQueue = new TaskQueue(async () => {
      callCount++;
      if (callCount === 1) {
        return { data: { response: 'ok', status: 'completed' } };
      }
      throw new Error('boom');
    });
    const resultAggregator = new ResultAggregator(
      {} as any, sessionStore, sessionStore, () => Promise.resolve({} as any),
    );
    executor = new TaskGraphExecutor(taskQueue, resultAggregator, sessionStore);

    const userId = 'u3';
    const sessionId = 's3';
    const session = await sessionStore.loadSession(userId, sessionId);
    const request = buildRequest('req-3');
    session.requests.push(request);
    session.activeRequestId = request.requestId;
    await sessionStore.saveSession(userId, sessionId, session);

    for (const tid of ['task-1', 'task-2']) {
      await sessionStore.addTaskToRequest(userId, sessionId, request.requestId, {
        taskId: `plan-3-${tid}`,
        content: tid,
        status: 'pending',
        skillName: 'echo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        result: null,
        questions: [],
        currentQuestion: null,
      });
    }

    const graph = buildGraph('plan-3', ['task-1', 'task-2']);

    try {
      await executor.executeTaskGraph(graph, sessionId, userId, request);
    } catch (e) {
      // 预期
    }

    const after = await sessionStore.loadSession(userId, sessionId);
    // task-1 成功,应 completed
    const t1 = after.requests[0].tasks.find(t => t.taskId === 'plan-3-task-1');
    const t2 = after.requests[0].tasks.find(t => t.taskId === 'plan-3-task-2');
    expect(t1?.status).toBe('completed');
    expect(t2?.status).toBe('failed');
  });
});