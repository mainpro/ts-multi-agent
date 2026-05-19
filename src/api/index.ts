import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { MainAgent } from '../agents/main-agent';
import { SkillRegistry } from '../skill-registry';
import { TaskQueue } from '../task-queue';
import { Task, TaskStatus } from '../types';
import { randomUUID } from 'crypto';
import { llmEvents, ReasoningEvent } from '../llm';
import { RequestContext } from '../context/request-context';

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
}

/**
 * Task submission response
 */
interface SubmitTaskResponse {
  taskId: string;
  status: TaskStatus;
  userId: string;
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
export function createAPIServer(
  mainAgent: MainAgent,
  skillRegistry: SkillRegistry,
  taskQueue: TaskQueue
): express.Application {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

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
  app.use(express.static('public'));

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      console.log(
        `[${timestamp}] ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`
      );
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
      res.status(400).json({ error: 'INVALID_REQUEST', message: 'sessionId is required' });
      return;
    }

    try {
      const history = await mainAgent.getSessionHistory(userId, sessionId);
      res.json(history);
    } catch (error) {
      console.error('Error getting session history:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get session history' });
    }
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
    (req: Request<{}, {}, {}, { status?: string }>, res: Response<{ tasks: Array<{ id: string; status: TaskStatus; requirement: string; createdAt: string }> } | ApiError>) => {
      try {
        const { status } = req.query;
        const validStatuses: TaskStatus[] = ['pending', 'running', 'completed', 'failed', 'suspended'];

        // Validate status filter if provided
        if (status && !validStatuses.includes(status as TaskStatus)) {
          res.status(400).json({
            error: 'Bad Request',
            message: `Invalid status filter. Must be one of: ${validStatuses.join(', ')}`,
            code: 'INVALID_STATUS_FILTER',
          });
          return;
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

  res.json({ tasks: formattedTasks });
      } catch (error) {
        console.error('Error listing tasks:', error);
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to list tasks',
          code: 'INTERNAL_ERROR',
        });
      }
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
    res: Response<SubmitTaskResponse | ApiError>
    ): Promise<void> => {
    try {
      const { requirement, userId } = req.body;
      const accessToken = extractAccessToken(req);
      // Validate request
      if (!requirement || typeof requirement !== 'string') {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Missing or invalid "requirement" field',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      const taskId = randomUUID();
      const effectiveUserId = userId || `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // #12: 先创建 task 对象尝试入队，再启动异步处理
      const task: Task = {
        id: taskId,
        requirement,
        status: 'pending',
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0,
        userId: effectiveUserId,
      };

      const addResult = taskQueue.addTask(task);
      if (!addResult.success) {
        // #1/#12: 队列满返回 429 而非崩溃
        res.status(429).json({
          error: 'Too Many Requests',
          message: addResult.error ?? 'Queue full',
          code: 'QUEUE_FULL',
        });
        return;
      }

      // #2: 添加 .catch() 防止 unhandledRejection
      RequestContext.run({ accessToken }, () => {
        processTaskAsync(taskId, requirement, effectiveUserId).catch((err) => {
          console.error('[API] Task processing failed:', err instanceof Error ? err.message : err);
          const t = taskQueue.getTask(taskId);
          if (t && t.status === 'pending') {
            t.status = 'failed';
            t.error = {
              type: 'FATAL' as const,
              message: err instanceof Error ? err.message : 'Unknown error',
              code: 'PROCESSING_FAILED',
            };
            t.completedAt = new Date();
          }
        });
      });

      res.status(201).json({
        taskId,
        status: 'pending',
        userId: effectiveUserId,
      });
    } catch (error) {
      console.error('Error creating task:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to create task',
        code: 'TASK_CREATION_FAILED',
      });
    }
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

    // 使用 RequestContext 包裹整个请求处理，使 accessToken 可在整条调用链中访问
    return RequestContext.run({ accessToken }, async () => {
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
        console.log('[API] 解析图片成功, 大小:', buffer.length);
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

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      sendEvent('start', { message: '开始处理您的请求...' });

      const originalLog = console.log;
      let stepCount = 0;
      console.log = (...args: unknown[]) => {
        const msg = args.join(' ');
        // Capture MainAgent, SubAgent, UnifiedPlanner process messages
        if (msg.includes('[MainAgent]') || msg.includes('[SubAgent]') || msg.includes('[UnifiedPlanner]') || msg.includes('[IntentRouter]') || msg.includes('[LLM]')) {
          stepCount++;
          let agent = 'MainAgent';
          if (msg.includes('[SubAgent]')) agent = 'SubAgent';
          else if (msg.includes('[UnifiedPlanner]')) agent = 'UnifiedPlanner';
          else if (msg.includes('[IntentRouter]')) agent = 'IntentRouter';
          else if (msg.includes('[LLM]')) agent = 'LLM';

          sendEvent('step', {
            step: stepCount,
            message: msg,
            agent,
            timestamp: new Date().toISOString()
          });
        }
        originalLog.apply(console, args);
      };

  // Subscribe to LLM reasoning events
  const reasoningBuffer: string[] = [];
  const handleReasoning = (data: string | ReasoningEvent) => {
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

try {
      const sessionId = req.body.sessionId as string | undefined;

      const result = await mainAgent.processRequirement(requirement, imageAttachment, userId, sessionId || userId);

        // Send final reasoning summary if any
        if (reasoningBuffer.length > 0) {
          sendEvent('reasoning_complete', {
            type: 'thinking_complete',
            totalChunks: reasoningBuffer.length,
            timestamp: new Date().toISOString()
          });
        }

        if (result.success) {
          sendEvent('complete', result.data);
        } else {
          sendEvent('error', result.error);
        }
      } finally {
        console.log = originalLog;
        llmEvents.off('reasoning', handleReasoning);
      }

      } catch (error) {
        console.error('[API] Error processing request:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        sendEvent('error', { 
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined
        });
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
    (req: Request<{ id: string }>, res: Response<TaskStatusResponse | ApiError>) => {
      try {
        const { id } = req.params;
        const task = taskQueue.getTask(id);

        if (!task) {
          res.status(404).json({
            error: 'Not Found',
            message: `Task with ID "${id}" not found`,
            code: 'TASK_NOT_FOUND',
          });
          return;
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

        res.json(response);
      } catch (error) {
        console.error('Error getting task status:', error);
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to get task status',
          code: 'INTERNAL_ERROR',
        });
      }
    }
  );

  /**
   * Get task result
   * GET /tasks/:id/result
   */
  app.get(
    '/tasks/:id/result',
    (req: Request<{ id: string }>, res: Response<TaskResultResponse | ApiError>) => {
      try {
        const { id } = req.params;
        const task = taskQueue.getTask(id);

        if (!task) {
          res.status(404).json({
            error: 'Not Found',
            message: `Task with ID "${id}" not found`,
            code: 'TASK_NOT_FOUND',
          });
          return;
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

        res.json(response);
      } catch (error) {
        console.error('Error getting task result:', error);
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to get task result',
          code: 'INTERNAL_ERROR',
        });
      }
    }
  );

  /**
   * Cancel a task
   * DELETE /tasks/:id
   */
  app.delete(
    '/tasks/:id',
    (req: Request<{ id: string }>, res: Response<{ success: boolean; message: string } | ApiError>) => {
      try {
        const { id } = req.params;
        const task = taskQueue.getTask(id);

        if (!task) {
          res.status(404).json({
            error: 'Not Found',
            message: `Task with ID "${id}" not found`,
            code: 'TASK_NOT_FOUND',
          });
          return;
        }

        const cancelled = taskQueue.cancelTask(id);

        if (cancelled) {
          res.json({
            success: true,
            message: `Task "${id}" has been cancelled`,
          });
        } else {
          res.status(400).json({
            error: 'Bad Request',
            message: `Cannot cancel task "${id}" - task is already ${task.status}`,
            code: 'TASK_CANNOT_CANCEL',
          });
        }
      } catch (error) {
        console.error('Error cancelling task:', error);
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to cancel task',
          code: 'INTERNAL_ERROR',
        });
      }
    }
  );

  // ============================================================================
  // P2-4: Plan Mode 执行确认端点
  // ============================================================================
  app.post('/tasks/execute', async (req, res) => {
    const { planId } = req.body;
    try {
      // This would call mainAgent.executePlan(planId, sessionId, userId)
      // For now, return a placeholder response
      res.json({ success: true, message: `Plan ${planId} execution started` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============================================================================
  // Error Handling Middleware
  // ============================================================================

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: 'The requested resource was not found',
      code: 'NOT_FOUND',
    });
  });

  // Global error handler
  app.use(
    (
      err: Error,
      _req: Request,
      res: Response<ApiError>,
      _next: NextFunction
    ) => {
      console.error('Unhandled error:', err);

      // Don't expose sensitive error details in production
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred',
        code: 'INTERNAL_ERROR',
      });
    }
  );

  async function processTaskAsync(taskId: string, requirement: string, userId: string = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`): Promise<void> {
    // Task 已在 POST /tasks 路由中入队，此处直接处理
    // 兼容：如果 task 不存在（如直接调用），则创建并入队
    let existingTask = taskQueue.getTask(taskId);
    if (!existingTask) {
      const task: Task = {
        id: taskId,
        requirement,
        status: 'pending',
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0,
        userId,
      };
      const addResult = taskQueue.addTask(task);
      if (!addResult.success) {
        console.error(`[API] Failed to add task ${taskId}: ${addResult.error}`);
        return;
      }
    }

    try {
      console.log(`Processing task ${taskId} with requirement: ${requirement} for user: ${userId}`);
      const result = await mainAgent.processRequirement(requirement, undefined, userId);
      console.log(`Processing task ${taskId} completed with result:`, result);

const updatedTask = taskQueue.getTask(taskId);
if (updatedTask && result.success) {
  updatedTask.status = 'completed';
  updatedTask.result = { success: true, data: result.data };
  updatedTask.completedAt = new Date();
  console.log(`Task ${taskId} updated to completed`);
} else if (updatedTask && !result.success) {
  updatedTask.status = 'failed';
  updatedTask.error = result.error;
  updatedTask.completedAt = new Date();
  console.log(`Task ${taskId} updated to failed with error:`, result.error);
}
    } catch (error) {
      console.error(`Error processing task ${taskId}:`, error);
      const updatedTask = taskQueue.getTask(taskId);
      if (updatedTask) {
        updatedTask.status = 'failed';
        updatedTask.error = {
          type: 'FATAL',
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'PROCESSING_ERROR',
        };
        updatedTask.completedAt = new Date();
        console.log(`Task ${taskId} updated to failed with error:`, updatedTask.error);
      }
    }
  }

  return app;
}

export default createAPIServer;
