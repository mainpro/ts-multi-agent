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
import { RequestManager } from "./request-manager";
import { SessionStore } from "../memory/session-store";
import { buildSessionPrompt } from "../prompts/session-context-prompt";
import { z } from 'zod';
import {
  Task,
  TaskResult,
  TaskError,
  TaskStatus,
  TaskPlan,
  CONFIG,
  TaskPlanSchema,
  SkillExecutionResult,
  QAEntry,
  Request,
  RequestTask,
  TaskGraphNode,
  TaskGraph,
} from "../types";

export class MainAgent {
  private maxReplanAttempts: number;
  private intentRouter: IntentRouter;
  private userProfileService: UserProfileService;
  private memoryService: MemoryService;
  private dynamicContextBuilder: DynamicContextBuilder;
  private autoCompactService: AutoCompactService;
  private requestManager: RequestManager;
  private sessionStore: SessionStore;

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
    this.sessionStore = new SessionStore();
    this.requestManager = new RequestManager(this.sessionStore, llm);
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

      // ========== 步骤 0: 恢复会话上下文（服务重启后从持久化数据恢复） ==========
      if (sessionId && !sessionContextService.hasActiveContext(sessionId)) {
        try {
          const session = await this.sessionStore.loadSession(userId, sessionId);
          if (session.requests.length > 0) {
            sessionContextService.restoreFromSession(sessionId, session);
          }
        } catch (error) {
          console.warn(`[MainAgent] ⚠️ 恢复会话上下文失败:`, error);
        }
      }

      sessionContextService.addUserMessage(effectiveSessionId, requirement);

