/**
 * completeRequest 必须清理 activeRequestId 测试
 *
 * 覆盖:
 *  - status='completed' (derived from all-completed tasks) → 清 activeRequestId
 *  - status='processing' (tasks still pending, 但 completeRequest 被调用) → 强制清 activeRequestId
 *  - status='failed' (derived) → 清 activeRequestId (防御性)
 *  - activeRequestId 不匹配 → 不清
 *  - waiting 状态不调用 completeRequest(本测试不覆盖此路径)
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../src/memory/session-store';
import { Request } from '../src/types';

describe('completeRequest 必须清理 activeRequestId', () => {
  let dataDir: string;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `complete-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
    sessionStore = new SessionStore(100, dataDir);
  });

  async function seedSession(userId: string, sessionId: string, request: Request): Promise<void> {
    const session = await sessionStore.loadSession(userId, sessionId);
    session.requests.push(request);
    session.activeRequestId = request.requestId;
    await sessionStore.saveSession(userId, sessionId, session);
  }

  function makeRequest(id: string, options: {
    tasks?: Request['tasks'];
    status?: Request['status'];
  } = {}): Request {
    const now = new Date().toISOString();
    return {
      requestId: id,
      content: 'test',
      status: options.status ?? 'processing',
      createdAt: now,
      updatedAt: now,
      suspendedAt: null,
      suspendedReason: null,
      questions: [],
      currentQuestion: null,
      tasks: options.tasks ?? [],
      result: null,
    };
  }

  function makeTask(taskId: string, status: 'pending' | 'running' | 'completed' | 'failed') {
    return {
      taskId,
      content: 'task',
      status,
      skillName: 'echo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      questions: [],
      currentQuestion: null,
    };
  }

  test('正常路径:tasks 全 completed → derived status=completed → 清 activeRequestId', async () => {
    await seedSession('u1', 's1', makeRequest('req-1', {
      tasks: [makeTask('t1', 'completed'), makeTask('t2', 'completed')],
    }));

    await sessionStore.completeRequest('u1', 's1', 'req-1', 'result text');
    const session = await sessionStore.loadSession('u1', 's1');
    expect(session.activeRequestId).toBeNull();
    expect(session.requests[0].status).toBe('completed');
    expect(session.requests[0].result).toBe('result text');
  });

  test('Bug 复现路径:task 仍是 pending,completeRequest 被调用 → 仍清 activeRequestId', async () => {
    // 模拟 TaskGraphExecutor 没回写 task 状态的 bug 场景
    await seedSession('u1', 's1', makeRequest('req-stuck', {
      tasks: [makeTask('t1', 'pending')],
    }));

    await sessionStore.completeRequest('u1', 's1', 'req-stuck', 'response text');
    const session = await sessionStore.loadSession('u1', 's1');
    // 关键断言:activeRequestId 必须被清,即使 derived status 是 'processing'
    expect(session.activeRequestId).toBeNull();
    expect(session.requests[0].result).toBe('response text');
  });

  test('无 task 的请求 → status=completed → 清 activeRequestId', async () => {
    await seedSession('u2', 's2', makeRequest('req-2', { tasks: [] }));

    await sessionStore.completeRequest('u2', 's2', 'req-2', 'result');
    const session = await sessionStore.loadSession('u2', 's2');
    expect(session.activeRequestId).toBeNull();
    expect(session.requests[0].status).toBe('completed');
  });

  test('部分 task failed → derived status=failed → 仍清 activeRequestId(防御性)', async () => {
    await seedSession('u3', 's3', makeRequest('req-3', {
      tasks: [makeTask('t1', 'completed'), makeTask('t2', 'failed')],
    }));

    await sessionStore.completeRequest('u3', 's3', 'req-3', 'partial result');
    const session = await sessionStore.loadSession('u3', 's3');
    expect(session.activeRequestId).toBeNull();
    // status derived as failed because some task failed
    expect(session.requests[0].status).toBe('failed');
  });

  test('activeRequestId 不匹配 → 不清(防御性)', async () => {
    // session.activeRequestId 指向 req-other, 但 completeRequest 被调用于 req-stuck
    await seedSession('u4', 's4', makeRequest('req-other', {
      tasks: [makeTask('t1', 'completed')],
    }));
    const session = await sessionStore.loadSession('u4', 's4');
    session.requests.push(makeRequest('req-stuck', { tasks: [] }));
    await sessionStore.saveSession('u4', 's4', session);

    // 完成 req-stuck,但 activeRequestId 指向 req-other,不能误清
    await sessionStore.completeRequest('u4', 's4', 'req-stuck', 'result');
    const afterSession = await sessionStore.loadSession('u4', 's4');
    expect(afterSession.activeRequestId).toBe('req-other');
  });

  test('重复调用 completeRequest → 不会清错(幂等)', async () => {
    await seedSession('u5', 's5', makeRequest('req-5', { tasks: [] }));

    await sessionStore.completeRequest('u5', 's5', 'req-5', 'first');
    await sessionStore.completeRequest('u5', 's5', 'req-5', 'second');

    const session = await sessionStore.loadSession('u5', 's5');
    expect(session.activeRequestId).toBeNull();
    // 后一次覆盖前一次
    expect(session.requests[0].result).toBe('second');
  });

  test('集成场景:pendingRequests 不影响 completeRequest 的清理逻辑', async () => {
    // 模拟:之前有请求排队,现在 active request 完成了
    const session = await sessionStore.loadSession('u6', 's6');
    session.requests.push(makeRequest('req-active', { tasks: [makeTask('t1', 'pending')] }));
    session.activeRequestId = 'req-active';
    session.pendingRequests.push({
      draftId: 'd-1',
      requirement: 'stale pending',
      enqueuedAt: new Date().toISOString(),
      hasImage: false,
    });
    await sessionStore.saveSession('u6', 's6', session);

    await sessionStore.completeRequest('u6', 's6', 'req-active', 'response');
    const afterSession = await sessionStore.loadSession('u6', 's6');
    // activeRequestId 必须清
    expect(afterSession.activeRequestId).toBeNull();
    // pendingRequests 不被清(它有自己的 drain 逻辑,这里不该动)
    expect(afterSession.pendingRequests.length).toBe(1);
  });
});