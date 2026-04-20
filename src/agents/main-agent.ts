import { LLMClient } from "../llm";
import { SkillRegistry } from "../skill-registry";
import { TaskQueue } from "../task-queue";
import { IntentRouter } from "../routers";
import { UnifiedPlanner } from "../planners";
import { UserProfileService } from "../user-profile";
import { MemoryService, sessionContextService } from "../memory";
import { DynamicContextBuilder } from "../context/dynamic-context";
import { AutoCompactService } from "../memory/auto-compact";
import { buildReplanPrompt } from "../prompts";
import { hookManager } from "../hooks/hook-manager";
import { HookEvent } from "../hooks/types";
import {
  Task,
  TaskResult,
  TaskError,
  TaskStatus,
  TaskPlan,
  CONFIG,
  TaskPlanSchema,
  SkillExecutionResult,
} from "../types";

export class MainAgent {
  private maxReplanAttempts: number;
  private intentRouter: IntentRouter;
  private userProfileService: UserProfileService;
  private memoryService: MemoryService;
  private dynamicContextBuilder: DynamicContextBuilder;
  private autoCompactService: AutoCompactService;
  private waitingQuestions: Map<string, any> = new Map();

  constructor(
    private llm: LLMClient,
    private skillRegistry: SkillRegistry,
    private taskQueue: TaskQueue,
    maxReplanAttempts: number = CONFIG.MAX_REPLAN_ATTEMPTS,
  ) {
    this.maxReplanAttempts = maxReplanAttempts;
    this.intentRouter = new IntentRouter(llm, this.skillRegistry);
    this.userProfileService = new UserProfileService("data");
    this.memoryService = new MemoryService("data");
    this.dynamicContextBuilder = new DynamicContextBuilder({
      memoryDataDir: "data",
    });
    this.autoCompactService = new AutoCompactService(llm);
  }

