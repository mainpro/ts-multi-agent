import { TaskQueue, TaskExecutor } from '../task-queue';
import { ResultAggregator } from './result-aggregator';
import { getSkillData } from '../types';
import { SessionStore } from '../memory/session-store';
import { createLogger } from '../observability/logger';
import { BusinessError, LlmError, AppError, SkillError } from '../errors';
import { LLMError } from '../llm';

const log = createLogger({ module: 'TaskGraphExecutor' });
import {
  Task,
  TaskResult,
  TaskPlan,
  TaskGraph,
  TaskGraphNode,
  Request,
  QAEntry,
  CONFIG,
  TaskError,
} from '../types';

/**
 * 单个失败任务信息
 */
interface FailedTaskInfo {
  taskId: string;
  skillName: string | null;
  /** P5: task 需求文本,让汇总 LLM 看到失败 task 的 context */
  requirement?: string;
  error: TaskError;
}

/**
 * 单层执行结果
 */
interface LayerExecutionResult {
  /** 所有已完成任务的结果（包含本次和之前累积的） */
  allResults: Array<{ taskId: string; skillName: string; requirement: string; result: any }>;
  /** 是否在执行过程中遇到等待用户输入的任务 */
  waitingTaskId?: string;
  /** 失败任务列表（收集所有失败，而非仅第一个） */
  failedTasks: FailedTaskInfo[];
  /** 是否全部执行完成（true=完成，false=中途暂停或失败） */
  done: boolean;
  /**
   * 是否因 checkpoint 让位而被中断。
   * true=onCheckpoint 返回 shouldStop=true,executeLayers 在该层完成后立即返回,
   * 调用方(executeTaskGraph / resumeFromBreakpoint)应停止后续层的执行。
   * 用于多任务合并:R1 在 checkpoint 让位给 R2 后,后续 layer 不再执行,避免并发写 session。
   */
  stopped?: boolean;
}

/**
 * TaskGraphExecutor — 任务图构建、分层执行、断点续传
 *
 * 从 MainAgent 抽取，负责：
 * - buildTaskGraph: TaskPlan → TaskGraph（拓扑分层）
 * - executeTaskGraph: 从第 0 层开始执行整个图
 * - resumeFromBreakpoint: 从断点层恢复执行
 * - onceTaskEvent: 一次性监听单个任务完成/失败事件
 *
 * executeLayers 是 executeTaskGraph 和 resumeFromBreakpoint 的共享核心循环，
 * 消除了原先 ~200 行的重复代码。
 */
/**
 * P3 race fix: per-task executor 工厂。
 *
 * MainAgent 调用 TaskGraphExecutor 时把当前请求的 executor(例如某个虚拟员工)
 * 通过 factory 传入,executeLayers 在构造 task 时 `task.executor = factory(task)`,
 * 这样 executor 跟随 task 而不是 process-global,跨请求并发时不会互相覆盖。
 *
 * Factory 返回 undefined 时退回到 TaskQueue 自身的 this.executor(back-compat)。
 */
export type TaskExecutorFactory = (task: Task) => TaskExecutor | undefined;

export class TaskGraphExecutor {
  constructor(
    private taskQueue: TaskQueue,
    private resultAggregator: ResultAggregator,
    private sessionStore: SessionStore,
    private options: {
      /**
       * Called after each task layer completes; awaited before next layer starts.
       * 返回 `{ shouldStop: true }` 时,executeLayers 立即中断后续层执行 —— 用于多任务合并
       * 流程:R1 在 checkpoint 让位给 R2 后,后续 layer 不再执行,避免并发写 session。
       * 返回 void / undefined 时,保持原行为(继续执行下一层)。
       *
       * `userId` / `sessionId` 由 executeLayers 透传,主智能体据此定位 session,无需依赖
       * 实例级共享字段(避免多 session 并发时上下文覆盖)。
       */
      onCheckpoint?: (info: {
        userId: string;
        sessionId: string;
        requestId: string;
        completedTaskIds: string[];
      }) => Promise<{ shouldStop?: boolean } | void>;
    } = {},
  ) {}

