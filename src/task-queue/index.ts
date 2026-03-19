import { Task, TaskStatus, TaskError, CONFIG } from '../types';

type TaskExecutor = (task: Task) => Promise<unknown>;

/**
 * TaskQueue manages task scheduling, execution, and dependency resolution
 * 
 * Features:
 * - DAG-based dependency management with cycle detection
 * - Concurrent execution limiting (MAX_CONCURRENT_SUBAGENTS = 5)
 * - Task-level timeout handling (30s)
 * - State machine: pending → running → completed/failed
 */
export class TaskQueue {
  private readonly MAX_RESULT_SIZE = 1024 * 1024; // 1MB
  private tasks: Map<string, Task> = new Map();
  private running: Set<string> = new Set();
  private executor: TaskExecutor;
  private timeoutHandles: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private isProcessing = false;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupIntervalMs: number;
  private retentionTimeMs: number;

  private metrics = {
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksTimedOut: 0,
    averageExecutionTime: 0,
    totalExecutionTime: 0
  };

  constructor(executor: TaskExecutor, cleanupIntervalMs?: number, retentionTimeMs?: number) {
    this.executor = executor;
    this.cleanupIntervalMs = cleanupIntervalMs ?? CONFIG.TASK_CLEANUP_INTERVAL_MS;
    this.retentionTimeMs = retentionTimeMs ?? CONFIG.TASK_RETENTION_TIME_MS;

    this.startCleanupInterval();
  }

  /**
   * Start the periodic cleanup interval
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);
  }

  /**
   * Stop the cleanup interval
   */
  private stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clean up completed and failed tasks older than retention time
   */
  private cleanup(): void {
    const now = new Date().getTime();

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== 'completed' && task.status !== 'failed') {
        continue;
      }

