/**
 * P1-2 修复测试:用户切换话题时,AskAgent 挂起原请求并清理 TaskQueue 残留任务。
 *
 * 覆盖:
 *  1. 挂起后,TaskQueue 中原请求的 pending 任务被移除
 *  2. 已 completed 的任务不受影响(removePendingTask 只动 pending)
 *  3. 没有 TaskQueue 注入时也能正常工作(向后兼容)
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AskAgent } from '../src/agents/ask-agent';
import { SessionStore } from '../src/memory/session-store';
import { TaskQueue } from '../src/task-queue';
import { QAEntry } from '../src/types';

describe('AskAgent suspend 清理 TaskQueue 残留 (P1-2)', () => {
  let dataDir: string;
  let sessionStore: SessionStore;
  let taskQueue: TaskQueue;
  let askAgent: AskAgent;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `p12-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(dataDir, { recursive: true });
    sessionStore = new SessionStore(100, dataDir);
    taskQueue = new TaskQueue(async () => ({ ok: true }));
    askAgent = new AskAgent(sessionStore, {} as any, taskQueue);
  });

  /** 构造一个 waiting 请求(主智能体询问),模拟用户先发了 R1 后被询问 */
  async function seedWaitingRequest(userId: string, sessionId: string) {
    const session = await sessionStore.loadSession(userId, sessionId);
    const requestId = 'r1';
    const questionId = 'q1';
    const qa: QAEntry = {
      questionId,
      content: '请确认系统?',
      source: 'main_agent',
      taskId: null,
      skillName: null,
      answer: null,
      answeredAt: null,
      createdAt: new Date().toISOString(),
    };
    session.requests.push({
      requestId,
      content: 'parent message',
      status: 'waiting',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      suspendedAt: null,
      suspendedReason: null,
      questions: [qa],
      currentQuestion: qa,
      tasks: [],
      result: null,
    });
    session.activeRequestId = requestId;
    await sessionStore.saveSession(userId, sessionId, session);
    return { requestId, questionId };
  }

  test('挂起时清理原请求的 pending 任务', async () => {
    const userId = 'u1';
    const sessionId = 's1';
    await seedWaitingRequest(userId, sessionId);

    // 在 TaskQueue 中放入原请求的一个 pending 任务
    const pendingTask = {
      id: 'r1-t1',
      requirement: 'pending work',
      status: 'pending' as const,
      skillName: 'echo',
      params: {},
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      questionHistory: [],
    };
    // 直接加入 tasks Map(status=pending),不触发 processQueue
    (taskQueue as any).tasks.set('r1-t1', pendingTask);

    // 把这个 task 也写到 session.tasks(挂起时会扫描它)
    const session = await sessionStore.loadSession(userId, sessionId);
    session.requests[0].tasks.push({
      taskId: 'r1-t1',
      content: 'pending work',
      status: 'pending',
      skillName: 'echo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      questions: [],
      currentQuestion: null,
    });
    await sessionStore.saveSession(userId, sessionId, session);

    expect(taskQueue.getTask('r1-t1')).toBeDefined();

    // 用户切换话题:handleUserInput 应该挂起 R1 并清理 pending
    const judgeContinuation = (askAgent as any).judgeContinuation.bind(askAgent);
    (askAgent as any).judgeContinuation = async () => ({ isContinuation: false, confidence: 0.9, reason: 'topic switch' });

    const result = await askAgent.handleUserInput(userId, sessionId, 'new topic');

    expect(result.type).toBe('new_request');
    // 原请求应被挂起
    const afterSession = await sessionStore.loadSession(userId, sessionId);
    const r1 = afterSession.requests.find(r => r.requestId === 'r1');
    expect(r1?.status).toBe('suspended');
    // pending 任务应被清理
    expect(taskQueue.getTask('r1-t1')).toBeUndefined();

    // 还原 judgeContinuation(避免污染其他测试)
    (askAgent as any).judgeContinuation = judgeContinuation;
  });

  test('挂起时已 completed 的任务不受影响', async () => {
    const userId = 'u2';
    const sessionId = 's2';
    await seedWaitingRequest(userId, sessionId);

    // completed 任务(子智能体返回 waiting_user_input 时 TaskQueue 是 completed)
    const completedTask = {
      id: 'r1-completed',
      requirement: 'done',
      status: 'completed' as const,
      skillName: 'echo',
      params: {},
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      completedAt: new Date(),
      result: { ok: true },
      questionHistory: [],
    };
    (taskQueue as any).tasks.set('r1-completed', completedTask);

    // session.tasks 也记录
    const session = await sessionStore.loadSession(userId, sessionId);
    session.requests[0].tasks.push({
      taskId: 'r1-completed',
      content: 'done',
      status: 'completed',
      skillName: 'echo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: 'done',
      questions: [],
      currentQuestion: null,
    });
    await sessionStore.saveSession(userId, sessionId, session);

    (askAgent as any).judgeContinuation = async () => ({ isContinuation: false, confidence: 0.9, reason: 'switch' });
    await askAgent.handleUserInput(userId, sessionId, 'new');

    // completed 任务不应被 remove(removePendingTask 只删 pending)
    expect(taskQueue.getTask('r1-completed')).toBeDefined();
  });

  test('无 TaskQueue 注入时仍可正常工作(向后兼容)', async () => {
    // 不传 taskQueue
    const minimalAskAgent = new AskAgent(sessionStore, {} as any);
    const userId = 'u3';
    const sessionId = 's3';
    await seedWaitingRequest(userId, sessionId);

    (minimalAskAgent as any).judgeContinuation = async () => ({ isContinuation: false, confidence: 0.9, reason: 'switch' });

    const result = await minimalAskAgent.handleUserInput(userId, sessionId, 'new');
    expect(result.type).toBe('new_request');

    const afterSession = await sessionStore.loadSession(userId, sessionId);
    const r1 = afterSession.requests.find(r => r.requestId === 'r1');
    expect(r1?.status).toBe('suspended');
  });
});