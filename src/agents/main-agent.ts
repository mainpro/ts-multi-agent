import { LLMClient, llmEvents } from '../llm';
import { VisionLLMClient } from '../llm/vision-client';
import { SkillRegistry } from '../skill-registry';
import { TaskQueue } from '../task-queue';
import { IntentRouter } from '../routers';
import { UserProfileService } from '../user-profile';
import { buildReplanPrompt, buildSkillExecutionPrompt, buildRefinementPrompt } from '../prompts';
import {
  Task,
  TaskResult,
  TaskError,
  TaskStatus,
  TaskPlan,
  CONFIG,
  TaskPlanSchema,
} from '../types';
import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';

export class MainAgent {
  private maxReplanAttempts: number;
  private intentRouter: IntentRouter;
  private visionClient: VisionLLMClient;
  private userProfileService: UserProfileService;

  constructor(
    private llm: LLMClient,
    private skillRegistry: SkillRegistry,
    private taskQueue: TaskQueue,
    maxReplanAttempts: number = CONFIG.MAX_REPLAN_ATTEMPTS
  ) {
    this.maxReplanAttempts = maxReplanAttempts;
    this.intentRouter = new IntentRouter(llm, this.skillRegistry);
    this.visionClient = new VisionLLMClient();
    this.userProfileService = new UserProfileService('data');
  }

