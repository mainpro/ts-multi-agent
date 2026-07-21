import { TaskQueue } from '../task-queue';
import { ResultAggregator } from './result-aggregator';
import { getSkillData } from '../types';
import { createLogger } from '../observability/logger';

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
export class TaskGraphExecutor {
  constructor(
    private taskQueue: TaskQueue,
    private resultAggregator: ResultAggregator,
  ) {}

  /**
   * 从 TaskPlan 构建 TaskGraph（拓扑排序分层）
   */
  buildTaskGraph(plan: TaskPlan): TaskGraph {
    const nodes: TaskGraphNode[] = plan.tasks.map(t => ({
      taskId: `${plan.id}-${t.id}`,
      content: t.requirement,
      skillName: t.skillName,
      dependencies: t.dependencies.map(depId => `${plan.id}-${depId}`),
      params: t.params || {},
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
        };

        this.taskQueue.addTask(task);
        return this.onceTaskEvent(taskId);
      });

      const layerResults = await Promise.all(layerPromises);

      for (const { taskId, result, status } of layerResults) {
        const node = graph.nodes.find(n => n.taskId === taskId)!;

        if (status === 'completed' && result) {
          completedResults.set(taskId, result);
          allResults.push({ taskId, skillName: node.skillName, requirement: node.content, result });

          // 旧 remember(procedural) 已由 L3 summarizeRequest 在请求完成时统一处理

          // 检查是否需要用户输入
          const skillData = getSkillData(result);
          if (skillData?.status === 'waiting_user_input' && skillData.question) {
            log.info(`⏸️ 任务 ${taskId} 等待用户输入，暂停后续层级执行`);
            return { allResults, waitingTaskId: taskId, failedTasks, done: false };
          }
        } else if (status === 'failed') {
          log.error(`❌ 任务 ${taskId} 执行失败`);
          // 旧 remember(procedural) 已由 L3 summarizeRequest 在请求完成时统一处理
          failedTasks.push({
            taskId,
            skillName: node.skillName,
            error: result?.error || { type: 'FATAL', message: `任务 ${taskId} 执行失败`, code: 'TASK_FAILED' },
          });
        } else {
          log.error(`❌ 任务 ${taskId} 状态异常: ${status}`);
          failedTasks.push({
            taskId,
            skillName: node.skillName,
            error: { type: 'FATAL', message: `任务 ${taskId} ${status}`, code: `TASK_${status.toUpperCase()}` },
          });
        }
      }

      log.info(`✅ Layer ${layerIdx} 完成 (${layer.length}/${layer.length})`);
    }

    log.info(`✅ TaskGraph 全部执行完成 (${allResults.length} 个任务)`);
    return { allResults, failedTasks, done: true };
  }

  /**
   * 从第 0 层开始执行整个任务图
   */
  async executeTaskGraph(
    graph: TaskGraph,
    sessionId: string,
    userId: string,
    request: Request,
  ): Promise<TaskResult> {
    const completedResults: Map<string, any> = new Map();
    const allResults: Array<{ taskId: string; skillName: string; requirement: string; result: any }> = [];

    const layerResult = await this.executeLayers(graph, sessionId, userId, 0, completedResults, allResults);

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
      } catch (e) {
        log.error(`[TaskGraphExecutor] ⚠️ taskGraph 序列化失败: ${(e as Error).message}，跳过保存执行进度`);
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

    // 有任务失败
    if (layerResult.failedTasks.length > 0) {
      return {
        success: false,
        error: layerResult.failedTasks[0].error,
        data: {
          planId: graph.id,
          results: allResults,
          failedTasks: layerResult.failedTasks,
        } as any,
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
  ): Promise<TaskResult> {
    const progress = request.executionProgress!;
    const graph = progress.taskGraph;
    const completedResults = new Map<string, any>(Object.entries(progress.completedResults || {}));

    // 防御性检查：验证加载的进度数据有效性
    if (!graph || !Array.isArray(graph.layers) || !Array.isArray(graph.nodes)) {
      log.error('[TaskGraphExecutor] ⚠️ executionProgress.taskGraph 格式无效，无法恢复断点');
      return { success: false, error: { type: 'FATAL', message: '执行进度损坏，无法恢复断点', code: 'CORRUPT_PROGRESS' } };
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
            return { success: false, error: taskAfterReconstruct!.error || { type: 'FATAL', message: '任务执行失败', code: 'TASK_FAILED' } };
          }
          return { success: false, error: { type: 'FATAL', message: `任务状态异常: ${onceResult.status}`, code: `TASK_${onceResult.status.toUpperCase()}` } };
        }
        taskAfterReconstruct!.result = onceResult.result;

        const tcResult = await this.resultAggregator.handleTaskCompletion(taskAfterReconstruct!, userId, sessionId, request);
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

    const layerResult = await this.executeLayers(graph, sessionId, userId, startLayerIdx, completedResults, allResults);

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
        return this.resultAggregator.handleTaskCompletion({ ...task, result: completedResults.get(taskId) } as Task, userId, sessionId, request);
      }
    }

    if (layerResult.failedTasks.length > 0) {
      return { success: false, error: layerResult.failedTasks[0].error };
    }

    // 所有层执行完毕 → 汇总结果
    const taskList = allResults.map(tr => ({
      taskId: tr.taskId,
      skillName: tr.skillName,
      requirement: tr.requirement,
      response: getSkillData(tr.result)?.response || '',
    }));

    if (taskList.length === 1) {
      log.info(`✅ 断点续传-单任务完成`);
    }
    const summary = await this.resultAggregator.summarizeResults(request.content, taskList, userId, sessionId, request);

    return {
      success: true,
      data: {
        results: taskList,
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
