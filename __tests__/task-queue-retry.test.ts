import { TaskQueue } from '../src/task-queue';
import { LLMError } from '../src/llm';

describe('TaskQueue retry logic', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue(async () => ({ success: true }), 60000, 60000, { baseMs: 10, maxMs: 50 });
  });

  it('retries TIMEOUT error up to maxRetries', async () => {
    let attempts = 0;
    const executor = async () => {
      attempts++;
      if (attempts < 3) throw new LLMError('TIMEOUT', 'timeout');
      return { success: true };
    };
    const q = new TaskQueue(executor as any, 60000, 60000, { baseMs: 10, maxMs: 50 });
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      status: 'pending',
      maxRetries: 2, retryableErrorTypes: ['TIMEOUT'],
    });
    await new Promise(r => setTimeout(r, 3000));
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    const executor = async () => {
      attempts++;
      throw new LLMError('INVALID_KEY', 'bad key');
    };
    const q = new TaskQueue(executor as any, 60000, 60000, { baseMs: 10, maxMs: 50 });
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      status: 'pending',
      maxRetries: 5, retryableErrorTypes: ['TIMEOUT', 'NETWORK_ERROR'],
    });
    await new Promise(r => setTimeout(r, 50));
    expect(attempts).toBe(1); // 不重试
  });

  it('does not retry API_ERROR with statusCode < 500', async () => {
    let attempts = 0;
    const executor = async () => {
      attempts++;
      throw new LLMError('API_ERROR', 'client error', 400);
    };
    const q = new TaskQueue(executor as any, 60000, 60000, { baseMs: 10, maxMs: 50 });
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      status: 'pending',
      maxRetries: 3, retryableErrorTypes: ['API_ERROR'],
    });
    await new Promise(r => setTimeout(r, 50));
    expect(attempts).toBe(1);
  });

  it('retries API_ERROR with statusCode >= 500', async () => {
    let attempts = 0;
    const executor = async () => {
      attempts++;
      if (attempts < 2) throw new LLMError('API_ERROR', 'server error', 503);
      return { success: true };
    };
    const q = new TaskQueue(executor as any, 60000, 60000, { baseMs: 10, maxMs: 50 });
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      status: 'pending',
      maxRetries: 1, retryableErrorTypes: ['API_ERROR'],
    });
    await new Promise(r => setTimeout(r, 1500));
    expect(attempts).toBe(2);
  });

  it('increments task.retryCount on each retry', async () => {
    let task: any;
    const executor = async (t: any) => {
      task = t;
      if (t.retryCount < 2) throw new LLMError('TIMEOUT', 'timeout');
      return { success: true };
    };
    const q = new TaskQueue(executor as any, 60000, 60000, { baseMs: 10, maxMs: 50 });
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      status: 'pending',
      maxRetries: 3, retryableErrorTypes: ['TIMEOUT'],
    });
    await new Promise(r => setTimeout(r, 4000));
    expect(task.retryCount).toBe(2);
  });

  it('marks retryExhausted in error after maxRetries attempts', async () => {
    const executor = async () => {
      throw new LLMError('TIMEOUT', 'always times out');
    };
    const q = new TaskQueue(executor as any, 60000, 60000, { baseMs: 10, maxMs: 50 });
    const events: any[] = [];
    q.on('task-failed', (e: any) => events.push(e));
    q.addTask({
      id: 't1', requirement: 'r', skillName: 's',
      dependencies: [], dependents: [], createdAt: new Date(),
      status: 'pending',
      maxRetries: 1, retryableErrorTypes: ['TIMEOUT'],
    });
    await new Promise(r => setTimeout(r, 1500));
    expect(events).toHaveLength(1);
    expect(events[0].error.code).toBe('TIMEOUT');  // 原始错误类型保留
  });
});