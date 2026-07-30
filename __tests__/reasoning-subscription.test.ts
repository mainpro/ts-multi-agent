/**
 * LLM reasoning 事件订阅修复测试
 *
 * 覆盖:
 *  - llmEvents.emit('reasoning') 在 processRequirement 期间到达 → 通过 SSE 推送给客户端
 *  - reasoning 事件在 headers flush 前到达 → 被 buffer,flush 后按序重放
 *  - reasoning 事件在 headers flush 后到达 → 直接转发
 *  - queueFull / queued 路径下不漏 unsubscribe
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import request from 'supertest';
import { EventEmitter } from 'events';
import { createAPIServer } from '../src/api/index';
import { llmEvents } from '../src/llm';
import { ReasoningEvent } from '../src/llm';

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

describe('LLM reasoning 事件订阅修复', () => {
  let mockMainAgent: any;

  beforeEach(() => {
    mockMainAgent = {
      processRequirement: async () => ({ success: true, data: { type: 'skill_task' } }),
    };
  });

  test('processRequirement 期间 emit reasoning → SSE 推送 reasoning 事件', async () => {
    mockMainAgent.processRequirement = async () => {
      llmEvents.emit('reasoning', '用户想要查询 GEAM 凭证权限');
      llmEvents.emit('reasoning', '需要先确认用户身份');
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    const body = res.text;
    // 两条 reasoning 都被推送到 SSE
    const reasoningEvents = body.split('\n\n').filter(b =>
      b.startsWith('event: reasoning\n')  // 排除 reasoning_complete
    );
    expect(reasoningEvents.length).toBe(2);
    expect(body).toContain('用户想要查询 GEAM 凭证权限');
    expect(body).toContain('需要先确认用户身份');
  });

  test('reasoning 在 processRequirement 期间被 buffer → flush 后按序重放', async () => {
    mockMainAgent.processRequirement = async () => {
      llmEvents.emit('reasoning', '缓冲-1');
      await new Promise(r => setTimeout(r, 20));
      llmEvents.emit('reasoning', '缓冲-2');
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    const reasoningEvents = res.text.split('\n\n').filter(b =>
      b.startsWith('event: reasoning\n')
    );
    // 两条 reasoning 都被缓冲并在 flush 后重放
    expect(reasoningEvents.length).toBe(2);
    // 缓冲-1 应在 缓冲-2 之前(保持顺序)
    expect(res.text.indexOf('缓冲-1')).toBeLessThan(res.text.indexOf('缓冲-2'));
  });

  test('reasoning_complete 事件始终发出', async () => {
    mockMainAgent.processRequirement = async () => {
      llmEvents.emit('reasoning', '思考内容');
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    expect(res.text).toContain('event: reasoning_complete');
  });

  test('queueFull 路径:不订阅 / 不泄漏 listener', async () => {
    mockMainAgent.processRequirement = async () => ({
      success: false,
      queueFull: true,
      pendingCount: 100,
    });

    const initialListenerCount = (llmEvents as any).listeners.get('reasoning')?.length ?? 0;
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(503);

    expect((llmEvents as any).listeners.get('reasoning')?.length ?? 0).toBe(initialListenerCount);
  });

  test('queued 路径:不订阅 / 不泄漏 listener', async () => {
    mockMainAgent.processRequirement = async () => ({
      success: true,
      queued: true,
      draftId: 'd-1',
      position: 1,
    });

    const initialListenerCount = (llmEvents as any).listeners.get('reasoning')?.length ?? 0;
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(202);

    expect((llmEvents as any).listeners.get('reasoning')?.length ?? 0).toBe(initialListenerCount);
  });
});