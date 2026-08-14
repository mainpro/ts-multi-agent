import { EventEmitter } from 'events';
import { Task, TaskStatus, TaskError, TaskResult, CONFIG } from "../types";
import { AppError } from '../errors';
import { LLMError } from '../llm';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'TaskQueue' });

export type TaskExecutor = (task: Task, signal?: AbortSignal) => Promise<unknown>;

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
  // NOTE: spec mandates production backoff = base 2000ms / max 60000ms with
  // ±1s jitter. Tests pass smaller values via the constructor's `retryBackoff`
  // option so retry waits stay fast (50-200ms total). The exponential-backoff
  // algorithm itself (base * 2^(attempt-1), capped at max) is unchanged.

  private readonly MAX_RESULT_SIZE = 1024 * 1024; // 1MB
  private tasks: Map<string, Task> = new Map();
  private running: Set<string> = new Set();
  private executor: TaskExecutor;

  private timeoutHandles: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private isProcessing = false;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupIntervalMs: number;
  private retentionTimeMs: number;
  private retryBaseDelayMs: number;
  private retryMaxDelayMs: number;
  private emitter = new EventEmitter();

  private metrics = {
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksTimedOut: 0,
    averageExecutionTime: 0,
    totalExecutionTime: 0,
  };

  constructor(
    executor: TaskExecutor,
    cleanupIntervalMs?: number,
    retentionTimeMs?: number,
    retryBackoff?: { baseMs?: number; maxMs?: number },
  ) {
    this.executor = executor;
    this.cleanupIntervalMs =
      cleanupIntervalMs ?? CONFIG.TASK_CLEANUP_INTERVAL_MS;
    this.retentionTimeMs = retentionTimeMs ?? CONFIG.TASK_RETENTION_TIME_MS;
    this.retryBaseDelayMs = retryBackoff?.baseMs ?? 2000;
    this.retryMaxDelayMs = retryBackoff?.maxMs ?? 60000;

    this.startCleanupInterval();
  }

  /**
   * Replace the task executor. Reserved for future routing use cases —
   * the agent can swap the executor per request to route tasks to a
   * different handler (e.g. a specialized executor).
   *
   * Note: the new executor is NOT auto-restored. The sole caller
   * (MainAgent._processRequirementInner) deliberately lets the swap persist so
   * subsequent requests re-resolve and re-swap to a fresh executor.
   */
  setExecutor(executor: TaskExecutor): void {
    this.executor = executor;
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
      if (task.status !== "completed" && task.status !== "failed") {
        continue;
      }

      if (
        task.completedAt &&
        now - task.completedAt.getTime() > this.retentionTimeMs
      ) {
        this.clearTaskTimeout(taskId);

        for (const otherTask of this.tasks.values()) {
          const index = otherTask.dependencies.indexOf(taskId);
          if (index > -1) {
            otherTask.dependencies.splice(index, 1);
          }
          if (otherTask.dependents) {
            const depIndex = otherTask.dependents.indexOf(taskId);
            if (depIndex > -1) {
              otherTask.dependents.splice(depIndex, 1);
            }
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
  addTask(task: Task): { success: boolean; error?: string; taskId?: string } {
    if (this.tasks.size >= CONFIG.MAX_QUEUE_SIZE) {
      // 尝试清理已完成的任务后再判断
      this.cleanup();
      if (this.tasks.size >= CONFIG.MAX_QUEUE_SIZE) {
        return {
          success: false,
          error: `Queue full: cannot exceed ${CONFIG.MAX_QUEUE_SIZE} tasks`,
        };
      }
    }

    if (this.tasks.has(task.id)) {
      return {
        success: false,
        error: `Task with ID "${task.id}" already exists`,
      };
    }

    for (const depId of task.dependencies) {
      if (depId === task.id) {
        throw new Error(`Task "${task.id}" cannot depend on itself`);
      }
    }

    if (this.wouldCreateCycle(task)) {
      return {
        success: false,
        error: `Adding task "${task.id}" would create a circular dependency`,
      };
    }

    this.tasks.set(task.id, task);

    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (dep && dep.dependents && !dep.dependents.includes(task.id)) {
        dep.dependents.push(task.id);
      }
    }

    this.processQueue();

    return { success: true, taskId: task.id };
  }

  /**
   * 从持久化状态重建 Task 对象并加入队列
   *
   * 用于服务器重启后，从 SessionStore 中的 RequestTask 信息重建任务。
   * 服务器重启后 TaskQueue 为空，但 SessionStore 中仍有任务状态，
   * 此时需要重建 Task 对象并恢复执行。
   *
   * @param taskEntry SessionStore 中持久化的任务信息
   * @param answers 已回答的问题历史（从 taskEntry.questions 构建）
   * @param latestAnswer 最新用户回答
   * @returns 重建的 Task 对象
   */
  reconstructTask(
    taskEntry: { taskId: string; content: string; skillName: string | null },
    answers: Array<{
      question: { type: string; content: string; taskId?: string; metadata?: Record<string, unknown> };
      answer: string;
      timestamp: Date;
    }>,
    latestAnswer: string,
  ): Task {
    // 构建 questionHistory（格式化为 Task 所需的结构）
    const questionHistory = answers.map(a => ({
      question: {
        type: a.question.type || 'skill_question',
        content: a.question.content,
        taskId: a.question.taskId || taskEntry.taskId,
        metadata: a.question.metadata,
      },
      answer: a.answer,
      timestamp: a.timestamp,
    }));

    // 构建 Task 对象
    const task: Task = {
      id: taskEntry.taskId,
      requirement: taskEntry.content,
      skillName: taskEntry.skillName || undefined,
      status: 'pending',
      params: {
        latestUserAnswer: latestAnswer,
      },
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      questionHistory,
    };

    const result = this.addTask(task);
    if (!result.success) {
      // 任务 ID 可能已存在（如重启后队列未完全清空），使用新 ID
      const newId = `${taskEntry.taskId}-resume-${Date.now()}`;
      task.id = newId;
      const retryResult = this.addTask(task);
      if (!retryResult.success) {
        throw new Error(`[TaskQueue] reconstructTask failed: ${retryResult.error}`);
      }
    }

    log.info('重建任务并加入队列', { taskId: task.id, questionHistoryCount: questionHistory.length });
    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    return this.getAllTasks().filter((task) => task.status === status);
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * 手动触发队列处理
   */
  triggerProcess(): void {
    this.processQueue();
  }

  // P1-1: 事件驱动接口
  on(event: string, listener: (...args: any[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending") {
      return false;
    }

    this.failTask(taskId, {
      type: "USER_ERROR",
      message: "Task was cancelled by user",
      code: "CANCELLED",
    });

    return true;
  }

  /**
   * Remove a pending task from the queue without marking it as failed.
   * Used at checkpoint boundaries when a request is being closed and its
   * unstarted tasks should not fire (they'll be re-planned by the merged R2).
   * Returns true if the task was removed.
   *
   * Treats both 'pending' and undefined status as removable — tasks added via
   * `addTask` directly may not have their status set yet.
   */
  removePendingTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }
    if (task.status !== undefined && task.status !== 'pending') {
      return false;
    }
    this.tasks.delete(taskId);
    return true;
  }

  clear(): void {
    this.stopCleanupInterval();

    for (const [, handle] of this.timeoutHandles) {
      clearTimeout(handle);
    }
    this.timeoutHandles.clear();

    for (const task of this.tasks.values()) {
      if (task.status === "pending" || task.status === "running") {
        task.status = "failed";
        task.error = {
          type: "FATAL",
          message: "Task queue cleared",
          code: "QUEUE_CLEARED",
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
  private isReachable(
    start: string,
    target: string,
    visited: Set<string>,
  ): boolean {
    if (visited.has(start)) {
      return false;
    }
    visited.add(start);

    const node = this.tasks.get(start);
    if (!node) {
      return false;
    }

    for (const dependentId of node.dependents || []) {
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
      const { tasks: readyTasks } = this.findReadyTasks();

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

      if (
        this.running.size < CONFIG.MAX_CONCURRENT_SUBAGENTS &&
        this.findReadyTasks().hasReady
      ) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  // #21: Merged findReadyTasks and hasReadyTasks into single method
  private findReadyTasks(): { tasks: Task[]; hasReady: boolean } {
    const ready: Task[] = [];

    for (const task of this.tasks.values()) {
      if (task.status !== "pending") {
        continue;
      }

      // Skip tasks without skillName - these are tracking tasks, not execution tasks
      if (!task.skillName) {
        continue;
      }

      const allDepsCompleted = task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === "completed";
      });

      if (allDepsCompleted) {
        ready.push(task);
      }
    }

    ready.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));

    return { tasks: ready, hasReady: ready.length > 0 };
  }

  private shouldRetry(err: unknown, retryableTypes: Set<string>): boolean {
    if (err instanceof LLMError) {
      if (!retryableTypes.has(err.type)) return false;
      // API_ERROR 仅在 statusCode >= 500 时重试(4xx 是客户端错,无意义)
      if (err.type === 'API_ERROR' && (err.statusCode ?? 0) < 500) return false;
      return true;
    }
    return false;
  }

  private getRetryBackoffMs(attempt: number): number {
    // attempt = 1 表示第 1 次重试,2 表示第 2 次
    const base = this.retryBaseDelayMs;
    const max = this.retryMaxDelayMs;
    const exp = Math.min(base * Math.pow(2, attempt - 1), max);
    // ±1s jitter per spec
    return exp + Math.random() * 1000;
  }

  private async executeTask(task: Task): Promise<void> {
    task.status = "running";
    task.startedAt = new Date();
    this.running.add(task.id);

    // P1-1: 发射 task-started,供 MainAgent 翻译层订阅后转发到 SSE
    this.emitter.emit('task-started', { taskId: task.id, task });

    const startTime = Date.now();
    const controller = new AbortController();

    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, CONFIG.TASK_TIMEOUT_MS);
    this.timeoutHandles.set(task.id, timeoutHandle);

    // P5: 重试配置(从 task 取,无则用全局默认值)
    const retryEnabled = CONFIG.PARTIAL_FAILURE_ENABLED;
    const maxRetries = retryEnabled ? (task.maxRetries ?? 2) : 0;
    const retryableTypes = new Set(
      task.retryableErrorTypes ?? ['TIMEOUT', 'NETWORK_ERROR', 'API_ERROR'],
    );
    // 确保 retryCount 是 number(首次执行时为 0,executor 内部可读取)
    if (task.retryCount === undefined) {
      task.retryCount = 0;
    }

    let lastError: unknown;
    let retryExhausted = false;

    try {
      // 重试循环
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          // 重试前:更新 retryCount + 退避
          task.retryCount = (task.retryCount ?? 0) + 1;
          const backoff = this.getRetryBackoffMs(attempt);
          log.warn('task retry', {
            taskId: task.id,
            attempt,
            maxRetries,
            backoffMs: backoff,
            previousError: lastError instanceof Error ? lastError.message : String(lastError),
          });
          await new Promise(r => setTimeout(r, backoff));
        }

        try {
          log.info('开始执行任务', { taskId: task.id, attempt: attempt + 1 });
          // P3 race fix: 优先用 task 自带的 executor(),fall back 到 this.executor。
          // 这样 executor 跟随 task 而不是 process-global,跨请求并发时不会互相覆盖。
          const executor = task.executor ?? this.executor;
          const result = await executor(task, controller.signal);
          log.info('executor 返回成功', { taskId: task.id, attempt: attempt + 1 });

          clearTimeout(timeoutHandle);
          this.timeoutHandles.delete(task.id);

          const executionTime = Date.now() - startTime;
          log.info('任务完成', { taskId: task.id, executionTime, attempts: attempt + 1 });
          this.completeTask(task.id, result, executionTime);
          return;
        } catch (err) {
          lastError = err;
          if (!this.shouldRetry(err, retryableTypes) || attempt >= maxRetries) {
            if (this.shouldRetry(err, retryableTypes) && attempt >= maxRetries) {
              retryExhausted = true;
            }
            break;
          }
        }
      }

      // 走到这里说明重试耗尽或不可重试
      throw lastError;
    } catch (error) {
      log.error('executor 抛出异常', { taskId: task.id, error, retryExhausted });
      clearTimeout(timeoutHandle);
      this.timeoutHandles.delete(task.id);

      const executionTime = Date.now() - startTime;
      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("timed out"));

      if (isTimeout) {
        log.warn('任务超时', { taskId: task.id, executionTime });
      } else {
        log.warn('任务失败', { taskId: task.id, executionTime, retryExhausted });
      }

      // Preserve original AppError (type/code/statusCode) so downstream layers
      // (TaskGraphExecutor + global error handler) can honor the invariant
      // "thrown AppError → envelope with original type/code".
      // LLMError is treated similarly (type/code mirrored) so retry exhaustion
      // doesn't lose the original error classification. retryExhausted is
      // tracked separately on the event payload, NOT mutated into code, so
      // downstream consumers see the original classification.
      const taskError: TaskError = error instanceof AppError
        ? {
            type: error.type,
            code: error.code,
            message: error.message,
            statusCode: error.statusCode,
            stack: error.stack,
            originalError: error,
          }
        : error instanceof LLMError
        ? {
            type: error.type as unknown as TaskError['type'],
            code: error.type,
            message: error.message,
            statusCode: error.statusCode,
            stack: error.stack,
            originalError: error,
          }
        : {
            type: "RETRYABLE",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          };
      this.failTask(task.id, taskError, isTimeout, retryExhausted);
    } finally {
      this.running.delete(task.id);
      this.processQueue();
    }
  }

  private clearTaskTimeout(taskId: string): void {
    const handle = this.timeoutHandles.get(taskId);
    if (handle) {
      clearTimeout(handle);
      this.timeoutHandles.delete(taskId);
    }
  }

  private completeTask(
    taskId: string,
    result: unknown,
    executionTime: number,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const resultStr = JSON.stringify(result);
    const resultSize = resultStr.length;
    if (resultSize > this.MAX_RESULT_SIZE) {
      log.warn('任务结果超过大小限制', { taskId, resultSize });
      result = {
        warning: "Result truncated due to size limit",
        partialResult: resultStr.substring(0, 1000) + "...",
        originalSize: resultSize,
      };
    }

    task.status = "completed";
    task.result = result as TaskResult;
    task.completedAt = new Date();

    this.metrics.tasksCompleted++;
    this.metrics.totalExecutionTime += executionTime;
    this.metrics.averageExecutionTime =
      this.metrics.totalExecutionTime / this.metrics.tasksCompleted;

    this.emitter.emit('task-completed', { taskId, result });
    // notifyDependents removed: processQueue() in finally block already handles dependent task scheduling
  }

  private failTask(
    taskId: string,
    error: TaskError,
    isTimeout: boolean = false,
    retryExhausted: boolean = false,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    task.status = "failed";
    task.error = error;
    task.completedAt = new Date();

    if (isTimeout) {
      this.metrics.tasksTimedOut++;
    } else {
      this.metrics.tasksFailed++;
    }

    this.emitter.emit('task-failed', { taskId, error, retryExhausted });
    this.failDependents(taskId, error);
  }

  // #20: notifyDependents removed - processQueue() in executeTask's finally block already handles scheduling
  // private notifyDependents(taskId: string): void { ... }

  private failDependents(failedTaskId: string, error: TaskError): void {
    const failedTask = this.tasks.get(failedTaskId);
    if (!failedTask) {
      return;
    }

    for (const dependentId of failedTask.dependents || []) {
      const dependent = this.tasks.get(dependentId);
      if (!dependent || dependent.status !== "pending") {
        continue;
      }

      // P3-4: 检查是否为弱依赖
      const isWeakDep = dependent.weakDependencies?.includes(failedTaskId);
      if (isWeakDep) {
        log.info('弱依赖跳过级联失败', { dependentId, failedTaskId });
        continue;
      }

      const propagatedError: TaskError = {
        type: "FATAL",
        message: `Dependency "${failedTaskId}" failed: ${error.message}`,
        code: "DEPENDENCY_FAILED",
      };

      this.failTask(dependentId, propagatedError);
    }
  }
}

export default TaskQueue;
