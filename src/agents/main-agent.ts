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
import { SessionGate, QueueFullError } from "./session-gate";
import { requestLifecycle } from "../events/request-lifecycle";
import { taskEvents } from "../events/task-events";
import { BusinessError, AppError, SkillError } from '../errors';
import { slaTracker, reportSlaBreach } from '../observability/sla-watcher';
import { CONFIG } from '../types';
import type { EmployeeRegistry } from './employee/registry';
import type { EmployeeAgent } from './employee/agent';
import { routeIntentToEmployee } from './employee/router';
import { computeAllowedTools } from './employee/tools';

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
  /** 进程级员工注册表,启动期一次性 register,运行期只读 */
  employeeRegistry: EmployeeRegistry;
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
  private gate: SessionGate;
  /** 进程级员工注册表。MainAgent 不再持有单一 employee,运行期通过 routeIntentToEmployee 选择。 */
  private employeeRegistry: EmployeeRegistry;

  constructor(deps: MainAgentDependencies) {
    const {
      llm, skillRegistry, taskQueue,
      intentRouter, userProfileService, memoryService,
      dynamicContextBuilder,
      sessionStore, askAgent,
      systemSkillLoader, executorRegistry,
      employeeRegistry,
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

    if (!employeeRegistry) {
      throw new Error('MainAgent: employeeRegistry is required');
    }
    this.employeeRegistry = employeeRegistry;

    // resultAggregator 需要 processNormalRequirement 回调,循环依赖 → MainAgent 内创建
    // P5: ResultAggregator 注入 transferHook(本期 noop)
    // TODO(Task 13): 接外部工单系统时实现真实 hook
    // T7: ResultAggregator 持有 EmployeeRegistry,按 task.employeeId 在汇总阶段选 rewriter。
    const transferHook: import('./result-aggregator').TransferToHumanHook = (_results) => {
      // noop — 等真实转人工实现
      return false;
    };

    this.resultAggregator = new ResultAggregator(
      llm, memoryService, sessionStore,
      (request, userId, sessionId) =>
        this.processNormalRequirement(request.content, userId, sessionId, request, undefined, undefined, 1),
      this.employeeRegistry,
      transferHook,
    );
    this.gate = new SessionGate(sessionStore);
    // Rebuild TaskGraphExecutor with the checkpoint callback wired to onTaskGraphCheckpoint.
    this.taskGraphExecutor = new TaskGraphExecutor(taskQueue, this.resultAggregator, sessionStore, {
      onCheckpoint: (info) => this.onTaskGraphCheckpoint(info),
    });
  }

  /**
   * 判断新请求是否应作为 steer 注入(而非走 gate 队列)。
   *
   * 条件:
   *  - session 有 activeRequestId
   *  - activeRequest.status === 'processing'
   *  - 至少一个 task status === 'running'(SubAgent 工具循环未结束,能消费 steer)
   *
   * waiting 状态不进 steer(走 continueRequest)。
   *
   * 取代原 getSessionStore() 暴露,封装边界清晰。
   */
  async shouldSteer(userId: string, sessionId: string): Promise<boolean> {
    try {
      const session = await this.sessionStore.loadSession(userId, sessionId);
      if (!session.activeRequestId) return false;
      const activeReq = session.requests.find(r => r.requestId === session.activeRequestId);
      if (activeReq?.status !== 'processing') return false;
      return !!activeReq.tasks?.some(t => t.status === 'running');
    } catch (err) {
      MainAgent.log.warn('shouldSteer 判定失败,返回 false', { error: (err as Error).message });
      return false;
    }
  }

  /**
   * 提前执行 gate 决策(fast,~ms)。API 层可借此判断是否需要 SSE 流。
   * - queueFull / queued: 调用方直接返回 JSON 状态码(503 / 202),不发 SSE
   * - proceed: 调用方可以立即 flushHeaders + emit start,再调 processRequirement
   *   此时 LLM 流式 reasoning 能实时通过 SSE 推到前端,不再黑屏
   *
   * 与 processRequirement 内的 gate 逻辑保持一致(都委托给 this.gate)。
   */
  async gateCheck(
    userId: string,
    sessionId: string,
    requirement: string,
    hasImage: boolean,
    options?: { skipGate?: boolean; draftId?: string },
  ): Promise<
    | { type: 'proceed' }
    | { type: 'queue_full'; pendingCount: number; draftId: string }
    | { type: 'queued'; draftId: string; position: number }
    | { type: 'continue_waiting' }
  > {
    if (options?.skipGate) {
      return { type: 'proceed' };
    }
    const effectiveSessionId = sessionId || userId;
    const draftId = options?.draftId ?? `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const decision = await this.gate.decide(userId, effectiveSessionId, {
      draftId, requirement, hasImage,
    });
    if (decision.type === 'queue') {
      const enqueuedAt = new Date().toISOString();
      try {
        const { position } = await this.gate.enqueue(userId, effectiveSessionId, {
          draftId, requirement, enqueuedAt, hasImage,
        });
        requestLifecycle.emit({ type: 'request_queued', draftId, position, enqueuedAt });
        return { type: 'queued', draftId, position };
      } catch (enqueueErr) {
        if (enqueueErr instanceof QueueFullError) {
          return { type: 'queue_full', pendingCount: enqueueErr.pendingCount, draftId };
        }
        throw enqueueErr;
      }
    }
    if (decision.type === 'continue_waiting') {
      return { type: 'continue_waiting' };
    }
    return { type: 'proceed' };
  }

  async processRequirement(
    requirement: string,
    imageAttachment?: { data: Buffer; mimeType: string; originalName?: string },
    userId: string = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    sessionId?: string,
    options?: { planMode?: boolean; draftId?: string; skipGate?: boolean; gateChecked?: boolean; requestOverride?: Request },
  ): Promise<TaskResult & { queued?: boolean; queueFull?: boolean; pendingCount?: number; draftId?: string; position?: number }> {
    const effectiveSessionId = sessionId || userId;

    // SLA Watcher (Task 9): 跟踪整条 processRequirement 链路耗时,超阈值时归因 + 审计告警。
    // 入口先以 placeholder ID 启动;拿到真实 requestId 后重新 start(用真实 ID 替换);
    // finally 块统一清理 / 归因。activeSlaId 在闭包内可变,inner 会切换到真实 ID。
    const slaRequestId = `req-sla-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let activeSlaId: string = slaRequestId;
    const switchSlaId = (newId: string): void => {
      slaTracker.clear(slaRequestId);
      slaTracker.start(newId, CONFIG.SLA_REQUEST_MS);
      activeSlaId = newId;
    };
    slaTracker.start(slaRequestId, CONFIG.SLA_REQUEST_MS);
    try {
      return await this._processRequirementInner(
        requirement, imageAttachment, userId, sessionId, effectiveSessionId, options, switchSlaId,
      );
    } finally {
      // SLA 收尾:check 当前 active ID(可能是 placeholder 或真实 requestId),超阈值归因 + 清理。
      const check = slaTracker.check(activeSlaId);
      slaTracker.clear(activeSlaId);
      if (check.breached) {
        reportSlaBreach(activeSlaId, 'REQUEST', check.elapsedMs, check.slaMs);
      }
    }
  }

  /**
   * processRequirement 内部实现,由外层 try/finally 包裹以保证 SLA 收尾。
   * 拆分原因:processRequirement 内部多 return 路径,直接套 try/finally 会破坏现有结构;
   * 抽出后 finally 由外层统一执行,任何 return / throw 都触发。
   */
  private async _processRequirementInner(
    requirement: string,
    imageAttachment: { data: Buffer; mimeType: string; originalName?: string } | undefined,
    userId: string,
    sessionId: string | undefined,
    effectiveSessionId: string,
    options: { planMode?: boolean; draftId?: string; skipGate?: boolean; gateChecked?: boolean; requestOverride?: Request } | undefined,
    switchSlaId: (newId: string) => void,
  ): Promise<TaskResult & { queued?: boolean; queueFull?: boolean; pendingCount?: number; draftId?: string; position?: number }> {

    // Gate: if the session already has an active request, queue this one.
    // Skip when the caller is the queue/merge pipeline itself (spawnMergedRequest)
    // — the merged R2 is already the active request by the time it runs, so the
    // gate would queue it again as a self-enqueue.
    // Also skip when gateChecked=true — API layer has already run gateCheck() and
    // committed to the proceed path (SSE headers already flushed). Re-running
    // here would race against any newly-arrived requests and waste the early-flush.
    if (!options?.skipGate && !options?.gateChecked) {
      const draftId = options?.draftId ?? `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const decision = await this.gate.decide(userId, effectiveSessionId, {
        draftId, requirement, hasImage: !!imageAttachment,
      });
      if (decision.type === 'queue') {
        const enqueuedAt = new Date().toISOString();
        try {
          const { position } = await this.gate.enqueue(userId, effectiveSessionId, {
            draftId, requirement, enqueuedAt, hasImage: !!imageAttachment,
          });
          requestLifecycle.emit({ type: 'request_queued', draftId, position, enqueuedAt });
          return { success: true, queued: true, draftId, position, data: undefined as any };
        } catch (enqueueErr) {
          if (enqueueErr instanceof QueueFullError) {
            return {
              success: false,
              queueFull: true,
              pendingCount: enqueueErr.pendingCount,
              draftId,
              data: undefined as any,
            };
          }
          throw enqueueErr;
        }
      }
      if (decision.type === 'continue_waiting') {
        // Fall through to existing AskAgent.handleUserInput path which routes to continueRequest.
      }
    }

    // userId/sessionId 由 TaskGraphExecutor 通过 onCheckpoint info 透传,
    // 不再需要实例级 _lastSeen* 共享字段(避免多 session 并发时上下文覆盖)。

    // Top-level: no catch — let AppError propagate to API middleware.
    // (Known failures throw AppError explicitly in inner methods.)
    MainAgent.log.info('收到用户请求', { requirement });

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
        MainAgent.log.warn('恢复会话上下文失败', { error });
      }
    }

    // L1 + L4 同步写入(替代旧的双写)
    try {
      await this.memoryService.saveUserMessage(userId, effectiveSessionId, requirement);
    } catch (e) { MainAgent.log.error('保存用户消息到记忆失败', { error: e }); }

    // ===== Employee routing =====
    // 员工由 EmployeeRegistry 统一持有,由 routeIntentToEmployee(intentResult, registry)
    // 在意图分类之后选出(LLM 返回 employeeId → registry 命中,否则静默兜底到
    // registry.defaultFallback())。MainAgent 不再绑定单一 this.employee。
    // 选中的 employee 提供 persona / tools / skillWhitelist / decompositionHint,
    // 由 injectEmployeeContext 写入每个 plan task(employeeId / allowedTools /
    // _personaContext),TaskGraphExecutor 据 task.employeeId 绑定实际 executor。
    // executeTaskGraph 不再需要 executorFactory(EmployeeRegistry 接管路由)。

    // ========== 步骤 1: 图片分析 ==========
    if (imageAttachment) {
      MainAgent.log.info('附件信息', { originalName: imageAttachment.originalName, mimeType: imageAttachment.mimeType });
      try {
        const VisionLLMClient = (await import("./vision-client.js")).VisionLLMClient;
        const visionClient = new VisionLLMClient();
        const visionResult = await visionClient.analyzeImage(
          imageAttachment.data.toString("base64"),
          imageAttachment.mimeType,
        );
        MainAgent.log.info('视觉分析完成', { system: visionResult.system });
        requirement = `${requirement}\n\n[图片分析结果]\n系统: ${visionResult.system || "未知"}\n错误类型: ${visionResult.errorType || "未知"}\n描述: ${visionResult.description}\n建议操作: ${visionResult.suggestedAction || "无"}`;
      } catch (visionError) {
        MainAgent.log.error('视觉分析失败', { error: visionError });
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

      MainAgent.log.info('执行系统命令', { cmdName, executor: systemSkill.executor });
      const result = await executor.execute(systemSkill, { requirement });

      return {
        success: result.success,
        data: result.success ? { response: result.message || '执行完成', data: result.data } : undefined,
        error: result.success ? undefined : { type: 'FATAL' as const, message: result.error || '执行失败', code: 'EXECUTION_ERROR' },
      };
    }

    // ========== 步骤 2: AskAgent 处理用户输入 ==========
    // requestOverride: when the caller already created a Request (e.g. spawnMergedRequest
    // pre-creating R2 with merged content), skip askAgent.handleUserInput's createRequest
    // step and use the provided request directly. Without this, the merged flow would
    // create a duplicate R3 and orphan R2.
    const handleResult = options?.requestOverride
      ? { type: 'new_request' as const, request: options.requestOverride }
      : await this.askAgent.handleUserInput(userId, effectiveSessionId, requirement);
    MainAgent.log.info('AskAgent 结果', { type: handleResult.type });

    // SLA Watcher (Task 9): 替换为真实 requestId,以便最终归因/审计携带可追溯 ID。
    // 旧 placeholder 立即 clear(避免泄漏到 records Map),并按真实 ID 重新 start。
    // HandleResult 是 discriminated union,只有 continue/new_request/recall_prompt 有 request。
    const realRequestId =
      handleResult.type === 'continue' || handleResult.type === 'new_request' || handleResult.type === 'recall_prompt'
        ? handleResult.request?.requestId
        : undefined;
    if (realRequestId) {
      switchSlaId(realRequestId);
    }

    switch (handleResult.type) {
      case 'continue':
        // 用户回复了等待的问题，继续执行
        return this.continueRequest(userId, effectiveSessionId, handleResult.request, handleResult.question);

      case 'new_request':
        // 新请求，走正常流程。
        return this.processNormalRequirement(
          requirement, userId, effectiveSessionId, handleResult.request,
          imageAttachment, options,
        );

      case 'recall_prompt':
      case 'no_action':
        return {
          success: false,
          error: { type: 'FATAL', message: '未知的处理结果类型', code: 'UNKNOWN_HANDLE_RESULT' },
        };
    }
    // Exhaustiveness check: if a new HandleResult.type variant is added,
    // TypeScript will fail compilation here.
    const _exhaustive: never = handleResult;
    void _exhaustive;
  }

  /**
   * 获取会话历史记录（供前端恢复对话使用）
   */
  async getSessionHistory(userId: string, sessionId: string): Promise<{
    exists: boolean;
    messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string; type?: string }>;
    activeRequestId: string | null;
    requestStatus: string | null;
    /**
     * 每个 request 的 executionProgress(若有),用于复盘完整 DAG。
     * Key 是 requestId,值含 taskGraph/layers/completedResults。
     * 与 traceId 配合可在 DevTools 中串联多任务全链路。
     */
    executionProgress?: Record<string, {
      currentLayerIndex: number;
      totalLayers: number;
      taskGraph: { id: string; layers: string[][]; nodes: Array<{ taskId: string; content: string; skillName: string | null }> };
    }>;
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

      // 汇总 executionProgress(每个 request 一份,若有)
      const executionProgress: Record<string, any> = {};
      for (const req of session.requests) {
        if (req.executionProgress?.taskGraph) {
          executionProgress[req.requestId] = {
            currentLayerIndex: req.executionProgress.currentLayerIndex,
            totalLayers: req.executionProgress.taskGraph.layers.length,
            taskGraph: {
              id: req.executionProgress.taskGraph.id,
              layers: req.executionProgress.taskGraph.layers,
              nodes: req.executionProgress.taskGraph.nodes.map(n => ({
                taskId: n.taskId,
                content: n.content,
                skillName: n.skillName,
              })),
            },
          };
        }
      }

      return {
        exists: true,
        messages,
        activeRequestId: session.activeRequestId,
        requestStatus: activeRequest?.status || null,
        executionProgress: Object.keys(executionProgress).length > 0 ? executionProgress : undefined,
      };
    } catch (error) {
      MainAgent.log.error('[MainAgent] 获取会话历史失败', { error });
      if (error instanceof AppError) throw error;
      throw new BusinessError('SESSION_HISTORY_FAILED', 'Failed to load session history', { cause: error });
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
    MainAgent.log.info('继续执行请求', { requestId: request.requestId, question: question.content, answer: question.answer, taskId: question.taskId, source: question.source });

    // 找到关联的任务（如果有）
    const taskEntry = question.taskId
      ? request.tasks.find(t => t.taskId === question.taskId)
      : null;

    MainAgent.log.info('任务关联', { taskEntryId: taskEntry?.taskId, requestTasks: request.tasks.map(t => `${t.taskId}(status=${t.status})`).join(', ') });

    if (taskEntry) {
      // 检查是否有断点续传的执行进度
      if (request.executionProgress) {
        MainAgent.log.info('检测到执行进度，从断点恢复', { layerIndex: request.executionProgress.currentLayerIndex });
        return this.resumeFromBreakpoint(userId, sessionId, request, question);
      }

      // 子智能体任务需要继续执行
      const task = this.taskQueue.getTask(taskEntry.taskId);
      if (!task) {
        // TaskQueue 是内存的，服务器重启后队列为空。
        // 从 SessionStore 持久化数据重建 Task 对象并恢复执行。
        MainAgent.log.warn('任务在 TaskQueue 中不存在，从持久化数据重建', { taskId: taskEntry.taskId });

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
          MainAgent.log.info('自动填充参数', { paramName, value: question.answer });
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

        MainAgent.log.info('任务已重建并继续', { taskId: taskEntry.taskId });
        return this.pollTaskCompletion(reconstructed.id, userId, sessionId, request);
      }

      // 自动填充参数（如果 question 包含 paramName）
      const paramName = question.metadata?.paramName as string | undefined;
      if (paramName && question.answer) {
        task.params = task.params || {};
        task.params[paramName] = question.answer;
        MainAgent.log.info('自动填充参数', { paramName, value: question.answer });
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

      MainAgent.log.info('任务已准备继续', { taskId: taskEntry.taskId, questionHistoryCount: task.questionHistory.length });

      const ctxLen = task.conversationContext?.length ?? 0;
      MainAgent.log.info('任务上下文状态', { conversationContextEntries: ctxLen, completedToolCalls: task.completedToolCalls?.length ?? 0 });

      this.taskQueue.triggerProcess();
      return this.pollTaskCompletion(taskEntry.taskId, userId, sessionId, request);
    }

    // 主智能体自己的询问（如 confirm_system），需要重新识别意图并派发任务
    // 将用户回答保存到记忆，然后直接传递原始需求 — 避免在 enrichedRequirement 中
    // 重复 Q&A（historyPrompt 会从记忆中加载完整对话上下文，包括本次问答）
    MainAgent.log.info('主智能体询问已回答，重新识别意图', { question: question.content.substring(0, 40), answer: question.answer });
    try {
      await this.memoryService.saveUserMessage(userId, sessionId, question.answer || '');
    } catch (e) { MainAgent.log.error('保存用户回答到记忆失败', { error: e }); }
    return this.processNormalRequirement(request.content, userId, sessionId, request, undefined, undefined, 1);
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
   * Checkpoint callback wired into TaskGraphExecutor. Invoked between task
   * graph layers. If the session has pending requests, drain them and spawn
   * a new merged request. The current request is marked 'checkpoint_reached'.
   *
   * The `info.requestId` from TaskGraphExecutor is a placeholder ('session-active')
   * that the executor doesn't have access to; we resolve the real current request
   * from `session.activeRequestId` instead.
   *
   * P0 闭环修复:当实际 spawn 了 R2 时,返回 `{ shouldStop: true }`,让 executeLayers
   * 立即中断后续 layer(否则 R1 与 R2 并发执行,产生竞争写 session 且 R1 永远停在
   * checkpoint_reached)。无 pending 时返回 undefined,保持原行为(R1 继续执行)。
   */
  private async onTaskGraphCheckpoint(info: {
    userId: string;
    sessionId: string;
    requestId: string;
    completedTaskIds: string[];
  }): Promise<{ shouldStop?: boolean } | void> {
    const { userId, sessionId } = info;
    if (!userId || !sessionId) {
      return undefined; // No session context — skip checkpoint.
    }

    const session = await this.sessionStore.loadSession(userId, sessionId);
    if (session.pendingRequests.length === 0) {
      return undefined; // Nothing to drain.
    }

    // Mark current request as checkpoint_reached
    const currentReq = session.requests.find(r => r.requestId === session.activeRequestId);
    if (currentReq) {
      currentReq.status = 'checkpoint_reached';
      currentReq.updatedAt = new Date().toISOString();
    }
    session.activeRequestId = null;
    await this.sessionStore.saveSession(userId, sessionId, session);

    // Clean up R1's pending tasks from TaskQueue. They will be re-planned by R2.
    // Tasks already completed (in info.completedTaskIds) are left alone — only
    // unstarted tasks are removed. This prevents stale side effects from firing
    // after R1 is closed.
    if (currentReq) {
      const completedSet = new Set(info.completedTaskIds);
      let removed = 0;
      for (const task of currentReq.tasks) {
        if (!completedSet.has(task.taskId) && task.status !== 'completed') {
          if (this.taskQueue.removePendingTask(task.taskId)) removed++;
        }
      }
      if (removed > 0) {
        MainAgent.log.info('checkpoint: removed R1 unstarted tasks', {
          requestId: currentReq.requestId,
          removed,
          completed: info.completedTaskIds.length,
        });
      }
    }

    // Emit checkpoint event with the real current requestId
    requestLifecycle.emit({
      type: 'request_checkpoint',
      requestId: currentReq?.requestId ?? info.requestId,
      checkpointAt: new Date().toISOString(),
      pendingCount: session.pendingRequests.length,
      completedTaskCount: info.completedTaskIds.length,
    });

    // Spawn merged
    await this.spawnMergedRequest(userId, sessionId, currentReq?.requestId ?? '', session.pendingRequests);

    // P0 闭环修复:R1 已在 checkpoint 让位给 R2,后续 layer 不应执行。
    // executeLayers 收到 shouldStop=true 后会立即中断,避免 R1 与 R2 并发写 session。
    return { shouldStop: true };
  }

  /**
   * Drain pending requests, build merged requirement, create a new Request,
   * emit request_spawned, and trigger processRequirement on the merged content.
   */
  private async spawnMergedRequest(
    userId: string,
    sessionId: string,
    parentRequestId: string,
    _pendingRequests: import('../types').PendingRequest[],
  ): Promise<void> {
    const drained = await this.gate.drain(userId, sessionId);
    if (drained.length === 0) return;

    const session = await this.sessionStore.loadSession(userId, sessionId);
    const parent = session.requests.find(r => r.requestId === parentRequestId);
    const parentContent = parent?.content ?? '';

    const mergedRequirement =
      parentContent +
      '\n\n---\n\n' +
      drained.map(p => p.requirement).join('\n\n---\n\n');

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    session.requests.push({
      requestId,
      content: mergedRequirement,
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      suspendedAt: null,
      suspendedReason: null,
      questions: [],
      currentQuestion: null,
      tasks: [],
      result: null,
    });
    session.activeRequestId = requestId;
    await this.sessionStore.saveSession(userId, sessionId, session);

    requestLifecycle.emit({
      type: 'request_spawned',
      requestId,
      parentRequestId,
      draftIds: drained.map(d => d.draftId),
      requirementPreview: mergedRequirement.substring(0, 200),
    });

    // Fire-and-forget: process the merged requirement.
    // skipGate: this is the merged R2, already the active request — the gate would
    // otherwise treat it as a fresh pending submission and self-enqueue it.
    // requestOverride: pass the pre-created R2 so processRequirement skips askAgent's
    // createRequest step (which would otherwise create a duplicate R3).
    //
    // The result/rejection both flow through `handleMergedCompletion`, which:
    //   - emits a `request_error` lifecycle event when R2 failed (so the original
    //     SSE stream receives the error even though its handler already returned 202)
    //   - clears session.activeRequestId so the session is ready for the next input
    //   - logs structured error info for ops visibility
    void this.processRequirement(mergedRequirement, undefined, userId, sessionId, {
      skipGate: true,
      requestOverride: session.requests[session.requests.length - 1],
    })
      .then(
        (result) => this.handleMergedCompletion(userId, sessionId, requestId, parentRequestId, result, null),
        (err) => this.handleMergedCompletion(userId, sessionId, requestId, parentRequestId, null, err),
      );
  }

  /**
   * Handle R2 completion (success or failure). Emits a `request_error` event so
   * the original SSE stream learns about R2's failure, and clears
   * activeRequestId so the session is ready for the next input.
   */
  private async handleMergedCompletion(
    userId: string,
    sessionId: string,
    r2RequestId: string,
    parentRequestId: string,
    result: (TaskResult & { queued?: boolean; queueFull?: boolean; draftId?: string; position?: number }) | null,
    rejection: unknown,
  ): Promise<void> {
    // Distinguish: did R2 throw, or did it return a failure result?
    const failure = rejection
      ? { type: 'FATAL' as const, message: rejection instanceof Error ? rejection.message : String(rejection) }
      : (result && (result as any).success === false)
        ? (result as any).error ?? { type: 'FATAL' as const, message: 'unknown failure' }
        : null;

    if (!failure) {
      return; // R2 succeeded — normal completion path already wrote the session.
    }

    MainAgent.log.error('合并请求处理失败', {
      parentRequestId,
      newRequestId: r2RequestId,
      userId,
      sessionId,
      error: failure.message,
      type: failure.type,
      code: (failure as any).code,
      stack: rejection instanceof Error ? rejection.stack : undefined,
    });

    // Mark R2 as failed in session store
    try {
      const session = await this.sessionStore.loadSession(userId, sessionId);
      const r2 = session.requests.find(r => r.requestId === r2RequestId);
      if (r2) {
        r2.status = 'failed';
        r2.result = failure.message;
        r2.updatedAt = new Date().toISOString();
      }
      if (session.activeRequestId === r2RequestId) {
        session.activeRequestId = null;
      }
      await this.sessionStore.saveSession(userId, sessionId, session);
    } catch (sessionErr) {
      MainAgent.log.error('记录 R2 失败状态失败', { error: sessionErr });
    }

    // Emit lifecycle event so the API forwards it to the original SSE stream
    requestLifecycle.emit({
      type: 'request_error',
      requestId: r2RequestId,
      parentRequestId,
      error: {
        type: failure.type,
        code: (failure as any).code,
        message: failure.message,
      },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 把选中员工的上下文注入单个 plan task(原地修改并返回同一对象)。
   *
   * 单任务快路径与多任务 planner 路径共用此方法 —— 早期版本只在多任务循环里做注入,
   * 导致单任务请求的 task.employeeId 永远是 undefined,resolveExecutorForTask 一律
   * 回退到 registry.defaultFallback(),LLM 选出的员工被静默丢弃(白名单 / persona /
   * tools 同样失效)。
   *
   * 注入内容:
   *   1. skill 白名单校验(不合规直接抛 SkillError,派单前 fail-fast)
   *      - skillWhitelist 缺失 → 全部放行(向后兼容)
   *      - type === 'unrestricted' → 全部放行
   *      - type === 'allowlist'    → skillName 必须在 skills 列表里
   *      - 没有 skillName 的任务(IntentRouter 标注 unclear 等)直接放过
   *   2. employeeId —— TaskGraphExecutor 据此从 EmployeeRegistry 绑定 executor
   *   3. allowedTools —— skill 声明 ∩ 员工 ToolPolicy
   *   4. _personaContext —— 员工 persona 前缀 / style / boundaries
   *
   * 注意必须写回 plan.tasks[i] 本身:buildTaskGraph 从 plan.tasks 构建 TaskGraphNode,
   * 只挂在 RequestTask 上时 executeLayers 构造运行时 Task 拿不到这些字段。
   */
  private async injectEmployeeContext(
    taskDef: TaskPlan['tasks'][number],
    employee: EmployeeAgent,
  ): Promise<TaskPlan['tasks'][number]> {
    if (taskDef.skillName) {
      const whitelist = employee.config.capabilities.skillWhitelist;
      if (whitelist && whitelist.type === 'allowlist' && !whitelist.skills.includes(taskDef.skillName)) {
        MainAgent.log.warn('SKILL_NOT_ALLOWED: task 被员工策略拦截', {
          employeeId: employee.id,
          skillName: taskDef.skillName,
          whitelistType: whitelist.type,
        });
        throw new SkillError(
          'SKILL_NOT_ALLOWED',
          `skill "${taskDef.skillName}" 不在员工 "${employee.id}" 的白名单中`,
        );
      }
    }

    // 计算 task 的最终 allowedTools(skill 声明 ∩ 员工 tools 策略)
    //   1. skill metadata 优先(轻量);失败则降级到 loadFullSkill
    //   2. 员工 ToolPolicy(白/黑名单)叠加
    let skillAllowedTools: string[] | undefined;
    try {
      const meta = this.skillRegistry.getSkillMetadata?.(taskDef.skillName ?? '');
      skillAllowedTools = meta?.allowedTools;
    } catch {
      // ignore - fall through to loadFullSkill
    }
    if (!skillAllowedTools && taskDef.skillName) {
      try {
        const full = await this.skillRegistry.loadFullSkill?.(taskDef.skillName);
        skillAllowedTools = full?.allowedTools;
      } catch {
        // ignore
      }
    }
    const allowed = computeAllowedTools(skillAllowedTools, employee.config.capabilities.tools);

    // employee.personaPrefix 已经由 EmployeeAgent 在 getter 中完成 ${displayName} 模板替换
    const personaPrefix = employee.personaPrefix ?? '';
    taskDef._personaContext = personaPrefix
      ? {
          prefix: personaPrefix,
          style: employee.persona?.style,
          boundaries: employee.persona?.boundaries,
        }
      : undefined;
    taskDef.allowedTools = Array.from(allowed);
    taskDef.employeeId = employee.id;

    return taskDef;
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
      MainAgent.log.error('递归深度超过限制', { depth });
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
      MainAgent.log.debug('用户画像', { profile: Object.fromEntries(Object.entries(userProfile).filter(([, v]) => v !== undefined && v !== null)) });

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
      } catch (e) { MainAgent.log.error('召回记忆失败', { error: e }); }

      // ========== 加载活跃任务（防止重复分派）==========
      const activeTasksInSession = request.tasks.filter(t =>
        t.status !== 'completed' && t.status !== 'failed'
      );
      if (activeTasksInSession.length > 0) {
        MainAgent.log.info('活跃任务', { count: activeTasksInSession.length });
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
        MainAgent.log.info('Session 上下文已注入');
      }

      if (dynamicContext) {
        enrichedRequirement = dynamicContext + "\n\n" + enrichedRequirement;
      }

      // ========== 意图路由 ==========
      MainAgent.log.info('正在分类用户意图');

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
      } catch (e) { MainAgent.log.error('召回过程性记忆失败', { error: e }); }

      // Task 5: 路由选择 EmployeeAgent,后续 employee.X 替换 this.employee.X
      // IntentRouter.classify 同时接收 availableEmployees(LLM 据此选择 employeeId)
      // 注意:此处 classify 调用不传 persona/displayName,因为路由前不知道选哪个员工;
      // 路由后 employee.persona 已用于下游 _personaContext 注入。
      // persona system prompt 的缺失由后续迭代(把 classify 拆为「粗分类」+「细分类」)解决。
      const intentResult = await this.intentRouter.classify(
        requirement, userProfile, recentHistory, sessionId, proceduralExperience, userId,
        undefined,                                                    // persona 由 route 后的 employee 提供
        undefined,                                                    // displayName 同上
        this.employeeRegistry.listForLLM(),                           // Task 5: 新增第 9 参数
      );

      const employee = routeIntentToEmployee(intentResult, this.employeeRegistry);

      await hookManager.emit(HookEvent.AFTER_INTENT_CLASSIFY, {
        userId, sessionId, data: { intent: intentResult.intent, confidence: intentResult.confidence, tasks: intentResult.tasks }
      });

      MainAgent.log.info('意图分类结果', { intent: intentResult.intent, confidence: intentResult.confidence });

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

      // P2-1 修复:如果请求中包含 unclear 任务,整条请求转人工(不执行 skill 任务)
      // 旧行为:执行 skill 任务 + 在回复前加 "转人工" 前缀 → 用户看到一半结果一半转人工,语义混乱
      const shouldTransferToHuman = tasksWithSkill.length === 0 || hasTransferRequest;

      if (tasksWithSkill.length > 0 && !hasTransferRequest) {
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
      const tasksToExecute = hasTransferRequest ? [] : tasksWithSkill;

      if (shouldTransferToHuman) {
        assistantResponse = '抱歉，这个问题暂时超出了我的处理范围，我帮您转给人工客服处理。';
        try {
          await this.memoryService.saveAssistantMessage(userId, sessionId, assistantResponse);
        } catch (e) { MainAgent.log.error('保存非技能助手消息到记忆失败', { error: e }); }
        await this.sessionStore.completeRequest(userId, sessionId, request.requestId, assistantResponse);
        // 请求级摘要(异步,失败不阻塞)
        fireAndForget(
          this.memoryService.summarizeRequest({
            userId, sessionId, requestId: request.requestId,
            userMessage: requirement, assistantMessage: assistantResponse,
          }),
          'summarizeRequest (no-skill / hasTransferRequest)',
          (err) => MainAgent.log.error('请求摘要生成失败', { error: err }),
        );
        return { success: true, data: { message: assistantResponse, type: 'unclear' } };
      }

      if (tasksToExecute.length === 1) {
        // 单任务快路径:跳过 UnifiedPlanner(省一次 LLM),但员工上下文注入不能跳过 ——
        // employeeId / allowedTools / _personaContext 统一由下面的 injectEmployeeContext
        // 循环补齐(与多任务路径同一入口)。
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
        // Task 8: 传入 EmployeeAgent 实例,planner 内部读取 employee.decompositionHint
        // 并把 employee.id 写入每个 task 的 employeeId 字段。
        const planResult = await planner.plan(enrichedRequirement, employee);
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

      MainAgent.log.info('规划完成', { taskCount: plan.tasks.length });

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

      // 注册任务到请求中。
      // 派单前统一注入员工上下文(employeeId / allowedTools / _personaContext)并
      // 执行 skill 白名单校验 —— 单任务快路径与多任务 planner 路径都走这里,避免
      // 快路径漏注入导致所有单任务请求被路由到兜底员工。
      // 注:injectEmployeeContext 原地修改 plan.tasks[i],因为 buildTaskGraph 从
      // plan.tasks 构建 TaskGraphNode;RequestTask 上冗余保存一份用于持久化/兼容。
      for (const taskDef of plan.tasks) {
        const uniqueTaskId = `${plan.id}-${taskDef.id}`;

        await this.injectEmployeeContext(taskDef, employee);

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
          _personaContext: taskDef._personaContext,
          allowedTools: taskDef.allowedTools,
        };

        await this.sessionStore.addTaskToRequest(userId, sessionId, request.requestId, requestTask);
      }

      MainAgent.log.info('构建 TaskGraph 并执行');

      await hookManager.emit(HookEvent.BEFORE_TASK_EXECUTE, {
        userId, sessionId, data: { planId: plan.id, tasks: plan.tasks }
      });

      // 订阅 TaskQueue 内部事件,翻译为 TaskEvent(供 SSE 进度卡消费)
      // 必须在 buildTaskGraph 之前订阅,因为 executeTaskGraph 内部会立即 addTask 触发 task-started
      const offTaskEvents = this.setupTaskEventForwarding(
        request.requestId, plan.id, plan.tasks.length,
      );

      // 构建 TaskGraph 并分层执行
      const graph = this.buildTaskGraph(plan);
      let result: TaskResult;
      try {
        // Task 8: executeTaskGraph 不再接受 executorFactory,executor 改由 TaskQueue
        // 提供(Master 不再绑定具体 SubAgent 类型)。bootstrap 注入默认 SubAgent,
        // persona/tools 由 MainAgent 派单时注入。
        result = await this.executeTaskGraph(graph, sessionId, userId, request);
      } finally {
        offTaskEvents();
      }

      await hookManager.emit(HookEvent.AFTER_TASK_EXECUTE, {
        userId, sessionId, data: { planId: plan.id, success: result.success, result: result.data, error: result.error }
      });

      await this.updateProfileAfterRequest(userProfile, enrichedRequirement, userId);

      // 持久化 executionProgress(成功完成态,wating 路径由 task-graph-executor.ts 单独处理)
      // 让运维复盘时可通过 request.executionProgress.taskGraph 重建完整 DAG
      // currentLayerIndex = graph.layers.length 表示所有 layer 已完成
      const resultDataForProgress = result.data as any;
      const taskResultsForProgress = resultDataForProgress?.results || [];
      if (!resultDataForProgress?.mergedAway && taskResultsForProgress.length > 0) {
        try {
          const completedResultsMap: Record<string, any> = {};
          for (const tr of taskResultsForProgress) {
            completedResultsMap[tr.taskId] = tr.result;
          }
          await this.sessionStore.saveExecutionProgress(userId, sessionId, request.requestId, {
            currentLayerIndex: graph.layers.length,
            completedResults: completedResultsMap,
            taskGraph: graph,
          });
        } catch (progressErr) {
          // progress 持久化失败不影响主流程
          MainAgent.log.warn('executionProgress 持久化失败', { error: progressErr });
        }
      }

      // 检查是否有任务需要等待用户输入
      const resultData = result.data as any;
      // P5: 合并成功 + 失败 task,让下游 taskList / summarizeResults 看到完整状态
      // 修复:之前 taskResults 仅含成功 task,单 task 全失败时 taskList=[],
      //     导致走入"多任务空数组"分支,summarizeResults LLM 收到空上下文。
      const successResults = resultData?.results || [];
      const failedAsResults = (resultData?.failedTasks || []).map((t: any) => ({
        taskId: t.taskId,
        skillName: t.skillName || '',
        requirement: t.requirement || '',
        response: '',
        status: 'failed',
        error: t.error,
      }));
      const taskResults = [...successResults, ...failedAsResults];

      // P0 闭环修复:R1 在 checkpoint 让位给了 R2,跳过后续汇总 / completeRequest。
      // R1.result 保持现状(null),R1.status='checkpoint_reached' 由 onTaskGraphCheckpoint
      // 写入,R2 会基于 R1 的内容 + pending 重新规划并执行。
      if (resultData?.mergedAway) {
        MainAgent.log.info('R1 在 checkpoint 让位给 R2,跳过汇总', {
          requestId: request.requestId,
          completedLayerResults: taskResults.length,
        });
        // 设置 assistantResponse 占位,跳过 finally 中的 popLastAssistantMessage
        // (R1 此时尚未生成助手消息,无需 pop)
        assistantResponse = '[merged-into-r2]';
        return {
          success: true,
          data: {
            type: 'merged',
            requestId: request.requestId,
            results: taskResults,
          },
        };
      }

      // P5: 部分失败 → 不走 throw 路径,继续到汇总
      if (resultData?.hasPartialFailure) {
        MainAgent.log.info('部分任务失败,进入汇总阶段', {
          succeeded: resultData.results?.length || 0,
          failed: resultData.failedTasks?.length || 0,
          failedTaskIds: resultData.failedTasks?.map((t: any) => t.taskId) || [],
        });
        // 设置 result.success = true(因为请求本身没彻底失败),让汇总分支正常走
        result = { ...result, success: true };
      }

      // 检查 executeTaskGraph 返回的 waitingTaskId
      if (resultData?.waitingTaskId) {
        const waitingTaskId = resultData.waitingTaskId;
        const waitingResult = taskResults.find((tr: any) => tr.taskId === waitingTaskId);
        const skillResult = waitingResult?.result?.data;

        if (skillResult?.status === 'waiting_user_input') {
          // P2-2 防御:即使 question 缺失,也按 waiting 处理(不进入 completeRequest 路径),
          // 避免 request.status='completed' 与 task.status='waiting' 状态不一致。
          // 缺失 question 通常是子智能体 bug,我们用占位文本兜底,避免请求卡死或状态错乱。
          if (!skillResult.question) {
            MainAgent.log.error('子任务 waiting_user_input 但 question 缺失,使用占位文本', {
              waitingTaskId,
              skillResult,
            });
          }

          const effectiveQuestion = skillResult.question ?? {
            content: '(子任务请求输入但未提供问题内容)',
            metadata: undefined,
          };
          const effectiveSkillData = { ...skillResult, question: effectiveQuestion };
          const qaEntry = this.resultAggregator.createQAEntry(effectiveSkillData, waitingTaskId, waitingResult?.skillName || null);

          MainAgent.log.info('检测到子任务需要用户输入', { waitingTaskId, hasQuestion: !!skillResult.question });

          // 子智能体询问只放到任务级 questions，不放请求级
          // 同时保存断点续执行上下文（conversationContext 等），确保进程重启后可恢复
          const waitingTask = request.tasks.find(t => t.taskId === waitingTaskId);
          await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, waitingTaskId, {
            currentQuestion: qaEntry,
            status: 'waiting',
            questions: [...(waitingTask?.questions || []), qaEntry],
            conversationContext: waitingTask?.conversationContext,
            completedToolCalls: waitingTask?.completedToolCalls,
            executionProgress: waitingTask?.executionProgress,
          });

          // waiting 状态是断点关键点，立即刷盘（不走防抖），防止崩溃丢失上下文
          const session = await this.sessionStore.loadSession(userId, sessionId);
          await this.sessionStore.flushToDisk(userId, sessionId, session);

          try {
            await this.memoryService.saveAssistantMessage(userId, sessionId, qaEntry.content, {
              skillName: qaEntry.skillName || undefined,
            });
          } catch (e) { MainAgent.log.error('保存助手消息到记忆失败', { error: e }); }

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
        // Task 7: 透传 employeeId,ResultAggregator 据此选 per-employee rewriter
        employeeId: tr.employeeId,
      }));

      let finalResponse: string;
      let isCompleted = false;

      if (taskList.length === 1) {
        // 单任务：直接使用子智能体的结果，无需额外汇总
        MainAgent.log.info('单任务完成，跳过汇总，直接使用子智能体结果');
        finalResponse = taskList[0].response;
        if (!finalResponse) {
          finalResponse = JSON.stringify(result.data);
        }
        isCompleted = taskList[0].status !== 'failed'; // P5: 部分失败时不算完成

        // P5: 单任务也可能失败(TaskGraphExecutor 返回 failedTasks)
        const failedIds = (resultData?.failedTasks || []).map((t: any) => t.taskId);
        const isPartial = failedIds.length > 0;
        await this.sessionStore.completeRequest(userId, sessionId, request.requestId, finalResponse, {
          partialFailure: isPartial,
          failedTaskIds: isPartial ? failedIds : undefined,
        });
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

        // P5: 部分失败时,带 partialFailure 标志写入 completeRequest
        if (summary.failedTaskIds.length > 0) {
          try {
            await this.sessionStore.completeRequest(userId, sessionId, request.requestId, finalResponse, {
              partialFailure: true,
              failedTaskIds: summary.failedTaskIds,
            });
          } catch (e) {
            MainAgent.log.error('partial failure completeRequest 失败', { error: e });
          }
        }
      }

      // P2-1 修复:hasTransferRequest 已在前面短路返回,这里不再拼接 "转人工" 前缀
      // (旧行为会同时返回 skill 结果和转人工前缀,语义混乱)

      assistantResponse = finalResponse;
      try {
        await this.memoryService.saveAssistantMessage(userId, sessionId, assistantResponse, {
          skillName: taskList[0]?.skillName || undefined,
        });
      } catch (e) { MainAgent.log.error('保存助手消息到记忆失败', { error: e }); }
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
          type: 'skill_task',
          requestId: request.requestId,
          completed: isCompleted,
          summary: finalResponse,
        },
      };
    } catch (error) {
      MainAgent.log.error('处理普通需求失败', { error });
      await this.sessionStore.failRequest(userId, sessionId, request.requestId, error instanceof Error ? error.message : 'Unknown error');
      if (error instanceof AppError) {
        throw error;
      }
      throw new BusinessError('PROCESSING_FAILED', error instanceof Error ? error.message : 'Unknown error', { cause: error });
    } finally {
      // 回滚 L1 最后一条消息(如果未生成 assistantResponse)
      if (!assistantResponse) {
        try {
          await this.memoryService.popLastAssistantMessage(userId, sessionId);
        } catch (e) {
          MainAgent.log.error('移除最后助手消息失败', { error: e });
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
      } catch (e) { MainAgent.log.error('保存非技能助手消息到记忆失败', { error: e }); }
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
      } catch (e) { MainAgent.log.error('保存非技能助手消息到记忆失败', { error: e }); }

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
      } catch (e) { MainAgent.log.error('保存非技能助手消息到记忆失败', { error: e }); }
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
    } catch (e) { MainAgent.log.error('保存非技能助手消息到记忆失败', { error: e }); }
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
   *
   * P5: 返回 4 字段 — 包含 failedTaskIds / transferTriggered
   */
  private async summarizeResults(
    originalRequirement: string,
    taskResults: Array<{ taskId: string; skillName: string; requirement: string; response: string; status?: string }>,
    userId: string,
    sessionId: string,
    request: Request,
  ): Promise<{ completed: boolean; summary: string; failedTaskIds: string[]; transferTriggered: boolean }> {
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
   *
   * Task 8 起 executorFactory 移除 — executor 由 TaskQueue 默认提供。
   * TaskGraphExecutor.executeTaskGraph 仍保留该参数(向后兼容),此处不再传入。
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

  /**
   * 订阅 TaskQueue 内部事件,翻译为 TaskEvent 发射到 taskEvents 总线。
   *
   * 必须在 executeTaskGraph 之前调用,因为 executeLayers 会立即 addTask 触发 task-started。
   * 调用方负责在 finally 中调用返回的 unsubscribe 函数清理监听器
   * (避免多 session 并发时上下文泄漏 —— P1-1 教训)。
   *
   * @param requestId 当前请求 ID
   * @param planId 当前 plan ID(用于进度卡分组)
   * @param totalTasks plan 内任务总数(用于进度卡显示 N/M)
   */
  private setupTaskEventForwarding(
    requestId: string,
    planId: string,
    totalTasks: number,
  ): () => void {
    const startedListener = (e: { taskId: string; task: { requirement: string; skillName?: string | null } }) => {
      taskEvents.emit({
        type: 'task_started',
        requestId,
        planId,
        taskId: e.taskId,
        requirement: e.task.requirement,
        skillName: e.task.skillName ?? null,
        totalTasks,
        startedAt: new Date().toISOString(),
      });
    };

    const completedListener = (e: { taskId: string }) => {
      const task = this.taskQueue.getTask(e.taskId);
      const durationMs = task?.startedAt && task?.completedAt
        ? task.completedAt.getTime() - task.startedAt.getTime()
        : 0;
      taskEvents.emit({
        type: 'task_completed',
        requestId,
        planId,
        taskId: e.taskId,
        status: 'completed',
        durationMs,
      });
    };

    const failedListener = (e: { taskId: string; error?: { type?: string; code?: string; message?: string } }) => {
      const task = this.taskQueue.getTask(e.taskId);
      const durationMs = task?.startedAt && task?.completedAt
        ? task.completedAt.getTime() - task.startedAt.getTime()
        : 0;
      taskEvents.emit({
        type: 'task_failed',
        requestId,
        planId,
        taskId: e.taskId,
        status: 'failed',
        error: {
          type: e.error?.type ?? 'UNKNOWN',
          code: e.error?.code,
          message: e.error?.message ?? 'Unknown error',
        },
        durationMs,
      });
    };

    this.taskQueue.on('task-started', startedListener);
    this.taskQueue.on('task-completed', completedListener);
    this.taskQueue.on('task-failed', failedListener);

    return () => {
      this.taskQueue.off('task-started', startedListener);
      this.taskQueue.off('task-completed', completedListener);
      this.taskQueue.off('task-failed', failedListener);
    };
  }

  private async updateProfileAfterRequest(
    userProfile: { commonSystems: string[]; conversationCount: number },
    enrichedRequirement: string,
    userId: string,
  ): Promise<void> {
    const mentionedSystem = this.userProfileService.inferSystemFromText(enrichedRequirement);
    if (mentionedSystem && !userProfile.commonSystems.includes(mentionedSystem)) {
      MainAgent.log.info('更新用户画像: 新增系统', { system: mentionedSystem });
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
