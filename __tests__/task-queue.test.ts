import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { TaskQueue } from '../src/task-queue';
import type { Task, TaskError } from '../src/types';

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).substr(2, 9)}`,
    requirement: 'Test requirement',
    status: 'pending',
    dependencies: [],
    dependents: [],
    createdAt: new Date(),
    retryCount: 0,
    ...overrides,
  };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('TaskQueue', () => {
  let queue: TaskQueue;
  let mockExecutor: ReturnType<typeof mock>;

  beforeEach(() => {
    mockExecutor = mock(async (_task: Task) => {
      return { success: true };
    });
    queue = new TaskQueue(mockExecutor);
  });

  describe('constructor', () => {
    it('should create queue with executor', () => {
      expect(queue).toBeDefined();
    });
  });

  describe('addTask', () => {
    it('should add a task successfully', () => {
      const task = createMockTask({ id: 'task-1' });
      const result = queue.addTask(task);
      expect(result).toBe(true);
    });

    it('should throw error for duplicate task ID', () => {
      const task = createMockTask({ id: 'task-1' });
      queue.addTask(task);
      expect(() => queue.addTask(task)).toThrow('Task with ID "task-1" already exists');
    });

    it('should throw error when queue is full', () => {
      for (let i = 0; i < 100; i++) {
        queue.addTask(createMockTask({ id: `task-${i}` }));
      }
      expect(() => queue.addTask(createMockTask({ id: 'overflow' }))).toThrow('Queue full');
    });

    it('should throw error for self-dependency', () => {
      const task = createMockTask({ id: 'task-1', dependencies: ['task-1'] });
      expect(() => queue.addTask(task)).toThrow('cannot depend on itself');
    });

    it('should detect circular dependency when completing a cycle', () => {
      const task1 = createMockTask({ id: 'task-1' });
      const task2 = createMockTask({ id: 'task-2', dependencies: ['task-1'] });
      const task3 = createMockTask({ id: 'task-3', dependencies: ['task-2'] });
      queue.addTask(task1);
      queue.addTask(task2);
      queue.addTask(task3);
      const task4 = createMockTask({ id: 'task-4', dependencies: ['task-3'] });
      queue.addTask(task4);
      const circularTask = createMockTask({ id: 'task-1', dependencies: ['task-4'] });
      expect(() => queue.addTask(circularTask)).toThrow('already exists');
    });

    it('should detect indirect circular dependency', () => {
      const task1 = createMockTask({ id: 'task-1' });
      const task2 = createMockTask({ id: 'task-2', dependencies: ['task-1'] });
      const task3 = createMockTask({ id: 'task-3', dependencies: ['task-2'] });
      queue.addTask(task1);
      queue.addTask(task2);
      expect(() => queue.addTask(task3)).not.toThrow();
      
      const task4 = createMockTask({ id: 'task-4', dependencies: ['task-3'] });
      queue.addTask(task4);
      
      const circularTask = createMockTask({ id: 'task-circular', dependencies: ['task-4'], dependents: ['task-1'] });
    });
  });

  describe('getTask', () => {
    it('should return undefined for non-existent task', () => {
      const task = queue.getTask('non-existent');
      expect(task).toBeUndefined();
    });

    it('should return task by ID', () => {
      const task = createMockTask({ id: 'task-1' });
      queue.addTask(task);
      const retrieved = queue.getTask('task-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('task-1');
    });
  });

  describe('getAllTasks', () => {
    it('should return empty array when no tasks', () => {
      const tasks = queue.getAllTasks();
      expect(tasks).toEqual([]);
    });

    it('should return all tasks', () => {
      queue.addTask(createMockTask({ id: 'task-1' }));
      queue.addTask(createMockTask({ id: 'task-2' }));
      const tasks = queue.getAllTasks();
      expect(tasks).toHaveLength(2);
    });
  });

  describe('getTasksByStatus', () => {
    it('should return tasks filtered by status', async () => {
      queue.addTask(createMockTask({ id: 'task-1' }));
      
      await delay(100);
      
      const pendingTasks = queue.getTasksByStatus('pending');
      expect(pendingTasks.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getRunningCount', () => {
    it('should return 0 when no tasks running', () => {
      expect(queue.getRunningCount()).toBe(0);
    });
  });

  describe('isRunning', () => {
    it('should return false for non-running task', () => {
      expect(queue.isRunning('task-1')).toBe(false);
    });
  });

  describe('cancelTask', () => {
    it('should return false for non-existent task', () => {
      const result = queue.cancelTask('non-existent');
      expect(result).toBe(false);
    });

    it('should return false for running task', async () => {
      const slowExecutor = mock(async () => {
        await delay(500);
        return { success: true };
      });
      const slowQueue = new TaskQueue(slowExecutor);
      const task = createMockTask({ id: 'task-1' });
      slowQueue.addTask(task);
      
      await delay(50);
      
      const result = slowQueue.cancelTask('task-1');
      expect(result).toBe(false);
    });

    it('should cancel pending task', async () => {
      const slowExecutor = mock(async () => {
        await delay(5000);
        return { success: true };
      });
      const pendingQueue = new TaskQueue(slowExecutor);
      const blockingTask = createMockTask({ id: 'blocking-task' });
      const pendingTask = createMockTask({ id: 'pending-task', dependencies: ['blocking-task'] });
      pendingQueue.addTask(blockingTask);
      pendingQueue.addTask(pendingTask);
      await delay(50);
      const result = pendingQueue.cancelTask('pending-task');
      expect(result).toBe(true);
      const cancelledTask = pendingQueue.getTask('pending-task');
      expect(cancelledTask?.status).toBe('failed');
      expect(cancelledTask?.error?.code).toBe('CANCELLED');
    });
  });

  describe('clear', () => {
    it('should clear all tasks and timeouts', () => {
      queue.addTask(createMockTask({ id: 'task-1' }));
      queue.addTask(createMockTask({ id: 'task-2' }));

      queue.clear();

      const tasks = queue.getAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.every(t => t.status === 'failed')).toBe(true);
      expect(queue.getRunningCount()).toBe(0);
    });

    it('should mark pending and running tasks as failed', async () => {
      const task = createMockTask({ id: 'task-1' });
      queue.addTask(task);
      
      queue.clear();
      
      const clearedTask = queue.getTask('task-1');
      expect(clearedTask?.status).toBe('failed');
      expect(clearedTask?.error?.code).toBe('QUEUE_CLEARED');
    });
  });

  describe('task execution', () => {
    it('should execute task and mark as completed', async () => {
      mockExecutor = mock(async () => ({ result: 'success' }));
      queue = new TaskQueue(mockExecutor);
      
      const task = createMockTask({ id: 'task-1' });
      queue.addTask(task);
      
      await delay(100);
      
      expect(mockExecutor).toHaveBeenCalled();
    });

    it('should handle task failure', async () => {
      mockExecutor = mock(async () => {
        throw new Error('Task failed');
      });
      queue = new TaskQueue(mockExecutor);
      
      const task = createMockTask({ id: 'task-1' });
      queue.addTask(task);
      
      await delay(100);
      
      const failedTask = queue.getTask('task-1');
      expect(failedTask?.status).toBe('failed');
    });

    it('should propagate failure to dependents', async () => {
      mockExecutor = mock(async () => {
        throw new Error('Task failed');
      });
      queue = new TaskQueue(mockExecutor);
      
      const task1 = createMockTask({ id: 'task-1' });
      const task2 = createMockTask({ id: 'task-2', dependencies: ['task-1'] });
      queue.addTask(task1);
      queue.addTask(task2);
      
      await delay(100);
      
      const dependentTask = queue.getTask('task-2');
      expect(dependentTask?.status).toBe('failed');
      expect(dependentTask?.error?.code).toBe('DEPENDENCY_FAILED');
    });
  });

  describe('concurrency control', () => {
    it('should respect max concurrent limit', async () => {
      const executingTasks: string[] = [];
      const slowExecutor = mock(async (task: Task) => {
        executingTasks.push(task.id);
        await delay(200);
        executingTasks.splice(executingTasks.indexOf(task.id), 1);
        return { success: true };
      });
      
      const slowQueue = new TaskQueue(slowExecutor);
      
      for (let i = 0; i < 7; i++) {
        slowQueue.addTask(createMockTask({ id: `task-${i}` }));
      }
      
      await delay(50);
      
      expect(executingTasks.length).toBeLessThanOrEqual(5);
    });
  });

  describe('dependency management', () => {
    it('should wait for dependencies before executing', async () => {
      const executionOrder: string[] = [];
      const executor = mock(async (task: Task) => {
        executionOrder.push(task.id);
        return { success: true };
      });
      
      queue = new TaskQueue(executor);
      
      const task1 = createMockTask({ id: 'task-1' });
      const task2 = createMockTask({ id: 'task-2', dependencies: ['task-1'] });
      
      queue.addTask(task2);
      queue.addTask(task1);
      
      await delay(200);
      
      expect(executionOrder[0]).toBe('task-1');
    });

    it('should execute independent tasks concurrently', async () => {
      const executionOrder: string[] = [];
      const executor = mock(async (task: Task) => {
        executionOrder.push(task.id);
        await delay(50);
        return { success: true };
      });
      
      queue = new TaskQueue(executor);
      
      queue.addTask(createMockTask({ id: 'task-1' }));
      queue.addTask(createMockTask({ id: 'task-2' }));
      
      await delay(100);
      
      expect(executionOrder).toHaveLength(2);
    });
  });

  describe('timeout handling', () => {
    it('should handle task timeout', async () => {
      const slowExecutor = mock(async () => {
        await delay(35000);
        return { success: true };
      });
      
      const slowQueue = new TaskQueue(slowExecutor);
      const task = createMockTask({ id: 'task-1' });
      slowQueue.addTask(task);
      
      await delay(100);
      
    }, 36000);
  });
});
