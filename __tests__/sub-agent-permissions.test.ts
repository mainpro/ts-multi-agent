import { SubAgent } from '../src/agents/sub-agent';
import { SkillRegistry } from '../src/skill-registry';
import { LLMClient } from '../src/llm';
import { Task } from '../src/types';

// Mock LLMClient
class MockLLMClient implements LLMClient {
  async generateText(prompt: string, systemPrompt?: string): Promise<string> {
    return 'Test response';
  }

  async generateStructured<T>(prompt: string, schema: any, systemPrompt?: string): Promise<T> {
    return {} as T;
  }

  async generateWithTools(prompt: string, tools: any[], toolExecutor: any, systemPrompt?: string): Promise<{ content: string; toolCalls: any[] }> {
    // 检查传递的工具列表
    return {
      content: 'Test response',
      toolCalls: []
    };
  }
}

describe('SubAgent - Tool Permissions', () => {
  let subAgent: SubAgent;
  let skillRegistry: SkillRegistry;
  let llmClient: MockLLMClient;

  beforeEach(() => {
    llmClient = new MockLLMClient();
    skillRegistry = new SkillRegistry();
    subAgent = new SubAgent(skillRegistry, llmClient as any);
  });

  it('should use default safe tools when allowedTools is not defined', async () => {
    // Mock skill without allowedTools
    const mockSkill = {
      name: 'test-skill',
      description: 'Test skill',
      body: 'Test skill body',
      // No allowedTools defined
    };

    // Mock skillRegistry.loadFullSkill
    jest.spyOn(skillRegistry, 'loadFullSkill').mockResolvedValue(mockSkill as any);

    // Mock toolRegistry.list
    const mockToolRegistry = (subAgent as any).toolRegistry;
    jest.spyOn(mockToolRegistry, 'list').mockReturnValue([
      { name: 'conversation-get', description: 'Get conversation' },
      { name: 'read', description: 'Read file' },
      { name: 'glob', description: 'Glob files' },
      { name: 'grep', description: 'Grep files' },
      { name: 'bash', description: 'Execute bash' },
      { name: 'write', description: 'Write file' },
      { name: 'edit', description: 'Edit file' },
    ]);

    const task: Task = {
      id: 'test-task-1',
      requirement: 'Test requirement',
      status: 'pending',
      skillName: 'test-skill',
      params: {},
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      retryCount: 0,
    };

    // Mock generateWithTools to capture the tools parameter
    const generateWithToolsSpy = jest.spyOn(llmClient, 'generateWithTools');

    await subAgent.execute(task);

    // Check that generateWithTools was called with only safe tools
    expect(generateWithToolsSpy).toHaveBeenCalled();
    const calledWith = generateWithToolsSpy.mock.calls[0];
    const tools = calledWith[1];
    
    const toolNames = tools.map((tool: any) => tool.name);
    expect(toolNames).toContain('conversation-get');
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('glob');
    expect(toolNames).toContain('grep');
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('write');
    expect(toolNames).not.toContain('edit');
  });

  it('should use only allowed tools when allowedTools is defined', async () => {
    // Mock skill with allowedTools
    const mockSkill = {
      name: 'test-skill',
      description: 'Test skill',
      body: 'Test skill body',
      allowedTools: ['read', 'glob'],
    };

    // Mock skillRegistry.loadFullSkill
    jest.spyOn(skillRegistry, 'loadFullSkill').mockResolvedValue(mockSkill as any);

    // Mock toolRegistry.list
    const mockToolRegistry = (subAgent as any).toolRegistry;
    jest.spyOn(mockToolRegistry, 'list').mockReturnValue([
      { name: 'conversation-get', description: 'Get conversation' },
      { name: 'read', description: 'Read file' },
      { name: 'glob', description: 'Glob files' },
      { name: 'grep', description: 'Grep files' },
      { name: 'bash', description: 'Execute bash' },
    ]);

    const task: Task = {
      id: 'test-task-2',
      requirement: 'Test requirement',
      status: 'pending',
      skillName: 'test-skill',
      params: {},
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      retryCount: 0,
    };

    // Mock generateWithTools to capture the tools parameter
    const generateWithToolsSpy = jest.spyOn(llmClient, 'generateWithTools');

    await subAgent.execute(task);

    // Check that generateWithTools was called with only allowed tools
    expect(generateWithToolsSpy).toHaveBeenCalled();
    const calledWith = generateWithToolsSpy.mock.calls[0];
    const tools = calledWith[1];
    
    const toolNames = tools.map((tool: any) => tool.name);
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('glob');
    expect(toolNames).not.toContain('conversation-get');
    expect(toolNames).not.toContain('grep');
    expect(toolNames).not.toContain('bash');
  });

  it('should allow bash when explicitly included in allowedTools', async () => {
    // Mock skill with bash in allowedTools
    const mockSkill = {
      name: 'test-skill',
      description: 'Test skill',
      body: 'Test skill body',
      allowedTools: ['bash'],
    };

    // Mock skillRegistry.loadFullSkill
    jest.spyOn(skillRegistry, 'loadFullSkill').mockResolvedValue(mockSkill as any);

    // Mock toolRegistry.list
    const mockToolRegistry = (subAgent as any).toolRegistry;
    jest.spyOn(mockToolRegistry, 'list').mockReturnValue([
      { name: 'bash', description: 'Execute bash' },
      { name: 'read', description: 'Read file' },
    ]);

    const task: Task = {
      id: 'test-task-3',
      requirement: 'Test requirement',
      status: 'pending',
      skillName: 'test-skill',
      params: {},
      dependencies: [],
      dependents: [],
      createdAt: new Date(),
      retryCount: 0,
    };

    // Mock generateWithTools to capture the tools parameter
    const generateWithToolsSpy = jest.spyOn(llmClient, 'generateWithTools');

    await subAgent.execute(task);

    // Check that generateWithTools was called with bash
    expect(generateWithToolsSpy).toHaveBeenCalled();
    const calledWith = generateWithToolsSpy.mock.calls[0];
    const tools = calledWith[1];
    
    const toolNames = tools.map((tool: any) => tool.name);
    expect(toolNames).toContain('bash');
    expect(toolNames).not.toContain('read');
  });
});