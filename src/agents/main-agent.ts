import { LLMClient, llmEvents } from '../llm';
import { VisionLLMClient } from '../llm/vision-client';
import { SkillRegistry } from '../skill-registry';
import { TaskQueue } from '../task-queue';
import { IntentRouter } from '../routers';
import { UserProfileService } from '../user-profile';
import { MemoryService, sessionContextService } from '../memory';
import { buildReplanPrompt } from '../prompts';
import {
  Task,
  TaskResult,
  TaskError,
  TaskStatus,
  TaskPlan,
  CONFIG,
  TaskPlanSchema,
  ToolDefinition,
} from '../types';

import { promises as fs } from 'fs';
import * as path from 'path';
  
export class MainAgent {
  private maxReplanAttempts: number;
  private intentRouter: IntentRouter;
  private visionClient: VisionLLMClient;
  private userProfileService: UserProfileService;
  private memoryService: MemoryService;

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
    this.memoryService = new MemoryService('data');
  }

  async processRequirement(
    requirement: string,
    imageAttachment?: { data: Buffer; mimeType: string; originalName?: string },
    userId: string = 'default',
    sessionId?: string
  ): Promise<TaskResult> {
    try {
      console.log(`[MainAgent] 📥 收到用户请求: "${requirement}"`);
      if (imageAttachment) {
        console.log(`[MainAgent] 📎 附件: ${imageAttachment.originalName || 'unnamed'} (${imageAttachment.mimeType})`);
      }

      const effectiveSessionId = sessionId || userId;

      // ========== 步骤 0: 加载用户画像 ==========
      const userProfile = await this.userProfileService.loadProfile(userId);
      console.log(`[MainAgent] 👤 用户画像: 部门=${userProfile.department}, 常用系统=${userProfile.commonSystems.join(', ')}`);

      // ========== 步骤 0.1: 加载对话历史 ==========
      const memory = await this.memoryService.loadMemory(userId);
      const historyPrompt = this.memoryService.buildContextPrompt(memory);
      if (historyPrompt) {
        console.log(`[MainAgent] 📚 对话历史: ${memory.conversationHistory.length} 条消息`);
      }

      // ========== 步骤 0.2: 检查 Session Context ==========
      const sessionContext = sessionContextService.getContext(effectiveSessionId);
      if (sessionContext.currentSkill) {
        console.log(`[MainAgent] 🎯 Session Context: 当前技能=${sessionContext.currentSkill}, 轮次=${sessionContext.turnCount}`);
      }

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

    if (historyPrompt) {
      enrichedRequirement = historyPrompt + '\n\n' + enrichedRequirement;
    }

    // ========== 步骤 1: 意图路由（快速应答） ==========
    console.log(`[MainAgent] 🔄 正在分类用户意图...`);
    const intentResult = await this.intentRouter.classify(requirement, userProfile, memory.conversationHistory);
      console.log(`[MainAgent] 📊 意图分类: ${intentResult.intent} (置信度: ${intentResult.confidence})`);

  switch (intentResult.intent) {
    case 'small_talk':
      console.log(`[MainAgent] 💬 闲聊模式：快速应答`);
      await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);
      return {
        success: true,
        data: {
          message: intentResult.suggestedResponse,
          type: 'small_talk',
        },
      };

    case 'guess_confirm':
      console.log(`[MainAgent] 🎯 猜测确认：${intentResult.guessedSystem}`);
      await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);
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
      await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);
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
      await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);
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
      await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);
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

      // 更新 Session Context
      sessionContextService.updateContext(effectiveSessionId, {
        currentSkill: singleTask.skillName,
        currentTopic: 'skill_execution',
      });

      await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);
      const resultData = result.data as { response?: string; _metadata?: { skill?: string; references?: string[] } } | undefined;
      const responseText = resultData?.response || JSON.stringify(result.data);
      await this.memoryService.saveInteraction(userId, requirement, responseText, {
        skill: resultData?._metadata?.skill,
        references: resultData?._metadata?.references,
      });
      return result;
    }

    console.log(`[MainAgent] 🔄 多技能任务：派发给 TaskQueue`);
    const result = await this.monitorAndReplan(plan);

    // ========== 步骤 4: 更新用户画像 ==========
    await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);
    const resultData = result.data as { response?: string; _metadata?: { skill?: string; references?: string[] } } | undefined;
    const responseText = resultData?.response || JSON.stringify(result.data);
    await this.memoryService.saveInteraction(userId, requirement, responseText, {
      skill: resultData?._metadata?.skill,
      references: resultData?._metadata?.references,
    });

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

      console.log(`[MainAgent] skill.body 长度: ${skill.body.length}`);
      console.log(`[MainAgent] skill.body 前100字: ${skill.body.substring(0, 100)}`);

      // 定义工具：read_reference
      const tools: ToolDefinition[] = [
        {
          name: 'read_reference',
          description: '读取技能的参考资料文件，用于获取详细的处理流程、话术模板、申请表链接等信息',
          parameters: {
            type: 'object',
            properties: {
              fileName: {
                type: 'string',
                description: '要读取的文件名，如 invoice-format.md、permission.md',
              },
            },
            required: ['fileName'],
          },
        },
      ];

      // 构建执行 prompt
      const prompt = `## 技能内容
${skill.body}

## 用户问题
${requirement}

## 执行规则
1. 严格按照技能内容执行，不跳过任何步骤
2. 遇到分支时，根据用户问题选择正确的执行路径
3. 遇到"读取 references/xxx.md"或需要详细资料时，使用 read_reference 工具
4. 根据读取的内容继续执行
5. **重要：如果技能内容无法回答用户问题，不要乱编，请明确告知用户**
6. 最终输出给用户的完整回复（使用礼貌、专业的中文）

## 无法处理的判断标准
如果用户问题属于以下情况，请返回"抱歉，我无法处理您当前的需求，我的知识不包含该问题的处理逻辑"：
- 问题与技能主题无关
- 技能内容中没有对应的处理流程或答案
- 用户询问的是技能未覆盖的场景

## 输出格式
直接输出给用户的回复内容，不要输出 JSON 或其他格式。如果无法处理，使用上述无法处理的回复。`;

      // 调用 LLM（支持工具调用）
      const result = await this.llm.generateWithTools(
        prompt,
        tools,
  async (toolCall) => {
        if (toolCall.name === 'read_reference') {
          // 参数类型验证
          if (!toolCall.arguments.fileName || typeof toolCall.arguments.fileName !== 'string') {
            return '错误：缺少 fileName 参数或类型错误';
          }

          const fileName = toolCall.arguments.fileName as string;

          // 安全验证：防止路径遍历攻击
          if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return '错误：文件名包含非法字符';
          }

          // 验证文件扩展名
          if (!fileName.endsWith('.md') && !fileName.endsWith('.txt')) {
            return '错误：只支持 .md 和 .txt 文件';
          }

          console.log(`[MainAgent] 📚 读取参考资料: ${fileName}`);

          if (!skill.referencesDir) {
            return '错误：技能没有参考资料目录';
          }

          const content = await this.readReferences(skill.referencesDir, [fileName]);
          return content || `文件 ${fileName} 不存在或读取失败`;
        }
        return `错误：未知工具 "${toolCall.name}"。可用工具：read_reference`;
      },
        undefined
      );

      console.log(`[MainAgent] ✅ 技能执行完成，工具调用次数: ${result.toolCalls.length}`);

      // 记录使用的 references
      const usedRefs = result.toolCalls
        .filter(tc => tc.name === 'read_reference')
        .map(tc => tc.arguments.fileName as string);

      console.log(`[MainAgent] 📚 读取的参考资料: ${usedRefs.join(', ')}`);

      return { 
        success: true, 
        data: { 
          response: result.content,
          _metadata: {
            skill: skillName,
            references: usedRefs
          }
        } 
      };
    } catch (error) {
      console.error('[MainAgent] 技能执行错误:', error);
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
    enrichedRequirement: string,
    userId: string = 'default'
  ): Promise<void> {
    const mentionedSystem = this.userProfileService.inferSystemFromText(enrichedRequirement);
    if (mentionedSystem && !userProfile.commonSystems.includes(mentionedSystem)) {
      console.log(`[MainAgent] 📝 更新用户画像: 新增系统 ${mentionedSystem}`);
      await this.userProfileService.updateProfile(userId, {
        commonSystems: [...userProfile.commonSystems, mentionedSystem],
        conversationCount: userProfile.conversationCount + 1,
      });
    } else {
      await this.userProfileService.updateProfile(userId, {
        conversationCount: userProfile.conversationCount + 1,
      });
    }
  }
}

export default MainAgent;
