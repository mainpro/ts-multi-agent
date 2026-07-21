import { ILLMClient } from "../llm";
import { SkillRegistry } from "../skill-registry";
import { TaskQueue } from "../task-queue";
import { IntentRouter } from "../routers";
import { UnifiedPlanner } from "../planners";
import { UserProfileService } from "../user-profile";
import { MemoryService, sessionContextService, DEFAULT_RECALL_CONFIG } from "../memory";
import { DynamicContextBuilder } from "../context/dynamic-context";
import { hookManager } from "../hooks/hook-manager";
import { HookEvent } from "../hooks/types";
import { AskAgent } from "./ask-agent";
import { SessionStore } from "../memory/session-store";
import { buildSessionPrompt } from "../prompts/session-context-prompt";
import {
  Task,
  TaskResult,
  TaskPlan,
  QAEntry,
  Request,
  RequestTask,
  TaskGraph,
} from "../types";
import { SystemSkillLoader, ExecutorRegistry } from "../system-skills";
import { fireAndForget } from "../utils/fire-and-forget";
import { createLogger } from '../observability/logger';
import { TaskGraphExecutor } from "./task-graph-executor";
import { ResultAggregator } from "./result-aggregator";

/**
 * MainAgent 依赖注入接口
 *
 * index.ts (bootstrap) 负责创建所有依赖并注入，MainAgent 不再自行 new XXX()。
 * resultAggregator 和 taskGraphExecutor 必须在 MainAgent 内创建（循环依赖）。
 */
export interface MainAgentDependencies {
  llm: ILLMClient;
  skillRegistry: SkillRegistry;
  taskQueue: TaskQueue;
  intentRouter: IntentRouter;
  userProfileService: UserProfileService;
  memoryService: MemoryService;
  dynamicContextBuilder: DynamicContextBuilder;
  sessionStore: SessionStore;
  askAgent: AskAgent;
  systemSkillLoader: SystemSkillLoader;
  executorRegistry: ExecutorRegistry;
}

export class MainAgent {
  private static readonly log = createLogger({ module: 'MainAgent' });
  private llm: ILLMClient;
  private skillRegistry: SkillRegistry;
  private taskQueue: TaskQueue;
  private intentRouter: IntentRouter;
  private userProfileService: UserProfileService;
  private memoryService: MemoryService;
  private dynamicContextBuilder: DynamicContextBuilder;
  private askAgent: AskAgent;
  private sessionStore: SessionStore;
  private systemSkillLoader: SystemSkillLoader;
  private executorRegistry: ExecutorRegistry;
  private taskGraphExecutor: TaskGraphExecutor;
  private resultAggregator: ResultAggregator;

  constructor(deps: MainAgentDependencies) {
    const {
      llm, skillRegistry, taskQueue,
      intentRouter, userProfileService, memoryService,
      dynamicContextBuilder,
      sessionStore, askAgent,
      systemSkillLoader, executorRegistry,
    } = deps;

    this.llm = llm;
    this.skillRegistry = skillRegistry;
    this.taskQueue = taskQueue;
    this.intentRouter = intentRouter;
    this.userProfileService = userProfileService;
    this.memoryService = memoryService;
    this.dynamicContextBuilder = dynamicContextBuilder;
    this.sessionStore = sessionStore;
    this.askAgent = askAgent;
    this.systemSkillLoader = systemSkillLoader;
    this.executorRegistry = executorRegistry;

    // resultAggregator 需要 processNormalRequirement 回调，循环依赖 → MainAgent 内创建
    this.resultAggregator = new ResultAggregator(
      llm, memoryService, sessionStore,
      (request, userId, sessionId) =>
        this.processNormalRequirement(request.content, userId, sessionId, request, undefined, undefined, 1),
    );
    this.taskGraphExecutor = new TaskGraphExecutor(taskQueue, this.resultAggregator);
  }

