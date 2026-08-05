import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { MainAgent } from '../agents/main-agent';
import { SkillRegistry } from '../skill-registry';
import { TaskQueue } from '../task-queue';
import { TaskStatus, CONFIG } from '../types';
import { llmEvents, ReasoningEvent } from '../llm';
import { requestLifecycle } from '../events/request-lifecycle';
import { taskEvents, TaskEvent } from '../events/task-events';
import { RequestContext } from '../context/request-context';
import { resolveResource } from '../utils/app-root';
import { traceIdMiddleware, globalErrorHandler, errorToResponse } from './error-handler';
import { BusinessError } from '../errors';
import { steeringBuffer } from '../memory/steering-buffer';
import { createLogger } from '../observability/logger';
import type { ApiResponse } from '../types/api-response';
import { UserProfileService } from '../user-profile';
import { guardrailMiddleware } from '../guardrail/middleware';
import { collectOtelMetrics } from '../observability/otel';

interface ImageAttachment {
  data: Buffer;
  mimeType: string;
  originalName?: string;
}

interface ApiError {
  error: string;
  message: string;
  code?: string;
}

interface SubmitTaskRequest {
  requirement: string;
  image?: string;
  userId?: string; // 可选，默认 'default'
  sessionId?: string; // 可选，默认使用 userId
  accessToken?: string; // 可选，透传给技能脚本的认证 token
  draftId?: string; // 可选，幂等键（与 Tasks 6 的 gate.queue 关联）
}

/**
 * Task status response
 */
interface TaskStatusResponse {
  taskId: string;
  status: TaskStatus;
  requirement: string;
  skillName?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
}

/**
 * Task result response
 */
interface TaskResultResponse {
  taskId: string;
  status: TaskStatus;
  result?: unknown;
  error?: {
    type: string;
    message: string;
    code?: string;
  };
}

/**
 * Skills list response
 */
interface SkillsResponse {
  skills: Array<{
    name: string;
    description: string;
    license?: string;
    compatibility?: string;
  }>;
}

/**
 * Health check response
 */
interface HealthResponse {
  status: string;
  timestamp: string;
}

/**
 * 从请求中提取 accessToken（兼容 Header 和参数两种方式）
 * 优先级：Header(accesstoken / Authorization) > Query > Body
 */
function extractAccessToken(req: Request): string | undefined {
  // 1. Header: accesstoken (case-insensitive)
  const headerToken = req.headers['accesstoken'] as string | undefined;
  if (headerToken) return headerToken;

  // 2. Header: Authorization: Bearer xxx
  const authHeader = req.headers['authorization'] as string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 3. Query parameter
  const queryToken = req.query.accessToken as string | undefined;
  if (queryToken) return queryToken;

  // 4. Body
  const bodyToken = (req.body as any)?.accessToken as string | undefined;
  if (bodyToken) return bodyToken;

  return undefined;
}

/**
 * Create Express HTTP API server
 */
const log = createLogger({ module: 'API' });

