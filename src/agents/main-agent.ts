import { LLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { TaskQueue } from '../task-queue';
import { IntentRouter } from '../routers';
import { UnifiedPlanner } from '../planners';
import {
  Task,
  TaskResult,
  TaskError,
  TaskStatus,
  TaskPlan,
  CONFIG,
  TaskPlanSchema,
} from '../types';

export class MainAgent {
  private maxReplanAttempts: number;
  private static planIdCounter = 0;
  private intentRouter: IntentRouter;
  private unifiedPlanner: UnifiedPlanner;

  constructor(
    private llm: LLMClient,
    private skillRegistry: SkillRegistry,
    private taskQueue: TaskQueue,
    maxReplanAttempts: number = CONFIG.MAX_REPLAN_ATTEMPTS
  ) {
    this.maxReplanAttempts = maxReplanAttempts;
    this.intentRouter = new IntentRouter(llm, skillRegistry);
    this.unifiedPlanner = new UnifiedPlanner(llm, skillRegistry);
  }

  async processRequirement(requirement: string): Promise<TaskResult> {
    try {
      console.log(`[MainAgent] 📥 收到用户请求: "${requirement}"`);

      // ========== 步骤 1: 意图路由（快速应答） ==========
      console.log(`[MainAgent] 🔄 正在分类用户意图...`);
      const intentResult = await this.intentRouter.classify(requirement);
      console.log(`[MainAgent] 📊 意图分类: ${intentResult.intent} (置信度: ${intentResult.confidence})`);

      switch (intentResult.intent) {
      case 'small_talk':
        console.log(`[MainAgent] 💬 闲聊模式：快速应答`);
        return {
          success: true,
          data: {
            message: intentResult.suggestedResponse,
            type: 'small_talk',
          },
        };

      case 'out_of_scope':
        console.log(`[MainAgent] 🚫 超出范围：返回提示`);
        return {
          success: true,
          data: {
            message: intentResult.suggestedResponse,
            type: 'out_of_scope',
          },
        };

      case 'unclear':
        console.log(`[MainAgent] ❓ 意图不明确：请求澄清`);
        return {
          success: true,
          data: {
            message: this.intentRouter.generateClarificationResponse(),
            type: 'clarification',
          },
        };

      case 'skill_task':
        console.log(`[MainAgent] ⚙️ 技能任务：继续处理${intentResult.matchedSkill ? ` (匹配技能: ${intentResult.matchedSkill})` : ''}`);
        break;
      }

      // ========== 步骤 2: 统一规划（合并分析+匹配+规划） ==========
      console.log(`[MainAgent] 🚀 使用统一规划器...`);
      const planResult = await this.unifiedPlanner.plan(requirement);

      if (!planResult.success || !planResult.plan) {
        console.log(`[MainAgent] ⚠️ 规划失败或需要澄清`);
        return {
          success: true,
          data: {
            message: planResult.clarificationPrompt || '抱歉，无法处理该请求。',
            type: 'clarification',
          },
        };
      }

      console.log(`[MainAgent] ✅ 规划完成 - 共 ${planResult.plan.tasks.length} 个任务`);
      planResult.plan.tasks.forEach((task, idx) => {
        console.log(`[MainAgent] 任务 ${idx + 1}: [${task.skillName}] ${task.requirement}`);
      });

      // ========== 步骤 3: 执行任务 ==========
      console.log(`[MainAgent] 🔍 执行任务 (监控中...)`);
      return await this.monitorAndReplan(planResult.plan);
    } catch (error) {
      console.error('Error processing requirement:', error);
      return {
        success: false,
        error: {
          type: 'FATAL',
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'PROCESSING_ERROR',
        },
      };
    }
}

  async monitorAndReplan(plan: TaskPlan): Promise<TaskResult> {
    let replanAttempts = 0;
    let currentPlan = plan;
    let submittedPlans = new Set<string>();

    while (replanAttempts <= this.maxReplanAttempts) {
      // Only submit tasks if this plan hasn't been submitted before
      if (!submittedPlans.has(currentPlan.id)) {
        this.submitPlanTasks(currentPlan);
        submittedPlans.add(currentPlan.id);
      }
      const result = await this.waitForCompletion(currentPlan.id);

      if (result.success) {
        return result;
      }

      const failedTasks = this.getFailedTasks(currentPlan);

      if (failedTasks.length === 0) {
        return result;
      }

      const errors = failedTasks.map((t) => t.error!).filter(Boolean);
      const allRetryable = errors.every((e) => e.type === 'RETRYABLE');

      if (!allRetryable) {
        const fatalError = errors.find((e) => e.type !== 'RETRYABLE');
        return {
          success: false,
          error: fatalError || errors[0],
        };
      }

      if (replanAttempts >= this.maxReplanAttempts) {
        return {
          success: false,
          error: {
            type: 'FATAL',
            message: `Max replan attempts (${this.maxReplanAttempts}) exceeded`,
            code: 'MAX_REPLAN_EXCEEDED',
          },
        };
      }

      replanAttempts++;
      currentPlan = await this.replan(currentPlan, errors);
    }

    return {
      success: false,
      error: {
        type: 'FATAL',
        message: 'Unexpected end of replan loop',
        code: 'UNEXPECTED',
      },
    };
  }

  private submitPlanTasks(plan: TaskPlan): void {
    console.log(`[MainAgent] 📤 向任务队列提交 ${plan.tasks.length} 个任务`);
    for (const taskDef of plan.tasks) {
      // Generate unique task ID by combining plan ID and task ID
      const uniqueTaskId = `${plan.id}-${taskDef.id}`;
      
      // Update dependencies to use unique task IDs
      const updatedDependencies = taskDef.dependencies.map(depId => `${plan.id}-${depId}`);
      
      const task: Task = {
        id: uniqueTaskId,
        requirement: taskDef.requirement,
        status: 'pending' as TaskStatus,
        skillName: taskDef.skillName,
        params: (taskDef as any).params,
        dependencies: updatedDependencies,
        dependents: [],
        createdAt: new Date(),
        retryCount: 0,
      };

      this.taskQueue.addTask(task);
    }
  }

  private async waitForCompletion(planId: string): Promise<TaskResult> {
    const startTime = Date.now();
    const maxWaitTime = CONFIG.TOTAL_TIMEOUT_MS;
    let pollInterval = 100;
    let pollCount = 0;

    while (Date.now() - startTime < maxWaitTime) {
      pollCount++;
      const allTasks = this.taskQueue.getAllTasks();

      // Only check tasks belonging to this specific plan
      const planTasks = allTasks.filter((t) => t.id.startsWith(planId) && t.skillName);

      // If no tasks for this plan, return success
      if (planTasks.length === 0) {
        return {
          success: true,
          data: {
            planId,
            results: [],
          },
        };
      }

      // Check if all plan tasks are completed
      const allCompleted = planTasks.every(
        (t) => t.status === 'completed' || t.status === 'failed'
      );

      if (allCompleted) {
        const failedTasks = planTasks.filter((t) => t.status === 'failed');

        if (failedTasks.length === 0) {
          const results = planTasks
            .filter((t) => t.status === 'completed')
            .map((t) => ({
              taskId: t.id,
              skillName: t.skillName,
              result: t.result,
            }));

          console.log(`[MainAgent] ✅ 所有任务执行完成 (${results.length}/${planTasks.length})`);
          return {
            success: true,
            data: {
              planId,
              results,
            },
          };
        }

        return {
          success: false,
          error: failedTasks[0].error,
        };
      }

      // 指数退避等待
      await this.sleep(pollInterval);
      pollInterval = Math.min(pollInterval * 2, 1000);
    }

    // If we've timed out, return an error
    return {
      success: false,
      error: {
        type: 'RETRYABLE',
        message: `Workflow timeout after ${maxWaitTime}ms`,
        code: 'TIMEOUT',
      },
    };
  }

  private getFailedTasks(plan: TaskPlan): Task[] {
    return plan.tasks
      .map((t) => this.taskQueue.getTask(`${plan.id}-${t.id}`))
      .filter((t): t is Task => t !== undefined && t.status === 'failed');
  }

  private static replanCounter = 0;

  private async replan(failedPlan: TaskPlan, errors: TaskError[]): Promise<TaskPlan> {
    const systemPrompt = `You are a replanning assistant. The previous plan failed. Create a revised plan.

Consider:
- Alternative approaches to achieve the goal
- Different skill combinations
- Simplified subtasks

Respond in the same JSON format as before.`;

    const errorSummary = errors
      .map((e) => `- ${e.type}: ${e.message}${e.code ? ` (${e.code})` : ''}`)
      .join('\n');

    const prompt = `The previous plan failed with these errors:
${errorSummary}

Original requirement: "${failedPlan.requirement}"

Previous plan had ${failedPlan.tasks.length} tasks. Create a revised plan that might succeed.`;

    try {
      const newPlan = await this.llm.generateStructured(prompt, TaskPlanSchema, systemPrompt);
      // Generate unique plan ID with counter and timestamp to avoid conflicts
      MainAgent.replanCounter++;
      newPlan.id = `${failedPlan.id}-retry-${MainAgent.replanCounter}-${Date.now()}`;
      newPlan.requirement = failedPlan.requirement;

      // Cancel old tasks
      for (const taskDef of failedPlan.tasks) {
        const oldTaskId = `${failedPlan.id}-${taskDef.id}`;
        const task = this.taskQueue.getTask(oldTaskId);
        if (task && task.status !== 'completed' && task.status !== 'failed') {
          this.taskQueue.cancelTask(oldTaskId);
        }
      }

      return newPlan;
    } catch {
      return failedPlan;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default MainAgent;
