/**
 * TaskEventEmitter 单元测试
 *
 * 覆盖:
 *  - 基本 on/emit 行为
 *  - 多次订阅者都收到事件
 *  - on() 返回的 unsubscribe 函数可用
 *  - 监听器抛错不影响其他监听器
 */
import { describe, test, expect } from 'bun:test';
import { taskEvents, TaskEvent } from '../src/events/task-events';

describe('TaskEventEmitter', () => {
  test('on + emit: 订阅者收到事件', () => {
    const received: TaskEvent[] = [];
    const off = taskEvents.on('task_started', (e) => received.push(e));
    taskEvents.emit({
      type: 'task_started',
      requestId: 'r1',
      planId: 'p1',
      taskId: 't1',
      requirement: 'test req',
      skillName: 'echo',
      totalTasks: 2,
      startedAt: '2026-07-30T00:00:00Z',
    });
    expect(received.length).toBe(1);
    expect(received[0].taskId).toBe('t1');
    off();
  });

  test('多次订阅者都收到事件', () => {
    const a: TaskEvent[] = [];
    const b: TaskEvent[] = [];
    const offA = taskEvents.on('task_completed', (e) => a.push(e));
    const offB = taskEvents.on('task_completed', (e) => b.push(e));
    taskEvents.emit({
      type: 'task_completed',
      requestId: 'r1',
      planId: 'p1',
      taskId: 't1',
      status: 'completed',
      durationMs: 100,
    });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    offA(); offB();
  });

  test('on() 返回的 unsubscribe 函数可用', () => {
    const received: TaskEvent[] = [];
    const off = taskEvents.on('task_failed', (e) => received.push(e));
    taskEvents.emit({
      type: 'task_failed',
      requestId: 'r1',
      planId: 'p1',
      taskId: 't1',
      status: 'failed',
      error: { type: 'FATAL', code: 'TEST', message: 'fail' },
      durationMs: 50,
    });
    expect(received.length).toBe(1);
    off();
    taskEvents.emit({
      type: 'task_failed',
      requestId: 'r1',
      planId: 'p1',
      taskId: 't2',
      status: 'failed',
      error: { type: 'FATAL', code: 'TEST', message: 'fail2' },
      durationMs: 60,
    });
    expect(received.length).toBe(1);
  });

  test('监听器抛错不影响其他监听器', () => {
    const received: TaskEvent[] = [];
    taskEvents.on('task_waiting', () => { throw new Error('boom'); });
    const off = taskEvents.on('task_waiting', (e) => received.push(e));
    taskEvents.emit({
      type: 'task_waiting',
      requestId: 'r1',
      planId: 'p1',
      taskId: 't1',
      status: 'waiting',
      requirement: 'req',
      skillName: null,
      question: { content: 'please answer' },
    });
    expect(received.length).toBe(1);
    off();
  });

  test('off(event, callback) 移除指定监听器', () => {
    const received: TaskEvent[] = [];
    const cb = (e: TaskEvent) => received.push(e);
    taskEvents.on('task_started', cb);
    taskEvents.emit({
      type: 'task_started',
      requestId: 'r1',
      planId: 'p1',
      taskId: 't1',
      requirement: 'req',
      skillName: null,
      totalTasks: 1,
      startedAt: '2026-07-30T00:00:00Z',
    });
    expect(received.length).toBe(1);
    taskEvents.off('task_started', cb);
    taskEvents.emit({
      type: 'task_started',
      requestId: 'r1',
      planId: 'p1',
      taskId: 't2',
      requirement: 'req2',
      skillName: null,
      totalTasks: 1,
      startedAt: '2026-07-30T00:00:01Z',
    });
    expect(received.length).toBe(1);
  });
});