      // ========== 步骤 1: 图片分析 ==========
      if (imageAttachment) {
        console.log(`[MainAgent] 📎 附件: ${imageAttachment.originalName || "unnamed"} (${imageAttachment.mimeType})`);
        try {
          const VisionLLMClient = (await import("../llm/vision-client.js")).VisionLLMClient;
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

      // ========== 步骤 2: RequestManager 处理用户输入 ==========
      const handleResult = await this.requestManager.handleUserInput(userId, effectiveSessionId, requirement);

      console.log(`[MainAgent] 📊 RequestManager 结果: ${handleResult.type}`);

      switch (handleResult.type) {
        case 'recall_prompt':
          // 有挂起请求可能需要召回，提示用户
          return {
            success: true,
            data: {
              type: 'recall_prompt',
              message: `您之前有类似的请求还在进行中："${handleResult.suspendedRequest.content}"，是否继续执行？`,
              suspendedRequest: {
                requestId: handleResult.suspendedRequest.requestId,
                content: handleResult.suspendedRequest.content,
                suspendedAt: handleResult.suspendedRequest.suspendedAt,
              },
              requestId: handleResult.request.requestId,
            },
          };

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
    messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
    activeRequestId: string | null;
    requestStatus: string | null;
  }> {
    try {
      const session = await this.sessionStore.loadSession(userId, sessionId);
      if (session.requests.length === 0) {
        return { exists: false, messages: [], activeRequestId: null, requestStatus: null };
      }

      const messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> = [];

      for (const req of session.requests) {
        // 用户原始请求
        messages.push({ role: 'user', content: req.content, timestamp: req.createdAt });

        // 问答历史（请求级 + 任务级）
        const allQA: Array<{ content: string; answer: string | null; createdAt: string; answeredAt: string | null }> = [];
        for (const qa of req.questions) {
          allQA.push(qa);
        }
        for (const task of req.tasks || []) {
          for (const qa of task.questions || []) {
            allQA.push(qa);
          }
        }

        for (const qa of allQA) {
          if (qa.content) {
            messages.push({ role: 'assistant', content: qa.content, timestamp: qa.createdAt });
          }
          if (qa.answer) {
            messages.push({ role: 'user', content: qa.answer, timestamp: qa.answeredAt || qa.createdAt });
          }
        }

        // 最终结果
        if (req.result && req.status === 'completed') {
          messages.push({ role: 'assistant', content: req.result, timestamp: req.updatedAt });
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
   * 召回挂起的请求
   */
  async recallRequest(userId: string, sessionId: string, requestId: string): Promise<TaskResult> {
    const request = await this.requestManager.recallRequest(userId, sessionId, requestId);
    if (!request) {
      return { success: false, error: { type: 'FATAL', message: '请求不存在', code: 'REQUEST_NOT_FOUND' } };
    }

    // 继续执行被召回的请求
    return this.processNormalRequirement(request.content, userId, sessionId, request, undefined);
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

    // 找到关联的任务（如果有）
    const taskEntry = question.taskId
      ? request.tasks.find(t => t.taskId === question.taskId)
      : null;

    if (taskEntry) {
      // 检查是否有断点续传的执行进度
      if (request.executionProgress) {
        console.log(`[MainAgent] 📌 检测到执行进度，从断点恢复 (Layer ${request.executionProgress.currentLayerIndex})`);
        return this.resumeFromBreakpoint(userId, sessionId, request, question);
      }

      // 子智能体任务需要继续执行
      const task = this.taskQueue.getTask(taskEntry.taskId);
      if (!task) {
        // TaskQueue 是内存的，任务可能已丢失（如服务重启）
        // 此时不能走 processNormalRequirement 重新执行（会重复派发任务），
        // 而是直接将回答作为结果返回
        console.warn(`[MainAgent] ⚠️ 任务 ${taskEntry.taskId} 在 TaskQueue 中不存在（可能服务重启），直接返回回答`);
        await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, taskEntry.taskId, {
          status: 'completed',
          currentQuestion: null,
        });
        this.syncRequestStatusAfterAnswer(userId, sessionId, request);
        return {
          success: true,
          data: {
            type: 'skill_task',
            message: `已记录您的回答：${question.answer}`,
            requestId: request.requestId,
          },
        };
      }

      // 添加询问历史到 task（用于子智能体 prompt）
      task.questionHistory = task.questionHistory || [];
      task.questionHistory.push({
        question: { type: 'skill_question', content: question.content, taskId: question.taskId || '' },
        answer: question.answer || '',
        timestamp: new Date(),
      });

      // 传递最新回复
      task.params = task.params || {};
      task.params.latestUserAnswer = question.answer || '';

      // 重置任务状态
      task.status = "pending";
      task.result = undefined;
      task.error = undefined;

      console.log(`[MainAgent] 📝 任务已准备继续: ${taskEntry.taskId} (询问历史: ${task.questionHistory.length}条)`);

      this.taskQueue.triggerProcess();
      return this.pollTaskCompletion(taskEntry.taskId, userId, sessionId, request);
    }

    // 主智能体自己的询问（如 confirm_system），需要重新识别意图并派发任务
    // 将回答作为上下文追加到需求中
    console.log(`[MainAgent] 💬 主智能体询问已回答，重新识别意图: "${question.content.substring(0, 40)}..." → "${question.answer}"`);
    const enrichedRequirement = `之前的对话：\n问：${question.content}\n答：${question.answer}\n\n现在请继续处理：${request.content}`;
    return this.processNormalRequirement(enrichedRequirement, userId, sessionId, request, undefined);
  }

  /**
   * 回答问题后重新同步请求状态
   */
  private syncRequestStatusAfterAnswer(_userId: string, _sessionId: string, request: Request): void {
    console.log(`[MainAgent] 📊 请求 ${request.requestId} 状态已同步`);
  }

  /**
   * 从断点恢复执行（Phase 3: 断点续传）
   *
   * 当任务图执行过程中某个任务等待用户输入时，
   * 执行进度被保存到 request.executionProgress。
   * 用户回答后，从断点层继续执行剩余任务。
   */
  private async resumeFromBreakpoint(
    userId: string,
    sessionId: string,
    request: Request,
    question: QAEntry,
  ): Promise<TaskResult> {
    const progress = request.executionProgress!;
    const graph = progress.taskGraph;
    const completedResults = new Map<string, any>(Object.entries(progress.completedResults));
    const startLayerIdx = progress.currentLayerIndex;

    console.log(`[MainAgent] 📌 从 Layer ${startLayerIdx} 恢复执行，已有 ${completedResults.size} 个任务结果`);

    // 先让等待的任务继续执行（获取结果后放入 completedResults）
    if (question.taskId) {
      const task = this.taskQueue.getTask(question.taskId);
      if (task) {
        task.questionHistory = task.questionHistory || [];
        task.questionHistory.push({
          question: { type: 'skill_question', content: question.content, taskId: question.taskId },
          answer: question.answer || '',
          timestamp: new Date(),
        });
        task.params = task.params || {};
        task.params.latestUserAnswer = question.answer || '';
        task.status = "pending";
        task.result = undefined;
        task.error = undefined;

        this.taskQueue.triggerProcess();

        // 等待任务完成
        const taskResult = await this.pollTaskCompletion(question.taskId, userId, sessionId, request);

        // 如果任务又产生了新的询问，直接返回
        if (taskResult.success && (taskResult.data as any)?.type === 'question') {
          return taskResult;
        }

        // 将结果放入 completedResults
        if (taskResult.success) {
          completedResults.set(question.taskId, task.result);
        } else {
          return taskResult;
        }
      }
    }

    // 清除执行进度
    request.executionProgress = undefined;

    // 从断点层继续执行
    const allResults: Array<{ taskId: string; skillName: string; requirement: string; result: any }> = [];

    // 将之前已完成的结果也加入
    for (const [taskId, result] of completedResults) {
      const node = graph.nodes.find(n => n.taskId === taskId);
      if (node) {
        allResults.push({ taskId, skillName: node.skillName, requirement: node.content, result });
      }
    }

    for (let layerIdx = startLayerIdx; layerIdx < graph.layers.length; layerIdx++) {
      const layer = graph.layers[layerIdx];
      console.log(`[MainAgent] 🚀 恢复执行 Layer ${layerIdx}: ${layer.length} 个任务`);

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
        };

        this.taskQueue.addTask(task);

        return new Promise<{ taskId: string; result: any; status: string }>((resolve) => {
          const wrappedCheck = () => {
            const t = this.taskQueue.getTask(taskId);
            if (!t) { resolve({ taskId, result: null, status: 'lost' }); return; }
            if (t.status === 'completed' || t.status === 'failed') {
              resolve({ taskId, result: t.result, status: t.status });
            }
          };

          this.taskQueue.on('task-completed', wrappedCheck);
          this.taskQueue.on('task-failed', wrappedCheck);

          const timeout = setTimeout(() => {
            this.taskQueue.off('task-completed', wrappedCheck);
            this.taskQueue.off('task-failed', wrappedCheck);
            resolve({ taskId, result: null, status: 'timeout' });
          }, CONFIG.TASK_TIMEOUT_MS);

          wrappedCheck();

          // 包装清理
          const origResolve = resolve;
          const wrappedResolve = (value: { taskId: string; result: any; status: string }) => {
            clearTimeout(timeout);
            this.taskQueue.off('task-completed', wrappedCheck);
            this.taskQueue.off('task-failed', wrappedCheck);
            origResolve(value);
          };
          this.taskQueue.off('task-completed', wrappedCheck);
          this.taskQueue.off('task-failed', wrappedCheck);
          const finalCheck = () => {
            const t = this.taskQueue.getTask(taskId);
            if (!t) { wrappedResolve({ taskId, result: null, status: 'lost' }); return; }
            if (t.status === 'completed' || t.status === 'failed') {
              wrappedResolve({ taskId, result: t.result, status: t.status });
            }
          };
          this.taskQueue.on('task-completed', finalCheck);
          this.taskQueue.on('task-failed', finalCheck);
          finalCheck();
        });
      });

      const layerResults = await Promise.all(layerPromises);

      for (const { taskId, result, status } of layerResults) {
        const node = graph.nodes.find(n => n.taskId === taskId)!;

        if (status === 'completed' && result) {
          completedResults.set(taskId, result);
          allResults.push({ taskId, skillName: node.skillName, requirement: node.content, result });

          const skillData = (result as any)?.data;
          if (skillData?.status === 'waiting_user_input' && skillData.question) {
            // 又产生了新的询问，再次保存进度
            request.executionProgress = {
              currentLayerIndex: layerIdx + 1,
              completedResults: Object.fromEntries(completedResults),
              taskGraph: graph,
            };
            // 由 handleTaskCompletion 处理 QAEntry
            return await this.handleTaskCompletion(
              { ...this.taskQueue.getTask(taskId)!, result } as Task,
              userId, sessionId, request,
            );
          }
        } else if (status === 'failed') {
          return { success: false, error: result?.error || { type: 'FATAL', message: `任务 ${taskId} 执行失败`, code: 'TASK_FAILED' } };
        }
      }
    }

    // 所有层执行完毕 → 汇总结果
    const taskList = allResults.map(tr => ({
      taskId: tr.taskId,
      skillName: tr.skillName,
      requirement: tr.requirement,
      response: (tr.result as any)?.data?.response || '',
    }));

    let finalResponse: string;
    let isCompleted: boolean;

    if (taskList.length === 1) {
      // 单任务：直接使用子智能体的结果，无需额外汇总
      console.log(`[MainAgent] ✅ 断点续传-单任务完成，跳过汇总`);
      finalResponse = taskList[0].response;
      isCompleted = true;
      await this.sessionStore.completeRequest(userId, sessionId, request.requestId, finalResponse);
    } else {
      // 多任务：调用 LLM 汇总判断
      const summary = await this.summarizeResults(request.content, taskList, userId, sessionId, request);
      finalResponse = summary.summary;
      isCompleted = summary.completed;
    }

    return {
      success: true,
      data: {
        results: taskList,
        type: 'skill_task',
        requestId: request.requestId,
        completed: isCompleted,
        summary: finalResponse,
      },
    };
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
    options?: { planMode?: boolean }
  ): Promise<TaskResult> {
    let assistantResponse = '';

    try {
      // ========== 上下文加载 ==========
      const skillsMetadata = this.skillRegistry.getAllMetadata();
      this.userProfileService.setSkillsMetadata(skillsMetadata);

      const userProfile = await this.userProfileService.loadProfile(userId);
      console.log(`[MainAgent] 👤 用户画像: 部门=${userProfile.department}, 常用系统=${userProfile.commonSystems.join(", ")}`);

      const memory = await this.memoryService.loadMemory(userId);
      const messages = memory.conversationHistory.map((msg) => ({
        role: msg.role,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      }));

      const microCompactedMessages = this.autoCompactService.microCompact(messages);
      const compactedMessages = await this.autoCompactService.checkAndCompact(microCompactedMessages);

      const compactedHistory = compactedMessages.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
        timestamp: new Date(msg.timestamp || Date.now()).toISOString(),
      }));

      const historyPrompt = this.memoryService.buildContextPrompt({
        ...memory,
        conversationHistory: compactedHistory,
      });

      let enrichedRequirement = requirement;
      if (historyPrompt) {
        enrichedRequirement = historyPrompt + "\n\n" + enrichedRequirement;
      }

      // ========== 注入 Session 上下文到提示词 ==========
      const session = await this.sessionStore.loadSession(userId, sessionId);
      const sessionPrompt = buildSessionPrompt(session);
      if (sessionPrompt) {
        enrichedRequirement = sessionPrompt + "\n\n" + enrichedRequirement;
        console.log(`[MainAgent] 📑 Session 上下文已注入`);
      }

      const dynamicContext = await this.dynamicContextBuilder.build(requirement, userId);
      if (dynamicContext) {
        enrichedRequirement = dynamicContext + "\n\n" + enrichedRequirement;
      }

      // ========== 意图路由 ==========
      console.log(`[MainAgent] 🔄 正在分类用户意图...`);

      await hookManager.emit(HookEvent.BEFORE_INTENT_CLASSIFY, {
        userId, sessionId, data: { requirement }
      });

      const intentResult = await this.intentRouter.classify(
        requirement, userProfile, memory.conversationHistory, sessionId,
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
        assistantResponse = '您好，您的这个问题我暂时无法通过知识库解决，我帮您转到人工这边，让工程师进一步帮您排查一下。';
        sessionContextService.addAssistantMessage(sessionId, assistantResponse);
        await this.sessionStore.completeRequest(userId, sessionId, request.requestId, assistantResponse);
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
            params: t.params,
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

          const questionId = `q-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
          const qaEntry: QAEntry = {
            questionId,
            content: skillResult.question.content,
            source: 'sub_agent',
            taskId: waitingTaskId,
            skillName: waitingResult?.skillName || null,
            answer: null,
            answeredAt: null,
            createdAt: new Date().toISOString(),
          };

          // 子智能体询问只放到任务级 questions，不放请求级
          await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, waitingTaskId, {
            currentQuestion: qaEntry,
            status: 'waiting',
            questions: [...(request.tasks.find(t => t.taskId === waitingTaskId)?.questions || []), qaEntry],
          });

          sessionContextService.addAssistantMessage(sessionId, qaEntry.content);

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

      // 兼容旧逻辑：遍历所有任务结果检查 waiting_user_input
      for (const tr of taskResults) {
        const skillResult = tr.result?.data;
        if (skillResult?.status === 'waiting_user_input' && skillResult.question) {
          console.log(`[MainAgent] 🔄 检测到子任务 ${tr.taskId} 需要用户输入`);

          const questionId = `q-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
          const qaEntry: QAEntry = {
            questionId,
            content: skillResult.question.content,
            source: 'sub_agent',
            taskId: tr.taskId,
            skillName: tr.skillName || null,
            answer: null,
            answeredAt: null,
            createdAt: new Date().toISOString(),
          };

          // 子智能体询问只放到任务级 questions，不放请求级
          // 请求状态通过 syncRequestStatus 自动聚合为 waiting
          await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, tr.taskId, {
            currentQuestion: qaEntry,
            status: 'waiting',
            questions: [...(request.tasks.find(t => t.taskId === tr.taskId)?.questions || []), qaEntry],
          });

          sessionContextService.addAssistantMessage(sessionId, qaEntry.content);

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
        finalResponse = '您好，您的这个问题我暂时无法通过知识库解决，我帮您转到人工这边，让工程师进一步帮您排查一下。\n\n' + finalResponse;
      }

