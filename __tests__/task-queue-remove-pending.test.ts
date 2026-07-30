/**
 * Unit test for TaskQueue.removePendingTask — added so onTaskGraphCheckpoint
 * can clean R1's unstarted tasks before spawning R2.
 */
import { describe, test, expect } from 'bun:test';
import { TaskQueue } from '../src/task-queue';

const makeTask = (id: string) => ({
  id, skillName: 'echo', requirement: 'r1',
  params: {}, conversationContext: [], completedToolCalls: [], questionHistory: [],
  dependencies: [],
  status: 'pending' as const,
});

describe('TaskQueue.removePendingTask', () => {
  test('removes pending task, returns true', async () => {
    // Use a blocking callback so the task stays 'pending' (not auto-picked up).
    let blockExecution: ((v: any) => void) | null = null;
    const queue = new TaskQueue(async () => {
      await new Promise<any>(r => { blockExecution = r; });
      return { ok: true };
    });
    queue.addTask(makeTask('t1'));
    // addTask calls processQueue which transitions to 'running' synchronously;
    // rewind to 'pending' so we exercise the pending-removal path.
    const t = queue.getTask('t1');
    expect(t).toBeDefined();
    expect(t!.status).toBe('running');
    t!.status = 'pending';

    const removed = queue.removePendingTask('t1');
    expect(removed).toBe(true);
    expect(queue.getTask('t1')).toBeUndefined();

    blockExecution!({ ok: true });
  });

  test('returns false for non-existent task', () => {
    const queue = new TaskQueue(async () => ({ ok: true }));
    expect(queue.removePendingTask('nonexistent')).toBe(false);
  });

  test('does not remove running task', async () => {
    let resolveTask: ((v: any) => void) | null = null;
    const queue = new TaskQueue(async () => {
      await new Promise<any>(r => { resolveTask = r; });
      return { ok: true };
    });
    queue.addTask(makeTask('t1'));
    await new Promise(r => setTimeout(r, 30));
    expect((queue.getTask('t1') as any)?.status).toBe('running');

    const removed = queue.removePendingTask('t1');
    expect(removed).toBe(false);
    expect(queue.getTask('t1')).toBeDefined();

    resolveTask!({ ok: true });
  });

  test('does not remove completed task', async () => {
    const queue = new TaskQueue(async () => ({ ok: true }));
    queue.addTask(makeTask('t1'));
    await new Promise(r => setTimeout(r, 50));
    expect((queue.getTask('t1') as any)?.status).toBe('completed');

    const removed = queue.removePendingTask('t1');
    expect(removed).toBe(false);
    expect(queue.getTask('t1')).toBeDefined();
  });
});
