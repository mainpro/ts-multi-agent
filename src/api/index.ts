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
import { createLogger } from '../observability/logger';
import type { ApiResponse } from '../types/api-response';

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
  taskQueue: TaskQueue
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
  // Metrics API (Issue #11)
  // ============================================================================
  app.get('/metrics', (_req: Request, res: Response) => {
    const metrics = taskQueue.getMetrics();
    res.json({
      queue: {
        tasksCompleted: metrics.tasksCompleted,
        tasksFailed: metrics.tasksFailed,
        tasksTimedOut: metrics.tasksTimedOut,
        averageExecutionTime: Math.round(metrics.averageExecutionTime),
        totalExecutionTime: Math.round(metrics.totalExecutionTime),
      },
      queueSize: taskQueue.getAllTasks().length,
      runningCount: taskQueue.getRunningCount(),
    });
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

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let handleReasoning: ((data: string | ReasoningEvent) => void) | null = null;
    let lifecycleHandler: ((event: import('../events/request-lifecycle').RequestLifecycleEvent) => void) | null = null;

    try {
      const sessionId = req.body.sessionId as string | undefined;

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

      const result = await mainAgent.processRequirement(requirement, imageAttachment, userId, sessionId || userId, { draftId: req.body.draftId });

      // Queue full: pending queue exceeded MAX_PENDING_REQUESTS. Return 503 directly.
      if ((result as any).queueFull === true) {
        lifecycleActive = false;
        if (lifecycleHandler) {
          requestLifecycle.off('request_queued', lifecycleHandler);
          requestLifecycle.off('request_checkpoint', lifecycleHandler);
          requestLifecycle.off('request_spawned', lifecycleHandler);
          requestLifecycle.off('request_error', lifecycleHandler);
          lifecycleHandler = null;
        }
        offTaskStarted(); offTaskCompleted(); offTaskFailed(); offTaskWaiting();
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'Pending queue is full. Please wait for the current request to complete.',
          code: 'QUEUE_FULL',
          pendingCount: (result as any).pendingCount,
        } as any);
        return;
      }

      // Queue path: when the gate decides to queue, return 202 + JSON (no SSE).
      if ((result as any).queued === true) {
        lifecycleActive = false;
        if (lifecycleHandler) {
          requestLifecycle.off('request_queued', lifecycleHandler);
          requestLifecycle.off('request_checkpoint', lifecycleHandler);
          requestLifecycle.off('request_spawned', lifecycleHandler);
          requestLifecycle.off('request_error', lifecycleHandler);
          lifecycleHandler = null;
        }
        offTaskStarted(); offTaskCompleted(); offTaskFailed(); offTaskWaiting();
        res.status(202).json({
          status: 'queued',
          draftId: (result as any).draftId,
          position: (result as any).position,
        } as any);
        return;
      }

      // Execution path — only now commit to SSE: set headers and emit start event.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.flushHeaders?.();

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

      sendEvent('start', { message: '开始处理您的请求...', traceId });

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
        // Subscribe to LLM reasoning events
        const reasoningBuffer: string[] = [];
        handleReasoning = (data: string | ReasoningEvent) => {
          const eventData = typeof data === 'string' ? { content: data, agent: 'MainAgent' as const } : data;
          reasoningBuffer.push(eventData.content);
          sendEvent('reasoning', {
            type: 'thinking',
            content: eventData.content,
            agent: eventData.agent,
            timestamp: new Date().toISOString()
          });
        };
        llmEvents.on('reasoning', handleReasoning);

        // Subscribe to request lifecycle events — forwarded to SSE during active stream.
        // (Already subscribed BEFORE processRequirement awaited so cross-request events
        // emitted during the first request's execution are captured.)

        // Send final reasoning summary if any
        if (reasoningBuffer.length > 0) {
          sendEvent('reasoning_complete', {
            type: 'thinking_complete',
            totalChunks: reasoningBuffer.length,
            timestamp: new Date().toISOString()
          });
        }

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