  async processRequirement(
    requirement: string,
    imageAttachment?: { data: Buffer; mimeType: string; originalName?: string },
    userId: string = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    sessionId?: string,
    options?: { planMode?: boolean },
  ): Promise<TaskResult> {
    const effectiveSessionId = sessionId || userId;

    try {
      console.log(`[MainAgent] 📥 收到用户请求: "${requirement}"`);

      // ========== 步骤 0: 恢复会话上下文（服务重启后从 L4 历史恢复） ==========
      if (sessionId && !sessionContextService.hasActiveContext(sessionId)) {
        try {
          // 优先从 L4 历史恢复(更纯粹)
          const l4 = this.memoryService.getL4();
          const historyEntries = await l4.listEntries(userId, sessionId);
          if (historyEntries.length > 0) {
            sessionContextService.restoreFromHistory(sessionId, userId, historyEntries);
          }
        } catch (error) {
          console.warn(`[MainAgent] ⚠️ 恢复会话上下文失败:`, error);
        }
      }

      // L1 + L4 同步写入(替代旧的双写)
      try {
        await this.memoryService.saveUserMessage(userId, effectiveSessionId, requirement);
      } catch (e) { console.error('[MainAgent] Failed to save user message to memory:', e); }

      // ========== 步骤 1: 图片分析 ==========
      if (imageAttachment) {
        console.log(`[MainAgent] 📎 附件: ${imageAttachment.originalName || "unnamed"} (${imageAttachment.mimeType})`);
        try {
          const VisionLLMClient = (await import("./vision-client.js")).VisionLLMClient;
          const visionClient = new VisionLLMClient();
          const visionResult = await visionClient.analyzeImage(
            imageAttachment.data.toString("base64"),
            imageAttachment.mimeType,
          );
          console.log(`[MainAgent] ✅ 视觉分析完成: ${visionResult.system || "未知系统"}`);
          requirement = `${requirement}\n\n[图片分析结果]\n系统: ${visionResult.system || "未知"}\n错误类型: ${visionResult.errorType || "未知"}\n描述: ${visionResult.description}\n建议操作: ${visionResult.suggestedAction || "无"}`;
        } catch (visionError) {
          console.error(`[MainAgent] ❌ 视觉分析失败:`, visionError);
        }
      }

      // ========== 步骤 1.5: 系统命令拦截 ==========
      if (SystemSkillLoader.isSystemCommand(requirement)) {
        const cmdName = SystemSkillLoader.extractCommandName(requirement);
        const systemSkill = this.systemSkillLoader.getCommand(cmdName);

        if (!systemSkill) {
          return {
            success: false,
            error: {
              type: 'FATAL',
              message: `未知系统命令 /${cmdName}，可用命令: ${this.systemSkillLoader.getAllCommands().join(', ')}`,
              code: 'UNKNOWN_COMMAND',
            },
          };
        }

        const executor = this.executorRegistry.getExecutor(systemSkill.executor, this.llm);
        if (!executor) {
          return {
            success: false,
            error: {
              type: 'FATAL',
              message: `执行器类型 "${systemSkill.executor}" 未注册`,
              code: 'EXECUTOR_NOT_FOUND',
            },
          };
        }

        console.log(`[MainAgent] 🛠️ 执行系统命令: /${cmdName} (执行器: ${systemSkill.executor})`);
        const result = await executor.execute(systemSkill, { requirement });

        return {
          success: result.success,
          data: result.success ? { response: result.message || '执行完成', data: result.data } : undefined,
          error: result.success ? undefined : { type: 'FATAL' as const, message: result.error || '执行失败', code: 'EXECUTION_ERROR' },
        };
      }

      // ========== 步骤 2: AskAgent 处理用户输入 ==========
      const handleResult = await this.askAgent.handleUserInput(userId, effectiveSessionId, requirement);
      console.log(`[MainAgent] 📊 AskAgent 结果: ${handleResult.type}`);

      switch (handleResult.type) {
        case 'continue':
          // 用户回复了等待的问题，继续执行
          return this.continueRequest(userId, effectiveSessionId, handleResult.request, handleResult.question);

        case 'new_request':
          // 新请求，走正常流程
          return this.processNormalRequirement(requirement, userId, effectiveSessionId, handleResult.request, imageAttachment, options);

        default:
          return {
            success: false,
            error: { type: 'FATAL', message: '未知的处理结果类型', code: 'UNKNOWN_HANDLE_RESULT' },
          };
      }
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

  /**
   * 获取会话历史记录（供前端恢复对话使用）
   */
  async getSessionHistory(userId: string, sessionId: string): Promise<{
    exists: boolean;
    messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string; type?: string }>;
    activeRequestId: string | null;
    requestStatus: string | null;
  }> {
    try {
      const session = await this.sessionStore.loadSession(userId, sessionId);
      if (session.requests.length === 0) {
        return { exists: false, messages: [], activeRequestId: null, requestStatus: null };
      }

      const messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string; type?: string }> = [];

      for (const req of session.requests) {
        // 用户原始请求
        messages.push({ role: 'user', content: req.content, timestamp: req.createdAt });

        // 问答历史（请求级 + 任务级）
        const allQA: Array<{ content: string; answer: string | null; createdAt: string; answeredAt: string | null; source: string }> = [];
        for (const qa of req.questions) {
          allQA.push({ ...qa });
        }
        for (const task of req.tasks || []) {
          for (const qa of task.questions || []) {
            allQA.push({ ...qa, source: qa.source || 'sub_agent' });
          }
        }

        for (const qa of allQA) {
          if (qa.content) {
            // 询问类消息标记为 question
            messages.push({ role: 'assistant', content: qa.content, timestamp: qa.createdAt, type: 'question' });
          }
          if (qa.answer) {
            messages.push({ role: 'user', content: qa.answer, timestamp: qa.answeredAt || qa.createdAt });
          }
        }

        // 最终结果（只要有 result 就显示）
        if (req.result) {
          // 判断消息类型：
          // - question: 询问类消息（需要用户回答）
          // - task_result: 任务执行结果（有任务执行）
          // - simple: 简单回复（闲聊、确认等）
          const hasQuestions = req.questions.length > 0 || req.tasks.some(t => (t.questions?.length || 0) > 0);
          const hasTasks = req.tasks.length > 0;
          
          let msgType: string;
          if (hasQuestions) {
            msgType = 'question';
          } else if (hasTasks) {
            msgType = 'task_result';
          } else {
            msgType = 'simple';
          }
          
          messages.push({ role: 'assistant', content: req.result, timestamp: req.updatedAt, type: msgType });
        }
      }

      const activeRequest = session.requests.find(r => r.requestId === session.activeRequestId);

      return {
        exists: true,
        messages,
        activeRequestId: session.activeRequestId,
        requestStatus: activeRequest?.status || null,
      };
    } catch (error) {
      console.error('[MainAgent] 获取会话历史失败:', error);
      return { exists: false, messages: [], activeRequestId: null, requestStatus: null };
    }
  }