  async processRequirement(
    requirement: string,
    imageAttachment?: { data: Buffer; mimeType: string; originalName?: string },
    userId: string = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    sessionId?: string,
    options?: { planMode?: boolean },
  ): Promise<TaskResult> {
    let assistantResponse = '';
    const effectiveSessionId = sessionId || userId;
    
    try {
      console.log(`[MainAgent] 📥 收到用户请求: "${requirement}"`);

      sessionContextService.addUserMessage(effectiveSessionId, requirement);

      // ========== 步骤 1: 图片分析（如有附件） ==========
      if (imageAttachment) {
        console.log(
          `[MainAgent] 📎 附件: ${imageAttachment.originalName || "unnamed"} (${imageAttachment.mimeType})`,
        );

        console.log(`[MainAgent] 🔍 调用视觉模型分析图片...`);
        try {
          const VisionLLMClient = (await import("../llm/vision-client.js"))
            .VisionLLMClient;
          const visionClient = new VisionLLMClient();

          const visionResult = await visionClient.analyzeImage(
            imageAttachment.data.toString("base64"),
            imageAttachment.mimeType,
          );

          console.log(
            `[MainAgent] ✅ 视觉分析完成: ${visionResult.system || "未知系统"}, ${visionResult.errorType || "无错误"}`,
          );

          requirement = `${requirement}\n\n[图片分析结果]\n系统: ${visionResult.system || "未知"}\n错误类型: ${visionResult.errorType || "未知"}\n描述: ${visionResult.description}\n建议操作: ${visionResult.suggestedAction || "无"}`;
        } catch (visionError) {
          console.error(`[MainAgent] ❌ 视觉分析失败:`, visionError);
        }
      }

    // ========== 步骤 1.5: 检查是否有等待的问题 ==========
    const waitingQuestion = this.waitingQuestions.get(effectiveSessionId);
    
    if (waitingQuestion) {
      console.log(`[MainAgent] 🔄 检测到等待的问题: ${waitingQuestion.type}`);
      
      // 根据询问类型处理
      if (waitingQuestion.type === 'system_confirm' || waitingQuestion.type === 'skill_confirm') {
        // 主智能体层面的确认 → 清除等待状态，重新处理
        this.waitingQuestions.delete(effectiveSessionId);
        console.log(`[MainAgent] ✅ 用户已回复系统确认，重新处理`);
        // 继续正常处理流程
      } else if (waitingQuestion.type === 'skill_question') {
        // 子智能体层面的询问 → 继续执行任务
        console.log(`[MainAgent] 🔄 继续执行任务，传递用户回复`);
        return this.continueTask(effectiveSessionId, waitingQuestion, requirement, userId);
      }
    }

    // ========== 步骤 2: 上下文加载 ==========
    const skillsMetadata = this.skillRegistry.getAllMetadata();
    this.userProfileService.setSkillsMetadata(skillsMetadata);
    
    const userProfile = await this.userProfileService.loadProfile(userId);
    console.log(
      `[MainAgent] 👤 用户画像: 部门=${userProfile.department}, 常用系统=${userProfile.commonSystems.join(", ")}`,
    );

      const memory = await this.memoryService.loadMemory(userId);
      const messages = memory.conversationHistory.map((msg) => ({
        role: msg.role,
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
        timestamp: msg.timestamp
          ? new Date(msg.timestamp).getTime()
          : Date.now(),
      }));

      const microCompactedMessages =
        this.autoCompactService.microCompact(messages);
      const compactedMessages = await this.autoCompactService.checkAndCompact(
        microCompactedMessages,
      );

      const originalTokens = await this.autoCompactService.estimateTokens(messages);
      const compactedTokens =
        await this.autoCompactService.estimateTokens(compactedMessages);
      if (originalTokens !== compactedTokens) {
        console.log(
          `[MainAgent] 🗜️ 上下文压缩: ${originalTokens} → ${compactedTokens} tokens (${Math.round((1 - compactedTokens / originalTokens) * 100)}% reduction)`,
        );
      }

      const compactedHistory = compactedMessages.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
        timestamp: new Date(msg.timestamp || Date.now()).toISOString(),
      }));

      const historyPrompt = this.memoryService.buildContextPrompt({
        ...memory,
        conversationHistory: compactedHistory,
      });

      if (historyPrompt) {
        console.log(
          `[MainAgent] 📚 对话历史: ${compactedHistory.length} 条消息 (${compactedTokens} tokens)`,
        );
      }

      const sessionContext =
        sessionContextService.getContext(effectiveSessionId);
      if (sessionContext.currentSkill) {
        console.log(
          `[MainAgent] 🎯 Session Context: 当前技能=${sessionContext.currentSkill}, 轮次=${sessionContext.turnCount}`,
        );
      }

      let enrichedRequirement = requirement;
      if (historyPrompt) {
        enrichedRequirement = historyPrompt + "\n\n" + enrichedRequirement;
      }

      const dynamicContext = await this.dynamicContextBuilder.build(
        requirement,
        userId,
      );
      if (dynamicContext) {
        enrichedRequirement = dynamicContext + "\n\n" + enrichedRequirement;
        console.log(`[MainAgent] 📑 动态上下文已注入`);
      }

      // ========== 步骤 3: 意图路由 + 技能匹配（单一 LLM 调用） ==========
      console.log(`[MainAgent] 🔄 正在分类用户意图...`);
      
      // 触发意图分类前钩子
      await hookManager.emit(HookEvent.BEFORE_INTENT_CLASSIFY, {
        userId,
        sessionId: effectiveSessionId,
        data: { requirement }
      });
      
      const intentResult = await this.intentRouter.classify(
        requirement,
        userProfile,
        memory.conversationHistory,
        effectiveSessionId,
      );
      
      // 触发意图分类后钩子
      await hookManager.emit(HookEvent.AFTER_INTENT_CLASSIFY, {
        userId,
        sessionId: effectiveSessionId,
        data: { 
          intent: intentResult.intent,
          confidence: intentResult.confidence,
          tasks: intentResult.tasks
        }
      });
      console.log(
        `[MainAgent] 📊 意图分类: ${intentResult.intent} (置信度: ${intentResult.confidence})`,
      );

      if (intentResult.intent !== "skill_task") {
        console.log(`[MainAgent] ⏭️ 非技能任务，直接返回`);

        if (intentResult.intent === "small_talk") {
          assistantResponse = intentResult.question?.content || "您好！有什么可以帮助您的吗？";
          sessionContextService.addAssistantMessage(effectiveSessionId, assistantResponse);
          return {
            success: true,
            data: {
              message: assistantResponse,
              type: "small_talk",
            },
          };
        }

        if (intentResult.intent === "confirm_system") {
          assistantResponse = intentResult.question?.content || "请问您说的是哪个系统？";
          sessionContextService.addAssistantMessage(effectiveSessionId, assistantResponse);
          
          // 保存系统确认询问到 waitingQuestions
          if (intentResult.question) {
            this.waitingQuestions.set(effectiveSessionId, intentResult.question);
          }
          
          return {
            success: true,
            data: {
              message: assistantResponse,
              type: "confirm_system",
              question: intentResult.question,
            },
          };
        }

        assistantResponse = intentResult.question?.content || "";
        sessionContextService.addAssistantMessage(effectiveSessionId, assistantResponse);
        return {
          success: true,
          data: {
            message: assistantResponse,
            type: "unclear",
          },
        };
      }

      const tasks = intentResult.tasks;

      if (tasks.length === 0) {
        console.log(`[MainAgent] ⚠️ 未匹配到技能`);
        await this.updateProfileAfterRequest(
          userProfile,
          enrichedRequirement,
          userId,
        );
        return {
          success: false,
          error: {
            type: "FATAL",
            message: "未匹配到合适的技能",
            code: "NO_SKILL_MATCHED",
          },
        };
      }

      // 按技能分组：有技能的 vs 无技能的
      const tasksWithSkill = tasks.filter(t => t.skillName);
      const tasksWithoutSkill = tasks.filter(t => !t.skillName);

      console.log(`[MainAgent] 📊 任务分析: 共${tasks.length}个, 有技能=${tasksWithSkill.length}, 无技能=${tasksWithoutSkill.length}`);

      // 检测转人工任务
      const transferTask = tasksWithoutSkill.find(t => t.intent === 'unclear');
      const hasTransferRequest = !!transferTask;
      if (hasTransferRequest) {
        console.log(`[MainAgent] ⚠️ 检测到转人工请求`);
      }

      // 更新 SessionContext（如果有技能任务）
      if (tasksWithSkill.length > 0) {
        const firstTask = tasksWithSkill[0];
        const tempVariables: Record<string, unknown> = {};
        
        // 将提取的参数保存到 SessionContext
        if (firstTask.params) {
          for (const [key, value] of Object.entries(firstTask.params)) {
            tempVariables[key] = value;
          }
        }
        
        sessionContextService.updateContext(effectiveSessionId, {
          currentSkill: firstTask.skillName!,
          currentSystem: firstTask.skillName!,
          currentTopic: 'skill_task',
          tempVariables,
        });
        console.log(
          `[MainAgent] 📝 SessionContext 已更新: currentSkill=${firstTask.skillName}, params=${JSON.stringify(tempVariables)}, turn=${sessionContextService.getContext(effectiveSessionId).turnCount}`,
        );
      }

      // ========== 步骤 4: 任务规划与执行 ==========
      let plan: TaskPlan;

      // 只执行有技能的任务
      const tasksToExecute = tasksWithSkill;

      if (tasksToExecute.length === 0) {
        // 没有需要执行的技能任务，直接返回转人工
        assistantResponse = '您好，您的这个问题我暂时无法通过知识库解决，我帮您转到人工这边，让工程师进一步帮您排查一下。';
        sessionContextService.addAssistantMessage(effectiveSessionId, assistantResponse);
        return {
          success: true,
          data: {
            message: assistantResponse,
            type: 'unclear',
          },
        };
      }

      if (tasksToExecute.length === 1) {
        console.log(`[MainAgent] 📋 单技能任务：直接创建计划`);
        plan = {
          id: `plan-${Date.now()}`,
          requirement: enrichedRequirement,
          tasks: tasksToExecute.map((t, idx) => ({
            id: `task-${idx + 1}`,
            requirement: t.requirement,
            skillName: t.skillName!,
            params: t.params,
            dependencies: [],
          })),
        };
      } else {
        console.log(
          `[MainAgent] 📋 多任务 (${tasksToExecute.length}个)：调用规划器`,
        );
        const planner = new UnifiedPlanner(this.llm, this.skillRegistry);
        const planResult = await planner.plan(enrichedRequirement);

        if (!planResult.success || !planResult.plan) {
          await this.updateProfileAfterRequest(
            userProfile,
            enrichedRequirement,
            userId,
          );
          return {
            success: false,
            error: {
              type: "FATAL",
              message: planResult.clarificationPrompt || "规划失败",
              code: "PLANNING_FAILED",
            },
          };
        }
        plan = planResult.plan;
      }

      console.log(`[MainAgent] ✅ 规划完成 - 共 ${plan.tasks.length} 个任务`);
      plan.tasks.forEach((task, idx) => {
        console.log(
          `[MainAgent] 任务 ${idx + 1}: [${task.skillName}] ${task.requirement}`,
        );
      });

      // P2-4: Plan Mode - 返回计划详情，不执行
      if (options?.planMode && plan) {
        return {
          success: true,
          data: {
            type: 'plan_preview',
            plan: {
              id: plan.id,
              tasks: plan.tasks.map((t: any) => ({
                id: t.id,
                skillName: t.skillName,
                requirement: t.requirement,
                dependencies: t.dependencies,
              })),
            },
            message: '请确认以上计划，确认后将开始执行。',
          },
        };
      }

      console.log(`[MainAgent] 🔄 派发给 TaskQueue 执行`);
      
      // 触发任务执行前钩子
      await hookManager.emit(HookEvent.BEFORE_TASK_EXECUTE, {
        userId,
        sessionId: effectiveSessionId,
        data: { planId: plan.id, tasks: plan.tasks }
      });
      
      const result = await this.monitorAndReplan(plan, effectiveSessionId, userId);
      
      // 触发任务执行后钩子
      await hookManager.emit(HookEvent.AFTER_TASK_EXECUTE, {
        userId,
        sessionId: effectiveSessionId,
        data: { 
          planId: plan.id,
          success: result.success,
          result: result.data,
          error: result.error
        }
      });

      await this.updateProfileAfterRequest(
        userProfile,
        enrichedRequirement,
        userId,
      );

      const resultData = result.data as
        | {
            response?: string;
            _metadata?: { skill?: string; references?: string[] };
            results?: Array<{
              taskId: string;
              skillName: string;
              requirement: string;
              result?: { response?: string; _metadata?: { skill?: string; references?: string[] } };
              status?: string;
            }>;
          }
        | undefined;

      const taskResults = resultData?.results || [];

      // ========== 检查是否有任务需要等待用户输入 ==========
      for (const tr of taskResults) {
        // tr.result 结构: { success: true, data: SkillExecutionResult }
        const taskResult = tr.result as { success?: boolean; data?: SkillExecutionResult } | undefined;
        const skillResult = taskResult?.data;

        if (skillResult?.status === 'waiting_user_input' && skillResult.question) {
          console.log(`[MainAgent] 🔄 检测到子任务 ${tr.taskId} 需要用户输入，保存等待状态`);

          // 保存等待的问题
          this.waitingQuestions.set(effectiveSessionId, skillResult.question);

          // 保存 taskId 到 SessionContext，供 continueTask 使用
          sessionContextService.updateContext(effectiveSessionId, {
            tempVariables: { taskId: tr.taskId },
          } as any);

          sessionContextService.addAssistantMessage(effectiveSessionId, skillResult.question.content);

          return {
            success: true,
            data: {
              message: skillResult.question.content,
              type: 'question',
              question: skillResult.question,
            },
          };
        }
      }

      const taskList = taskResults.map((tr, idx) => ({
        taskId: tr.taskId || `task-${idx + 1}`,
        skillName: tr.skillName || '',
        requirement: tr.requirement || '',
        response: tr.result?.response || '',
        status: tr.status || 'completed',
      }));

      let combinedResponse = taskList
        .map(t => t.response)
        .filter(r => r)
        .join('\n\n---\n\n');

      if (!combinedResponse && taskList.length === 0) {
        combinedResponse = JSON.stringify(result.data);
      }

      if (hasTransferRequest) {
        const transferMsg = '您好，您的这个问题我暂时无法通过知识库解决，我帮您转到人工这边，让工程师进一步帮您排查一下。\n\n';
        combinedResponse = transferMsg + combinedResponse;
      }
      
      assistantResponse = combinedResponse;
      
      sessionContextService.addAssistantMessage(effectiveSessionId, assistantResponse);
      
      await this.memoryService.saveInteraction(
        userId,
        requirement,
        assistantResponse,
        {
          skill: taskList[0]?.skillName || '',
        },
      );

      return {
        success: result.success,
        data: {
          results: taskList,
          type: hasTransferRequest ? 'unclear' : 'skill_task',
        },
      };
    } catch (error) {
      console.error("Error processing requirement:", error);
      return {
        success: false,
        error: {
          type: "FATAL",
          message: error instanceof Error ? error.message : "Unknown error",
          code: "PROCESSING_ERROR",
        },
      };
    } finally {
      if (!assistantResponse) {
        sessionContextService.getContext(effectiveSessionId).conversation.pop();
      }
    }
  }

  async monitorAndReplan(plan: TaskPlan, sessionId?: string, userId?: string): Promise<TaskResult> {
    let replanAttempts = 0;
    let currentPlan = plan;
    let submittedPlans = new Set<string>();

    while (replanAttempts <= this.maxReplanAttempts) {
      if (!submittedPlans.has(currentPlan.id)) {
        this.submitPlanTasks(currentPlan, sessionId, userId);
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
      const allRetryable = errors.every((e) => e.type === "RETRYABLE");

      if (!allRetryable) {
        const fatalError = errors.find((e) => e.type !== "RETRYABLE");
        return {
          success: false,
          error: fatalError || errors[0],
        };
      }

      if (replanAttempts >= this.maxReplanAttempts) {
        return {
          success: false,
          error: {
            type: "FATAL",
            message: `Max replan attempts (${this.maxReplanAttempts}) exceeded`,
            code: "MAX_REPLAN_EXCEEDED",
          },
        };
      }

      replanAttempts++;
      currentPlan = await this.replan(currentPlan, errors);
    }

    return {
      success: false,
      error: {
        type: "FATAL",
        message: "Unexpected end of replan loop",
        code: "UNEXPECTED",
      },
    };
  }

  private submitPlanTasks(plan: TaskPlan, sessionId?: string, userId?: string): void {
    console.log(`[MainAgent] 📤 向任务队列提交 ${plan.tasks.length} 个任务`);
    for (const taskDef of plan.tasks) {
      const uniqueTaskId = `${plan.id}-${taskDef.id}`;

      const updatedDependencies = taskDef.dependencies.map(
        (depId) => `${plan.id}-${depId}`,
      );

      const task: Task = {
        id: uniqueTaskId,
        requirement: taskDef.requirement,
        status: "pending" as TaskStatus,
        skillName: taskDef.skillName,
        params: taskDef.params,
        dependencies: updatedDependencies,
        dependents: [],
        createdAt: new Date(),
        retryCount: 0,
        sessionId,
        userId,
      };

      this.taskQueue.addTask(task);
    }
  }

  private async waitForCompletion(planId: string): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve) => {
      const checkCompletion = () => {
        const allTasks = this.taskQueue.getAllTasks();

        // Only check tasks belonging to this specific plan
        const planTasks = allTasks.filter(
          (t) => t.id.startsWith(planId) && t.skillName,
        );

        // If no tasks for this plan, return success
        if (planTasks.length === 0) {
          resolve({
            success: true,
            data: {
              planId,
              results: [],
            },
          });
          return;
        }

        // Check if all plan tasks are completed
        const allCompleted = planTasks.every(
          (t) => t.status === "completed" || t.status === "failed",
        );

        if (allCompleted) {
          const failedTasks = planTasks.filter((t) => t.status === "failed");

          if (failedTasks.length === 0) {
            const results = planTasks
              .filter((t) => t.status === "completed")
              .map((t) => ({
                taskId: t.id,
                skillName: t.skillName,
                result: t.result,
              }));

            console.log(
              `[MainAgent] ✅ 所有任务执行完成 (${results.length}/${planTasks.length})`,
            );
            resolve({
              success: true,
              data: {
                planId,
                results,
              },
            });
          } else {
            resolve({
              success: false,
              error: failedTasks[0].error,
            });
          }
        }
      };

      const onDone = () => checkCompletion();
      this.taskQueue.on('task-completed', onDone);
      this.taskQueue.on('task-failed', onDone);

      // timeout
      const timeoutHandle = setTimeout(() => {
        this.taskQueue.off('task-completed', onDone);
        this.taskQueue.off('task-failed', onDone);
        resolve({ success: false, error: { type: 'RETRYABLE', message: 'timeout', code: 'TIMEOUT' } });
      }, CONFIG.TOTAL_TIMEOUT_MS);

      // Store timeout handle so we can clear it when resolved
      const originalResolve = resolve;
      const wrappedResolve = (value: TaskResult) => {
        clearTimeout(timeoutHandle);
        this.taskQueue.off('task-completed', onDone);
        this.taskQueue.off('task-failed', onDone);
        originalResolve(value);
      };

      // Re-wrap checkCompletion to use wrappedResolve
      const wrappedCheck = () => {
        const allTasks = this.taskQueue.getAllTasks();
        const planTasks = allTasks.filter(
          (t) => t.id.startsWith(planId) && t.skillName,
        );

        if (planTasks.length === 0) {
          wrappedResolve({
            success: true,
            data: { planId, results: [] },
          });
          return;
        }

        const allCompleted = planTasks.every(
          (t) => t.status === "completed" || t.status === "failed",
        );

        if (allCompleted) {
          const failedTasks = planTasks.filter((t) => t.status === "failed");

          if (failedTasks.length === 0) {
            const results = planTasks
              .filter((t) => t.status === "completed")
              .map((t) => ({
                taskId: t.id,
                skillName: t.skillName,
                result: t.result,
              }));

            console.log(
              `[MainAgent] ✅ 所有任务执行完成 (${results.length}/${planTasks.length})`,
            );
            wrappedResolve({
              success: true,
              data: { planId, results },
            });
          } else {
            wrappedResolve({
              success: false,
              error: failedTasks[0].error,
            });
          }
        }
      };

      // Replace the listener with the wrapped version
      this.taskQueue.off('task-completed', onDone);
      this.taskQueue.off('task-failed', onDone);
      const wrappedOnDone = () => wrappedCheck();
      this.taskQueue.on('task-completed', wrappedOnDone);
      this.taskQueue.on('task-failed', wrappedOnDone);

      wrappedCheck(); // initial check
    });
  }

  private getFailedTasks(plan: TaskPlan): Task[] {
    return plan.tasks
      .map((t) => this.taskQueue.getTask(`${plan.id}-${t.id}`))
      .filter((t): t is Task => t !== undefined && t.status === "failed");
  }

  private static replanCounter = 0;

  private async replan(
    failedPlan: TaskPlan,
    errors: TaskError[],
  ): Promise<TaskPlan> {
    const allSkills = this.skillRegistry.getAllMetadata();
    const systemPrompt = buildReplanPrompt(allSkills);

    const errorSummary = errors
      .map((e) => `- ${e.type}: ${e.message}${e.code ? ` (${e.code})` : ""}`)
      .join("\n");

    const prompt = `原始需求: "${failedPlan.requirement}"
失败原因:
${errorSummary}

之前有 ${failedPlan.tasks.length} 个任务。创建新计划。`;

    try {
      const newPlan = await this.llm.generateStructured(
        prompt,
        TaskPlanSchema,
        systemPrompt,
      );
      MainAgent.replanCounter++;
      newPlan.id = `${failedPlan.id}-retry-${MainAgent.replanCounter}-${Date.now()}`;
      newPlan.requirement = failedPlan.requirement;

      for (const taskDef of failedPlan.tasks) {
        const oldTaskId = `${failedPlan.id}-${taskDef.id}`;
        const task = this.taskQueue.getTask(oldTaskId);
        if (task && task.status !== "completed" && task.status !== "failed") {
          this.taskQueue.cancelTask(oldTaskId);
        }
      }

      return newPlan as TaskPlan;
    } catch {
      return failedPlan;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async updateProfileAfterRequest(
    userProfile: { commonSystems: string[]; conversationCount: number },
    enrichedRequirement: string,
    userId: string,
  ): Promise<void> {
    const mentionedSystem =
      this.userProfileService.inferSystemFromText(enrichedRequirement);
    if (
      mentionedSystem &&
      !userProfile.commonSystems.includes(mentionedSystem)
    ) {
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

  /**
   * 继续执行任务（处理用户对询问的回复）
   */
  private async continueTask(
    sessionId: string,
    question: any,
    userAnswer: string,
    _userId: string
  ): Promise<TaskResult> {
    console.log(`[MainAgent] 🔄 继续执行任务，用户回复: "${userAnswer}"`);
    
    // 获取之前的任务（从 SessionContext 中获取）
    const ctx = sessionContextService.getContext(sessionId);
    if (!ctx.tempVariables) {
      console.log(`[MainAgent] ⚠️ 未找到之前的任务`);
      return {
        success: false,
        error: {
          type: "FATAL",
          message: "未找到之前的任务",
          code: "TASK_NOT_FOUND",
        },
      };
    }
    
    // 修复：使用正确的方式获取 taskId
    const previousTaskId = ctx.tempVariables.get('taskId') as string;
    
    if (!previousTaskId) {
      console.log(`[MainAgent] ⚠️ 未找到之前的任务ID`);
      return {
        success: false,
        error: {
          type: "FATAL",
          message: "未找到之前的任务ID",
          code: "TASK_NOT_FOUND",
        },
      };
    }
    
    const previousTask = this.taskQueue.getTask(previousTaskId);
    
    if (!previousTask) {
      console.log(`[MainAgent] ⚠️ 任务不存在: ${previousTaskId}`);
      return {
        success: false,
        error: {
          type: "FATAL",
          message: "任务不存在",
          code: "TASK_NOT_FOUND",
        },
      };
    }
    
    // 添加询问历史
    previousTask.questionHistory = previousTask.questionHistory || [];
    previousTask.questionHistory.push({
      question,
      answer: userAnswer,
      timestamp: new Date(),
    });
    
    // 清除等待状态
    this.waitingQuestions.delete(sessionId);
    
    // 重置任务状态为 pending，让它重新执行
    previousTask.status = "pending";
    previousTask.result = undefined;
    previousTask.error = undefined;
    
    console.log(`[MainAgent] 📝 已添加询问历史，重新执行任务: ${previousTaskId}`);
    
    // 重新添加任务到队列（TaskQueue 会自动执行）
    this.taskQueue.addTask(previousTask);
    
    // 轮询等待任务完成
    const maxWaitTime = 60000; // 最多等待 60 秒
    const pollInterval = 500; // 每 500ms 检查一次
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      const task = this.taskQueue.getTask(previousTaskId);
      
      if (!task) {
        return {
          success: false,
          error: {
            type: "FATAL",
            message: "任务丢失",
            code: "TASK_LOST",
          },
        };
      }
      
      if (task.status === "completed") {
        const taskResult = task.result || { success: true, data: {} };

        // 检查是否又产生了新的询问
        // task.result 结构: { success: true, data: SkillExecutionResult }
        const skillData = (taskResult as { data?: SkillExecutionResult }).data;

        if (skillData?.status === 'waiting_user_input' && skillData.question) {
          // 保存新的询问
          this.waitingQuestions.set(sessionId, skillData.question);

          return {
            success: true,
            data: {
              message: skillData.question.content,
              type: 'question',
              question: skillData.question,
            },
          };
        }

        return taskResult;
      }
      
      if (task.status === "failed") {
        return {
          success: false,
          error: task.error || {
            type: "FATAL",
            message: "任务执行失败",
            code: "TASK_FAILED",
          },
        };
      }
      
      // 等待一段时间再检查
      await this.sleep(pollInterval);
    }
    
    return {
      success: false,
      error: {
        type: "FATAL",
        message: "任务执行超时",
        code: "TASK_TIMEOUT",
      },
    };
  }
}

export default MainAgent;
