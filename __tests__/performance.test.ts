import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { TaskQueue } from '../src/task-queue';
import { MainAgent } from '../src/agents/main-agent';
import { SubAgent } from '../src/agents/sub-agent';
import { SkillRegistry } from '../src/skill-registry';
import { LLMClient } from '../src/llm';
import { Task, TaskStatus } from '../src/types';

// Mock LLMClient for performance testing
class MockLLMClient implements LLMClient {
  async generateText(prompt: string, systemPrompt?: string): Promise<string> {
    // Simulate LLM response time
    await new Promise(resolve => setTimeout(resolve, 10));
    return 'Test response';
  }

  async generateStructured<T>(prompt: string, schema: any, systemPrompt?: string): Promise<T> {
    // Simulate LLM response time
    await new Promise(resolve => setTimeout(resolve, 15));
    return {
      id: 'test-plan',
      requirement: 'Test requirement',
      tasks: [
        {
          id: 'task-1',
          requirement: 'Test task',
          skillName: 'test-skill',
          params: {},
          dependencies: []
        }
      ]
    } as T;
  }

  async generateWithTools(prompt: string, tools: any[], toolExecutor: any, systemPrompt?: string, signal?: AbortSignal, concurrencyChecker?: (toolName: string) => boolean): Promise<{ content: string; toolCalls: any[] }> {
    // Simulate LLM response time
    await new Promise(resolve => setTimeout(resolve, 20));
    return {
      content: 'Test response from LLM',
      toolCalls: []
    };
  }
}

// Mock SkillRegistry
class MockSkillRegistry extends SkillRegistry {
  constructor() {
    super();
  }

  async loadFullSkill(skillName: string) {
    if (skillName === 'test-skill') {
      return {
        name: 'test-skill',
        description: 'Test skill',
        body: 'Test skill body',
        allowedTools: ['read', 'glob']
      };
    }
    return null;
  }

  getAllMetadata() {
    return [
      {
        name: 'test-skill',
        description: 'Test skill',
        license: 'MIT',
        compatibility: 'universal'
      }
    ];
  }

  hasSkill(skillName: string) {
    return skillName === 'test-skill';
  }
}