  /**
   * 继续执行请求（用户回答了等待的问题）
   */
  private async continueRequest(
    userId: string,
    sessionId: string,
    request: Request,
    question: QAEntry
  ): Promise<TaskResult> {
    console.log(`[MainAgent] 🔄 继续执行请求: ${request.requestId}`);
    console.log(`[MainAgent] 📝 问题: "${question.content.substring(0, 60)}..."`);
    console.log(`[MainAgent] 📝 回答: "${question.answer}"`);
    console.log(`[MainAgent] 📝 question.taskId="${question.taskId || '(null)'}" question.source="${question.source || '?'}"`);

    // 找到关联的任务（如果有）
    const taskEntry = question.taskId
      ? request.tasks.find(t => t.taskId === question.taskId)
      : null;

    console.log(`[MainAgent] 📝 taskEntry=${taskEntry ? taskEntry.taskId : 'NULL'}, request.tasks=[${request.tasks.map(t => `${t.taskId}(status=${t.status})`).join(', ')}]`);

    if (taskEntry) {
      // 检查是否有断点续传的执行进度
      if (request.executionProgress) {
        console.log(`[MainAgent] 📌 检测到执行进度，从断点恢复 (Layer ${request.executionProgress.currentLayerIndex})`);
        return this.resumeFromBreakpoint(userId, sessionId, request, question);
      }

      // 子智能体任务需要继续执行
      const task = this.taskQueue.getTask(taskEntry.taskId);
      if (!task) {
        // TaskQueue 是内存的，服务器重启后队列为空。
        // 从 SessionStore 持久化数据重建 Task 对象并恢复执行。
        console.warn(`[MainAgent] ⚠️ 任务 ${taskEntry.taskId} 在 TaskQueue 中不存在，从持久化数据重建`);

        const answers = (taskEntry.questions || [])
          .filter((q: QAEntry) => q.answer)
          .map((q: QAEntry) => ({
            question: { type: 'skill_question' as const, content: q.content, taskId: q.taskId || undefined, metadata: q.metadata },
            answer: q.answer || '',
            timestamp: new Date(q.answeredAt || q.createdAt),
          }));

        const reconstructed = this.taskQueue.reconstructTask(
          { taskId: taskEntry.taskId, content: taskEntry.content, skillName: taskEntry.skillName },
          answers,
          question.answer || '',
        );

        // 自动填充参数（如果 question 包含 paramName）
        const paramName = question.metadata?.paramName as string | undefined;
        if (paramName && question.answer) {
          reconstructed.params = reconstructed.params || {};
          reconstructed.params[paramName] = question.answer;
          console.log(`[MainAgent] ✅ 自动填充参数 ${paramName} = ${question.answer}`);
        }

        // 从已回答问题构建 conversationSummary
        const conversationSummary = (taskEntry.questions || [])
          .filter((q: QAEntry) => q.answer)
          .map((q: QAEntry, i: number) => `第${i + 1}轮:\n问: ${q.content.replace(/\n/g, ' ')}\n答: ${q.answer}`)
          .join('\n\n') || '';
        reconstructed.params = reconstructed.params || {};
        if (conversationSummary) {
          reconstructed.params.conversationSummary = conversationSummary;
        }

        console.log(`[MainAgent] 📝 任务已重建并继续: ${taskEntry.taskId}`);
        return this.pollTaskCompletion(reconstructed.id, userId, sessionId, request);
      }

      // 自动填充参数（如果 question 包含 paramName）
      const paramName = question.metadata?.paramName as string | undefined;
      if (paramName && question.answer) {
        task.params = task.params || {};
        task.params[paramName] = question.answer;
        console.log(`[MainAgent] ✅ 自动填充参数 ${paramName} = ${question.answer}`);
      }

      // 添加询问历史到 task（用于子智能体 prompt）
      task.questionHistory = task.questionHistory || [];
      task.questionHistory.push({
        question: {
          type: 'skill_question',
          content: question.content,
          taskId: question.taskId || '',
          metadata: question.metadata,  // 保留完整的 metadata
        },
        answer: question.answer || '',
        timestamp: new Date(),
      });

      // 传递最新回复
      task.params = task.params || {};
      task.params.latestUserAnswer = question.answer || '';

      // conversationContext 可能缺少之前的问答（纯对话技能无工具调用时只有2条消息），
      // 所以从 session.json 的 task.questions 中提取已回答的问答对作为补充上下文
      const conversationSummary = taskEntry.questions
        ?.filter((q: QAEntry) => q.answer)
        ?.map((q: QAEntry, i: number) => `第${i + 1}轮:\n问: ${q.content.replace(/\n/g, ' ')}\n答: ${q.answer}`)
        ?.join('\n\n') || '';
      if (conversationSummary) {
        task.params.conversationSummary = conversationSummary;
      }

      // 重置任务状态
      task.status = "pending";
      task.result = undefined;
      task.error = undefined;

      console.log(`[MainAgent] 📝 任务已准备继续: ${taskEntry.taskId} (询问历史: ${task.questionHistory.length}条)`);

      const ctxLen = task.conversationContext?.length ?? 0;
      console.log(`[MainAgent] 📝 conversationContext entries: ${ctxLen}, completedToolCalls: ${task.completedToolCalls?.length ?? 0}`);

      this.taskQueue.triggerProcess();
      return this.pollTaskCompletion(taskEntry.taskId, userId, sessionId, request);
    }

    // 主智能体自己的询问（如 confirm_system），需要重新识别意图并派发任务
    // 将回答作为上下文追加到需求中
    console.log(`[MainAgent] 💬 主智能体询问已回答，重新识别意图: "${question.content.substring(0, 40)}..." → "${question.answer}"`);
    const enrichedRequirement = `之前的对话：\n问：${question.content}\n答：${question.answer}\n\n现在请继续处理：${request.content}`;
    return this.processNormalRequirement(enrichedRequirement, userId, sessionId, request, undefined, undefined, 1);
  }

