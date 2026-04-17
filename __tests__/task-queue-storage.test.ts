import { TaskQueue } from '../src/task-queue';
import { Task, TaskStatus } from '../src/types';
import * as fs from 'fs';
import * as path from 'path';

// Mock executor
const mockExecutor = async (task: Task): Promise<any> => {
  return { success: true, data: { response: 'Test response' } };
};

describe('TaskQueueStorage', () => {
  const testDataDir = 'data/task-queue';
  const testFilePath = path.join(testDataDir, 'tasks.json');

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it('should save tasks to file and load them back', async () => {
    // Create first TaskQueue instance and add tasks
    const taskQueue1 = new TaskQueue(mockExecutor);
    
    // Add some tasks
    const task1: Task = {
      id: 'test-task-1',
      requirement: 'Test requirement 1',
      status: 'pending',
      skillName: 'test-skill',
      params: {},
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      retryCount: 0,
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
      retryCount: 0,
    };

    taskQueue1.addTask(task1);
    taskQueue1.addTask(task2);

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Verify file exists
    expect(fs.existsSync(testFilePath)).toBe(true);

    // Create second TaskQueue instance and load tasks
    const taskQueue2 = new TaskQueue(mockExecutor);
    
    // Wait for loading
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify tasks were loaded
    const allTasks = taskQueue2.getAllTasks();
    expect(allTasks.length).toBe(2);
    expect(allTasks.some(t => t.id === 'test-task-1')).toBe(true);
    expect(allTasks.some(t => t.id === 'test-task-2')).toBe(true);
  });

  it('should handle running tasks by resetting to pending', async () => {
    // Create task with running status
    const runningTask: Task = {
      id: 'running-task',
      requirement: 'Test running task',
      status: 'running',
      skillName: 'test-skill',
      params: {},
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      startedAt: new Date(),
      retryCount: 0,
    };

    // Create storage and save task
    const taskQueue1 = new TaskQueue(mockExecutor);
    taskQueue1.addTask(runningTask);

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Create new TaskQueue and load
    const taskQueue2 = new TaskQueue(mockExecutor);
    
    // Wait for loading
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify task status is reset to pending
    const loadedTask = taskQueue2.getTask('running-task');
    expect(loadedTask).toBeDefined();
    expect(loadedTask?.status).toBe('pending');
  });

  it('should handle task completion and failure', async () => {
    const taskQueue = new TaskQueue(mockExecutor);

    const task: Task = {
      id: 'completing-task',
      requirement: 'Test completing task',
      status: 'pending',
      skillName: 'test-skill',
      params: {},
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      retryCount: 0,
    };

    taskQueue.addTask(task);

    // Wait for task to complete
    await new Promise(resolve => {
      const checkTask = () => {
        const t = taskQueue.getTask('completing-task');
        if (t?.status === 'completed') {
          resolve(undefined);
        } else {
          setTimeout(checkTask, 100);
        }
      };
      checkTask();
    });

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Verify task is saved as completed
    const loadedTaskQueue = new TaskQueue(mockExecutor);
    await new Promise(resolve => setTimeout(resolve, 100));

    const loadedTask = loadedTaskQueue.getTask('completing-task');
    expect(loadedTask).toBeDefined();
    expect(loadedTask?.status).toBe('completed');
  });

  it('should handle 100 tasks concurrently', async () => {
    const taskQueue = new TaskQueue(mockExecutor);

    // Add 100 tasks
    for (let i = 1; i <= 100; i++) {
      const task: Task = {
        id: `task-${i}`,
        requirement: `Test task ${i}`,
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0,
      };
      taskQueue.addTask(task);
    }

    // Wait for debounce and task completion
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify all tasks are saved
    const loadedTaskQueue = new TaskQueue(mockExecutor);
    await new Promise(resolve => setTimeout(resolve, 100));

    const loadedTasks = loadedTaskQueue.getAllTasks();
    expect(loadedTasks.length).toBe(100);
    expect(loadedTasks.every(t => t.id.startsWith('task-'))).toBe(true);
  });
});