/**
 * API SSE task_* 事件集成测试
 *
 * 覆盖:
 *  - taskEvents 总线事件通过 SSE 流式推送给客户端
 *  - 4 种事件类型(task_started/completed/failed/waiting)都能正确序列化
 *  - events 在 headers flush 之前到达 → 被 buffer,flush 后重放
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import request from 'supertest';
import { createAPIServer } from '../src/api/index';
import { taskEvents } from '../src/events/task-events';
import { EventEmitter } from 'events';

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

describe('API SSE task_* 事件 (per-task progress)', () => {
  let mockMainAgent: any;

  beforeEach(() => {
    // 默认 mock: processRequirement 内部不发射任何 task 事件,测试可覆盖
    mockMainAgent = {
      gateCheck: async () => ({ type: 'proceed' as const }),
      processRequirement: async () => ({ success: true, data: { type: 'skill_task' } }),
    };
  });

  test('task_started 在 processRequirement 期间发射 → 通过 SSE 推送给客户端', async () => {
    mockMainAgent.processRequirement = async () => {
      taskEvents.emit({
        type: 'task_started',
        requestId: 'req-1',
        planId: 'plan-1',
        taskId: 't1',
        requirement: '查询权限',
        skillName: 'permission',
        totalTasks: 3,
        startedAt: new Date().toISOString(),
      });
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    const body = res.text;
    expect(body).toContain('event: task_started');
    expect(body).toContain('"planId":"plan-1"');
    expect(body).toContain('"taskId":"t1"');
    expect(body).toContain('查询权限');
    expect(body).toContain('"totalTasks":3');
  });

  test('task_completed 携带 durationMs 通过 SSE 推送', async () => {
    mockMainAgent.processRequirement = async () => {
      taskEvents.emit({
        type: 'task_completed',
        requestId: 'req-1',
        planId: 'plan-1',
        taskId: 't1',
        status: 'completed',
        durationMs: 234,
      });
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    const body = res.text;
    expect(body).toContain('event: task_completed');
    expect(body).toContain('"durationMs":234');
  });

  test('task_failed 携带 error 信息通过 SSE 推送', async () => {
    mockMainAgent.processRequirement = async () => {
      taskEvents.emit({
        type: 'task_failed',
        requestId: 'req-1',
        planId: 'plan-1',
        taskId: 't1',
        status: 'failed',
        error: { type: 'SKILL_ERROR', code: 'TASK_FAILED', message: '技能执行失败' },
        durationMs: 50,
      });
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    const body = res.text;
    expect(body).toContain('event: task_failed');
    expect(body).toContain('技能执行失败');
    expect(body).toContain('TASK_FAILED');
  });

  test('task_waiting 携带 question 内容通过 SSE 推送', async () => {
    mockMainAgent.processRequirement = async () => {
      taskEvents.emit({
        type: 'task_waiting',
        requestId: 'req-1',
        planId: 'plan-1',
        taskId: 't1',
        status: 'waiting',
        requirement: '需要确认',
        skillName: 'confirm',
        question: { content: '请问您说的是哪个系统?', metadata: { paramName: 'system' } },
      });
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    const body = res.text;
    expect(body).toContain('event: task_waiting');
    expect(body).toContain('请问您说的是哪个系统');
    expect(body).toContain('paramName');
  });

  test('多个 task 事件按发射顺序推送到客户端', async () => {
    mockMainAgent.processRequirement = async () => {
      taskEvents.emit({
        type: 'task_started',
        requestId: 'req-1',
        planId: 'plan-1',
        taskId: 't1',
        requirement: 'first',
        skillName: 'echo',
        totalTasks: 2,
        startedAt: '2026-07-30T00:00:00Z',
      });
      taskEvents.emit({
        type: 'task_started',
        requestId: 'req-1',
        planId: 'plan-1',
        taskId: 't2',
        requirement: 'second',
        skillName: 'echo',
        totalTasks: 2,
        startedAt: '2026-07-30T00:00:01Z',
      });
      taskEvents.emit({
        type: 'task_completed',
        requestId: 'req-1',
        planId: 'plan-1',
        taskId: 't1',
        status: 'completed',
        durationMs: 100,
      });
      return { success: true, data: { type: 'skill_task' } };
    };

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());
    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect(200);

    const body = res.text;
    // t1 started 应在 t2 started 之前
    const t1StartIdx = body.indexOf('"taskId":"t1"');
    const t2StartIdx = body.indexOf('"taskId":"t2"');
    expect(t1StartIdx).toBeGreaterThan(-1);
    expect(t2StartIdx).toBeGreaterThan(-1);
    expect(t1StartIdx).toBeLessThan(t2StartIdx);
  });
});