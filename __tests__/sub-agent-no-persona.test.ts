// __tests__/sub-agent-no-persona.test.ts
/**
 * Task 7: SubAgent 移除 4 个 persona hooks,改为读 task 上下文。
 *
 * 断言:
 *  - 4 个 hook(systemPromptPrefix / allowedSkillNames / resultRewriter / configId)在类上不存在
 *  - execute() 入口不再做 skill 白名单校验(无 skillName 时仍抛 MISSING_SKILL)
 *  - persona prefix 来自 task._personaContext(而不是 hook)
 *  - 工具过滤优先用 task.allowedTools
 */
import { describe, expect, test } from 'bun:test';
import { SubAgent } from '../src/agents/sub-agent';
import { SkillRegistry } from '../src/skill-registry';
import { ILLMClient } from '../src/llm';
import { Task, Skill } from '../src/types';

class StubLLM implements ILLMClient {
  readonly calls: { messages: { role: string; content: string }[]; tools?: unknown[] }[] = [];
  responseContent = 'stub-response';

  async generateText(): Promise<string> {
    throw new Error('generateText not expected here');
  }

  async generateStructured(): Promise<unknown> {
    throw new Error('generateStructured not expected here');
  }

  async generateWithTools(
    messages: { role: string; content: string }[],
    tools?: unknown[],
  ): Promise<{ content: string; toolCalls: unknown[]; messages: { role: string; content: string }[] }> {
    this.calls.push({ messages, tools });
    return { content: this.responseContent, toolCalls: [], messages };
  }
}

class StubSkillRegistry extends SkillRegistry {
  constructor(private readonly skill: Skill) {
    super();
  }

  async loadFullSkill(name: string): Promise<Skill | null> {
    return name === this.skill.name ? this.skill : null;
  }
}

const buildStubSkillRegistry = (allowedTools?: string[]) =>
  new StubSkillRegistry({
    name: 'test-skill',
    description: 'Test skill',
    body: 'ORIGINAL_SKILL_BODY_MARKER',
    ...(allowedTools ? { allowedTools } : {}),
  } as Skill);

describe('SubAgent persona hooks 已移除', () => {
  test('SubAgent 不再有 systemPromptPrefix 方法', () => {
    const sa = new SubAgent(buildStubSkillRegistry(), new StubLLM());
    expect((sa as any).systemPromptPrefix).toBeUndefined();
  });

  test('SubAgent 不再有 allowedSkillNames 方法', () => {
    const sa = new SubAgent(buildStubSkillRegistry(), new StubLLM());
    expect((sa as any).allowedSkillNames).toBeUndefined();
  });

  test('SubAgent 不再有 resultRewriter 方法', () => {
    const sa = new SubAgent(buildStubSkillRegistry(), new StubLLM());
    expect((sa as any).resultRewriter).toBeUndefined();
  });

  test('SubAgent 不再有 configId 方法', () => {
    const sa = new SubAgent(buildStubSkillRegistry(), new StubLLM());
    expect((sa as any).configId).toBeUndefined();
  });

  test('execute 入口不再校验 skill 白名单(无 skillName 仍抛 MISSING_SKILL)', async () => {
    const sa = new SubAgent(buildStubSkillRegistry(), new StubLLM());
    const task = { id: 't1', requirement: 'r', dependencies: [] } as unknown as Task;

    await expect(sa.execute(task)).rejects.toThrow(/MISSING_SKILL|No skill assigned/);
  });
});