      assistantResponse = finalResponse;
      sessionContextService.addAssistantMessage(sessionId, assistantResponse);
      await this.memoryService.saveInteraction(userId, requirement, assistantResponse, { skill: taskList[0]?.skillName || '' });

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
      if (!assistantResponse) {
        sessionContextService.getContext(sessionId).conversation.pop();
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
      sessionContextService.addAssistantMessage(sessionId, assistantResponse);
      return { success: true, data: { message: assistantResponse, type: "small_talk", requestId: request.requestId } };
    }

    if (intentResult.intent === "confirm_system") {
      assistantResponse = intentResult.question?.content || "请问您说的是哪个系统？";
      sessionContextService.addAssistantMessage(sessionId, assistantResponse);

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

    assistantResponse = intentResult.question?.content || "";
    sessionContextService.addAssistantMessage(sessionId, assistantResponse);
    return { success: true, data: { message: assistantResponse, type: "unclear", requestId: request.requestId } };
  }

  /**
   * 汇总任务结果，判断是否满足用户原始需求
   *
   * 所有子任务执行完毕后，主智能体拿着原始需求 + 各任务结果做一次 LLM 判断，
   * 生成汇总回复并设置 request.result
   */
  private async summarizeResults(
    originalRequirement: string,
    taskResults: Array<{ taskId: string; skillName: string; requirement: string; response: string }>,
    userId: string,
    sessionId: string,
    request: Request,
  ): Promise<{ completed: boolean; summary: string }> {
    console.log(`[MainAgent] 📊 汇总 ${taskResults.length} 个任务结果...`);

    const resultsContext = taskResults
      .map((t, idx) => `任务${idx + 1} [${t.skillName}]: ${t.response}`)
      .join('\n\n');

    const prompt = `用户原始需求: ${originalRequirement}

以下是各子任务的执行结果:
${resultsContext}

请判断:
1. 所有子任务的结果是否已经完整满足了用户的需求？
2. 如果满足，请生成一段简洁自然的汇总回复（直接回复用户，不要说"根据执行结果"等机械用语）
3. 如果不满足，说明还需要执行什么操作

输出 JSON:
{
  "completed": true/false,
  "summary": "汇总文本（completed=true时）或 说明还需要什么（completed=false时）"
}`;

    try {
      const judgment = await this.llm.generateStructured(prompt, z.object({
        completed: z.boolean(),
        summary: z.string(),
      }));

      console.log(`[MainAgent] 📊 汇总判断: completed=${judgment.completed}`);

      if (judgment.completed) {
        await this.sessionStore.completeRequest(userId, sessionId, request.requestId, judgment.summary);
      }

      return judgment;
    } catch (error) {
      console.error(`[MainAgent] ⚠️ 汇总判断失败，使用默认拼接`, error);
      // 降级：直接拼接所有任务结果
      const fallback = taskResults.map(t => t.response).filter(r => r).join('\n\n');
      await this.sessionStore.completeRequest(userId, sessionId, request.requestId, fallback);
      return { completed: true, summary: fallback };
    }
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
    const maxWaitTime = 60000;
    const pollInterval = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const task = this.taskQueue.getTask(taskId);
      if (!task) {
        return { success: false, error: { type: 'FATAL', message: '任务丢失', code: 'TASK_LOST' } };
      }

      if (task.status === "completed") {
        return await this.handleTaskCompletion(task, userId, sessionId, request);
      }

      if (task.status === "failed") {
        return {
          success: false,
          error: task.error || { type: 'FATAL', message: '任务执行失败', code: 'TASK_FAILED' },
        };
      }

      await this.sleep(pollInterval);
    }

