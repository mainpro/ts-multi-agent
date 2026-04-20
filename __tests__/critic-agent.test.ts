import { CriticAgent } from '../src/agents/critic-agent';
import { LLMClient } from '../src/llm';
import { Task, TaskError } from '../src/types';
import { ProfessionalSkillRegistry } from '../src/skill-registry/professional-skill-registry';

// Mock LLM Client
class MockLLMClient extends LLMClient {
  async complete(params: any): Promise<any> {
    return {
      content: JSON.stringify({
        hasHallucination: false,
        confidence: 0.9,
        issues: [],
        suggestions: []
      })
    };
  }
}

describe('CriticAgent', () => {
  let criticAgent: CriticAgent;
  let llmClient: LLMClient;
  let professionalSkillRegistry: ProfessionalSkillRegistry;

  beforeEach(() => {
    llmClient = new MockLLMClient();
    criticAgent = new CriticAgent(llmClient);
    professionalSkillRegistry = new ProfessionalSkillRegistry();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      // This test just verifies that initialize doesn't throw
      await expect(criticAgent.initialize()).resolves.not.toThrow();
    });
  });

  describe('reviewTask', () => {
    it('should review a completed task', async () => {
      await criticAgent.initialize();
      const task: Task = {
        id: 'test-task-1',
        requirement: 'Test task',
        skillName: 'test-skill',
        dependencies: [],
        status: 'completed',
        result: {
          success: true,
          data: {
            response: 'Test response'
          }
        },
        createdAt: new Date(),
        completedAt: new Date()
      };

      const analysis = await criticAgent.reviewTask(task);
      expect(analysis).toBeDefined();
      expect(analysis.taskId).toBe('test-task-1');
      expect(analysis.agentType).toBe('sub');
      expect(analysis.issues).toBeInstanceOf(Array);
      expect(analysis.solutions).toBeInstanceOf(Array);
      expect(analysis.confidence).toBeGreaterThanOrEqual(0);
      expect(analysis.confidence).toBeLessThanOrEqual(1);
    });

    it('should review a failed task', async () => {
      await criticAgent.initialize();
      const task: Task = {
        id: 'test-task-2',
        requirement: 'Test task',
        skillName: 'test-skill',
        dependencies: [],
        status: 'failed',
        error: {
          type: 'RETRYABLE',
          message: 'Test error',
          code: 'TEST_ERROR'
        },
        createdAt: new Date(),
        completedAt: new Date()
      };

      const analysis = await criticAgent.reviewTask(task);
      expect(analysis).toBeDefined();
      expect(analysis.taskId).toBe('test-task-2');
      expect(analysis.agentType).toBe('sub');
      expect(analysis.issues).toBeInstanceOf(Array);
    });

    it('should analyze execution path', async () => {
      await criticAgent.initialize();
      const task: Task = {
        id: 'test-task-3',
        requirement: 'Test task',
        skillName: 'test-skill',
        dependencies: [],
        status: 'completed',
        result: {
          success: true,
          data: {
            response: 'Test response'
          }
        },
        executionPath: [
          {
            step: 'step1',
            timestamp: new Date(),
            result: 'success'
          },
          {
            step: 'step2',
            timestamp: new Date(),
            result: 'failure'
          },
          {
            step: 'step3',
            timestamp: new Date(),
            result: 'success'
          }
        ],
        createdAt: new Date(),
        completedAt: new Date()
      };

      const analysis = await criticAgent.reviewTask(task);
      expect(analysis).toBeDefined();
      expect(analysis.issues).toBeInstanceOf(Array);
    });

    it('should analyze error history', async () => {
      await criticAgent.initialize();
      const error: TaskError = {
        type: 'RETRYABLE',
        message: 'Test error',
        code: 'TEST_ERROR'
      };

      const task: Task = {
        id: 'test-task-4',
        requirement: 'Test task',
        skillName: 'test-skill',
        dependencies: [],
        status: 'failed',
        error,
        errorHistory: [
          {
            error,
            attemptedSolutions: [],
            timestamp: new Date()
          },
          {
            error,
            attemptedSolutions: [],
            timestamp: new Date()
          }
        ],
        createdAt: new Date(),
        completedAt: new Date()
      };

      const analysis = await criticAgent.reviewTask(task);
      expect(analysis).toBeDefined();
      expect(analysis.solutions).toBeInstanceOf(Array);
    });
  });

  describe('reviewTasks', () => {
    it('should review multiple tasks', async () => {
      await criticAgent.initialize();
      const tasks: Task[] = [
        {
          id: 'test-task-5',
          requirement: 'Test task 1',
          skillName: 'test-skill',
          dependencies: [],
          status: 'completed',
          result: {
            success: true,
            data: {
              response: 'Test response 1'
            }
          },
          createdAt: new Date(),
          completedAt: new Date()
        },
        {
          id: 'test-task-6',
          requirement: 'Test task 2',
          skillName: 'test-skill',
          dependencies: [],
          status: 'failed',
          error: {
            type: 'RETRYABLE',
            message: 'Test error',
            code: 'TEST_ERROR'
          },
          createdAt: new Date(),
          completedAt: new Date()
        }
      ];

      const analyses = await criticAgent.reviewTasks(tasks);
      expect(analyses).toBeInstanceOf(Array);
      expect(analyses.length).toBe(2);
    });
  });
});

describe('ProfessionalSkillRegistry', () => {
  let registry: ProfessionalSkillRegistry;

  beforeEach(() => {
    registry = new ProfessionalSkillRegistry();
  });

  describe('scanProfessionalSkills', () => {
    it('should scan professional skills', async () => {
      const skills = await registry.scanProfessionalSkills();
      expect(skills).toBeInstanceOf(Array);
      // Should find at least the hallucination-detector and error-analyzer skills
      const skillNames = skills.map(skill => skill);
      expect(skillNames).toContain('hallucination-detector');
      expect(skillNames).toContain('error-analyzer');
    });
  });

  describe('getProfessionalSkillNames', () => {
    it('should return professional skill names', async () => {
      await registry.scanProfessionalSkills();
      const skillNames = registry.getProfessionalSkillNames();
      expect(skillNames).toBeInstanceOf(Array);
    });
  });

  describe('hasProfessionalSkill', () => {
    it('should check if professional skill exists', async () => {
      await registry.scanProfessionalSkills();
      expect(registry.hasProfessionalSkill('hallucination-detector')).toBe(true);
      expect(registry.hasProfessionalSkill('error-analyzer')).toBe(true);
      expect(registry.hasProfessionalSkill('non-existent-skill')).toBe(false);
    });
  });
});