describe('SubAgent 从 task._personaContext 读 persona', () => {
  test('task._personaContext.prefix 拼到 skill body 之前', async () => {
    const PREFIX = '>>> TASK_PERSONA_PREFIX_MARKER <<<';
    const llm = new StubLLM();
    const sa = new SubAgent(buildStubSkillRegistry(), llm);

    await sa.execute({
      id: 't1', requirement: 'do thing', skillName: 'test-skill',
      dependencies: [], sessionId: 's', userId: 'u',
      _personaContext: { prefix: PREFIX },
    } as unknown as Task);

    const systemMsg = llm.calls[0].messages.find(m => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain(PREFIX);
    expect(systemMsg!.content.indexOf(PREFIX))
      .toBeLessThan(systemMsg!.content.indexOf('ORIGINAL_SKILL_BODY_MARKER'));
  });

  test('task._personaContext.style / boundaries 追加到 skill body 之后', async () => {
    const llm = new StubLLM();
    const sa = new SubAgent(buildStubSkillRegistry(), llm);

    await sa.execute({
      id: 't2', requirement: 'do thing', skillName: 'test-skill',
      dependencies: [], sessionId: 's', userId: 'u',
      _personaContext: { prefix: 'P', style: 'STYLE_MARKER', boundaries: 'BOUNDARY_MARKER' },
    } as unknown as Task);

    const systemMsg = llm.calls[0].messages.find(m => m.role === 'system')!;
    expect(systemMsg.content).toContain('STYLE_MARKER');
    expect(systemMsg.content).toContain('BOUNDARY_MARKER');
    // style/boundaries 排在 skill body 之后
    expect(systemMsg.content.indexOf('ORIGINAL_SKILL_BODY_MARKER'))
      .toBeLessThan(systemMsg.content.indexOf('STYLE_MARKER'));
  });

  test('无 _personaContext 时 system prompt 不含额外 persona 段', async () => {
    const llm = new StubLLM();
    const sa = new SubAgent(buildStubSkillRegistry(), llm);

    await sa.execute({
      id: 't3', requirement: 'do thing', skillName: 'test-skill',
      dependencies: [], sessionId: 's', userId: 'u',
    } as unknown as Task);

    const systemMsg = llm.calls[0].messages.find(m => m.role === 'system')!;
    expect(systemMsg.content).toContain('ORIGINAL_SKILL_BODY_MARKER');
    expect(systemMsg.content).not.toContain('【风格】');
    expect(systemMsg.content).not.toContain('【边界】');
  });

  // 覆盖迁移自 sub-agent-template-method.test.ts 的断点续执行 persona 断言
  test('断点续执行路径同样注入 task._personaContext.prefix', async () => {
    const PREFIX = '>>> RESUME_PERSONA_MARKER <<<';
    const llm = new StubLLM();
    const sa = new SubAgent(buildStubSkillRegistry(), llm);

    await sa.execute({
      id: 't6', requirement: 'resume task', skillName: 'test-skill',
      dependencies: [], sessionId: 's', userId: 'u',
      _personaContext: { prefix: PREFIX },
      conversationContext: [
        { role: 'user' as const, content: 'prior user message' },
        { role: 'assistant' as const, content: 'prior assistant reply' },
      ],
    } as unknown as Task);

    const messages = llm.calls[0].messages;
    expect(messages.some(m => typeof m.content === 'string' && m.content.includes(PREFIX))).toBe(true);
    expect(messages.some(m => typeof m.content === 'string' && m.content.includes('ORIGINAL_SKILL_BODY_MARKER'))).toBe(true);
  });
});

describe('SubAgent 工具过滤优先用 task.allowedTools', () => {
  test('task.allowedTools 存在 → 覆盖 skill.allowedTools', async () => {
    const llm = new StubLLM();
    // skill 声明了 read+glob+grep,但 master 只放行 read
    const sa = new SubAgent(buildStubSkillRegistry(['read', 'glob', 'grep']), llm);

    await sa.execute({
      id: 't4', requirement: 'do thing', skillName: 'test-skill',
      dependencies: [], sessionId: 's', userId: 'u',
      allowedTools: ['read'],
    } as unknown as Task);

    const toolNames = (llm.calls[0].tools as Array<{ name: string }> | undefined)?.map(t => t.name) ?? [];
    expect(toolNames).toContain('read');
    expect(toolNames).not.toContain('glob');
    expect(toolNames).not.toContain('grep');
  });

  test('task.allowedTools 缺省 → 回退到 skill.allowedTools', async () => {
    const llm = new StubLLM();
    const sa = new SubAgent(buildStubSkillRegistry(['read', 'glob']), llm);

    await sa.execute({
      id: 't5', requirement: 'do thing', skillName: 'test-skill',
      dependencies: [], sessionId: 's', userId: 'u',
    } as unknown as Task);

    const toolNames = (llm.calls[0].tools as Array<{ name: string }> | undefined)?.map(t => t.name) ?? [];
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('glob');
    expect(toolNames).not.toContain('grep');
  });
});
