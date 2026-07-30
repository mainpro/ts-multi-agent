/**
 * executionProgress 完成态持久化测试
 *
 * 覆盖:
 *  - SessionStore.saveExecutionProgress 立即刷盘 + 持久化
 *  - 完成态(成功)后 getSessionHistory.executionProgress 包含完整 DAG
 *  - 多次 saveExecutionProgress 互相覆盖(最终态生效)
 *  - TaskGraph 序列化/反序列化 round-trip 正确性
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../src/memory/session-store';
import { Request, TaskGraph, TaskGraphNode } from '../src/types';

describe('executionProgress 完成态持久化 (P3)', () => {
  let dataDir: string;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `ep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(dataDir, { recursive: true });
    sessionStore = new SessionStore(100, dataDir);
  });

  async function seedRequest(userId: string, sessionId: string, requestId: string): Promise<Request> {
    const session = await sessionStore.loadSession(userId, sessionId);
    const request: Request = {
      requestId,
      content: 'test request',
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
    session.requests.push(request);
    session.activeRequestId = requestId;
    await sessionStore.saveSession(userId, sessionId, session);
    return request;
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
      // 每层 1 个任务(线性依赖)
      layers: taskIds.map(id => [`${planId}-${id}`]),
    };
  }

  test('saveExecutionProgress: 立即刷盘 + 持久化', async () => {
    const userId = 'u1';
    const sessionId = 's1';
    await seedRequest(userId, sessionId, 'req-1');

    const graph = buildGraph('plan-1', ['t1', 't2', 't3']);
    const completedResults = {
      'plan-1-t1': { response: 'r1' },
      'plan-1-t2': { response: 'r2' },
    };

    await sessionStore.saveExecutionProgress(userId, sessionId, 'req-1', {
      currentLayerIndex: 3,
      completedResults,
      taskGraph: graph,
    });

    // 重新加载 session,确认 progress 已落盘
    const session = await sessionStore.loadSession(userId, sessionId);
    const req = session.requests.find(r => r.requestId === 'req-1')!;
    expect(req.executionProgress).toBeDefined();
    expect(req.executionProgress!.currentLayerIndex).toBe(3);
    expect(req.executionProgress!.completedResults).toEqual(completedResults);
    expect(req.executionProgress!.taskGraph.id).toBe('plan-1');
    expect(req.executionProgress!.taskGraph.nodes.length).toBe(3);
    expect(req.executionProgress!.taskGraph.layers).toEqual([['plan-1-t1'], ['plan-1-t2'], ['plan-1-t3']]);
  });

  test('TaskGraph round-trip: 序列化 → 反序列化 后结构保持一致', async () => {
    const userId = 'u2';
    const sessionId = 's2';
    await seedRequest(userId, sessionId, 'req-2');

    const graph = buildGraph('plan-2', ['t1', 't2']);
    await sessionStore.saveExecutionProgress(userId, sessionId, 'req-2', {
      currentLayerIndex: 2,
      completedResults: { 'plan-2-t1': { data: 'ok' } },
      taskGraph: graph,
    });

    // 读原始 session.json 验证落盘格式
    const filePath = path.join(dataDir, 'memory', userId, 'session', `${sessionId}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const persisted = parsed.requests[0].executionProgress;

    expect(persisted.taskGraph.id).toBe('plan-2');
    expect(persisted.taskGraph.nodes).toBeInstanceOf(Array);
    expect(persisted.taskGraph.nodes.length).toBe(2);
    expect(persisted.taskGraph.layers).toBeInstanceOf(Array);
    expect(persisted.completedResults).toEqual({ 'plan-2-t1': { data: 'ok' } });
  });

  test('多次 saveExecutionProgress: 最终态生效(覆盖)', async () => {
    const userId = 'u3';
    const sessionId = 's3';
    await seedRequest(userId, sessionId, 'req-3');

    const graph1 = buildGraph('plan-3', ['t1']);
    await sessionStore.saveExecutionProgress(userId, sessionId, 'req-3', {
      currentLayerIndex: 0,
      completedResults: {},
      taskGraph: graph1,
    });

    const graph2 = buildGraph('plan-3', ['t1', 't2']);
    await sessionStore.saveExecutionProgress(userId, sessionId, 'req-3', {
      currentLayerIndex: 2,
      completedResults: { 'plan-3-t1': { done: true } },
      taskGraph: graph2,
    });

    const session = await sessionStore.loadSession(userId, sessionId);
    const req = session.requests.find(r => r.requestId === 'req-3')!;
    expect(req.executionProgress!.currentLayerIndex).toBe(2);
    expect(req.executionProgress!.taskGraph.nodes.length).toBe(2);
    expect(req.executionProgress!.completedResults).toEqual({ 'plan-3-t1': { done: true } });
  });

  test('saveExecutionProgress: 不存在的 requestId → 静默 no-op(不抛错)', async () => {
    const userId = 'u4';
    const sessionId = 's4';
    await seedRequest(userId, sessionId, 'req-real');

    const graph = buildGraph('plan-4', ['t1']);
    await expect(
      sessionStore.saveExecutionProgress(userId, sessionId, 'req-does-not-exist', {
        currentLayerIndex: 1,
        completedResults: {},
        taskGraph: graph,
      }),
    ).resolves.toBeUndefined();

    // 真实 request 不受影响
    const session = await sessionStore.loadSession(userId, sessionId);
    const req = session.requests.find(r => r.requestId === 'req-real')!;
    expect(req.executionProgress).toBeUndefined();
  });

  test('saveExecutionProgress: 立即刷盘(不走防抖)', async () => {
    const userId = 'u5';
    const sessionId = 's5';
    await seedRequest(userId, sessionId, 'req-5');

    const graph = buildGraph('plan-5', ['t1']);
    await sessionStore.saveExecutionProgress(userId, sessionId, 'req-5', {
      currentLayerIndex: 1,
      completedResults: { 'plan-5-t1': { ok: true } },
      taskGraph: graph,
    });

    // 立即读 session.json 确认已落盘(不依赖 debounce)
    const filePath = path.join(dataDir, 'memory', userId, 'session', `${sessionId}.json`);
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.requests[0].executionProgress.taskGraph.id).toBe('plan-5');
  });
});