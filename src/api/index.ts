import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { MainAgent } from '../agents/main-agent';
import { SkillRegistry } from '../skill-registry';
import { TaskQueue } from '../task-queue';
import { Task, TaskStatus } from '../types';
import { randomUUID } from 'crypto';
import { llmEvents } from '../llm';

interface ApiError {
  error: string;
  message: string;
  code?: string;
}

/**
 * Task submission request
 */
interface SubmitTaskRequest {
  requirement: string;
}

/**
 * Task submission response
 */
interface SubmitTaskResponse {
  taskId: string;
  status: TaskStatus;
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
  app.use(express.json());

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
        const validStatuses: TaskStatus[] = ['pending', 'running', 'completed', 'failed'];

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
          status: task.status,
          requirement: task.requirement,
          createdAt: task.createdAt.toISOString(),
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
    async (
      req: Request<{}, {}, SubmitTaskRequest>,
      res: Response<SubmitTaskResponse | ApiError>
    ) => {
      try {
        const { requirement } = req.body;

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

        // Start processing asynchronously via MainAgent
        processTaskAsync(taskId, requirement);

        res.status(201).json({
          taskId,
          status: 'pending',
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

      // Validate request
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
    if (msg.includes('[MainAgent]') || msg.includes('[SubAgent]') || msg.includes('[UnifiedPlanner]') || msg.includes('[IntentRouter]')) {
      stepCount++;
      let agent = 'MainAgent';
      if (msg.includes('[SubAgent]')) agent = 'SubAgent';
      else if (msg.includes('[UnifiedPlanner]')) agent = 'UnifiedPlanner';
      else if (msg.includes('[IntentRouter]')) agent = 'IntentRouter';
      
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
      const handleReasoning = (reasoning: string) => {
        reasoningBuffer.push(reasoning);
        sendEvent('reasoning', {
          type: 'thinking',
          content: reasoning,
          agent: 'MainAgent',
          timestamp: new Date().toISOString()
        });
      };
      llmEvents.on('reasoning', handleReasoning);

      try {
        const result = await mainAgent.processRequirement(requirement);

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
        sendEvent('error', { 
          message: error instanceof Error ? error.message : 'Unknown error' 
        });
      } finally {
        res.end();
      }
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
          status: task.status,
          requirement: task.requirement,
          skillName: task.skillName,
          createdAt: task.createdAt.toISOString(),
          startedAt: task.startedAt?.toISOString(),
          completedAt: task.completedAt?.toISOString(),
          retryCount: task.retryCount,
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
          status: task.status,
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

  async function processTaskAsync(taskId: string, requirement: string): Promise<void> {
    // Create task and add to queue for tracking
    const task: Task = {
      id: taskId,
      requirement,
      status: 'pending',
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      retryCount: 0,
    };

    // Add task to queue for tracking
    taskQueue.addTask(task);

    try {
      console.log(`Processing task ${taskId} with requirement: ${requirement}`);
      const result = await mainAgent.processRequirement(requirement);
      console.log(`Processing task ${taskId} completed with result:`, result);

      const updatedTask = taskQueue.getTask(taskId);
      if (updatedTask && result.success) {
        updatedTask.status = 'completed';
        updatedTask.result = result.data;
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

/**
 * Start the API server
 */
export function startAPIServer(
  mainAgent: MainAgent,
  skillRegistry: SkillRegistry,
  taskQueue: TaskQueue,
  port: number = 3000
): void {
  const app = createAPIServer(mainAgent, skillRegistry, taskQueue);

  app.listen(port, () => {
    console.log(`🚀 API server running on http://localhost:${port}`);
    console.log(`📋 Available endpoints:`);
    console.log(`   GET    /health`);
    console.log(`   GET    /skills`);
    console.log(`   GET    /tasks`);
    console.log(`   POST   /tasks`);
    console.log(`   GET    /tasks/:id`);
    console.log(`   GET    /tasks/:id/result`);
    console.log(`   DELETE /tasks/:id`);
  });
}

export default createAPIServer;
