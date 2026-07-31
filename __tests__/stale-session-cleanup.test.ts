/**
 * 方案 A: 修 activeRequestId 卡死测试
 *
 * 覆盖:
 *  - SessionStore.cleanupStaleSessions: 把 dangling / processing 卡死请求清理
 *  - SessionGate.decide: stale processing 请求按 fresh 处理(短期 fallback)
 *  - 正常 waiting/suspended/checkpoint_reached 不被误清
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../src/memory/session-store';
import { SessionGate } from '../src/agents/session-gate';
import { Request } from '../src/types';

describe('方案 A: activeRequestId 卡死修复', () => {
  let dataDir: string;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `stale-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
    sessionStore = new SessionStore(100, dataDir);
  });

  // 工具:写入一个 session.json 文件(模拟进程崩溃后的磁盘残留)
  async function writeRawSession(userId: string, sessionId: string, sessionData: any): Promise<void> {
    const dir = path.join(dataDir, 'memory', userId, 'session');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(sessionData, null, 2));
  }

  function makeRequest(id: string, status: Request['status'], updatedAt: string): Request {
    return {
      requestId: id,
      content: 'test',
      status,
      createdAt: updatedAt,
      updatedAt,
      suspendedAt: null,
      suspendedReason: null,
      questions: [],
      currentQuestion: null,
      tasks: [],
      result: null,
    };
  }

  describe('cleanupStaleSessions', () => {
    test('processing 卡死请求 → 标记为 failed 并清 activeRequestId', async () => {
      await writeRawSession('u1', 's1', {
        sessionId: 's1',
        userId: 'u1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        activeRequestId: 'req-stuck',
        pendingRequests: [],
        requests: [makeRequest('req-stuck', 'processing', '2026-01-01T00:00:00Z')],
      });

      const result = await sessionStore.cleanupStaleSessions();
      expect(result.cleaned).toBe(1);
      expect(result.details[0].action).toBe('marked-failed');

      // 验证 session 状态
      const session = await sessionStore.loadSession('u1', 's1');
      expect(session.activeRequestId).toBeNull();
      expect(session.requests[0].status).toBe('failed');
      expect(session.requests[0].result).toContain('进程重启');
    });

    test('dangling activeRequestId(指向不存在的 request) → 清空', async () => {
      await writeRawSession('u2', 's2', {
        sessionId: 's2',
        userId: 'u2',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        activeRequestId: 'req-ghost',
        pendingRequests: [],
        requests: [makeRequest('req-real', 'completed', '2026-01-01T00:00:00Z')],
      });

      const result = await sessionStore.cleanupStaleSessions();
      expect(result.cleaned).toBe(1);
      expect(result.details[0].action).toBe('cleared');

      const session = await sessionStore.loadSession('u2', 's2');
      expect(session.activeRequestId).toBeNull();
    });

    test('waiting / suspended / checkpoint_reached → 不动', async () => {
      const statuses: Request['status'][] = ['waiting', 'suspended', 'checkpoint_reached'];
      for (let i = 0; i < statuses.length; i++) {
        const sid = `s-${i}`;
        await writeRawSession(`u${i}`, sid, {
          sessionId: sid,
          userId: `u${i}`,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          activeRequestId: `req-${i}`,
          pendingRequests: [],
          requests: [makeRequest(`req-${i}`, statuses[i], '2026-01-01T00:00:00Z')],
        });
      }

      const result = await sessionStore.cleanupStaleSessions();
      expect(result.cleaned).toBe(0);

      // 所有 session 保持不变
      for (let i = 0; i < statuses.length; i++) {
        const session = await sessionStore.loadSession(`u${i}`, `s-${i}`);
        expect(session.activeRequestId).toBe(`req-${i}`);
      }
    });

    test('没有 activeRequestId → no-op', async () => {
      await writeRawSession('u3', 's3', {
        sessionId: 's3',
        userId: 'u3',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        activeRequestId: null,
        pendingRequests: [],
        requests: [makeRequest('req-old', 'completed', '2026-01-01T00:00:00Z')],
      });

      const result = await sessionStore.cleanupStaleSessions();
      expect(result.cleaned).toBe(0);
    });

    test('dataDir 不存在 → no-op(不抛错)', async () => {
      const emptyStore = new SessionStore(100, path.join(dataDir, 'nonexistent'));
      const result = await emptyStore.cleanupStaleSessions();
      expect(result.cleaned).toBe(0);
    });

    test('混合:一个 processing + 一个 waiting + 一个正常 → 只清 processing', async () => {
      await writeRawSession('u4', 's4', {
        sessionId: 's4',
        userId: 'u4',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        activeRequestId: 'req-processing',
        pendingRequests: [],
        requests: [
          makeRequest('req-processing', 'processing', '2026-01-01T00:00:00Z'),
          makeRequest('req-waiting', 'waiting', '2026-01-01T00:00:00Z'),
          makeRequest('req-done', 'completed', '2026-01-01T00:00:00Z'),
        ],
      });

      const result = await sessionStore.cleanupStaleSessions();
      expect(result.cleaned).toBe(1);
      expect(result.details[0].requestId).toBe('req-processing');

      const session = await sessionStore.loadSession('u4', 's4');
      expect(session.activeRequestId).toBeNull();
      expect(session.requests.find(r => r.requestId === 'req-processing')!.status).toBe('failed');
      expect(session.requests.find(r => r.requestId === 'req-waiting')!.status).toBe('waiting');
    });
  });

  describe('SessionGate.decide stale 检测', () => {
    test('processing 请求 last update 在阈值内 → 仍然 queue', async () => {
      await writeRawSession('u5', 's5', {
        sessionId: 's5', userId: 'u5',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        activeRequestId: 'req-active',
        pendingRequests: [],
        requests: [makeRequest('req-active', 'processing', new Date().toISOString())],
      });

      const gate = new SessionGate(sessionStore);
      const decision = await gate.decide('u5', 's5', {
        draftId: 'd1', requirement: 'r', hasImage: false,
      });
      expect(decision.type).toBe('queue');
    });

    test('processing 请求 last update 超过阈值 → 按 fresh 处理', async () => {
      const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      await writeRawSession('u6', 's6', {
        sessionId: 's6', userId: 'u6',
        createdAt: staleTimestamp, updatedAt: staleTimestamp,
        activeRequestId: 'req-stale',
        pendingRequests: [],
        requests: [makeRequest('req-stale', 'processing', staleTimestamp)],
      });

      const gate = new SessionGate(sessionStore);
      const decision = await gate.decide('u6', 's6', {
        draftId: 'd1', requirement: 'r', hasImage: false,
      });
      // stale processing 应被识别为 fresh,不再 queue
      expect(decision.type).toBe('fresh');
    });

    test('waiting 请求不管更新时间 → continue_waiting', async () => {
      const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
      await writeRawSession('u7', 's7', {
        sessionId: 's7', userId: 'u7',
        createdAt: staleTimestamp, updatedAt: staleTimestamp,
        activeRequestId: 'req-wait',
        pendingRequests: [],
        requests: [makeRequest('req-wait', 'waiting', staleTimestamp)],
      });

      const gate = new SessionGate(sessionStore);
      const decision = await gate.decide('u7', 's7', {
        draftId: 'd1', requirement: 'r', hasImage: false,
      });
      // waiting 不受 stale 检测影响
      expect(decision.type).toBe('continue_waiting');
    });

    test('suspended 请求不管更新时间 → queue', async () => {
      const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await writeRawSession('u8', 's8', {
        sessionId: 's8', userId: 'u8',
        createdAt: staleTimestamp, updatedAt: staleTimestamp,
        activeRequestId: 'req-susp',
        pendingRequests: [],
        requests: [makeRequest('req-susp', 'suspended', staleTimestamp)],
      });

      const gate = new SessionGate(sessionStore);
      const decision = await gate.decide('u8', 's8', {
        draftId: 'd1', requirement: 'r', hasImage: false,
      });
      // suspended 不在 stale 检测范围,按 queue
      expect(decision.type).toBe('queue');
    });
  });
});