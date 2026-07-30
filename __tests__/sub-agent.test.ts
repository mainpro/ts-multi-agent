import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SubAgent, detectQuestion } from '../src/agents/sub-agent';
import { SkillRegistry } from '../src/skill-registry';
import { LLMClient, LLMError } from '../src/llm';
import { LlmError, SkillError, BusinessError } from '../src/errors';
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

    it('should throw SkillError for missing skill name', async () => {
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

      await expect(subAgent.execute(task)).rejects.toThrow(SkillError);
      try {
        await subAgent.execute(task);
      } catch (err) {
        expect(err).toBeInstanceOf(SkillError);
        expect((err as SkillError).code).toBe('MISSING_SKILL');
      }
    });

    it('should throw SkillError for non-existent skill', async () => {
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

      await expect(subAgent.execute(task)).rejects.toThrow(SkillError);
      try {
        await subAgent.execute(task);
      } catch (err) {
        expect(err).toBeInstanceOf(SkillError);
        expect((err as SkillError).code).toBe('SKILL_NOT_FOUND');
      }
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

      // Mock skillRegistry.loadFullSkill to throw a generic Error.
      // mapSubAgentError converts non-LLM/non-business Errors to SkillError('EXECUTION_ERROR').
      const originalLoadFullSkill = skillRegistry.loadFullSkill;
      skillRegistry.loadFullSkill = async () => {
        throw new Error('Test error');
      };

      try {
        await expect(subAgent.execute(task)).rejects.toMatchObject({
          code: 'EXECUTION_ERROR',
        });
      } finally {
        // Restore original method
        skillRegistry.loadFullSkill = originalLoadFullSkill;
      }
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

    it('should not detect query results as questions (with toolCallResults context)', () => {
      const result = detectQuestion(
        '查询到3条记录，以下是结果：\n1. 记录A\n2. 记录B',
        [{ name: 'conversation-get', result: '3 records' }]
      );
      expect(result).toBeNull();
    });

    it('should detect question with toolCallResults context', () => {
      const result = detectQuestion(
        '查询到3条记录，请问您需要哪个？',
        [{ name: 'conversation-get', result: '3 records' }]
      );
      expect(result).toBeDefined();
    });

    it('should detect question without toolCallResults', () => {
      const result = detectQuestion('请确认是否继续执行此操作');
      expect(result).toBeDefined();
    });
  });
});

describe('SubAgent AppError throw behavior', () => {
  const baseTask: Task = {
    id: 't1',
    requirement: 'test',
    status: 'pending',
    dependencies: [],
    dependents: [],
    createdAt: new Date(),
    retryCount: 0,
  };

  it('LLMError thrown by LLM is mapped to LlmError', async () => {
    class FailingLLMClient extends MockLLMClient {
      async generateWithTools(): Promise<{ content: string; toolCalls: any[] }> {
        throw new LLMError('RATE_LIMIT', 'too many', 429);
      }
    }
    const subAgent = new SubAgent(new MockSkillRegistry() as any, new FailingLLMClient() as any, undefined);
    const task = { ...baseTask, skillName: 'test-skill', params: {} };
    await expect(subAgent.execute(task)).rejects.toBeInstanceOf(LlmError);
  });

  it('non-LLM error is mapped to SkillError', async () => {
    class FailingLLMClient extends MockLLMClient {
      async generateWithTools(): Promise<{ content: string; toolCalls: any[] }> {
        throw new Error('boom');
      }
    }
    const subAgent = new SubAgent(new MockSkillRegistry() as any, new FailingLLMClient() as any, undefined);
    const task = { ...baseTask, skillName: 'test-skill', params: {} };
    await expect(subAgent.execute(task)).rejects.toBeInstanceOf(SkillError);
  });

  it('ENOENT error is mapped to BusinessError FILE_NOT_FOUND', async () => {
    class FailingLLMClient extends MockLLMClient {
      async generateWithTools(): Promise<{ content: string; toolCalls: any[] }> {
        const e: any = new Error('ENOENT: no such file');
        e.code = 'ENOENT';
        throw e;
      }
    }
    const subAgent = new SubAgent(new MockSkillRegistry() as any, new FailingLLMClient() as any, undefined);
    const task = { ...baseTask, skillName: 'test-skill', params: {} };
    try {
      await subAgent.execute(task);
      expect(true).toBe(false); // should have thrown
    } catch (e: any) {
      expect(e).toBeInstanceOf(BusinessError);
      expect(e.code).toBe('FILE_NOT_FOUND');
    }
  });
});