    return { success: false, error: { type: 'FATAL', message: '任务执行超时', code: 'TASK_TIMEOUT' } };
  }

  /**
   * 处理任务完成
   */
  private async handleTaskCompletion(
    task: Task,
    userId: string,
    sessionId: string,
    request: Request
  ): Promise<TaskResult> {
    const taskResult = task.result || { success: true, data: {} };
    const skillData = (taskResult as { data?: SkillExecutionResult }).data;

    // 检查是否又产生了新的询问
    if (skillData?.status === 'waiting_user_input' && skillData.question) {
      const questionId = `q-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const qaEntry: QAEntry = {
        questionId,
        content: skillData.question.content,
        source: 'sub_agent',
        taskId: task.id,
        skillName: task.skillName || null,
        answer: null,
        answeredAt: null,
        createdAt: new Date().toISOString(),
      };

      // 子智能体询问只放到任务级 questions，不放请求级
      await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, task.id, {
        currentQuestion: qaEntry,
        status: 'waiting',
        questions: [...(request.tasks.find(t => t.taskId === task.id)?.questions || []), qaEntry],
      });

      sessionContextService.addAssistantMessage(sessionId, qaEntry.content);

      return {
        success: true,
        data: { message: qaEntry.content, type: 'question', question: qaEntry, requestId: request.requestId },
      };
    }

    // 检查是否需要意图重分类
    if (skillData?.status === 'needs_intent_reclassification') {
      sessionContextService.updateContext(sessionId, {
        currentSkill: undefined,
        currentSystem: undefined,
        currentTopic: undefined,
        tempVariables: new Map(),
      } as any);
      console.log(`[MainAgent] 🔄 检测到用户回复与当前任务无关，重新识别意图`);
      return this.processNormalRequirement(request.content, userId, sessionId, request, undefined);
    }

    // 正常完成 → 更新请求中的任务状态
    await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, task.id, {
      status: 'completed',
      result: skillData?.response || null,
    });

    // 检查是否所有任务都已完成，如果是则完成请求
    const updatedSession = await this.sessionStore.loadSession(userId, sessionId);
    const updatedRequest = updatedSession.requests.find(r => r.requestId === request.requestId);
    if (updatedRequest) {
      const allTasksDone = updatedRequest.tasks.every(t => t.status === 'completed' || t.status === 'failed');
      const noWaitingQuestions = !updatedRequest.tasks.some(t => t.status === 'waiting' && t.currentQuestion);
      if (allTasksDone && noWaitingQuestions) {
        // 单任务直接用子智能体的结果，多任务由上层 summarizeResults 处理
        const taskCount = updatedRequest.tasks.length;
        if (taskCount === 1) {
          const taskResult_text = skillData?.response || '';
          await this.sessionStore.completeRequest(userId, sessionId, request.requestId, taskResult_text);
        }
        // 多任务时不在这里 completeRequest，由上层 processNormalRequirement 的 summarizeResults 处理
      }
    }

    return taskResult;
  }

  // ============================================================================
  // Plan-Execute-Summarize: 任务图构建、参数解析、分层执行
  // ============================================================================

  /**
   * 从 TaskPlan 构建 TaskGraph（拓扑排序分层）
   *
   * 将 IntentRouter/UnifiedPlanner 输出的 TaskPlan 转换为 TaskGraph，
   * 计算任务间的依赖关系并分层，支持串行/并行混合执行。
   */
  private buildTaskGraph(plan: TaskPlan): TaskGraph {
    const nodes: TaskGraphNode[] = plan.tasks.map(t => ({
      taskId: `${plan.id}-${t.id}`,
      content: t.requirement,
      skillName: t.skillName,
      dependencies: t.dependencies.map(depId => `${plan.id}-${depId}`),
      params: t.params || {},
    }));

    // 拓扑排序 + 分层（Kahn 算法变体）
    const inDegree = new Map<string, number>();
    const nodeMap = new Map<string, TaskGraphNode>();
    const dependents = new Map<string, string[]>();

    for (const node of nodes) {
      nodeMap.set(node.taskId, node);
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
      // 找出所有入度为 0 的节点
      const readyNodes = nodes.filter(
        n => !processed.has(n.taskId) && (inDegree.get(n.taskId) || 0) === 0
      );

      if (readyNodes.length === 0) {
        // 存在循环依赖，将剩余节点放入同一层
        console.warn(`[MainAgent] ⚠️ 检测到循环依赖，将剩余 ${nodes.length - processed.size} 个任务放入同一层`);
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

    console.log(`[MainAgent] 📊 TaskGraph 构建: ${nodes.length} 个节点, ${layers.length} 层`);
    for (let i = 0; i < layers.length; i++) {
      console.log(`  Layer ${i}: [${layers[i].join(', ')}]`);
    }

    return { id: plan.id, requirement: plan.requirement, nodes, layers };
  }

  /**
   * 解析参数引用
   *
   * 将参数中的 $taskId.result 引用替换为上游任务的实际结果。
   * 例如: { classes: "$plan-123-task-1.result" } → { classes: "[{name: '一班', ...}]" }
   */
  private resolveParams(
    params: Record<string, unknown> | undefined,
    completedResults: Map<string, any>,
  ): Record<string, unknown> {
    if (!params) return {};

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        // 解析 $taskId.result 或 $taskId.result.field
        const match = value.match(/^\$([^.]+)\.result(?:\.(.+))?$/);
        if (match) {
          const refTaskId = match[1];
          const field = match[2];
          const refResult = completedResults.get(refTaskId);
          if (refResult !== undefined) {
            const data = (refResult as any)?.data || refResult;
            if (field) {
              resolved[key] = field.split('.').reduce((obj: any, f: string) => obj?.[f], data);
            } else {
              resolved[key] = typeof data === 'string' ? data : JSON.stringify(data);
            }
            console.log(`[MainAgent] 🔗 参数解析: ${key} = $${refTaskId}.result${field ? '.' + field : ''}`);
          } else {
            console.warn(`[MainAgent] ⚠️ 参数引用未找到: ${value} (任务 ${refTaskId} 尚未完成)`);
            resolved[key] = value; // 保留原始引用
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
   * 分层执行任务图
   *
   * 按拓扑排序的层级执行任务：
   * - 同一层内的任务并行执行
   * - 层与层之间串行（上层完成后才执行下层）
   * - 上游任务的结果通过 $taskId.result 传递给下游任务
   * - 支持等待用户输入时保存进度
   */
  private async executeTaskGraph(
    graph: TaskGraph,
    sessionId: string,
    userId: string,
    request: Request,
  ): Promise<TaskResult> {
    const completedResults: Map<string, any> = new Map();
    const allResults: Array<{ taskId: string; skillName: string; requirement: string; result: any }> = [];

    for (let layerIdx = 0; layerIdx < graph.layers.length; layerIdx++) {
      const layer = graph.layers[layerIdx];
      console.log(`[MainAgent] 🚀 执行 Layer ${layerIdx}: ${layer.length} 个任务`);

      // 同一层内的任务并行执行
      const layerPromises = layer.map(async (taskId) => {
        const node = graph.nodes.find(n => n.taskId === taskId)!;

        // 解析参数引用
        const resolvedParams = this.resolveParams(node.params, completedResults);

        // 创建 TaskQueue 任务
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
        };

        this.taskQueue.addTask(task);

        // 等待任务完成
        return new Promise<{ taskId: string; result: any; status: string }>((resolve) => {
          const checkTask = () => {
            const t = this.taskQueue.getTask(taskId);
            if (!t) {
              resolve({ taskId, result: null, status: 'lost' });
              return;
            }
            if (t.status === 'completed' || t.status === 'failed') {
              resolve({ taskId, result: t.result, status: t.status });
              return;
            }
          };

          this.taskQueue.on('task-completed', checkTask);
          this.taskQueue.on('task-failed', checkTask);

          const timeout = setTimeout(() => {
            this.taskQueue.off('task-completed', checkTask);
            this.taskQueue.off('task-failed', checkTask);
            resolve({ taskId, result: null, status: 'timeout' });
          }, CONFIG.TASK_TIMEOUT_MS);

          // 立即检查一次（可能已完成）
          checkTask();

          // 包装 resolve 以清理监听
          const origResolve = resolve;
          const wrappedResolve = (value: { taskId: string; result: any; status: string }) => {
            clearTimeout(timeout);
            this.taskQueue.off('task-completed', checkTask);
            this.taskQueue.off('task-failed', checkTask);
            origResolve(value);
          };

          // 重新绑定
          this.taskQueue.off('task-completed', checkTask);
          this.taskQueue.off('task-failed', checkTask);
          const wrappedCheck = () => {
            const t = this.taskQueue.getTask(taskId);
            if (!t) { wrappedResolve({ taskId, result: null, status: 'lost' }); return; }
            if (t.status === 'completed' || t.status === 'failed') {
              wrappedResolve({ taskId, result: t.result, status: t.status });
            }
          };
          this.taskQueue.on('task-completed', wrappedCheck);
          this.taskQueue.on('task-failed', wrappedCheck);
          wrappedCheck();
        });
      });

      const layerResults = await Promise.all(layerPromises);

      // 处理本层结果
      for (const { taskId, result, status } of layerResults) {
        const node = graph.nodes.find(n => n.taskId === taskId)!;

        if (status === 'completed' && result) {
          completedResults.set(taskId, result);
          allResults.push({
            taskId,
            skillName: node.skillName,
            requirement: node.content,
            result,
          });

          // 检查是否需要用户输入
          const skillData = (result as any)?.data;
          if (skillData?.status === 'waiting_user_input' && skillData.question) {
            console.log(`[MainAgent] ⏸️ 任务 ${taskId} 等待用户输入，暂停后续层级执行`);

            // 保存执行进度
            request.executionProgress = {
              currentLayerIndex: layerIdx + 1,
              completedResults: Object.fromEntries(completedResults),
              taskGraph: graph,
            };

            // 返回等待用户输入的结果（由调用方处理 QAEntry 创建）
            return {
              success: true,
              data: {
                planId: graph.id,
                results: allResults,
                waitingTaskId: taskId,
              },
            };
          }
        } else if (status === 'failed') {
          console.error(`[MainAgent] ❌ 任务 ${taskId} 执行失败`);
          return {
            success: false,
            error: result?.error || { type: 'FATAL', message: `任务 ${taskId} 执行失败`, code: 'TASK_FAILED' },
          };
        } else {
          console.error(`[MainAgent] ❌ 任务 ${taskId} 状态异常: ${status}`);
          return {
            success: false,
            error: { type: 'FATAL', message: `任务 ${taskId} ${status}`, code: `TASK_${status.toUpperCase()}` },
          };
        }
      }

      console.log(`[MainAgent] ✅ Layer ${layerIdx} 完成 (${layer.length}/${layer.length})`);
    }

    // 所有层执行完毕
    console.log(`[MainAgent] ✅ TaskGraph 全部执行完成 (${allResults.length} 个任务)`);
    return {
      success: true,
      data: {
        planId: graph.id,
        results: allResults,
      },
    };
  }

  async monitorAndReplan(plan: TaskPlan, sessionId?: string, userId?: string, _request?: Request): Promise<TaskResult> {
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
      if (failedTasks.length === 0) return result;

      const errors = failedTasks.map((t) => t.error!).filter(Boolean);
      const allRetryable = errors.every((e) => e.type === "RETRYABLE");

      if (!allRetryable) {
        const fatalError = errors.find((e) => e.type !== "RETRYABLE");
        return { success: false, error: fatalError || errors[0] };
      }

      if (replanAttempts >= this.maxReplanAttempts) {
        return { success: false, error: { type: "FATAL", message: `Max replan attempts (${this.maxReplanAttempts}) exceeded`, code: "MAX_REPLAN_EXCEEDED" } };
      }

      replanAttempts++;
      currentPlan = await this.replan(currentPlan, errors);
    }

    return { success: false, error: { type: "FATAL", message: "Unexpected end of replan loop", code: "UNEXPECTED" } };
  }

  private submitPlanTasks(plan: TaskPlan, sessionId?: string, userId?: string): void {
    console.log(`[MainAgent] 📤 向任务队列提交 ${plan.tasks.length} 个任务`);
    for (const taskDef of plan.tasks) {
      const uniqueTaskId = `${plan.id}-${taskDef.id}`;
      const updatedDependencies = taskDef.dependencies.map((depId) => `${plan.id}-${depId}`);

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
        const planTasks = allTasks.filter((t) => t.id.startsWith(planId) && t.skillName);

        if (planTasks.length === 0) {
          resolve({ success: true, data: { planId, results: [] } });
          return;
        }

        const allCompleted = planTasks.every((t) => t.status === "completed" || t.status === "failed");

        if (allCompleted) {
          const failedTasks = planTasks.filter((t) => t.status === "failed");
          if (failedTasks.length === 0) {
            const results = planTasks.filter((t) => t.status === "completed").map((t) => ({
              taskId: t.id, skillName: t.skillName, requirement: t.requirement, result: t.result,
            }));
            console.log(`[MainAgent] ✅ 所有任务执行完成 (${results.length}/${planTasks.length})`);
            resolve({ success: true, data: { planId, results } });
          } else {
            resolve({ success: false, error: failedTasks[0].error });
          }
        }
      };

      const onDone = () => checkCompletion();
      this.taskQueue.on('task-completed', onDone);
      this.taskQueue.on('task-failed', onDone);

      const timeoutHandle = setTimeout(() => {
        this.taskQueue.off('task-completed', onDone);
        this.taskQueue.off('task-failed', onDone);
        resolve({ success: false, error: { type: 'RETRYABLE', message: 'timeout', code: 'TIMEOUT' } });
      }, CONFIG.TOTAL_TIMEOUT_MS);

      const originalResolve = resolve;
      const wrappedResolve = (value: TaskResult) => {
        clearTimeout(timeoutHandle);
        this.taskQueue.off('task-completed', onDone);
        this.taskQueue.off('task-failed', onDone);
        originalResolve(value);
      };

      const wrappedCheck = () => {
        const allTasks = this.taskQueue.getAllTasks();
        const planTasks = allTasks.filter((t) => t.id.startsWith(planId) && t.skillName);
        if (planTasks.length === 0) {
          wrappedResolve({ success: true, data: { planId, results: [] } });
          return;
        }
        const allCompleted = planTasks.every((t) => t.status === "completed" || t.status === "failed");
        if (allCompleted) {
          const failedTasks = planTasks.filter((t) => t.status === "failed");
          if (failedTasks.length === 0) {
            const results = planTasks.filter((t) => t.status === "completed").map((t) => ({
              taskId: t.id, skillName: t.skillName, requirement: t.requirement, result: t.result,
            }));
            console.log(`[MainAgent] ✅ 所有任务执行完成 (${results.length}/${planTasks.length})`);
            wrappedResolve({ success: true, data: { planId, results } });
          } else {
            wrappedResolve({ success: false, error: failedTasks[0].error });
          }
        }
      };

      this.taskQueue.off('task-completed', onDone);
      this.taskQueue.off('task-failed', onDone);
      const wrappedOnDone = () => wrappedCheck();
      this.taskQueue.on('task-completed', wrappedOnDone);
      this.taskQueue.on('task-failed', wrappedOnDone);
      wrappedCheck();
    });
  }

  private getFailedTasks(plan: TaskPlan): Task[] {
    return plan.tasks.map((t) => this.taskQueue.getTask(`${plan.id}-${t.id}`)).filter((t): t is Task => t !== undefined && t.status === "failed");
  }

  private static replanCounter = 0;

  private async replan(failedPlan: TaskPlan, errors: TaskError[]): Promise<TaskPlan> {
    const allSkills = this.skillRegistry.getAllMetadata();
    const systemPrompt = buildReplanPrompt(allSkills);
    const errorSummary = errors.map((e) => `- ${e.type}: ${e.message}${e.code ? ` (${e.code})` : ""}`).join("\n");
    const prompt = `原始需求: "${failedPlan.requirement}"\n失败原因:\n${errorSummary}\n\n之前有 ${failedPlan.tasks.length} 个任务。创建新计划。`;

    try {
      const newPlan = await this.llm.generateStructured(prompt, TaskPlanSchema, systemPrompt);
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