export function createAPIServer(
  mainAgent: MainAgent,
  skillRegistry: SkillRegistry,
  taskQueue: TaskQueue,
  // Optional to keep existing tests / callers that mock mainAgent working without
  // having to wire a profile service. When omitted, the guardrail middleware
  // falls back to a minimal `{ role: 'employee', permissions: [] }` profile,
  // which is correct (employee has no privileged access).
  userProfileService?: UserProfileService
): express.Application {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(traceIdMiddleware);

  // Rate limiting middleware - 10000 requests per minute per IP (high limit for capacity testing)
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10000,
    message: {
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
      code: 'RATE_LIMIT',
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  // Stricter rate limit for task submission - 1000 requests per minute per IP
  const taskLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 1000,
    message: {
      error: 'Too Many Requests',
      message: 'Task submission rate limit exceeded. Please try again later.',
      code: 'RATE_LIMIT',
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Static files middleware
  app.use(express.static(resolveResource('public')));

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      log.info('API 请求', { timestamp, method: req.method, path: req.path, statusCode: res.statusCode, duration });
    });

    next();
  });

  // ============================================================================
  // Health Check
  // ============================================================================
  app.get('/health', (_req: Request, res: Response<HealthResponse>) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // ============================================================================
  // Metrics API (Issue #11 + Task 11)
  // ============================================================================
  // 缺口 4.2:统一观测面板入口。
  // - task  ← TaskQueue 累计统计(完成/失败/超时/平均延迟/总耗时)
  // - otel  ← collectOtelMetrics() 浅拷贝 shadow buffer(LLM / Skill / Guardrail / SLA 共 10 个 metric)
  // - queueSize / runningCount 暂时保留为顶层字段供老探针使用,后续可在 SemVer 许可下迁入 task.{size,running}。
  app.get('/metrics', async (_req: Request, res: Response) => {
    try {
      const taskMetrics = taskQueue.getMetrics();
      const otelMetrics = await collectOtelMetrics();
      res.json({
        timestamp: new Date().toISOString(),
        task: {
          tasksCompleted: taskMetrics.tasksCompleted,
          tasksFailed: taskMetrics.tasksFailed,
          tasksTimedOut: taskMetrics.tasksTimedOut,
          averageExecutionTime: Math.round(taskMetrics.averageExecutionTime),
          totalExecutionTime: Math.round(taskMetrics.totalExecutionTime),
        },
        otel: otelMetrics,
        queueSize: taskQueue.getAllTasks().length,
        runningCount: taskQueue.getRunningCount(),
      });
    } catch (err) {
      log.error('Metrics collection failed', { error: (err as Error).message });
      res.status(500).json({ error: 'metrics collection failed' });
    }
  });

  // ============================================================================
  // Skills API
  // ============================================================================
  app.get('/skills', (_req: Request, res: Response<SkillsResponse>) => {
    const skills = skillRegistry.getAllMetadata();
    res.json({
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        license: skill.license,
        compatibility: skill.compatibility,
      })),
    });
  });

  // 获取会话历史记录（前端恢复对话使用）
  app.get('/sessions/:sessionId/history', async (req: Request, res: Response) => {
    // Express 5: req.params values can be string | string[]
    const sessionIdRaw = req.params.sessionId;
    const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;
    const userId = (req.query.userId as string) || 'default';

    if (!sessionId) {
      throw new BusinessError('INVALID_REQUEST', 'sessionId is required');
    }

    const history = await mainAgent.getSessionHistory(userId, sessionId);
    res.json({ success: true, data: history });
  });

  // ============================================================================
  // Tasks API
  // ============================================================================

  /**
   * List all tasks
   * GET /tasks
   */
  app.get(
    '/tasks',
    (req: Request<{}, {}, {}, { status?: string }>, res: Response<ApiResponse<{ tasks: Array<{ id: string; status: TaskStatus; requirement: string; createdAt: string }> }> | ApiError>) => {
      const { status } = req.query;
      const validStatuses: TaskStatus[] = ['pending', 'running', 'completed', 'failed', 'suspended'];

      // Validate status filter if provided
      if (status && !validStatuses.includes(status as TaskStatus)) {
        throw new BusinessError(
          'INVALID_STATUS_FILTER',
          `Invalid status filter. Must be one of: ${validStatuses.join(', ')}`,
        );
      }

      // Get tasks (filtered by status if provided)
      const tasks = status
        ? taskQueue.getTasksByStatus(status as TaskStatus)
        : taskQueue.getAllTasks();

      // Format response
      const formattedTasks = tasks.map((task) => ({
        id: task.id,
        status: task.status || 'pending',
        requirement: task.requirement,
        createdAt: task.createdAt?.toISOString() || new Date().toISOString(),
      }));

      res.json({ success: true, data: { tasks: formattedTasks } });
    }
  );

  /**
   * Submit a new task
   * POST /tasks
   */
  app.post(
    '/tasks',
    taskLimiter,
    async (
    req: Request<{}, {}, SubmitTaskRequest>,
    res: Response<ApiResponse<{ status: 'accepted'; message: string; userId: string }> | ApiError>
    ): Promise<void> => {
    const { requirement, userId } = req.body;
    const accessToken = extractAccessToken(req);

    // Validate request
    if (!requirement || typeof requirement !== 'string') {
      throw new BusinessError('INVALID_REQUEST', 'Missing or invalid "requirement" field');
    }

    if (requirement.length > CONFIG.MAX_REQUIREMENT_LENGTH) {
      throw new BusinessError(
        'REQUIREMENT_TOO_LONG',
        `Requirement exceeds maximum length of ${CONFIG.MAX_REQUIREMENT_LENGTH} characters`,
      );
    }

    const effectiveUserId = userId || `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // 直接由 mainAgent.processRequirement 处理（IntentRouter 识别意图 → 执行技能 → 结果持久化到 SessionStore）
    RequestContext.run({ accessToken }, () => {
      mainAgent.processRequirement(requirement, undefined, effectiveUserId).catch((err) => {
        // Persist the failure so it can be retrieved via /tasks/:id/result.
        // The error is a known AppError (or wrapped as one); log with structured context.
        // Note: task failure persistence is owned by the agent layer via sessionStore.failRequest,
        // which is already invoked by MainAgent.processNormalRequirement on error.
        log.error('Task processing failed', { error: err, userId: effectiveUserId });
      });
    });

    res.status(202).json({
      success: true,
      data: {
        status: 'accepted',
        message: 'Request accepted and processing',
        userId: effectiveUserId,
      },
    });
  }
  );

/**
 * Submit a new task with streaming
 * POST /tasks/stream
 */
app.post(
  '/tasks/stream',
  // 1. 加载 user profile → req.profile(给 guardrail 用)
  async (req: Request<{}, {}, SubmitTaskRequest>, _res: Response, next: NextFunction) => {
    if (userProfileService) {
      try {
        const userId = req.body.userId || 'default';
        (req as any).profile = await userProfileService.loadProfile(userId);
      } catch (err) {
        // profile 加载失败不阻塞主流程:guardrail middleware 会用兜底 profile
        log.warn('Failed to load user profile, using fallback', { error: (err as Error).message });
      }
    }
    next();
  },
  // 2. guardrail(deny/rewrite/alert)
  guardrailMiddleware(),
  // 3. 原 handler
  async (
    req: Request<{}, {}, SubmitTaskRequest>,
    res: Response<ApiError>
  ) => {
    const { requirement } = req.body;
    const userId = req.body.userId || 'default';
    const accessToken = extractAccessToken(req);
    // 在 API 入口生成 traceId,贯穿整条调用链的所有日志
    // 格式与 requestId 一致(req-{ts}-{rand}),便于业务 ID 与日志 ID 对齐
    const traceId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // 使用 RequestContext 包裹整个请求处理，使 accessToken / traceId 可在整条调用链中访问
    return RequestContext.run({ accessToken, traceId }, async () => {
    let imageAttachment: ImageAttachment | undefined;

    // 检查 JSON body 中的 base64 图片
    if (req.body.image && typeof req.body.image === 'string' && req.body.image.length > 100) {
      const match = req.body.image.match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        const mimeType = `image/${match[1] === 'jpeg' ? 'jpeg' : match[1]}`;
        const buffer = Buffer.from(match[2], 'base64');
        imageAttachment = {
          data: buffer,
          mimeType: mimeType,
          originalName: 'uploaded-image',
        };
        log.info('解析图片成功', { size: buffer.length });
      }
    }

    if (!requirement || typeof requirement !== 'string') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or invalid "requirement" field',
        code: 'INVALID_REQUEST',
      });
      return;
    }

    if (requirement.length > CONFIG.MAX_REQUIREMENT_LENGTH) {
      res.status(400).json({
        error: 'Bad Request',
        message: `Requirement exceeds maximum length of ${CONFIG.MAX_REQUIREMENT_LENGTH} characters`,
        code: 'REQUIREMENT_TOO_LONG',
      });
      return;
    }

    // ===== v4: Steer 注入 =====
    // 当前 session 已有"正在跑且已展开子任务"的 request 时,新消息不进 pendingRequests
    // 等 checkpoint 合并(长延迟),而是进 steeringBuffer,由 SubAgent 的工具循环在下一轮
    // LLM 调用前作为 user message 插入 —— 接近实时的用户改口。
    //
    // 只在有 running 任务时 steer:steering 消息只有 SubAgent 工具循环会消费,
    // 若此刻没有任何 running 任务(例如主智能体还在 IntentRouter 阶段),消息将无人消费、
    // 被静默丢弃,因此这种情况仍然走原来的 gate/queue 路径(202 queued / 503 queue_full)。
    {
      const steerSessionId = (req.body.sessionId as string | undefined) || userId;
      try {
        if (await mainAgent.shouldSteer(userId, steerSessionId)) {
          steeringBuffer.enqueue(steerSessionId, {
            content: requirement,
            enqueuedAt: new Date().toISOString(),
          });
          res.status(202).json({
            success: true,
            steered: true,
            message: '已注入 steer 队列,主请求处理完后会看到这条消息',
          } as any);
          return;
        }
      } catch (steerErr) {
        // mock 或旧版 mainAgent 没有 shouldSteer → 降级到原 gate 路径
        log.warn('shouldSteer 调用失败,回退到 gate 路径', {
          error: (steerErr as Error).message,
        });
      }
    }

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let handleReasoning: ((data: string | ReasoningEvent) => void) | null = null;
    let lifecycleHandler: ((event: import('../events/request-lifecycle').RequestLifecycleEvent) => void) | null = null;

    try {
      // Subscribe to request lifecycle events BEFORE awaiting processRequirement.
      // Lifecycle events (request_queued, request_checkpoint, request_spawned) can fire
      // while the first request is still running — e.g. when a second user message
      // arrives during processing. Subscribing up-front ensures the active SSE stream
      // captures queue/checkpoint/spawn events emitted during its own execution.
      // The handler buffers events until the SSE stream is opened; if the request turns
      // out to be queued (202 path), the buffered events are discarded.
      const lifecycleBuffer: Array<import('../events/request-lifecycle').RequestLifecycleEvent> = [];
      let lifecycleActive = true;
      lifecycleHandler = (event: import('../events/request-lifecycle').RequestLifecycleEvent) => {
        if (!lifecycleActive) return;
        if (res.headersSent) {
          sendEvent(event.type, event);
        } else {
          lifecycleBuffer.push(event);
        }
      };
      requestLifecycle.on('request_queued', lifecycleHandler);
      requestLifecycle.on('request_checkpoint', lifecycleHandler);
      requestLifecycle.on('request_spawned', lifecycleHandler);
      requestLifecycle.on('request_error', lifecycleHandler);

      // 订阅 task_events 总线,转发 task_started/completed/failed/waiting 到 SSE 进度卡
      const taskBuffer: TaskEvent[] = [];
      let taskActive = true;
      const taskListener = (event: TaskEvent) => {
        if (!taskActive) return;
        if (res.headersSent) {
          sendEvent(event.type, event);
        } else {
          taskBuffer.push(event);
        }
      };
      const offTaskStarted = taskEvents.on('task_started', taskListener);
      const offTaskCompleted = taskEvents.on('task_completed', taskListener);
      const offTaskFailed = taskEvents.on('task_failed', taskListener);
      const offTaskWaiting = taskEvents.on('task_waiting', taskListener);

      // 订阅 LLM reasoning 事件 —— 必须在 processRequirement 之前订阅,
      // 否则 processRequirement 期间 emit 的 reasoning 会被错过(导致前端思考气泡为空)。
      // reasoningBuffer 在 flushHeaders 之前暂存事件,之后按序重放。
      const reasoningBuffer: Array<{ content: string; agent: 'MainAgent' | 'SubAgent' }> = [];
      let reasoningActive = true;
      handleReasoning = (data: string | ReasoningEvent) => {
        if (!reasoningActive) return;
        const eventData = typeof data === 'string' ? { content: data, agent: 'MainAgent' as const } : data;
        reasoningBuffer.push({ content: eventData.content, agent: eventData.agent });
        if (res.headersSent) {
          sendEvent('reasoning', {
            type: 'thinking',
            content: eventData.content,
            agent: eventData.agent,
            timestamp: new Date().toISOString()
          });
        }
      };
      llmEvents.on('reasoning', handleReasoning);

      // 第一阶段:gate 决策(fast,~ms) —— 在 IntentRouter 同步 LLM 调用之前完成,
      // 让 queueFull/queued 能立即返回 JSON,避免后续慢路径拖到前端超时。
      // proceed 路径则立即 flushHeaders,IntentRouter 期间的 LLM 流式 reasoning
      // 能实时通过 SSE 推到前端(不再黑屏 50s+)。
      const effectiveSessionId = (req.body.sessionId as string | undefined) || userId;
      const gateResult = await mainAgent.gateCheck(
        userId, effectiveSessionId, requirement, !!imageAttachment,
        { draftId: req.body.draftId },
      );

      // Queue full: pending queue exceeded MAX_PENDING_REQUESTS. Return 503 directly.
      if (gateResult.type === 'queue_full') {
        lifecycleActive = false;
        if (lifecycleHandler) {
          requestLifecycle.off('request_queued', lifecycleHandler);
          requestLifecycle.off('request_checkpoint', lifecycleHandler);
          requestLifecycle.off('request_spawned', lifecycleHandler);
          requestLifecycle.off('request_error', lifecycleHandler);
          lifecycleHandler = null;
        }
        offTaskStarted(); offTaskCompleted(); offTaskFailed(); offTaskWaiting();
        if (handleReasoning) { llmEvents.off('reasoning', handleReasoning); reasoningActive = false; }
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Pending queue is full. Please wait for the current request to complete.',
          code: 'QUEUE_FULL',
          pendingCount: gateResult.pendingCount,
        } as any);
        return;
      }

      // Queue path: when the gate decides to queue, return 202 + JSON (no SSE).
      if (gateResult.type === 'queued') {
        lifecycleActive = false;
        if (lifecycleHandler) {
          requestLifecycle.off('request_queued', lifecycleHandler);
          requestLifecycle.off('request_checkpoint', lifecycleHandler);
          requestLifecycle.off('request_spawned', lifecycleHandler);
          requestLifecycle.off('request_error', lifecycleHandler);
          lifecycleHandler = null;
        }
        offTaskStarted(); offTaskCompleted(); offTaskFailed(); offTaskWaiting();
        if (handleReasoning) { llmEvents.off('reasoning', handleReasoning); reasoningActive = false; }
        res.status(202).json({
          status: 'queued',
          draftId: gateResult.draftId,
          position: gateResult.position,
        } as any);
        return;
      }

      // Proceed (or continue_waiting):gate 通过 → 立即 flush SSE headers,
      // 这样 processRequirement 期间的 LLM 流式 reasoning 能实时推到前端。
      // continue_waiting 走 processRequirement 内部的 AskAgent 路径,
      // 也会触发 LLM reasoning(主智能体继续判断),所以也走 proceed。
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.flushHeaders?.();

      sendEvent('start', { message: '开始处理您的请求...', traceId });

      // Replay buffered lifecycle events captured before SSE opened.
      for (const ev of lifecycleBuffer) {
        sendEvent(ev.type, ev);
      }
      lifecycleBuffer.length = 0;

      // Replay buffered task events captured before SSE opened.
      for (const ev of taskBuffer) {
        sendEvent(ev.type, ev);
      }
      taskBuffer.length = 0;

      // Replay buffered reasoning events captured before SSE opened.
      for (const ev of reasoningBuffer) {
        sendEvent('reasoning', {
          type: 'thinking',
          content: ev.content,
          agent: ev.agent,
          timestamp: new Date().toISOString()
        });
      }
      reasoningBuffer.length = 0;

      // 调 processRequirement —— gateChecked: true 避免重复 gate 决策
      // (gateCheck 后的 race window 内可能有新请求,但 processRequirement 内的
      // 后续 gate 已被跳过,符合设计意图:commit to proceed path).
      const result = await mainAgent.processRequirement(
        requirement, imageAttachment, userId, effectiveSessionId,
        { draftId: req.body.draftId, gateChecked: true },
      );

      // NOTE: SSE `step` events from a global `console.log` override were removed.
      //
      // The previous implementation monkey-patched `console.log` for the lifetime of
      // each request, then restored it in `finally`. Two issues made this unsafe:
      //   1. Race condition: two concurrent SSE requests would overwrite the global
      //      `console.log` and the first to finish would restore an obsolete function,
      //      leaking another request's messages into its stream (cross-request
      //      data leakage). Whichever order requests completed in, intercept state
      //      could remain active after completion.
      //   2. Stale contract: after Task 16, internal modules log via the structured
      //      JSON logger (`createLogger`), which writes single-line JSON via
      //      `console.log(JSON.stringify(entry))` — none of the `[MainAgent]` etc.
      //      prefixed strings the override looked for actually appear in agent output
      //      anymore, so the override was functionally dead for our own code.
      //
      // SSE observability is now provided exclusively by:
      //   - The structured JSON logger (always-on, see src/observability/logger.ts)
      //   - The `llmEvents.on('reasoning', ...)` stream registered below
      //   - Per-stage events explicitly emitted by agents
      //
      // The `step` event in the public SSE contract is no longer emitted. The
      // public/test.html front-end no longer mirrors console output as step events;
      // reasoning/thinking streaming and the final result payload remain.

      try {
        // Send final reasoning summary if any (buffer 已重放,这里只发 summary)
        if (reasoningBuffer.length === 0) {
          // 全部在 flushHeaders 之后到达,需要按已发送数计
          // 因为 buffer 已重放完且清空,这里不再处理
        }
        sendEvent('reasoning_complete', {
          type: 'thinking_complete',
          timestamp: new Date().toISOString()
        });

        // MainAgent.processRequirement returns TaskResult ({ success, data, error }).
        // New throw-based contract: failures throw AppError before reaching here,
        // but we still defensively handle the legacy envelope shape.
        if ((result as any).success === false) {
          sendEvent('error', { ...((result as any).error as object) });
        } else {
          sendEvent('complete', { success: true, data: result });
        }
      } finally {
        if (handleReasoning) llmEvents.off('reasoning', handleReasoning);
        reasoningActive = false;
        if (lifecycleHandler) {
          requestLifecycle.off('request_queued', lifecycleHandler);
          requestLifecycle.off('request_checkpoint', lifecycleHandler);
          requestLifecycle.off('request_spawned', lifecycleHandler);
          requestLifecycle.off('request_error', lifecycleHandler);
        }
        offTaskStarted(); offTaskCompleted(); offTaskFailed(); offTaskWaiting();
        taskActive = false;
      }

      } catch (error) {
        const { body } = errorToResponse(error);
        sendEvent('error', body.error);
      } finally {
        res.end();
      }
    }); // end RequestContext.run
  }
);

  /**
   * Get task status
   * GET /tasks/:id
   */
  app.get(
    '/tasks/:id',
    (req: Request<{ id: string }>, res: Response<ApiResponse<TaskStatusResponse> | ApiError>) => {
      const { id } = req.params;
      const task = taskQueue.getTask(id);

      if (!task) {
        throw new BusinessError('TASK_NOT_FOUND', `Task with ID "${id}" not found`, {
          statusCode: 404,
        });
      }

      const response: TaskStatusResponse = {
        taskId: task.id,
        status: task.status || 'pending',
        requirement: task.requirement,
        skillName: task.skillName,
        createdAt: task.createdAt?.toISOString() || new Date().toISOString(),
        startedAt: task.startedAt?.toISOString(),
        completedAt: task.completedAt?.toISOString(),
        retryCount: task.retryCount || 0,
      };

      res.json({ success: true, data: response });
    }
  );

  /**
   * Get task result
   * GET /tasks/:id/result
   */
  app.get(
    '/tasks/:id/result',
    (req: Request<{ id: string }>, res: Response<ApiResponse<TaskResultResponse> | ApiError>) => {
      const { id } = req.params;
      const task = taskQueue.getTask(id);

      if (!task) {
        throw new BusinessError('TASK_NOT_FOUND', `Task with ID "${id}" not found`, {
          statusCode: 404,
        });
      }

      const response: TaskResultResponse = {
        taskId: task.id,
        status: task.status || 'pending',
      };

      if (task.status === 'completed') {
        response.result = task.result;
      } else if (task.status === 'failed' && task.error) {
        response.error = {
          type: task.error.type,
          message: task.error.message,
          code: task.error.code,
        };
      }

      res.json({ success: true, data: response });
    }
  );

  /**
   * Cancel a task
   * DELETE /tasks/:id
   */
  app.delete(
    '/tasks/:id',
    (req: Request<{ id: string }>, res: Response<ApiResponse<{ message: string }> | ApiError>) => {
      const { id } = req.params;
      const task = taskQueue.getTask(id);

      if (!task) {
        throw new BusinessError('TASK_NOT_FOUND', `Task with ID "${id}" not found`, {
          statusCode: 404,
        });
      }

      const cancelled = taskQueue.cancelTask(id);

      if (cancelled) {
        res.json({
          success: true,
          data: { message: `Task "${id}" has been cancelled` },
        });
      } else {
        throw new BusinessError(
          'TASK_CANNOT_CANCEL',
          `Cannot cancel task "${id}" - task is already ${task.status}`,
          { statusCode: 400 },
        );
      }
    }
  );

  // ============================================================================
  // P2-4: Plan Mode 执行确认端点
  // ============================================================================
  app.post('/tasks/execute', async (req, res) => {
    const { planId } = req.body;
    res.json({ success: true, data: { message: `Plan ${planId} execution started` } });
  });

  // ============================================================================
  // Error Handling Middleware
  // ============================================================================

  // 404 handler
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new BusinessError('NOT_FOUND', 'The requested resource was not found', { statusCode: 404 }));
  });

  // Global error handler
  app.use(globalErrorHandler);

  return app;
}

export default createAPIServer;
