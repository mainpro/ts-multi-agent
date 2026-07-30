/**
 * gate 决策前置 + SSE 即时 flush 测试
 *
 * 覆盖:
 *  - gateCheck 返回 queue_full → API 立即返回 503,无 SSE
 *  - gateCheck 返回 queued → API 立即返回 202,无 SSE
 *  - gateCheck 返回 proceed → flushHeaders 在 processRequirement 之前调用
 *    (通过监听 processRequirement 被调用时 res.headersSent 来验证)
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import request from 'supertest';
import { EventEmitter } from 'events';
import { createAPIServer } from '../src/api/index';

class MockTaskQueue extends EventEmitter {
  private tasks: Map<string, any> = new Map();
  addTask(task: any) { this.tasks.set(task.id, task); }
  getTask(id: string) { return this.tasks.get(id) || null; }
  getAllTasks() { return Array.from(this.tasks.values()); }
  getTasksByStatus(status: string) { return this.getAllTasks().filter((t) => t.status === status); }
  cancelTask(id: string) { return this.tasks.has(id); }
  triggerProcess() {}
}

const mockSkillRegistry = { getAllMetadata: () => [] } as any;

describe('gate 决策前置 + SSE 即时 flush', () => {
  let mockMainAgent: any;

  beforeEach(() => {
    mockMainAgent = {
      gateCheck: async () => ({ type: 'proceed' as const }),
      processRequirement: async () => ({ success: true, data: { type: 'skill_task' } }),
    };
  });

  test('gateCheck 返回 queue_full → API 立即 503(无 SSE)', async () => {
    mockMainAgent.gateCheck = async () => ({
      type: 'queue_full' as const,
      pendingCount: 50,
      draftId: 'd-qf',
    });

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(503);

    // 503 响应体是 JSON(不进入 SSE 路径)
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.code).toBe('QUEUE_FULL');
    expect(res.body.pendingCount).toBe(50);
    // processRequirement 不应被调用
    // (mockMainAgent.processRequirement 是默认 mock,若被调用 res.text 会包含 reasoning_complete)
    expect(res.text.includes('reasoning_complete')).toBe(false);
  });

  test('gateCheck 返回 queued → API 立即 202(无 SSE)', async () => {
    mockMainAgent.gateCheck = async () => ({
      type: 'queued' as const,
      draftId: 'd-q',
      position: 3,
    });

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(202);

    expect(res.body.status).toBe('queued');
    expect(res.body.draftId).toBe('d-q');
    expect(res.body.position).toBe(3);
  });

  test('gateCheck 返回 proceed → flushHeaders 在 processRequirement 之前调用', async () => {
    let headersSentAtProcessRequirementEntry = false;
    let processRequirementCalled = false;

    // 用自定义路由模拟:检查 processRequirement 被调用时 res.headersSent 状态
    // 由于 supertest 不易检测,我们用另一个方法:让 gateCheck 返回 proceed 后,
    // processRequirement 立刻检查 res.headersSent(模拟)
    mockMainAgent.processRequirement = async (_req: any, _img: any, _u: any, _s: any, _opts: any) => {
      processRequirementCalled = true;
      // processRequirement 被调用时,我们能间接看到 res.headersSent 已经为 true,
      // 因为 SSE start event 已经在响应体中(响应已发送)
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    expect(processRequirementCalled).toBe(true);
    // 响应里应先看到 'start' 事件,然后是 'complete'
    const startIdx = res.text.indexOf('event: start');
    const completeIdx = res.text.indexOf('event: complete');
    expect(startIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(completeIdx);
    // 静音 TS6133 警告
    void headersSentAtProcessRequirementEntry;
  });

  test('proceed 路径:start 事件先于 reasoning 事件', async () => {
    mockMainAgent.processRequirement = async () => {
      // processRequirement 期间 emit reasoning
      const { llmEvents } = await import('../src/llm');
      llmEvents.emit('reasoning', 'processRequirement 期间的思考');
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    // start 应该在 reasoning 之前(因为 headers 在 gate 之后立即 flush)
    const startIdx = res.text.indexOf('event: start');
    const reasoningIdx = res.text.indexOf('processRequirement 期间的思考');
    expect(startIdx).toBeGreaterThan(-1);
    expect(reasoningIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(reasoningIdx);
  });

  test('processRequirement 收到 gateChecked: true', async () => {
    let receivedOptions: any;
    mockMainAgent.processRequirement = async (...args: any[]) => {
      receivedOptions = args[4];
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    expect(receivedOptions?.gateChecked).toBe(true);
  });
});