  /**
   * 从断点恢复执行（委托给 TaskGraphExecutor）
   */
  private async resumeFromBreakpoint(
    userId: string,
    sessionId: string,
    request: Request,
    question: QAEntry,
  ): Promise<TaskResult> {
    return this.taskGraphExecutor.resumeFromBreakpoint(userId, sessionId, request, question);
  }

  /**
   * 处理正常的请求（无等待问题的情况）
   */
  private async processNormalRequirement(
    requirement: string,
    userId: string,
    sessionId: string,
    request: Request,
    _imageAttachment?: { data: Buffer; mimeType: string; originalName?: string },
    options?: { planMode?: boolean },
    depth: number = 0,
  ): Promise<TaskResult> {
    // 递归深度限制，防止无限递归
    if (depth > 3) {
      console.error(`[MainAgent] ❌ 递归深度超过限制 (${depth} > 3)，终止处理`);
      return {
        success: false,
        error: { type: 'FATAL', message: '请求处理递归深度超过限制，请简化您的需求后重试', code: 'MAX_RECURSION_DEPTH' },
      };
    }

    let assistantResponse = '';

    try {
      // ========== 上下文加载（并行） ==========
      const skillsMetadata = this.skillRegistry.getAllMetadata();
      this.userProfileService.setSkillsMetadata(skillsMetadata);

      const [userProfile, memory, session, dynamicContext] = await Promise.all([
        this.userProfileService.loadProfile(userId),
        this.memoryService.loadUserMemory(userId, sessionId),
        this.sessionStore.loadSession(userId, sessionId),
        this.dynamicContextBuilder.build(requirement, userId, sessionId),
      ]);
      console.log(`[MainAgent] 👤 用户画像: ${JSON.stringify(Object.fromEntries(Object.entries(userProfile).filter(([, v]) => v !== undefined && v !== null)))}`);

      // ========== 召回相关记忆 ==========
      let recalledContext = '';
      try {
        const recalledResults = await this.memoryService.recall(userId, requirement, {
          topK: DEFAULT_RECALL_CONFIG.MAIN_AGENT_RECALL_TOP_K,
        });
        if (recalledResults.length > 0) {
          const lines = recalledResults.map(r => {
            const source = (r.metadata?.source as string) || '知识';
            return `[${source}] ${r.content}`;
          });
          recalledContext = '\n[相关记忆]\n' + lines.join('\n');
        }
      } catch (e) { console.error('[MainAgent] Failed to recall memory:', e); }

      // ========== 加载活跃任务（防止重复分派）==========
      const activeTasksInSession = request.tasks.filter(t =>
        t.status !== 'completed' && t.status !== 'failed'
      );
      if (activeTasksInSession.length > 0) {
        console.log(`[MainAgent] 📋 活跃任务: ${activeTasksInSession.length}个`);
      }

      // 删除 AutoCompactService 依赖:buildContextPrompt 已 slice(-50),足够压缩
      const historyPrompt = this.memoryService.buildContextPrompt(memory);

      let enrichedRequirement = requirement;
      if (historyPrompt) {
        enrichedRequirement = historyPrompt + recalledContext + "\n\n" + enrichedRequirement;
      } else if (recalledContext) {
        enrichedRequirement = recalledContext + "\n\n" + enrichedRequirement;
      }

      // ========== 注入 Session 上下文到提示词 ==========
      const sessionPrompt = buildSessionPrompt(session);
      if (sessionPrompt) {
        enrichedRequirement = sessionPrompt + "\n\n" + enrichedRequirement;
        console.log(`[MainAgent] 📑 Session 上下文已注入`);
      }

      if (dynamicContext) {
        enrichedRequirement = dynamicContext + "\n\n" + enrichedRequirement;
      }

      // ========== 意图路由 ==========
      console.log(`[MainAgent] 🔄 正在分类用户意图...`);

      await hookManager.emit(HookEvent.BEFORE_INTENT_CLASSIFY, {
        userId, sessionId, data: { requirement }
      });

      const recentHistory = memory.episodicEntries.map(entry => ({
        role: typeof entry.metadata?.role === 'string' ? entry.metadata.role : 'user',
        content: entry.content,
        skill: typeof entry.metadata?.skill === 'string' ? entry.metadata.skill : undefined,
        system: typeof entry.metadata?.system === 'string' ? entry.metadata.system : undefined,
      }));

      let proceduralExperience: Array<{ skillName: string; usageCount: number; lastSuccess: boolean }> | undefined;
      try {
        const proceduralResults = await this.memoryService.recall(userId, requirement, {
          topK: DEFAULT_RECALL_CONFIG.MAIN_AGENT_PROCEDURAL_TOP_K,
        });
        proceduralExperience = proceduralResults
          .filter(r => r.metadata?.skill)
          .map(r => ({
            skillName: r.metadata!.skill as string,
            usageCount: (r.metadata!.usageCount as number) || 0,
            lastSuccess: (r.metadata!.success as boolean) ?? true,
          }));
      } catch (e) { console.error('[MainAgent] Failed to recall procedural memory:', e); }

      const intentResult = await this.intentRouter.classify(
        requirement, userProfile, recentHistory, sessionId, proceduralExperience, userId,
      );

      await hookManager.emit(HookEvent.AFTER_INTENT_CLASSIFY, {
        userId, sessionId, data: { intent: intentResult.intent, confidence: intentResult.confidence, tasks: intentResult.tasks }
      });

      console.log(`[MainAgent] 📊 意图分类: ${intentResult.intent} (置信度: ${intentResult.confidence})`);

      if (intentResult.intent !== "skill_task") {
        return this.handleNonSkillIntent(intentResult, sessionId, request, userId);
      }

      const tasks = intentResult.tasks;
      if (tasks.length === 0) {
        await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);
      await this.sessionStore.failRequest(userId, sessionId, request.requestId, '未匹配到合适的技能');
        return {
          success: false,
          error: { type: "FATAL", message: "未匹配到合适的技能", code: "NO_SKILL_MATCHED" },
        };
      }

      const tasksWithSkill = tasks.filter(t => t.skillName);
      const tasksWithoutSkill = tasks.filter(t => !t.skillName);
      const hasTransferRequest = !!tasksWithoutSkill.find(t => t.intent === 'unclear');

      if (tasksWithSkill.length > 0) {
        const firstTask = tasksWithSkill[0];
        sessionContextService.updateContext(sessionId, {
          currentSkill: firstTask.skillName!,
          currentSystem: firstTask.skillName!,
          currentTopic: 'skill_task',
          tempVariables: firstTask.params || {},
        } as any);
      }

      // ========== 任务规划与执行 ==========
      let plan: TaskPlan;
      const tasksToExecute = tasksWithSkill;

      if (tasksToExecute.length === 0) {
        assistantResponse = '抱歉，这个问题暂时超出了我的处理范围，我帮您转给人工客服处理。';
        try {
          await this.memoryService.saveAssistantMessage(userId, sessionId, assistantResponse);
        } catch (e) { console.error('[MainAgent] Failed to save non-skill assistant message to memory:', e); }
        await this.sessionStore.completeRequest(userId, sessionId, request.requestId, assistantResponse);
        // 请求级摘要(异步,失败不阻塞)
        fireAndForget(
          this.memoryService.summarizeRequest({
            userId, sessionId, requestId: request.requestId,
            userMessage: requirement, assistantMessage: assistantResponse,
          }),
          'summarizeRequest (no-skill)',
          (err) => MainAgent.log.error('请求摘要生成失败', { error: err }),
        );
        return { success: true, data: { message: assistantResponse, type: 'unclear' } };
      }

      if (tasksToExecute.length === 1) {
        plan = {
          id: `plan-${Date.now()}`,
          requirement: enrichedRequirement,
          tasks: tasksToExecute.map((t, idx) => ({
            id: `task-${idx + 1}`,
            requirement: t.requirement,
            skillName: t.skillName!,
            params: {
              ...t.params,
              ...(userProfile.department ? { department: userProfile.department } : {}),
            },
            dependencies: [],
          })),
        };
      } else {
        const planner = new UnifiedPlanner(this.llm, this.skillRegistry);
        const planResult = await planner.plan(enrichedRequirement);
        if (!planResult.success || !planResult.plan) {
          await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);
          return {
            success: false,
            error: { type: "FATAL", message: planResult.clarificationPrompt || "规划失败", code: "PLANNING_FAILED" },
          };
        }
        plan = planResult.plan;
        for (const task of plan.tasks) {
          if (userProfile.department) {
            task.params = { ...task.params, department: userProfile.department };
          }
        }
      }

