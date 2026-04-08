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
import {
  Task,
  TaskResult,
  TaskError,
  TaskStatus,
  TaskPlan,
  CONFIG,
  TaskPlanSchema,
} from "../types";

export class MainAgent {
  private maxReplanAttempts: number;
  private intentRouter: IntentRouter;
  private userProfileService: UserProfileService;
  private memoryService: MemoryService;
  private dynamicContextBuilder: DynamicContextBuilder;
  private autoCompactService: AutoCompactService;

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
    userId: string = "default",
    sessionId?: string,
  ): Promise<TaskResult> {
    try {
      console.log(`[MainAgent] 📥 收到用户请求: "${requirement}"`);

      const effectiveSessionId = sessionId || userId;

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

      // ========== 步骤 2: 上下文加载 ==========
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

      const originalTokens = this.autoCompactService.estimateTokens(messages);
      const compactedTokens =
        this.autoCompactService.estimateTokens(compactedMessages);
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
      const intentResult = await this.intentRouter.classify(
        requirement,
        userProfile,
        memory.conversationHistory,
        effectiveSessionId,
      );
      console.log(
        `[MainAgent] 📊 意图分类: ${intentResult.intent} (置信度: ${intentResult.confidence})`,
      );

      if (intentResult.intent !== "skill_task") {
        console.log(`[MainAgent] ⏭️ 非技能任务，直接返回`);
        await this.updateProfileAfterRequest(
          userProfile,
          enrichedRequirement,
          userId,
        );

        if (intentResult.intent === "small_talk") {
          return {
            success: true,
            data: {
              message: intentResult.suggestedResponse || "您好！有什么可以帮助您的吗？",
              type: "small_talk",
            },
          };
        }

        return {
          success: true,
          data: {
            message: intentResult.suggestedResponse || "",
            type: "guess_confirm",
            guessedSystem: intentResult.guessedSystem,
          },
        };
      }

      const matchedSkills = intentResult.matchedSkills || (intentResult.matchedSkill ? [intentResult.matchedSkill] : []);

      if (matchedSkills.length === 0) {
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

      if (matchedSkills.length > 0) {
        sessionContextService.updateContext(effectiveSessionId, {
          currentSkill: matchedSkills[0],
          currentSystem: matchedSkills[0],
          currentTopic: 'skill_task',
        });
        console.log(
          `[MainAgent] 📝 SessionContext 已更新: currentSkill=${matchedSkills[0]}, turn=${sessionContextService.getContext(effectiveSessionId).turnCount}`,
        );
      }

      // ========== 步骤 4: 任务规划与执行 ==========
      let plan: TaskPlan;

      if (matchedSkills.length === 1) {
        console.log(`[MainAgent] 📋 单技能任务：直接创建计划`);
        plan = {
          id: `plan-${Date.now()}`,
          requirement: enrichedRequirement,
          tasks: [
            {
              id: "task-1",
              requirement: enrichedRequirement,
              skillName: matchedSkills[0],
              dependencies: [],
            },
          ],
        };
      } else {
        console.log(
          `[MainAgent] 📋 多技能任务 (${matchedSkills.length}个)：调用规划器`,
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

      console.log(`[MainAgent] 🔄 派发给 TaskQueue 执行`);
      const result = await this.monitorAndReplan(plan);

      await this.updateProfileAfterRequest(
        userProfile,
        enrichedRequirement,
        userId,
      );

      const resultData = result.data as
        | {
            response?: string;
            _metadata?: { skill?: string; references?: string[] };
          }
        | undefined;
      const responseText = resultData?.response || JSON.stringify(result.data);
      await this.memoryService.saveInteraction(
        userId,
        requirement,
        responseText,
        {
          skill: resultData?._metadata?.skill,
          references: resultData?._metadata?.references,
        },
      );

      return result;
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

  private submitPlanTasks(plan: TaskPlan): void {
    console.log(`[MainAgent] 📤 向任务队列提交 ${plan.tasks.length} 个任务`);
    for (const taskDef of plan.tasks) {
      // Generate unique task ID by combining plan ID and task ID
      const uniqueTaskId = `${plan.id}-${taskDef.id}`;

      // Update dependencies to use unique task IDs
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
      const planTasks = allTasks.filter(
        (t) => t.id.startsWith(planId) && t.skillName,
      );

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
        type: "RETRYABLE",
        message: `Workflow timeout after ${maxWaitTime}ms`,
        code: "TIMEOUT",
      },
    };
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
    userId: string = "default",
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
}

export default MainAgent;
