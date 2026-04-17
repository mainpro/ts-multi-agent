import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SubAgent, detectQuestion } from '../src/agents/sub-agent';
import { SkillRegistry } from '../src/skill-registry';
import { LLMClient } from '../src/llm';
import { Task, TaskResult, Skill } from '../src/types';

// Mock LLMClient
class MockLLMClient implements LLMClient {
  async generateText(prompt: string, systemPrompt?: string): Promise<string> {
    return 'Test response';
  }

  async generateStructured<T>(prompt: string, schema: any, systemPrompt?: string): Promise<T> {
    return {} as T;
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
      } as Skill;
    }
    return null;
  }
}

describe('SubAgent', () => {
  let subAgent: SubAgent;
  let llmClient: MockLLMClient;
  let skillRegistry: MockSkillRegistry;

  beforeEach(() => {
    llmClient = new MockLLMClient();
    skillRegistry = new MockSkillRegistry();
    subAgent = new SubAgent(skillRegistry, llmClient as any);
  });

  describe('constructor', () => {
    it('should create SubAgent with provided dependencies', () => {
      expect(subAgent).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should execute task successfully', async () => {
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

    it('should handle missing skill name', async () => {
      const task: Task = {
        id: 'test-task',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: '',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const result = await subAgent.execute(task);
      
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_SKILL');
    });

    it('should handle non-existent skill', async () => {
      const task: Task = {
        id: 'test-task',
        requirement: 'Test requirement',
        status: 'pending',
        skillName: 'non-existent-skill',
        params: {},
        dependencies: [],
        dependents: [],
        createdAt: new Date(),
        retryCount: 0
      };

      const result = await subAgent.execute(task);
      
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SKILL_NOT_FOUND');
    });

    it('should handle execution errors', async () => {
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

      // Mock skillRegistry.loadFullSkill to throw an error
      const originalLoadFullSkill = skillRegistry.loadFullSkill;
      skillRegistry.loadFullSkill = async () => {
        throw new Error('Test error');
      };

      const result = await subAgent.execute(task);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Restore original method
      skillRegistry.loadFullSkill = originalLoadFullSkill;
    });
  });

  describe('classifyError', () => {
    it('should classify timeout error as RETRYABLE', () => {
      const error = new Error('Timeout error');
      const classifiedError = subAgent['classifyError'](error);
      
      expect(classifiedError.type).toBe('RETRYABLE');
      expect(classifiedError.code).toBe('EXECUTION_ERROR');
    });

    it('should classify file not found error as FATAL', () => {
      const error = new Error('File not found');
      const classifiedError = subAgent['classifyError'](error);
      
      expect(classifiedError.type).toBe('FATAL');
      expect(classifiedError.code).toBe('FILE_NOT_FOUND');
    });

    it('should classify permission error as FATAL', () => {
      const error = new Error('Permission denied');
      const classifiedError = subAgent['classifyError'](error);
      
      expect(classifiedError.type).toBe('FATAL');
      expect(classifiedError.code).toBe('PERMISSION_DENIED');
    });

    it('should classify unknown error as RETRYABLE', () => {
      const error = 'Unknown error';
      const classifiedError = subAgent['classifyError'](error);
      
      expect(classifiedError.type).toBe('RETRYABLE');
      expect(classifiedError.code).toBe('UNKNOWN_ERROR');
    });
  });

  describe('detectQuestion', () => {
    it('should detect question patterns', () => {
      const testCases = [
        '请问您要选择哪个选项？',
        '请选择一个选项',
        '请提供您的姓名',
        '请问这是什么？',
        '请输入您的密码',
        '请确认您的操作',
        '请回复是或否',
        '请告诉我您的需求',
        '需要您提供更多信息',
        '您希望选择哪个方案？',
        '请问有多少个选项？'
      ];

      for (const testCase of testCases) {
        const result = detectQuestion(testCase);
        expect(result).toBeDefined();
        expect(result?.content).toBe(testCase);
      }
    });

    it('should not detect non-question patterns', () => {
      const testCases = [
        '这是一个陈述',
        '执行操作成功',
        '文件已保存',
        '系统正在处理',
        '欢迎使用系统'
      ];

      for (const testCase of testCases) {
        const result = detectQuestion(testCase);
        expect(result).toBeNull();
      }
    });

    it('should handle empty response', () => {
      const result = detectQuestion('');
      expect(result).toBeNull();
    });

    it('should handle null response', () => {
      const result = detectQuestion(null as any);
      expect(result).toBeNull();
    });
  });
});