      console.log(`[MainAgent] ✅ 规划完成 - 共 ${plan.tasks.length} 个任务`);

      if (options?.planMode && plan) {
        return {
          success: true,
          data: {
            type: 'plan_preview',
            plan: {
              id: plan.id,
              tasks: plan.tasks.map((t: any) => ({ id: t.id, skillName: t.skillName, requirement: t.requirement, dependencies: t.dependencies })),
            },
            message: '请确认以上计划，确认后将开始执行。',
            requestId: request.requestId,
          },
        };
      }

      // 注册任务到请求中
      for (const taskDef of plan.tasks) {
        const uniqueTaskId = `${plan.id}-${taskDef.id}`;

        const requestTask: RequestTask = {
          taskId: uniqueTaskId,
          content: taskDef.requirement,
          status: 'pending',
          skillName: taskDef.skillName || null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: null,
          questions: [],
          currentQuestion: null,
        };
        await this.sessionStore.addTaskToRequest(userId, sessionId, request.requestId, requestTask);
      }

      console.log(`[MainAgent] 🔄 构建 TaskGraph 并执行`);

      await hookManager.emit(HookEvent.BEFORE_TASK_EXECUTE, {
        userId, sessionId, data: { planId: plan.id, tasks: plan.tasks }
      });

      // 构建 TaskGraph 并分层执行
      const graph = this.buildTaskGraph(plan);
      const result = await this.executeTaskGraph(graph, sessionId, userId, request);