      if (task.completedAt && (now - task.completedAt.getTime()) > this.retentionTimeMs) {
        this.clearTaskTimeout(taskId);

        for (const otherTask of this.tasks.values()) {
          const index = otherTask.dependencies.indexOf(taskId);
          if (index > -1) {
            otherTask.dependencies.splice(index, 1);
          }
          const depIndex = otherTask.dependents.indexOf(taskId);
          if (depIndex > -1) {
            otherTask.dependents.splice(depIndex, 1);
          }
        }

        this.tasks.delete(taskId);
      }
    }
  }

  /**
   * Add a task to the queue
   * @param task - Task to add
   * @returns true if added successfully, false if rejected
   * @throws Error if circular dependency detected or queue full
   */
  addTask(task: Task): boolean {
    if (this.tasks.size >= CONFIG.MAX_QUEUE_SIZE) {
      throw new Error(`Queue full: cannot exceed ${CONFIG.MAX_QUEUE_SIZE} tasks`);
    }

    if (this.tasks.has(task.id)) {
      throw new Error(`Task with ID "${task.id}" already exists`);
    }

    for (const depId of task.dependencies) {
      if (depId === task.id) {
        throw new Error(`Task "${task.id}" cannot depend on itself`);
      }
    }

    if (this.wouldCreateCycle(task)) {
      throw new Error(`Adding task "${task.id}" would create a circular dependency`);
    }

    this.tasks.set(task.id, task);

    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (dep && !dep.dependents.includes(task.id)) {
        dep.dependents.push(task.id);
      }
    }

    this.processQueue();

    return true;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    return this.getAllTasks().filter(task => task.status === status);
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getMetrics() {
    return { ...this.metrics };
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') {
      return false;
    }

    this.failTask(taskId, {
      type: 'USER_ERROR',
      message: 'Task was cancelled by user',
      code: 'CANCELLED'
    });

    return true;
  }

  clear(): void {
    this.stopCleanupInterval();

    for (const [, handle] of this.timeoutHandles) {
      clearTimeout(handle);
    }
    this.timeoutHandles.clear();

    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'failed';
        task.error = {
          type: 'FATAL',
          message: 'Task queue cleared',
          code: 'QUEUE_CLEARED'
        };
        task.completedAt = new Date();
      }
    }

    this.running.clear();
    this.isProcessing = false;
  }

  /**
   * DFS-based cycle detection
   * Checks if adding the given task would create a circular dependency
   * 
   * Algorithm:
   * 1. Build temporary dependency graph including the new task
   * 2. For each dependency of the new task, check if new task is reachable
   * 3. If reachable, cycle exists
   */
  private wouldCreateCycle(newTask: Task): boolean {
    if (newTask.dependencies.length === 0) {
      return false;
    }

    for (const depId of newTask.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep) continue;

      if (this.isReachable(depId, newTask.id, new Set())) {
        return true;
      }
    }

    return false;
  }

  /**
   * DFS traversal to check if target is reachable from start
   */
  private isReachable(start: string, target: string, visited: Set<string>): boolean {
    if (visited.has(start)) {
      return false;
    }
    visited.add(start);

    const node = this.tasks.get(start);
    if (!node) {
      return false;
    }

    for (const dependentId of node.dependents) {
      if (dependentId === target) {
        return true;
      }
      if (this.isReachable(dependentId, target, visited)) {
        return true;
      }
    }

    return false;
  }

  private processQueue(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      const readyTasks = this.findReadyTasks();

      for (const task of readyTasks) {
        if (this.running.size >= CONFIG.MAX_CONCURRENT_SUBAGENTS) {
          break;
        }

        if (this.running.has(task.id)) {
          continue;
        }

        this.executeTask(task);
      }
    } finally {
      this.isProcessing = false;

      if (this.running.size < CONFIG.MAX_CONCURRENT_SUBAGENTS && this.hasReadyTasks()) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  private findReadyTasks(): Task[] {
    const ready: Task[] = [];

    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') {
        continue;
      }

      const allDepsCompleted = task.dependencies.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === 'completed';
      });

      if (allDepsCompleted) {
        ready.push(task);
      }
    }

    ready.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    return ready;
  }

  private hasReadyTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') {
        continue;
      }

      const allDepsCompleted = task.dependencies.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === 'completed';
      });

      if (allDepsCompleted) {
        return true;
      }
    }

    return false;
  }

  private async executeTask(task: Task): Promise<void> {
    task.status = 'running';
    task.startedAt = new Date();
    this.running.add(task.id);

    const startTime = Date.now();

    try {
      const result = await Promise.race([
        this.executor(task),
        this.createTimeoutPromise()
      ]);

      const executionTime = Date.now() - startTime;
      console.log(`[TaskQueue] Task ${task.id} completed in ${executionTime}ms`);
      this.completeTask(task.id, result, executionTime);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const isTimeout = error instanceof Error && error.message.includes('timed out');
      
      if (isTimeout) {
        console.warn(`[TaskQueue] Task ${task.id} timed out after ${executionTime}ms`);
      } else {
        console.warn(`[TaskQueue] Task ${task.id} failed after ${executionTime}ms`);
      }

      const taskError: TaskError = {
        type: 'RETRYABLE',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      };
      this.failTask(task.id, taskError, isTimeout);
    } finally {
      this.running.delete(task.id);
      this.processQueue();
    }
  }

  private createTimeoutPromise(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Task timed out after ${CONFIG.TASK_TIMEOUT_MS}ms`));
      }, CONFIG.TASK_TIMEOUT_MS);
    });
  }

  private clearTaskTimeout(taskId: string): void {
    const handle = this.timeoutHandles.get(taskId);
    if (handle) {
      clearTimeout(handle);
      this.timeoutHandles.delete(taskId);
    }
  }

  private completeTask(taskId: string, result: unknown, executionTime: number): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const resultSize = JSON.stringify(result).length;
    if (resultSize > this.MAX_RESULT_SIZE) {
      console.warn(`[TaskQueue] Task ${taskId} result exceeds size limit (${resultSize} bytes)`);
      result = {
        warning: 'Result truncated due to size limit',
        partialResult: JSON.stringify(result).substring(0, 1000) + '...'
      };
    }

    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date();

    this.metrics.tasksCompleted++;
    this.metrics.totalExecutionTime += executionTime;
    this.metrics.averageExecutionTime = this.metrics.totalExecutionTime / this.metrics.tasksCompleted;

    this.notifyDependents(taskId);
  }

  private failTask(taskId: string, error: TaskError, isTimeout: boolean = false): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    task.status = 'failed';
    task.error = error;
    task.completedAt = new Date();

    if (isTimeout) {
      this.metrics.tasksTimedOut++;
    } else {
      this.metrics.tasksFailed++;
    }

    this.failDependents(taskId, error);
  }

  private notifyDependents(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    for (const dependentId of task.dependents) {
      const dependent = this.tasks.get(dependentId);
      if (dependent && dependent.status === 'pending') {
        // Queue will be processed after current execution
      }
    }
  }

  private failDependents(failedTaskId: string, error: TaskError): void {
    const failedTask = this.tasks.get(failedTaskId);
    if (!failedTask) {
      return;
    }

    for (const dependentId of failedTask.dependents) {
      const dependent = this.tasks.get(dependentId);
      if (!dependent || dependent.status !== 'pending') {
        continue;
      }

      const propagatedError: TaskError = {
        type: 'FATAL',
        message: `Dependency "${failedTaskId}" failed: ${error.message}`,
        code: 'DEPENDENCY_FAILED'
      };

      this.failTask(dependentId, propagatedError);
    }
  }
}

export default TaskQueue;
