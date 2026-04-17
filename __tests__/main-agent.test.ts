import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MainAgent } from '../src/agents/main-agent';
import { LLMClient } from '../src/llm';
import { SkillRegistry } from '../src/skill-registry';
import { TaskQueue } from '../src/task-queue';
import { Task, TaskStatus, TaskResult } from '../src/types';

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

  async generateWithTools(prompt: string, tools: any[], toolExecutor: any, systemPrompt?: string): Promise<{ content: string; toolCalls: any[] }> {
    return {
      content: 'Test response',
      toolCalls: []
    };
  }
}

// Mock SkillRegistry
class MockSkillRegistry extends SkillRegistry {
  constructor() {
    super();
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

// Mock TaskQueue
class MockTaskQueue extends TaskQueue {
  private tasks: Map<string, Task> = new Map();
  private listeners: Map<string, Function[]> = new Map();

  addTask(task: Task): void {
    this.tasks.set(task.id, task);
    // Simulate task completion
    setTimeout(() => {
      task.status = 'completed';
      task.result = {
        success: true,
        data: {
          response: 'Test task completed',
          _metadata: {
            skill: 'test-skill'
          }
        }
      };
      this.emit('task-completed', task);
    }, 100);
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'cancelled';
    }
  }

  on(event: string, listener: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)?.push(listener);
  }

  off(event: string, listener: Function): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  emit(event: string, data: any): void {
    const listeners = this.listeners.get(event);
    listeners?.forEach(listener => listener(data));
  }
}

describe('MainAgent', () => {
  let mainAgent: MainAgent;
  let llmClient: MockLLMClient;
  let skillRegistry: MockSkillRegistry;
  let taskQueue: MockTaskQueue;

  beforeEach(() => {
    llmClient = new MockLLMClient();
    skillRegistry = new MockSkillRegistry();
    taskQueue = new MockTaskQueue();
    mainAgent = new MainAgent(llmClient as any, skillRegistry, taskQueue);
  });

  describe('constructor', () => {
    it('should create MainAgent with provided dependencies', () => {
      expect(mainAgent).toBeDefined();
    });

    it('should create MainAgent with default maxReplanAttempts', () => {
      const agent = new MainAgent(llmClient as any, skillRegistry, taskQueue);
      expect(agent).toBeDefined();
    });
  });

  describe('processRequirement', () => {
    it('should process simple requirement successfully', async () => {
      const requirement = 'Test requirement';
      const result = await mainAgent.processRequirement(requirement);
      
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should handle empty requirement', async () => {
      const requirement = '';
      const result = await mainAgent.processRequirement(requirement);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle plan mode', async () => {
      const requirement = 'Test requirement';
      const result = await mainAgent.processRequirement(requirement, undefined, undefined, undefined, { planMode: true });
      
      expect(result.success).toBe(true);
      expect(result.data?.type).toBe('plan_preview');
      expect(result.data?.plan).toBeDefined();
    });
  });

  describe('monitorAndReplan', () => {
    it('should monitor task completion successfully', async () => {
      const plan = {
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
      };

      const result = await mainAgent['monitorAndReplan'](plan);
      
      expect(result.success).toBe(true);
      expect(result.data?.results).toBeDefined();
    });
  });

  describe('submitPlanTasks', () => {
    it('should submit tasks to task queue', () => {
      const plan = {
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
      };

      mainAgent['submitPlanTasks'](plan);
      
      const tasks = taskQueue.getAllTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].skillName).toBe('test-skill');
    });
  });

  describe('getFailedTasks', () => {
    it('should return empty array when no failed tasks', () => {
      const plan = {
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
      };

      const failedTasks = mainAgent['getFailedTasks'](plan);
      expect(failedTasks.length).toBe(0);
    });
  });

  describe('replan', () => {
    it('should create new plan after failure', async () => {
      const failedPlan = {
        id: 'failed-plan',
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
      };

      const errors = [
        {
          type: 'RETRYABLE',
          message: 'Test error',
          code: 'TEST_ERROR'
        }
      ];

      const newPlan = await mainAgent['replan'](failedPlan, errors);
      
      expect(newPlan.id).not.toBe(failedPlan.id);
      expect(newPlan.tasks.length).toBe(1);
    });
  });
});
