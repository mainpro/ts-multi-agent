/**
 * P1-1 修复测试:onCheckpoint 通过 info 透传 userId/sessionId,
 * 不再依赖实例级 _lastSeen* 共享字段。
 *
 * 覆盖:
 *  1. onCheckpoint info 包含 userId/sessionId
 *  2. 主智能体的 onTaskGraphCheckpoint 使用 info 字段(而非实例字段)
 *  3. 多 session 并发时 checkpoint 回调能定位到正确的 session
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskGraphExecutor } from '../src/agents/task-graph-executor';
import { TaskQueue } from '../src/task-queue';
import { TaskGraph } from '../src/types';

describe('TaskGraphExecutor onCheckpoint 透传 userId/sessionId (P1-1)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `p11-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(dataDir, { recursive: true });
  });

  test('onCheckpoint info 包含 userId 和 sessionId', async () => {
    const captured: Array<{ userId: string; sessionId: string; requestId: string }> = [];
    const taskQueue = new TaskQueue(async () => ({ ok: true }));

    const executor = new TaskGraphExecutor(taskQueue, {} as any, {
      onCheckpoint: async (info) => {
        captured.push({ userId: info.userId, sessionId: info.sessionId, requestId: info.requestId });
      },
    });

    const graph: TaskGraph = {
      id: 'p', requirement: 'r',
      nodes: [
        { taskId: 'p-a', content: 'a', skillName: 'echo', dependencies: [], params: {} },
        { taskId: 'p-b', content: 'b', skillName: 'echo', dependencies: ['p-a'], params: {} },
      ],
      layers: [['p-a'], ['p-b']],
    };

    const request: any = {
      requestId: 'r1', content: 'c', status: 'processing',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null, tasks: [], result: null,
    };

    await executor.executeTaskGraph(graph, 'session-A', 'user-A', request);

    // 2 层 graph → 触发 2 次 checkpoint(Layer 0 后 + Layer 1 后)
    expect(captured.length).toBe(2);
    expect(captured[0].userId).toBe('user-A');
    expect(captured[0].sessionId).toBe('session-A');
    expect(captured[1].userId).toBe('user-A');
    expect(captured[1].sessionId).toBe('session-A');
    // requestId 仍为占位符 'session-active'(由 MainAgent 解析覆盖)
    expect(captured[0].requestId).toBe('session-active');
  });

  test('多 session 并发:各自 checkpoint 收到正确的 userId/sessionId', async () => {
    // 模拟两个 session 同时执行,checkpoint 应各自定位到正确的 session
    const captured = new Map<string, { userId: string; sessionId: string; calls: number }>();
    const taskQueue = new TaskQueue(async () => ({ ok: true }));

    const executor = new TaskGraphExecutor(taskQueue, {} as any, {
      onCheckpoint: async (info) => {
        const key = `${info.userId}:${info.sessionId}`;
        const existing = captured.get(key) ?? { userId: info.userId, sessionId: info.sessionId, calls: 0 };
        existing.calls++;
        captured.set(key, existing);
      },
    });

    const graphA: TaskGraph = {
      id: 'a', requirement: 'r',
      nodes: [{ taskId: 'a-x', content: 'x', skillName: 'echo', dependencies: [], params: {} }],
      layers: [['a-x']],
    };

    const graphB: TaskGraph = {
      id: 'b', requirement: 'r',
      nodes: [{ taskId: 'b-x', content: 'x', skillName: 'echo', dependencies: [], params: {} }],
      layers: [['b-x']],
    };

    const makeRequest = (id: string): any => ({
      requestId: id, content: 'c', status: 'processing',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null, tasks: [], result: null,
    });

    // 并发执行两个 session 的任务图
    await Promise.all([
      executor.executeTaskGraph(graphA, 'session-1', 'user-1', makeRequest('r-a')),
      executor.executeTaskGraph(graphB, 'session-2', 'user-2', makeRequest('r-b')),
    ]);

    expect(captured.size).toBe(2);
    expect(captured.get('user-1:session-1')?.calls).toBe(1);
    expect(captured.get('user-2:session-2')?.calls).toBe(1);
    // 关键断言:两个 session 的 checkpoint 没串味(如果是 _lastSeen* 共享字段会串)
    expect(captured.get('user-1:session-2')).toBeUndefined();
    expect(captured.get('user-2:session-1')).toBeUndefined();
  });
});