describe('Performance Tests', () => {
  let taskQueue: TaskQueue;
  let mainAgent: MainAgent;
  let skillRegistry: MockSkillRegistry;
  let llmClient: MockLLMClient;

  beforeEach(() => {
    llmClient = new MockLLMClient();
    skillRegistry = new MockSkillRegistry();
    
    // Create task queue with mock executor that simulates work
    const mockExecutor = mock(async (task: Task) => {
      // Simulate task execution time
      await new Promise(resolve => setTimeout(resolve, 5));
      return { success: true, data: { response: 'Task completed' } };
    });
    taskQueue = new TaskQueue(mockExecutor);
    
    // Create main agent
    mainAgent = new MainAgent(llmClient as any, skillRegistry, taskQueue);
  });

  describe('Response Time Tests', () => {
    it('should process requirement within reasonable time', async () => {
      const requirement = 'Test requirement';
      
      // Mock intent router
      const originalClassify = (mainAgent as any).intentRouter.classify;
      (mainAgent as any).intentRouter.classify = mock(async () => ({
        intent: 'skill_task',
        confidence: 0.9,
        tasks: [
          {
            requirement: 'Test task',
            skillName: 'test-skill',
            params: {}
          }
        ]
      }));

      const startTime = performance.now();
      const result = await mainAgent.processRequirement(requirement);
      const endTime = performance.now();
      const executionTime = endTime - startTime;
      
      expect(result.success).toBe(true);
      // Response time should be less than 100ms for this simple case
      expect(executionTime).toBeLessThan(100);
      
      // Restore original method
      (mainAgent as any).intentRouter.classify = originalClassify;
    });

    it('should handle multiple tasks efficiently', async () => {
      const requirement = 'Test multiple tasks';
      
      // Mock intent router to return multiple tasks
      const originalClassify = (mainAgent as any).intentRouter.classify;
      (mainAgent as any).intentRouter.classify = mock(async () => ({
        intent: 'skill_task',
        confidence: 0.9,
        tasks: [
          {
            requirement: 'Task 1',
            skillName: 'test-skill',
            params: {}
          },
          {
            requirement: 'Task 2',
            skillName: 'test-skill',
            params: {}
          },
          {
            requirement: 'Task 3',
            skillName: 'test-skill',
            params: {}
          }
        ]
      }));

      const startTime = performance.now();
      const result = await mainAgent.processRequirement(requirement);
      const endTime = performance.now();
      const executionTime = endTime - startTime;
      
      expect(result.success).toBe(true);
      // Response time should be less than 200ms for 3 tasks
      expect(executionTime).toBeLessThan(200);
      
      // Restore original method
      (mainAgent as any).intentRouter.classify = originalClassify;
    });
  });

  describe('Task Queue Performance', () => {
    it('should handle concurrent tasks efficiently', async () => {
      const tasks = [
        {
          id: 'task-1',
          requirement: 'Task 1',
          skillName: 'test-skill',
          params: {},
          dependencies: []
        },
        {
          id: 'task-2',
          requirement: 'Task 2',
          skillName: 'test-skill',
          params: {},
          dependencies: []
        },
        {
          id: 'task-3',
          requirement: 'Task 3',
          skillName: 'test-skill',
          params: {},
          dependencies: []
        }
      ];

      const startTime = performance.now();
      
      // Add all tasks
      for (const task of tasks) {
        await taskQueue.addTask(task);
      }

      // Wait for all tasks to complete
      await new Promise(resolve => {
        const checkTasks = setInterval(async () => {
          const allTasks = await taskQueue.getAllTasks();
          const completedTasks = allTasks.filter(t => t.status === TaskStatus.COMPLETED);
          if (completedTasks.length === tasks.length) {
            clearInterval(checkTasks);
            resolve(undefined);
          }
        }, 10);
      });

      const endTime = performance.now();
      const executionTime = endTime - startTime;
      
      // All tasks should complete within 50ms (parallel execution)
      expect(executionTime).toBeLessThan(50);
    });

    it('should handle task dependencies without performance degradation', async () => {
      const tasks = [
        {
          id: 'task-1',
          requirement: 'Task 1',
          skillName: 'test-skill',
          params: {},
          dependencies: []
        },
        {
          id: 'task-2',
          requirement: 'Task 2',
          skillName: 'test-skill',
          params: {},
          dependencies: ['task-1']
        },
        {
          id: 'task-3',
          requirement: 'Task 3',
          skillName: 'test-skill',
          params: {},
          dependencies: ['task-2']
        }
      ];

      const startTime = performance.now();
      
      // Add all tasks
      for (const task of tasks) {
        await taskQueue.addTask(task);
      }

      // Wait for all tasks to complete
      await new Promise(resolve => {
        const checkTasks = setInterval(async () => {
          const allTasks = await taskQueue.getAllTasks();
          const completedTasks = allTasks.filter(t => t.status === TaskStatus.COMPLETED);
          if (completedTasks.length === tasks.length) {
            clearInterval(checkTasks);
            resolve(undefined);
          }
        }, 10);
      });

      const endTime = performance.now();
      const executionTime = endTime - startTime;
      
      // Tasks with dependencies should complete within 20ms per task (sequential execution)
      expect(executionTime).toBeLessThan(60);
    });
  });

  describe('Resource Usage Tests', () => {
    it('should not consume excessive memory with multiple tasks', async () => {
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        id: `task-${i}`,
        requirement: `Task ${i}`,
        skillName: 'test-skill',
        params: {},
        dependencies: []
      }));

      // Measure memory before
      const memoryBefore = process.memoryUsage().heapUsed;

      // Add all tasks
      for (const task of tasks) {
        await taskQueue.addTask(task);
      }

      // Wait for all tasks to complete
      await new Promise(resolve => {
        const checkTasks = setInterval(async () => {
          const allTasks = await taskQueue.getAllTasks();
          const completedTasks = allTasks.filter(t => t.status === TaskStatus.COMPLETED);
          if (completedTasks.length === tasks.length) {
            clearInterval(checkTasks);
            resolve(undefined);
          }
        }, 10);
      });

      // Measure memory after
      const memoryAfter = process.memoryUsage().heapUsed;
      const memoryDiff = memoryAfter - memoryBefore;
      
      // Memory increase should be less than 1MB for 10 tasks
      expect(memoryDiff).toBeLessThan(1024 * 1024);
    });
  });
});
