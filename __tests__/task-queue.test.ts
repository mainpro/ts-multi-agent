import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { TaskQueue } from '../src/task-queue';
import { Task, TaskStatus, TaskResult, TaskError } from '../src/types';

// Mock CONFIG
(global as any).CONFIG = {
  MAX_QUEUE_SIZE: 100,
  MAX_CONCURRENT_SUBAGENTS: 5,
  TASK_TIMEOUT_MS: 30000,
  TASK_CLEANUP_INTERVAL_MS: 60000,
  TASK_RETENTION_TIME_MS: 3600000
};

// Mock TaskQueueStorage
mock.module('../src/task-queue/storage', () => ({
  TaskQueueStorage: class MockTaskQueueStorage {
    load() {
      return new Map<string, Task>();
    }
    save(tasks: Map<string, Task>) {
      // Do nothing
    }
  }
}));

describe('TaskQueue', () => {
  let taskQueue: TaskQueue;
  let mockExecutor: (task: Task, signal?: AbortSignal) => Promise<unknown>;

  beforeEach(() => {
    mockExecutor = mock(async (task: Task) => {
      // Add a small delay to simulate async execution
      await new Promise(resolve => setTimeout(resolve, 10));
      return { success: true, data: { response: 'Test task completed' } };
    });
    taskQueue = new TaskQueue(mockExecutor);
  });

  describe('constructor', () => {
    it('should create TaskQueue with executor', () => {
      expect(taskQueue).toBeDefined();
    });

    it('should create TaskQueue with custom cleanup interval', () => {
      const queue = new TaskQueue(mockExecutor, 1000, 5000);
      expect(queue).toBeDefined();
    });
  });

  describe('addTask', () => {
    it('should add task successfully', () => {
      const task: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const result = taskQueue.addTask(task);
      expect(result).toBe(true);
      expect(taskQueue.getTask('test-task-1')).toBeDefined();
    });

    it('should throw error when queue is full', () => {
      // Mock CONFIG.MAX_QUEUE_SIZE to 1
      const originalMaxQueueSize = (global as any).CONFIG.MAX_QUEUE_SIZE;
      (global as any).CONFIG = {
        ...(global as any).CONFIG,
        MAX_QUEUE_SIZE: 1
      };

      const task1: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement 1',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const task2: Task = {
        id: 'test-task-2',
        requirement: 'Test requirement 2',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      taskQueue.addTask(task1);
      expect(() => taskQueue.addTask(task2)).toThrow('Queue full');

      // Restore original value
      (global as any).CONFIG.MAX_QUEUE_SIZE = originalMaxQueueSize;
    });

    it('should throw error when task already exists', () => {
      const task: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      taskQueue.addTask(task);
      expect(() => taskQueue.addTask(task)).toThrow('Task with ID "test-task-1" already exists');
    });

    it('should throw error when task depends on itself', () => {
      const task: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: ['test-task-1'],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      expect(() => taskQueue.addTask(task)).toThrow('Task "test-task-1" cannot depend on itself');
    });

    it('should throw error when adding task creates circular dependency', () => {
      const task1: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement 1',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const task2: Task = {
        id: 'test-task-2',
        requirement: 'Test requirement 2',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: ['test-task-1'],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const task3: Task = {
        id: 'test-task-3',
        requirement: 'Test requirement 3',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: ['test-task-2'],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      taskQueue.addTask(task1);
      taskQueue.addTask(task2);
      
      // Create circular dependency
      task1.dependencies = ['test-task-3'];
      expect(() => taskQueue.addTask(task3)).toThrow('Adding task "test-task-3" would create a circular dependency');
    });
  });

  describe('getTask', () => {
    it('should return task by id', () => {
      const task: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      taskQueue.addTask(task);
      const retrievedTask = taskQueue.getTask('test-task-1');
      expect(retrievedTask).toBeDefined();
      expect(retrievedTask?.id).toBe('test-task-1');
    });

    it('should return undefined for non-existent task', () => {
      const task = taskQueue.getTask('non-existent-task');
      expect(task).toBeUndefined();
    });
  });

  describe('getAllTasks', () => {
    it('should return all tasks', () => {
      const task1: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement 1',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const task2: Task = {
        id: 'test-task-2',
        requirement: 'Test requirement 2',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      taskQueue.addTask(task1);
      taskQueue.addTask(task2);

      const tasks = taskQueue.getAllTasks();
      expect(tasks.length).toBe(2);
      expect(tasks.map(t => t.id)).toContain('test-task-1');
      expect(tasks.map(t => t.id)).toContain('test-task-2');
    });
  });

  describe('getTasksByStatus', () => {
    it('should return tasks by status', () => {
      const task1: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement 1',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      taskQueue.addTask(task1);

      const pendingTasks = taskQueue.getTasksByStatus('pending');
      expect(pendingTasks.length).toBe(1);
      expect(pendingTasks[0].status).toBe('pending');
    });
  });

  describe('getRunningCount', () => {
    it('should return running task count', () => {
      expect(taskQueue.getRunningCount()).toBe(0);
    });
  });

  describe('cancelTask', () => {
    it('should cancel pending task', () => {
      const task: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      taskQueue.addTask(task);
      const result = taskQueue.cancelTask('test-task-1');
      expect(result).toBe(true);
      const cancelledTask = taskQueue.getTask('test-task-1');
      expect(cancelledTask?.status).toBe('failed');
      expect(cancelledTask?.error?.code).toBe('CANCELLED');
    });

    it('should return false for non-pending task', () => {
      const task: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement',
        status: 'completed',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      taskQueue.addTask(task);
      const result = taskQueue.cancelTask('test-task-1');
      expect(result).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all tasks', () => {
      const task: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      taskQueue.addTask(task);
      taskQueue.clear();
      const tasks = taskQueue.getAllTasks();
      expect(tasks.length).toBe(1); // Task is marked as failed, not deleted
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].error?.code).toBe('QUEUE_CLEARED');
    });
  });

  describe('isRunning', () => {
    it('should return false for non-running task', () => {
      expect(taskQueue.isRunning('test-task-1')).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('should return metrics', () => {
      const metrics = taskQueue.getMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.tasksCompleted).toBe(0);
      expect(metrics.tasksFailed).toBe(0);
      expect(metrics.tasksTimedOut).toBe(0);
    });
  });

  describe('event handling', () => {
    it('should emit task-completed event', async () => {
      const task: Task = {
        id: 'test-task-1',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      let eventEmitted = false;
      taskQueue.on('task-completed', () => {
        eventEmitted = true;
      });

      taskQueue.addTask(task);

      // Wait for task to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(eventEmitted).toBe(true);
    });
  });
});
