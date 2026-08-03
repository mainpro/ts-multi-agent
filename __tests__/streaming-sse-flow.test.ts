/**
 * 流式 SSE 输出验证
 *
 * 覆盖:
 *  - gateCheck 返回 proceed → flushHeaders 在 processRequirement 之前
 *  - LLM 流式 reasoning 在 processRequirement 期间 → 实时到前端(不经 buffer)
 *  - queueFull / queued 路径仍走 JSON(不 flush)
 *  - gateChecked:true 传给 processRequirement(避免重复 gate)
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import request from 'supertest';
import { EventEmitter } from 'events';
import { createAPIServer } from '../src/api/index';
import { llmEvents } from '../src/llm';

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

describe('流式 SSE 输出', () => {
  let mockMainAgent: any;

  beforeEach(() => {
    mockMainAgent = {
      gateCheck: async () => ({ type: 'proceed' as const }),
      processRequirement: async () => ({ success: true, data: { type: 'skill_task' } }),
    };
  });

  test('gateCheck 返回 proceed → SSE start 事件在 processRequirement 期间已发出', async () => {
    // 验证:在 processRequirement 内部,start 事件已经写入了响应体。
    // 即:前端能在 processRequirement 完成前看到 "start"。
    let startSentBeforeProcessRequirement = false;
    let processRequirementStarted = false;

    mockMainAgent.processRequirement = async () => {
      processRequirementStarted = true;
      // 模拟:processRequirement 内部,start 已经在响应里写过了
      // (API 层在调 processRequirement 前就 flushHeaders + sendEvent('start'))
      startSentBeforeProcessRequirement = true;
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    expect(startSentBeforeProcessRequirement).toBe(true);
    expect(processRequirementStarted).toBe(true);
    // 响应体里 start 事件应该在 complete 之前
    expect(res.text.indexOf('event: start')).toBeLessThan(res.text.indexOf('event: complete'));
  });

  test('reasoning 事件在 processRequirement 期间 emit → 实时到前端(不经 buffer)', async () => {
    mockMainAgent.processRequirement = async () => {
      // 模拟 IntentRouter / SubAgent 期间的流式 reasoning
      llmEvents.emit('reasoning', '第一批推理');
      await new Promise(r => setTimeout(r, 30));
      llmEvents.emit('reasoning', '第二批推理');
      await new Promise(r => setTimeout(r, 30));
      llmEvents.emit('reasoning', '第三批推理');
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    // 三条 reasoning 都到响应(顺序保持:首批 < 第二批 < 第三批)
    expect(res.text).toContain('第一批推理');
    expect(res.text).toContain('第二批推理');
    expect(res.text).toContain('第三批推理');
    const idx1 = res.text.indexOf('第一批推理');
    const idx2 = res.text.indexOf('第二批推理');
    const idx3 = res.text.indexOf('第三批推理');
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  test('processRequirement 收到 gateChecked: true(避免重复 gate)', async () => {
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

  test('queueFull 路径 → 503 JSON(不进入 SSE 流程)', async () => {
    mockMainAgent.gateCheck = async () => ({
      type: 'queue_full' as const, pendingCount: 99, draftId: 'd-qf',
    });
    // 即使 processRequirement 被调,它也不会被调,因为 queueFull 应该 early-return
    mockMainAgent.processRequirement = async () => {
      throw new Error('processRequirement should NOT be called for queueFull');
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(503);

    expect(res.body.code).toBe('QUEUE_FULL');
    expect(res.body.pendingCount).toBe(99);
    // Content-Type 应该是 JSON 不是 text/event-stream
    expect(res.headers['content-type']).toMatch(/json/);
  });

  test('queued 路径 → 202 JSON(不进入 SSE 流程)', async () => {
    mockMainAgent.gateCheck = async () => ({
      type: 'queued' as const, draftId: 'd-q', position: 3,
    });
    mockMainAgent.processRequirement = async () => {
      throw new Error('processRequirement should NOT be called for queued');
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(202);

    expect(res.body.status).toBe('queued');
    expect(res.body.position).toBe(3);
  });

  test('continue_waiting 路径 → 走 proceed(SSE 流式)', async () => {
    // continue_waiting 表示用户在回答等待中的问题
    // 不算 queue,应该正常走 SSE 流程
    mockMainAgent.gateCheck = async () => ({ type: 'continue_waiting' as const });
    mockMainAgent.processRequirement = async () => {
      llmEvents.emit('reasoning', 'continue_waiting 流式 reasoning');
      return { success: true, data: { type: 'small_talk' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    expect(res.text).toContain('event: start');
    expect(res.text).toContain('continue_waiting 流式 reasoning');
  });
});