  async processRequirement(
    requirement: string,
    imageAttachment?: { data: Buffer; mimeType: string; originalName?: string }
  ): Promise<TaskResult> {
    try {
      console.log(`[MainAgent] 📥 收到用户请求: "${requirement}"`);
      if (imageAttachment) {
        console.log(`[MainAgent] 📎 附件: ${imageAttachment.originalName || 'unnamed'} (${imageAttachment.mimeType})`);
      }

      // ========== 步骤 0: 加载用户画像 ==========
      const userProfile = await this.userProfileService.loadProfile('default');
      console.log(`[MainAgent] 👤 用户画像: 部门=${userProfile.department}, 常用系统=${userProfile.commonSystems.join(', ')}`);

      // ========== 步骤 0.5: 图片分析（如果有图片） ==========
      let enrichedRequirement = requirement;
      if (imageAttachment) {
        console.log(`[MainAgent] 🖼️ 检测到图片，调用视觉分析...`);
        try {
          const base64 = imageAttachment.data.toString('base64');
          const visionResult = await this.visionClient.analyzeImage(base64, imageAttachment.mimeType);
          
          enrichedRequirement = `${requirement}\n\n[图片分析结果]: ${visionResult.description}`;
          if (visionResult.system) {
            enrichedRequirement += `\n系统: ${visionResult.system}`;
          }
          if (visionResult.errorType) {
            enrichedRequirement += `\n错误类型: ${visionResult.errorType}`;
          }
          if (visionResult.suggestedAction) {
            enrichedRequirement += `\n建议操作: ${visionResult.suggestedAction}`;
          }
          console.log(`[MainAgent] 🖼️ 图片分析完成`);
        } catch (error) {
          console.error(`[MainAgent] 🖼️ 图片分析失败:`, error);
        }
      }

    // ========== 步骤 1: 意图路由（快速应答） ==========
    console.log(`[MainAgent] 🔄 正在分类用户意图...`);
    const intentResult = await this.intentRouter.classify(enrichedRequirement, userProfile);
      console.log(`[MainAgent] 📊 意图分类: ${intentResult.intent} (置信度: ${intentResult.confidence})`);

  switch (intentResult.intent) {
    case 'small_talk':
      console.log(`[MainAgent] 💬 闲聊模式：快速应答`);
      await this.updateProfileAfterRequest(userProfile, enrichedRequirement);
      return {
        success: true,
        data: {
          message: intentResult.suggestedResponse,
          type: 'small_talk',
        },
      };

    case 'guess_confirm':
      console.log(`[MainAgent] 🎯 猜测确认：${intentResult.guessedSystem}`);
      await this.updateProfileAfterRequest(userProfile, enrichedRequirement);
      return {
        success: true,
        data: {
          message: intentResult.suggestedResponse,
          type: 'guess_confirm',
          guessedSystem: intentResult.guessedSystem,
        },
      };

    case 'out_of_scope': {
      console.log(`[MainAgent] 🔄 无法匹配，返回猜你想问`);
      const guessResponse = this.intentRouter.generateGuessQuestions(enrichedRequirement, userProfile);
      await this.updateProfileAfterRequest(userProfile, enrichedRequirement);
      return {
        success: true,
        data: {
          message: guessResponse.fullResponse,
          type: 'guess_confirm',
          guessedSystem: guessResponse.systems[0],
        },
      };
    }

    case 'unclear': {
      console.log(`[MainAgent] ❓ 意图不明确：返回猜你想问`);
      await this.updateProfileAfterRequest(userProfile, enrichedRequirement);
      const guessResponse = this.intentRouter.generateGuessQuestions(enrichedRequirement, userProfile);
      return {
        success: true,
        data: {
          message: guessResponse.fullResponse,
          type: 'guess_confirm',
          guessedSystem: guessResponse.systems[0],
        },
      };
    }

    case 'skill_task':
        console.log(`[MainAgent] ⚙️ 技能任务：继续处理${intentResult.matchedSkill ? ` (匹配技能: ${intentResult.matchedSkill})` : ''}`);
        break;
      }

      // ========== 步骤 2: 规划（优化：单技能跳过 LLM） ==========
      const planId = `plan-${Date.now()}`;
      let plan: TaskPlan;

      if (intentResult.matchedSkill && intentResult.matchedSkill !== 'fallback') {
        console.log(`[MainAgent] 🚀 单技能任务：直接创建计划`);
        plan = {
          id: planId,
          requirement: enrichedRequirement,
          tasks: [{
            id: 'task-1',
            requirement: enrichedRequirement,
            skillName: intentResult.matchedSkill,
            dependencies: [],
          }],
        };
      } else {
        // matchedSkill 是 fallback 或 undefined，不再调用 UnifiedPlanner
        console.log(`[MainAgent] 🎯 无法匹配技能，返回猜你想问`);
        const guessResponse = this.intentRouter.generateGuessQuestions(enrichedRequirement, userProfile);
        await this.updateProfileAfterRequest(userProfile, enrichedRequirement);
        return {
          success: true,
          data: {
            message: guessResponse.fullResponse,
            type: 'guess_confirm',
            guessedSystem: guessResponse.systems[0],
          },
        };
      }

  console.log(`[MainAgent] ✅ 规划完成 - 共 ${plan.tasks.length} 个任务`);
  plan.tasks.forEach((task, idx) => {
    console.log(`[MainAgent] 任务 ${idx + 1}: [${task.skillName}] ${task.requirement}`);
  });

  if (plan.tasks.length === 1) {
    console.log(`[MainAgent] 🎯 单技能任务：MainAgent 直接执行`);
    const singleTask = plan.tasks[0];
    const result = await this.executeSingleSkill(singleTask.requirement, singleTask.skillName);
    
    await this.updateProfileAfterRequest(userProfile, enrichedRequirement);
    return result;
  }

  console.log(`[MainAgent] 🔄 多技能任务：派发给 TaskQueue`);
  const result = await this.monitorAndReplan(plan);

    // ========== 步骤 4: 更新用户画像 ==========
    await this.updateProfileAfterRequest(userProfile, enrichedRequirement);

    return result;
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
        params: taskDef.params,
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
    const allSkills = this.skillRegistry.getAllMetadata();
    const systemPrompt = buildReplanPrompt(allSkills);

    const errorSummary = errors
      .map((e) => `- ${e.type}: ${e.message}${e.code ? ` (${e.code})` : ''}`)
      .join('\n');

    const prompt = `原始需求: "${failedPlan.requirement}"
失败原因:
${errorSummary}
之前有 ${failedPlan.tasks.length} 个任务。创建新计划。`;

    try {
      const newPlan = await this.llm.generateStructured(prompt, TaskPlanSchema, systemPrompt);
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

  private async executeSingleSkill(
    requirement: string,
    skillName: string
  ): Promise<TaskResult> {
    llmEvents.setAgent('MainAgent');

    try {
      console.log(`[MainAgent] 📥 执行技能: ${skillName}`);

      const skill = await this.skillRegistry.loadFullSkill(skillName);
      if (!skill) {
        return {
          success: false,
          error: { type: 'FATAL', message: `Skill not found: ${skillName}`, code: 'SKILL_NOT_FOUND' },
        };
      }

      const Phase1Schema = z.object({
        response: z.string().describe('给用户的回复'),
        needRefs: z.array(z.string()).optional().default([]).describe('如需参考资料，在此列出文件名'),
      });

      const refsAvailable = skill.referencesDir ? await this.listReferences(skill.referencesDir) : [];
      console.log(`[MainAgent] skill.body 长度: ${skill.body.length}`);
      console.log(`[MainAgent] skill.body 前100字: ${skill.body.substring(0, 100)}`);
      
      const refsHint = refsAvailable.length > 0
        ? `\n可用参考资料: ${refsAvailable.join(', ')}`
        : '';

      const step1 = await this.llm.generateStructured(
        buildSkillExecutionPrompt(skill, requirement, refsHint),
        Phase1Schema,
        undefined
      );

      if (!step1.needRefs?.length || !skill.referencesDir) {
        return { success: true, data: { response: step1.response } };
      }

      console.log(`[MainAgent] 📚 需要参考资料: ${step1.needRefs.join(', ')}`);
      const refContents = await this.readReferences(skill.referencesDir, step1.needRefs);

      const Phase2Schema = z.object({
        response: z.string(),
      });

      const step2 = await this.llm.generateStructured(
        buildRefinementPrompt(step1.response, refContents),
        Phase2Schema,
        undefined
      );

      return { success: true, data: { response: step2.response } };
    } catch (error) {
      return {
        success: false,
        error: {
          type: 'RETRYABLE',
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'EXECUTION_ERROR',
        },
      };
    } finally {
      llmEvents.setAgent('MainAgent');
    }
  }

  private async listReferences(refsDir: string): Promise<string[]> {
    try {
      const files = await fs.readdir(refsDir);
      return files.filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    } catch {
      return [];
    }
  }

  private async readReferences(refsDir: string, fileNames: string[]): Promise<string> {
    let content = '';
    let totalSize = 0;
    const maxTotal = 3000;

    for (const file of fileNames) {
      if (totalSize >= maxTotal) break;
      const fullPath = path.join(refsDir, file);
      try {
        const fileContent = await fs.readFile(fullPath, 'utf-8');
        const truncated = fileContent.substring(0, maxTotal - totalSize);
        content += `\n### ${file}\n${truncated}\n`;
        totalSize += truncated.length;
      } catch {
        content += `\n### ${file}\n(读取失败)\n`;
      }
    }

    return content;
  }

  private async updateProfileAfterRequest(
    userProfile: { commonSystems: string[]; conversationCount: number },
    enrichedRequirement: string
  ): Promise<void> {
    const mentionedSystem = this.userProfileService.inferSystemFromText(enrichedRequirement);
    if (mentionedSystem && !userProfile.commonSystems.includes(mentionedSystem)) {
      console.log(`[MainAgent] 📝 更新用户画像: 新增系统 ${mentionedSystem}`);
      await this.userProfileService.updateProfile('default', {
        commonSystems: [...userProfile.commonSystems, mentionedSystem],
        conversationCount: userProfile.conversationCount + 1,
      });
    } else {
      await this.userProfileService.updateProfile('default', {
        conversationCount: userProfile.conversationCount + 1,
      });
    }
  }
}

export default MainAgent;
