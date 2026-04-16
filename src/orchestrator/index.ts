/**
 * 编排器
 * P3-5: 分层编排重构
 * 将调度、监控、重规划逻辑从 MainAgent 中分离
 */
import { TaskQueue } from '../task-queue';
import { LLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { UnifiedPlanner } from '../planners/unified-planner';
import { TaskPlan, TaskResult, TaskError, CONFIG } from '../types';

export class Orchestrator {
  private taskQueue: TaskQueue;
  // @ts-expect-error reserved for future use
  private _llm: LLMClient;
  // @ts-expect-error reserved for future use
  private _skillRegistry: SkillRegistry;
  // @ts-expect-error reserved for future use
  private _planner: UnifiedPlanner;
  private replanAttempts: Map<string, number> = new Map();

  constructor(
    taskQueue: TaskQueue,
    llm: LLMClient,
    skillRegistry: SkillRegistry,
    planner: UnifiedPlanner
  ) {
    this.taskQueue = taskQueue;
    this._llm = llm;
    this._skillRegistry = skillRegistry;
    this._planner = planner;
  }

  /**
   * 编排任务计划
   */
  async orchestrate(plan: TaskPlan): Promise<TaskResult> {
    // 提交任务
    this.submitTasks(plan);

    // 事件驱动等待完成
    const result = await this.waitForPlanCompletion(plan.id);

    if (!result.success) {
      // 智能重规划
      return this.smartReplan(plan, result.error as TaskError);
    }

    return result;
  }

  /**
   * 提交任务到队列
   */
  private submitTasks(plan: TaskPlan): void {
    for (const task of plan.tasks) {
      this.taskQueue.addTask({
        id: task.id,
        skillName: task.skillName,
        requirement: task.requirement,
        params: task.params,
        dependencies: task.dependencies,
        status: 'pending',
        createdAt: new Date(),
      });
    }
  }

  /**
   * 等待计划中所有任务完成
   */
  private waitForPlanCompletion(planId: string): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve) => {
      const checkCompletion = () => {
        const allTasks = this.taskQueue.getAllTasks();
        const planTasks = allTasks.filter((t: any) => t.id.startsWith(planId) && t.skillName);

        if (planTasks.length === 0) {
          resolve({ success: true, data: { planId, results: [] } });
          return;
        }

        const allDone = planTasks.every((t: any) => t.status === 'completed' || t.status === 'failed');
        if (allDone) {
          const failedTasks = planTasks.filter((t: any) => t.status === 'failed');
          if (failedTasks.length === 0) {
            const results = planTasks
              .filter((t: any) => t.status === 'completed')
              .map((t: any) => ({
                taskId: t.id,
                skillName: t.skillName,
                result: t.result,
              }));
            resolve({ success: true, data: { planId, results } });
          } else {
            resolve({
              success: false,
              error: failedTasks[0].error || {
                type: 'RETRYABLE',
                message: `${failedTasks.length} task(s) failed`,
                code: 'TASK_FAILED',
              },
            });
          }
          return;
        }
      };

      // 监听事件
      const onDone = () => {
        clearTimeout(timeoutHandle);
        checkCompletion();
      };
      (this.taskQueue as any).on?.('task-completed', onDone);
      (this.taskQueue as any).on?.('task-failed', onDone);

      // 超时保护
      const timeoutHandle = setTimeout(() => {
        (this.taskQueue as any).off?.('task-completed', onDone);
        (this.taskQueue as any).off?.('task-failed', onDone);
        resolve({
          success: false,
          error: {
            type: 'RETRYABLE',
            message: `Orchestration timeout after ${CONFIG.TOTAL_TIMEOUT_MS}ms`,
            code: 'TIMEOUT',
          } as TaskError,
        });
      }, CONFIG.TOTAL_TIMEOUT_MS);

      // 首次检查
      checkCompletion();
    });
  }

  /**
   * 智能重规划
   */
  private async smartReplan(plan: TaskPlan, error: TaskError): Promise<TaskResult> {
    const attempts = this.replanAttempts.get(plan.id) || 0;
    if (attempts >= CONFIG.MAX_REPLAN_ATTEMPTS) {
      return { success: false, error };
    }

    this.replanAttempts.set(plan.id, attempts + 1);
    console.log(`[Orchestrator] 重规划第 ${attempts + 1} 次`);

    // TODO: 分析失败原因，决定重规划策略
    // - 部分失败：只重规划失败的任务
    // - 全部失败：整体重规划
    return { success: false, error };
  }
}