      await hookManager.emit(HookEvent.AFTER_TASK_EXECUTE, {
        userId, sessionId, data: { planId: plan.id, success: result.success, result: result.data, error: result.error }
      });

      await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);

      // 检查是否有任务需要等待用户输入
      const resultData = result.data as any;
      const taskResults = resultData?.results || [];

      // 检查 executeTaskGraph 返回的 waitingTaskId
      if (resultData?.waitingTaskId) {
        const waitingTaskId = resultData.waitingTaskId;
        const waitingResult = taskResults.find((tr: any) => tr.taskId === waitingTaskId);
        const skillResult = waitingResult?.result?.data;

        if (skillResult?.status === 'waiting_user_input' && skillResult.question) {
          console.log(`[MainAgent] 🔄 检测到子任务 ${waitingTaskId} 需要用户输入`);

          const qaEntry = this.resultAggregator.createQAEntry(skillResult!, waitingTaskId, waitingResult?.skillName || null);

          // 子智能体询问只放到任务级 questions，不放请求级
          await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, waitingTaskId, {
            currentQuestion: qaEntry,
            status: 'waiting',
            questions: [...(request.tasks.find(t => t.taskId === waitingTaskId)?.questions || []), qaEntry],
          });

          try {
            await this.memoryService.saveAssistantMessage(userId, sessionId, qaEntry.content, {
              skillName: qaEntry.skillName || undefined,
            });
          } catch (e) { console.error('[MainAgent] Failed to save assistant message to memory:', e); }

          return {
            success: true,
            data: {
              message: qaEntry.content,
              type: 'question',
              question: qaEntry,
              requestId: request.requestId,
            },
          };
        }
      }

      // 所有任务完成 → 汇总结果
      const taskList = taskResults.map((tr: any, idx: number) => ({
        taskId: tr.taskId || `task-${idx + 1}`,
        skillName: tr.skillName || '',
        requirement: tr.requirement || '',
        response: tr.result?.data?.response || '',
        status: tr.status || 'completed',
      }));

      let finalResponse: string;
      let isCompleted = false;

      if (taskList.length === 1) {
        // 单任务：直接使用子智能体的结果，无需额外汇总
        console.log(`[MainAgent] ✅ 单任务完成，跳过汇总，直接使用子智能体结果`);
        finalResponse = taskList[0].response;
        if (!finalResponse) {
          finalResponse = JSON.stringify(result.data);
        }
        isCompleted = true;
        await this.sessionStore.completeRequest(userId, sessionId, request.requestId, finalResponse);
      } else {
        // 多任务：调用 LLM 汇总判断
        const summary = await this.summarizeResults(
          request.content,  // 使用原始需求（非 enriched）
          taskList,
          userId,
          sessionId,
          request,
        );
        finalResponse = summary.summary;
        isCompleted = summary.completed;
      }

      if (hasTransferRequest) {
        finalResponse = '抱歉，这个问题暂时超出了我的处理范围，我帮您转给人工客服处理。\n\n' + finalResponse;
      }

      assistantResponse = finalResponse;
      try {
        await this.memoryService.saveAssistantMessage(userId, sessionId, assistantResponse, {
          skillName: taskList[0]?.skillName || undefined,
        });
      } catch (e) { console.error('[MainAgent] Failed to save assistant message to memory:', e); }
      // 请求级摘要(异步,失败不阻塞) — 替代旧 semanticExtractor.extract
      fireAndForget(
        this.memoryService.summarizeRequest({
          userId, sessionId, requestId: request.requestId,
          userMessage: requirement, assistantMessage: assistantResponse,
          skillName: taskList[0]?.skillName || undefined,
        }),
        'summarizeRequest (processNormalRequirement)',
        (err) => MainAgent.log.error('请求摘要生成失败', { error: err }),
      );

      // ===== v3: questionHistory 语义提取已由 L3 summarizeRequest 覆盖,不再单独提取 =====

      return {
        success: result.success,
        data: {
          results: taskList,
          type: hasTransferRequest ? 'unclear' : 'skill_task',
          requestId: request.requestId,
          completed: isCompleted,
          summary: finalResponse,
        },
      };
    } catch (error) {
      console.error("Error processing normal requirement:", error);
      await this.sessionStore.failRequest(userId, sessionId, request.requestId, error instanceof Error ? error.message : 'Unknown error');
      return {
        success: false,
        error: { type: "FATAL", message: error instanceof Error ? error.message : "Unknown error", code: "PROCESSING_ERROR" },
      };
    } finally {
      // 回滚 L1 最后一条消息(如果未生成 assistantResponse)
      if (!assistantResponse) {
        try {
          await this.memoryService.popLastAssistantMessage(userId, sessionId);
        } catch (e) {
          console.error('[MainAgent] Failed to pop last assistant message:', e);
        }
      }
    }
  }

  /**
   * 处理非技能意图
   */
  private async handleNonSkillIntent(intentResult: any, sessionId: string, request: Request, userId: string): Promise<TaskResult> {
    let assistantResponse = '';

    if (intentResult.intent === "small_talk") {
      assistantResponse = intentResult.question?.content || "您好！有什么可以帮助您的吗？";
      try {
        await this.memoryService.saveAssistantMessage(userId, sessionId, assistantResponse);
      } catch (e) { console.error('[MainAgent] Failed to save non-skill assistant message to memory:', e); }
      await this.sessionStore.completeRequest(userId, sessionId, request.requestId, assistantResponse);
      // 请求级摘要
      fireAndForget(
        this.memoryService.summarizeRequest({
          userId, sessionId, requestId: request.requestId,
          userMessage: request.content, assistantMessage: assistantResponse,
        }),
        'summarizeRequest (small_talk)',
        (err) => MainAgent.log.error('请求摘要生成失败', { error: err }),
      );
      return { success: true, data: { message: assistantResponse, type: "small_talk", requestId: request.requestId } };
    }

    if (intentResult.intent === "confirm_system") {
      assistantResponse = intentResult.question?.content || "请问您说的是哪个系统？";
      try {
        await this.memoryService.saveAssistantMessage(userId, sessionId, assistantResponse);
      } catch (e) { console.error('[MainAgent] Failed to save non-skill assistant message to memory:', e); }

      // 主智能体询问 → 记录到请求的 questions 中
      if (intentResult.question) {
        const questionId = `q-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const qaEntry: QAEntry = {
          questionId,
          content: intentResult.question.content,
          source: 'main_agent',
          taskId: null,
          skillName: null,
          answer: null,
          answeredAt: null,
          createdAt: new Date().toISOString(),
        };
        await this.sessionStore.addQuestionToRequest(
          userId, sessionId, request.requestId, qaEntry
        );
      }

      // confirm_system 是询问状态，不调用 completeRequest，等待用户回答
      return {
        success: true,
        data: {
          message: assistantResponse,
          type: "confirm_system",
          question: intentResult.question,
          requestId: request.requestId,
        },
      };
    }

    if (intentResult.intent === "out_of_scope") {
      assistantResponse = intentResult.question?.content || "抱歉，这个问题超出了我的处理范围。";
      try {
        await this.memoryService.saveAssistantMessage(userId, sessionId, assistantResponse);
      } catch (e) { console.error('[MainAgent] Failed to save non-skill assistant message to memory:', e); }
      await this.sessionStore.completeRequest(userId, sessionId, request.requestId, assistantResponse);
      // 请求级摘要
      fireAndForget(
        this.memoryService.summarizeRequest({
          userId, sessionId, requestId: request.requestId,
          userMessage: request.content, assistantMessage: assistantResponse,
        }),
        'summarizeRequest (out_of_scope)',
        (err) => MainAgent.log.error('请求摘要生成失败', { error: err }),
      );
      return { success: true, data: { message: assistantResponse, type: "out_of_scope", requestId: request.requestId } };
    }

    // unclear 或其他非技能意图：使用 LLM 生成的友好回复
    assistantResponse = intentResult.question?.content || "抱歉，我暂时无法理解您的需求，请换个方式描述或联系人工客服。";
    try {
      await this.memoryService.saveAssistantMessage(userId, sessionId, assistantResponse);
    } catch (e) { console.error('[MainAgent] Failed to save non-skill assistant message to memory:', e); }
    await this.sessionStore.completeRequest(userId, sessionId, request.requestId, assistantResponse);
    // 请求级摘要
    fireAndForget(
      this.memoryService.summarizeRequest({
        userId, sessionId, requestId: request.requestId,
        userMessage: request.content, assistantMessage: assistantResponse,
      }),
      'summarizeRequest (unclear)',
      (err) => MainAgent.log.error('请求摘要生成失败', { error: err }),
    );
    return { success: true, data: { message: assistantResponse, type: "unclear", requestId: request.requestId } };
  }

  /**
   * 汇总任务结果，判断是否满足用户原始需求（委托给 ResultAggregator）
   */
  private async summarizeResults(
    originalRequirement: string,
    taskResults: Array<{ taskId: string; skillName: string; requirement: string; response: string }>,
    userId: string,
    sessionId: string,
    request: Request,
  ): Promise<{ completed: boolean; summary: string }> {
    return this.resultAggregator.summarizeResults(originalRequirement, taskResults, userId, sessionId, request);
  }

  /**
   * 公共任务完成轮询
   */
  private async pollTaskCompletion(
    taskId: string,
    userId: string,
    sessionId: string,
    request: Request
  ): Promise<TaskResult> {
    const result = await this.onceTaskEvent(taskId);
    const task = this.taskQueue.getTask(taskId);

    if (!task || result.status === 'lost') {
      return { success: false, error: { type: 'FATAL', message: '任务丢失', code: 'TASK_LOST' } };
    }

    if (result.status === 'timeout') {
      return { success: false, error: { type: 'FATAL', message: '任务执行超时', code: 'TASK_TIMEOUT' } };
    }

    if (task.status === 'completed') {
      return this.handleTaskCompletion(task, userId, sessionId, request);
    }

    // task.status === 'failed'

    // 失败任务的语义提取已由 L3 summarizeRequest 在请求完成时统一处理,此处不再单独调用

    return {
      success: false,
      error: task.error || { type: 'FATAL', message: '任务执行失败', code: 'TASK_FAILED' },
    };
  }

  /**
   * 处理任务完成（委托给 ResultAggregator）
   */
  private async handleTaskCompletion(
    task: Task,
    userId: string,
    sessionId: string,
    request: Request
  ): Promise<TaskResult> {
    return this.resultAggregator.handleTaskCompletion(task, userId, sessionId, request);
  }

  // ============================================================================
  // Plan-Execute-Summarize: 任务图构建、参数解析、分层执行
  // ============================================================================

  /**
   * 从 TaskPlan 构建 TaskGraph（委托给 TaskGraphExecutor）
   */
  private buildTaskGraph(plan: TaskPlan): TaskGraph {
    return this.taskGraphExecutor.buildTaskGraph(plan);
  }

  /**
   * 分层执行任务图（委托给 TaskGraphExecutor）
   */
  private async executeTaskGraph(
    graph: TaskGraph,
    sessionId: string,
    userId: string,
    request: Request,
  ): Promise<TaskResult> {
    return this.taskGraphExecutor.executeTaskGraph(graph, sessionId, userId, request);
  }

  /**
   * 一次性监听单个任务完成/失败事件（委托给 TaskGraphExecutor）
   */
  private onceTaskEvent(taskId: string): Promise<{ taskId: string; result: any; status: string }> {
    return this.taskGraphExecutor.onceTaskEvent(taskId);
  }

  private async updateProfileAfterRequest(
    userProfile: { commonSystems: string[]; conversationCount: number },
    enrichedRequirement: string,
    userId: string,
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