  /**
   * 从 TaskPlan 构建 TaskGraph（拓扑排序分层）
   *
   * Task 8: plan.tasks[i] 上由 MainAgent 写入的 `_personaContext` / `allowedTools`
   * 透传到 TaskGraphNode,后续 executeLayers 在构造运行时 Task 时再复制到 task,
   * 这样 SubAgent.execute 能读到 Master 注入的 persona/tools(避免 RequestTask
   * 路径上字段被吞)。
   */
  buildTaskGraph(plan: TaskPlan): TaskGraph {
    const nodes: TaskGraphNode[] = plan.tasks.map(t => ({
      taskId: `${plan.id}-${t.id}`,
      content: t.requirement,
      skillName: t.skillName,
      dependencies: t.dependencies.map(depId => `${plan.id}-${depId}`),
      params: t.params || {},
      _personaContext: t._personaContext,
      allowedTools: t.allowedTools,
    }));

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node.taskId, node.dependencies.length);
      dependents.set(node.taskId, []);
    }

    for (const node of nodes) {
      for (const dep of node.dependencies) {
        if (dependents.has(dep)) {
          dependents.get(dep)!.push(node.taskId);
        }
      }
    }

    const layers: string[][] = [];
    const processed = new Set<string>();

    while (processed.size < nodes.length) {
      const readyNodes = nodes.filter(
        n => !processed.has(n.taskId) && (inDegree.get(n.taskId) || 0) === 0
      );

      if (readyNodes.length === 0) {
        log.warn(`[TaskGraphExecutor] ⚠️ 检测到循环依赖，将剩余 ${nodes.length - processed.size} 个任务放入同一层`);
        const remaining = nodes.filter(n => !processed.has(n.taskId));
        layers.push(remaining.map(n => n.taskId));
        break;
      }

      layers.push(readyNodes.map(n => n.taskId));

      for (const node of readyNodes) {
        processed.add(node.taskId);
        for (const dep of dependents.get(node.taskId) || []) {
          inDegree.set(dep, (inDegree.get(dep) || 1) - 1);
        }
      }
    }

    log.info(`📊 TaskGraph 构建: ${nodes.length} 个节点, ${layers.length} 层`);
    for (let i = 0; i < layers.length; i++) {
      log.info(`  Layer ${i}: [${layers[i].join(', ')}]`);
    }

    return { id: plan.id, requirement: plan.requirement, nodes, layers };
  }

  /**
   * 解析参数引用
   *
   * 将参数中的 $taskId.result 引用替换为上游任务的实际结果。
   */
  resolveParams(
    params: Record<string, unknown> | undefined,
    completedResults: Map<string, any>,
  ): Record<string, unknown> {
    if (!params) return {};

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        const match = value.match(/^\$([^.]+)\.result(?:\.(.+))?$/);
        if (match) {
          const refTaskId = match[1];
          const field = match[2];
          const refResult = completedResults.get(refTaskId);
          if (refResult !== undefined) {
            const data = getSkillData(refResult)?.response || refResult;
            if (field) {
              resolved[key] = field.split('.').reduce((obj: any, f: string) => obj?.[f], data);
            } else {
              resolved[key] = typeof data === 'string' ? data : JSON.stringify(data);
            }
            log.info(`[TaskGraphExecutor] 🔗 参数解析: ${key} = $${refTaskId}.result${field ? '.' + field : ''}`);
          } else {
            log.warn(`[TaskGraphExecutor] ⚠️ 参数引用未找到: ${value} (任务 ${refTaskId} 尚未完成)`);
            resolved[key] = value;
          }
        } else {
          resolved[key] = value;
        }
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  /**
   * 一次性监听单个任务完成/失败事件
   */
  onceTaskEvent(taskId: string): Promise<{ taskId: string; result: any; status: string }> {
    return new Promise((resolve) => {
      const handler = (event: { taskId: string; result?: any }) => {
        if (event.taskId !== taskId) return;
        const t = this.taskQueue.getTask(taskId);
        if (!t) {
          resolve({ taskId, result: null, status: 'lost' });
          return;
        }
        if (t.status === 'completed' || t.status === 'failed') {
          cleanup();
          resolve({ taskId, result: t.result, status: t.status });
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        this.taskQueue.off('task-completed', handler);
        this.taskQueue.off('task-failed', handler);
      };

      this.taskQueue.on('task-completed', handler);
      this.taskQueue.on('task-failed', handler);

      const timeoutHandle = setTimeout(() => {
        cleanup();
        resolve({ taskId, result: null, status: 'timeout' });
      }, CONFIG.TASK_TIMEOUT_MS);

      handler({ taskId });
    });
  }

  /**
   * 分层执行任务图的核心循环（executeTaskGraph 和 resumeFromBreakpoint 共享）
   *
   * @param startLayerIdx 起始层索引（0=从头执行，>0=断点续传）
   * @param completedResults 已完成任务的结果（会被本方法更新）
   * @param allResults 累积结果列表（会被本方法更新）
   */
  private async executeLayers(
    graph: TaskGraph,
    sessionId: string,
    userId: string,
    startLayerIdx: number,
    completedResults: Map<string, any>,
    allResults: Array<{ taskId: string; skillName: string; requirement: string; result: any }>,
    executorFactory?: TaskExecutorFactory,
  ): Promise<LayerExecutionResult> {
    const failedTasks: FailedTaskInfo[] = [];

    for (let layerIdx = startLayerIdx; layerIdx < graph.layers.length; layerIdx++) {
      const layer = graph.layers[layerIdx];
      log.info(`🚀 执行 Layer ${layerIdx}: ${layer.length} 个任务`);

      const layerPromises = layer.map(async (taskId) => {
        const node = graph.nodes.find(n => n.taskId === taskId)!;
        const resolvedParams = this.resolveParams(node.params, completedResults);

        const task: Task = {
          id: taskId,
          requirement: node.content,
          status: 'pending',
          skillName: node.skillName,
          params: { ...node.params, ...resolvedParams },
          dependencies: node.dependencies,
          dependents: [],
          createdAt: new Date(),
          retryCount: 0,
          sessionId,
          userId,
          questionHistory: [],
          // P3 race fix: 绑定 per-task executor,executor 跟随 task 生命周期而不是
          // process-global。即使后续 MainAgent 调用 setExecutor 覆盖了原值,
          // 已入队的 task 仍用自己绑定的 executor,避免跨请求并发互相污染。
          executor: executorFactory ? executorFactory({ id: taskId, requirement: node.content, skillName: node.skillName, dependencies: node.dependencies } as Task) : undefined,
          // Task 8: 把 Master 注入的 persona/tools 从 TaskGraphNode 复制到运行时 Task。
          // SubAgent.execute(task) 读这两个字段拼 system prompt / 过滤工具列表;
          // 没有这个传递链,SubAgent 永远拿不到 Master 的注入,persona prefix 和
          // 员工白/黑名单会全部失效。
        };
        if (node._personaContext !== undefined) {
          task._personaContext = node._personaContext;
        }
        if (node.allowedTools !== undefined) {
          task.allowedTools = node.allowedTools;
        }

        this.taskQueue.addTask(task);
        return this.onceTaskEvent(taskId);
      });

      const layerResults = await Promise.all(layerPromises);

      for (const { taskId, result, status } of layerResults) {
        const node = graph.nodes.find(n => n.taskId === taskId)!;

        // Read task.error directly so original AppError (with code/type preserved) is available.
        // `result?.error` is not reliable — TaskQueue only sets task.error, not task.result.error.
        const taskRecord = this.taskQueue.getTask(taskId);

        if (status === 'completed' && result) {
          completedResults.set(taskId, result);
          allResults.push({ taskId, skillName: node.skillName, requirement: node.content, result });

          // 旧 remember(procedural) 已由 L3 summarizeRequest 在请求完成时统一处理

          // 检查是否需要用户输入
          const skillData = getSkillData(result);
          // P2-2 修复:即使 question 缺失也按 waiting 处理,
          // 让上层(main-agent)有机会识别并兜底(question 缺失通常为子智能体 bug)。
          // 旧逻辑要求 question 必须存在,导致 question 缺失时 waitingTaskId 不设置,
          // 上层会 fall through 到 completeRequest,造成 request.status='completed'
          // 与 task.status='waiting' 状态不一致。
          if (skillData?.status === 'waiting_user_input') {
            log.info(`⏸️ 任务 ${taskId} 等待用户输入，暂停后续层级执行`, {
              hasQuestion: !!skillData.question,
            });
            return { allResults, waitingTaskId: taskId, failedTasks, done: false };
          }
        } else if (status === 'failed') {
          log.error(`❌ 任务 ${taskId} 执行失败`);
          // 旧 remember(procedural) 已由 L3 summarizeRequest 在请求完成时统一处理
          failedTasks.push({
            taskId,
            skillName: node.skillName,
            requirement: node.content,
            // Prefer task.error (set by TaskQueue with original AppError code/type).
            // Fall back to result?.error or hardcoded TASK_FAILED only if both unavailable.
            error: taskRecord?.error || result?.error || { type: 'FATAL', message: `任务 ${taskId} 执行失败`, code: 'TASK_FAILED' },
          });
        } else {
          log.error(`❌ 任务 ${taskId} 状态异常: ${status}`);
          failedTasks.push({
            taskId,
            skillName: node.skillName,
            requirement: node.content,
            error: taskRecord?.error || { type: 'FATAL', message: `任务 ${taskId} ${status}`, code: `TASK_${status.toUpperCase()}` },
          });
        }
      }

      log.info(`✅ Layer ${layerIdx} 完成 (${layer.length}/${layer.length})`);

      // Checkpoint hook: invoked between layers so the orchestrator can drain
      // the pending request queue. Awaited so the next layer does not start
      // until the gate decides whether to continue, merge, or stop.
      //
      // P0 闭环修复:onCheckpoint 可返回 `{ shouldStop: true }`,表示 R1 已在该层
      // 让位给 spawn 的 R2,后续 layer 不应再执行(否则 R1 与 R2 并发写 session,
      // 且 R1 永远停在 checkpoint_reached)。
      if (this.options.onCheckpoint) {
        const completedTaskIds = layerResults
          .filter(r => r.status === 'completed')
          .map(r => r.taskId);
        const checkpointResult = await this.options.onCheckpoint({
          userId,
          sessionId,
          requestId: 'session-active',  // overwritten by caller in Task 6
          completedTaskIds,
        });
        if (checkpointResult?.shouldStop) {
          log.info(`⏸️ checkpoint 信号让位,停止后续 layer (R1 已让给 R2)`);
          return { allResults, failedTasks, done: false, stopped: true };
        }
      }
    }

    log.info(`✅ TaskGraph 全部执行完成 (${allResults.length} 个任务)`);
    return { allResults, failedTasks, done: true };
  }

  /**
   * 从第 0 层开始执行整个任务图
   *
   * @param executorFactory P3 race fix 注入:per-task executor 工厂。
   *                        传入后,executeLayers 在 addTask 前给每个 task 绑定 executor,
   *                        跨请求并发时不会互相覆盖。
   *                        未传入时,executor 走 TaskQueue 自己的 this.executor(back-compat)。
   */
  async executeTaskGraph(
    graph: TaskGraph,
    sessionId: string,
    userId: string,
    request: Request,
    executorFactory?: TaskExecutorFactory,
  ): Promise<TaskResult> {
    const completedResults: Map<string, any> = new Map();
    const allResults: Array<{ taskId: string; skillName: string; requirement: string; result: any }> = [];

    const layerResult = await this.executeLayers(graph, sessionId, userId, 0, completedResults, allResults, executorFactory);

    // P3-1 修复:把每个 task 的执行结果回写到 session.tasks,
    // 避免 syncRequestStatus 看到 task=pending 推出 status='processing',
    // 进而导致 completeRequest 清不掉 activeRequestId(产生"卡死会话"假象)。
    // 失败的任务同样回写,确保 syncRequestStatus 能推出 'completed' / 'failed'。
    for (const tr of allResults) {
      try {
        await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, tr.taskId, {
          status: 'completed',
          result: getSkillData(tr.result)?.response || null,
        });
      } catch (e) {
        log.warn('回写 task 状态失败', { taskId: tr.taskId, error: e });
      }
    }
    for (const ft of layerResult.failedTasks) {
      try {
        // RequestTask 没有 error 字段,这里只更新 status(失败详情由
        // executeLayers 抛出的 SkillError 承载 + 日志记录)
        await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, ft.taskId, {
          status: 'failed',
        });
      } catch (e) {
        log.warn('回写 failed task 状态失败', { taskId: ft.taskId, error: e });
      }
    }

    // P0 闭环修复:R1 在 checkpoint 让位给 R2,跳过后续 layer。
    // 不保存 executionProgress(因为 R1 不再是 active),通过 mergedAway 标记让
    // main-agent 跳过 completeRequest / 汇总 / 助手消息保存。
    if (layerResult.stopped) {
      log.info(`📤 R1 让位给 R2,跳过后续汇总`);
      return {
        success: true,
        data: {
          planId: graph.id,
          results: allResults,
          mergedAway: true,
        },
      };
    }

    // 遇到等待用户输入：保存执行进度并返回
    if (layerResult.waitingTaskId) {
      const progressData = {
        currentLayerIndex: this.findLayerIndex(graph, layerResult.waitingTaskId) + 1,
        completedResults: Object.fromEntries(completedResults),
        taskGraph: graph,
      };

      // 验证 taskGraph 可序列化（Issue #3: 防止 Map 等非标准字段进入 JSON）
      try {
        const serialized = JSON.stringify(progressData.taskGraph);
        if (!serialized || serialized === 'null') {
          log.error(`[TaskGraphExecutor] ⚠️ taskGraph 序列化结果为空，跳过保存执行进度`);
        }
      } catch (error) {
        if (error instanceof LLMError) {
          throw new LlmError(error.type, error.message, { cause: error });
        }
        if (error instanceof AppError) throw error;
        throw new BusinessError('EXECUTION_INTERRUPTED',
          error instanceof Error ? error.message : String(error),
          { cause: error });
      }

      request.executionProgress = progressData;
      return {
        success: true,
        data: {
          planId: graph.id,
          results: allResults,
          waitingTaskId: layerResult.waitingTaskId,
        },
      };
    }

    // P5: 区分全失败 vs 部分失败(spec §7.1)
    // - 全失败(零成功):throw SkillError,保留 error-propagation-e2e 等测试期望的错误事件路径
    // - 部分失败(部分成功):返回 hasPartialFailure=true,MainAgent 走汇总阶段
    if (layerResult.failedTasks.length > 0) {
      const totalTasks = layerResult.failedTasks.length + allResults.length;
      if (layerResult.failedTasks.length === totalTasks) {
        // ALL failed → 保留 throw 行为(spec §7.1 failed 状态)
        const firstFailure = layerResult.failedTasks[0];
        // Preserve original AppError so the global error handler envelope
        // (type/code/statusCode) reflects the upstream cause, not the wrapping layer.
        if (firstFailure.error.originalError instanceof AppError) {
          throw firstFailure.error.originalError;
        }
        throw new SkillError(
          firstFailure.error.code || 'TASK_GRAPH_EXECUTION_FAILED',
          firstFailure.error.message || 'Task graph execution failed',
          { cause: firstFailure.error }
        );
      }
      // 部分失败 → 返回 hasPartialFailure,MainAgent 走汇总
      log.warn('TaskGraph 部分失败,进入汇总阶段', {
        failedCount: layerResult.failedTasks.length,
        successCount: allResults.length,
      });
      return {
        success: false,
        data: {
          planId: graph.id,
          results: allResults,
          failedTasks: layerResult.failedTasks,
          hasPartialFailure: true,
        },
      };
    }

    return {
      success: true,
      data: { planId: graph.id, results: allResults },
    };
  }

  /**
   * 从断点恢复执行
   *
   * 1. 先让等待中的任务继续执行（用户已回答）
   * 2. 清除执行进度
   * 3. 从断点层继续执行剩余层级
   */
  async resumeFromBreakpoint(
    userId: string,
    sessionId: string,
    request: Request,
    question: QAEntry,
    executorFactory?: TaskExecutorFactory,
  ): Promise<TaskResult> {
    const progress = request.executionProgress!;
    const graph = progress.taskGraph;
    const completedResults = new Map<string, any>(Object.entries(progress.completedResults || {}));

    // 防御性检查：验证加载的进度数据有效性
    if (!graph || !Array.isArray(graph.layers) || !Array.isArray(graph.nodes)) {
      log.error('[TaskGraphExecutor] ⚠️ executionProgress.taskGraph 格式无效，无法恢复断点');
      throw new BusinessError('CORRUPT_PROGRESS', '执行进度损坏，无法恢复断点');
    }
    if (!progress.completedResults || typeof progress.completedResults !== 'object') {
      log.warn('[TaskGraphExecutor] ⚠️ executionProgress.completedResults 格式异常，将从空结果开始');
    }

    const startLayerIdx = progress.currentLayerIndex;

    log.info(`📌 从 Layer ${startLayerIdx} 恢复执行，已有 ${completedResults.size} 个任务结果`);

    // 先让等待的任务继续执行
    if (question.taskId) {
      let taskAfterReconstruct = this.taskQueue.getTask(question.taskId);

      if (!taskAfterReconstruct) {
        // 服务器重启后 TaskQueue 为空，从 request.tasks 重建任务
        const taskEntry = request.tasks.find(t => t.taskId === question.taskId);
        if (!taskEntry) {
          throw new Error(`[TaskGraphExecutor] 无法恢复任务 ${question.taskId}：不在 TaskQueue 中，也不在 request.tasks 中`);
        }

        const answers = (taskEntry.questions || [])
          .filter((q: any) => q.answer)
          .map((q: any) => ({
            question: { type: 'skill_question', content: q.content, taskId: q.taskId, metadata: q.metadata },
            answer: q.answer,
            timestamp: new Date(q.answeredAt || q.createdAt),
          }));

        taskAfterReconstruct = this.taskQueue.reconstructTask(
          { taskId: taskEntry.taskId, content: taskEntry.content, skillName: taskEntry.skillName },
          answers,
          question.answer || '',
        );
        taskAfterReconstruct.params = taskAfterReconstruct.params || {};
        taskAfterReconstruct.params.latestUserAnswer = question.answer || '';
      }

      if (taskAfterReconstruct) {
        taskAfterReconstruct.questionHistory = taskAfterReconstruct.questionHistory || [];
        taskAfterReconstruct.questionHistory.push({
          question: { type: 'skill_question', content: question.content, taskId: question.taskId },
          answer: question.answer || '',
          timestamp: new Date(),
        });
        taskAfterReconstruct.params = taskAfterReconstruct.params || {};
        taskAfterReconstruct.params.latestUserAnswer = question.answer || '';
        taskAfterReconstruct.status = 'pending';
        taskAfterReconstruct.result = undefined;
        taskAfterReconstruct.error = undefined;

        this.taskQueue.triggerProcess();

        const onceResult = await this.onceTaskEvent(question.taskId);
        if (onceResult.status !== 'completed') {
          if (onceResult.status === 'failed') {
            // After triggerProcess, the task error may have been repopulated by the worker.
            // Read the latest value through a Task-typed local to avoid TS narrowing to `undefined`
            // (we assigned undefined above intentionally to clear stale state).
            const taskRef = taskAfterReconstruct as Task;
            const failedError: TaskError | undefined = taskRef.error;
            throw new SkillError(
              failedError?.code || 'TASK_FAILED',
              failedError?.message || '任务执行失败',
              { cause: failedError },
            );
          }
          throw new SkillError(
            `TASK_${onceResult.status.toUpperCase()}`,
            `任务状态异常: ${onceResult.status}`,
          );
        }
        taskAfterReconstruct!.result = onceResult.result;

        const tcResult = await this.resultAggregator.handleTaskCompletion(taskAfterReconstruct!, userId, sessionId, request, graph.id);
        if (tcResult.success && tcResult.data && typeof tcResult.data === 'object' && 'type' in tcResult.data && (tcResult.data as any).type === 'question') {
          return tcResult;
        }
        if (tcResult.success) {
          completedResults.set(question.taskId, taskAfterReconstruct!.result);
        } else {
          return tcResult;
        }
      }
    }

    request.executionProgress = undefined;

    const allResults: Array<{ taskId: string; skillName: string; requirement: string; result: any }> = [];
    for (const [taskId, result] of completedResults) {
      const node = graph.nodes.find(n => n.taskId === taskId);
      if (node) {
        allResults.push({ taskId, skillName: node.skillName, requirement: node.content, result });
      }
    }

    const layerResult = await this.executeLayers(graph, sessionId, userId, startLayerIdx, completedResults, allResults, executorFactory);

    // 遇到新的等待用户输入
    if (layerResult.waitingTaskId) {
      const taskId = layerResult.waitingTaskId;
      request.executionProgress = {
        currentLayerIndex: this.findLayerIndex(graph, taskId) + 1,
        completedResults: Object.fromEntries(completedResults),
        taskGraph: graph,
      };
      const task = this.taskQueue.getTask(taskId);
      if (task) {
        return this.resultAggregator.handleTaskCompletion({ ...task, result: completedResults.get(taskId) } as Task, userId, sessionId, request, graph.id);
      }
    }

    // P5: 区分全失败 vs 部分失败(与 executeTaskGraph 一致)
    if (layerResult.failedTasks.length > 0) {
      const totalTasks = layerResult.failedTasks.length + allResults.length;
      if (layerResult.failedTasks.length === totalTasks) {
        // ALL failed → throw(保留原 AppError cause)
        const firstFailure = layerResult.failedTasks[0];
        if (firstFailure.error?.originalError instanceof AppError) {
          throw firstFailure.error.originalError;
        }
        throw new SkillError(
          firstFailure.error?.code || 'TASK_GRAPH_EXECUTION_FAILED',
          firstFailure.error?.message || 'Task graph execution failed',
          { cause: firstFailure.error },
        );
      }
      // 部分失败 → 返回 hasPartialFailure,留给调用方(MainAgent)走汇总
      log.warn('Resume TaskGraph 部分失败,进入汇总阶段', {
        failedCount: layerResult.failedTasks.length,
        successCount: allResults.length,
      });
      return {
        success: true,
        data: {
          planId: graph.id,
          results: allResults,
          failedTasks: layerResult.failedTasks,
          hasPartialFailure: true,
        },
      };
    }

    // 所有层执行完毕 → 汇总结果
    // P5: 加 status 字段让 summarizeResults 走 every(completed) 正确判断(B-1 真正的修法)
    const successResults = allResults.map(tr => ({
      taskId: tr.taskId,
      skillName: tr.skillName,
      requirement: tr.requirement,
      response: getSkillData(tr.result)?.response || '',
      status: 'completed',
    }));
    if (successResults.length === 1) {
      log.info(`✅ 断点续传-单任务完成`);
    }
    const summary = await this.resultAggregator.summarizeResults(request.content, successResults, userId, sessionId, request);

    return {
      success: true,
      data: {
        results: successResults,
        type: 'skill_task',
        requestId: request.requestId,
        completed: summary.completed,
        summary: summary.summary,
      },
    };
  }

  /**
   * 查找 taskId 所在的层索引
   */
  private findLayerIndex(graph: TaskGraph, taskId: string): number {
    for (let i = 0; i < graph.layers.length; i++) {
      if (graph.layers[i].includes(taskId)) return i;
    }
    return 0;
  }
}

export default TaskGraphExecutor;
