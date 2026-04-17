import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MainAgent } from '../src/agents/main-agent';
import { SubAgent } from '../src/agents/sub-agent';
import { TaskQueue } from '../src/task-queue';
import { SkillRegistry } from '../src/skill-registry';
import { LLMClient } from '../src/llm';
import { Task, TaskStatus } from '../src/types';

// Mock LLMClient
class MockLLMClient implements LLMClient {
  async generateText(prompt: string, systemPrompt?: string): Promise<string> {
    return 'Test response';
  }

  async generateStructured<T>(prompt: string, schema: any, systemPrompt?: string): Promise<T> {
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

describe('Integration Tests', () => {
  let mainAgent: MainAgent;
  let subAgent: SubAgent;
  let taskQueue: TaskQueue;
  let skillRegistry: MockSkillRegistry;
  let llmClient: MockLLMClient;

  beforeEach(() => {
    llmClient = new MockLLMClient();
    skillRegistry = new MockSkillRegistry();
    
    // Create task queue with mock executor
    const mockExecutor = mock(async (task: Task) => {
      return { success: true, data: { response: 'Task completed' } };
    });
    taskQueue = new TaskQueue(mockExecutor);
    
    // Create agents
    subAgent = new SubAgent(skillRegistry, llmClient as any);
    mainAgent = new MainAgent(llmClient as any, skillRegistry, taskQueue);
  });

  describe('MainAgent with TaskQueue', () => {
    it('should submit tasks to TaskQueue', async () => {
      const requirement = 'Test requirement';
      
      // Mock intent router to return skill task
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

      const result = await mainAgent.processRequirement(requirement);
      
      expect(result.success).toBe(true);
      
      // Restore original method
      (mainAgent as any).intentRouter.classify = originalClassify;
    });

    it('should handle task completion', async () => {
      const requirement = 'Test requirement';
      
      // Mock intent router to return skill task
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

      const result = await mainAgent.processRequirement(requirement);
      
      expect(result.success).toBe(true);
      
      // Restore original method
      (mainAgent as any).intentRouter.classify = originalClassify;
    });
  });

  describe('SubAgent with LLMClient', () => {
    it('should use LLMClient to generate responses', async () => {
      const task: Task = {
        id: 'test-task',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const result = await subAgent.execute(task);
      
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should handle tool calls through LLMClient', async () => {
      const task: Task = {
        id: 'test-task',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const result = await subAgent.execute(task);
      
      expect(result.success).toBe(true);
    });
  });

  describe('TaskQueue with SubAgent', () => {
    it('should execute tasks using SubAgent', async () => {
      const task: Task = {
        id: 'test-task',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      // Create task queue with SubAgent as executor
      const executor = async (task: Task) => {
        return await subAgent.execute(task);
      };
      const queue = new TaskQueue(executor);

      queue.addTask(task);
      
      // Wait for task to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const completedTask = queue.getTask('test-task');
      expect(completedTask?.status).toBe('completed');
    });

    it('should handle task dependencies', async () => {
      const task1: Task = {
        id: 'task-1',
        requirement: 'Task 1',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const task2: Task = {
        id: 'task-2',
        requirement: 'Task 2',
        status: 'pending',
        skillName: 'test-skill',
        params: {},
        dependencies: ['task-1'],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const executor = async (task: Task) => {
        return { success: true, data: { response: `Task ${task.id} completed` } };
      };
      const queue = new TaskQueue(executor);

      queue.addTask(task1);
      queue.addTask(task2);
      
      // Wait for tasks to complete
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const completedTask1 = queue.getTask('task-1');
      const completedTask2 = queue.getTask('task-2');
      
      expect(completedTask1?.status).toBe('completed');
      expect(completedTask2?.status).toBe('completed');
    });
  });

  describe('Security Module with Tools', () => {
    it('should prevent access to sensitive files', async () => {
      // Test that path guard prevents access to sensitive files
      const { PathGuard } = require('../src/security/path-guard');
      
      const sensitivePaths = ['.env', '/home/user/.ssh/id_rsa'];
      
      for (const path of sensitivePaths) {
        const result = PathGuard.checkPath(path);
        expect(result.safe).toBe(false);
      }
    });

    it('should allow access to safe files', async () => {
      const { PathGuard } = require('../src/security/path-guard');
      
      const safePaths = ['README.md', 'src/index.ts', 'skills/test-skill/SKILL.md'];
      
      for (const path of safePaths) {
        const result = PathGuard.checkPath(path);
        expect(result.safe).toBe(true);
      }
    });
  });
});
