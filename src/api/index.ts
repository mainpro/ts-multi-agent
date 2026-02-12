import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { MainAgent } from '../agents/main-agent';
import { SkillRegistry } from '../skill-registry';
import { TaskQueue } from '../task-queue';
import { Task, TaskStatus } from '../types';
import { randomUUID } from 'crypto';

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

        // Create initial task
        const task: Task = {
          id: taskId,
          requirement,
          status: 'pending',
          dependencies: [],
          dependents: [],
          createdAt: new Date(),
          retryCount: 0,
        };

        // Add task to queue (executor will handle it)
        taskQueue.addTask(task);

        // Start processing asynchronously
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
    try {
      const result = await mainAgent.processRequirement(requirement);

      const task = taskQueue.getTask(taskId);
      if (task && result.success) {
        task.status = 'completed';
        task.result = result.data;
        task.completedAt = new Date();
      } else if (task && !result.success) {
        task.status = 'failed';
        task.error = result.error;
        task.completedAt = new Date();
      }
    } catch (error) {
      console.error(`Error processing task ${taskId}:`, error);
      const task = taskQueue.getTask(taskId);
      if (task) {
        task.status = 'failed';
        task.error = {
          type: 'FATAL',
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'PROCESSING_ERROR',
        };
        task.completedAt = new Date();
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
