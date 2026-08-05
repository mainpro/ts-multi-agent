import { describe, expect, test, spyOn } from 'bun:test';
import { SubAgent } from '../src/agents/sub-agent';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';
import { SkillRegistry } from '../src/skill-registry';
import { ILLMClient } from '../src/llm';
import { Task, Skill } from '../src/types';

/**
 * Minimal-but-complete ILLMClient stub.
 * - generateWithTools is the only method exercised by SubAgent.execute().
 * - generateText / generateStructured are stubbed to satisfy the interface but
 *   never invoked here; they throw so any accidental use surfaces clearly.
 */
class StubLLM implements ILLMClient {
  /** Captured messages from generateWithTools calls — used by integration tests. */
  readonly calls: { messages: { role: string; content: string }[] }[] = [];

  /** Override per-test to control the LLM response content. */
  responseContent = 'stub-response';

  async generateText(): Promise<string> {
    throw new Error('generateText not expected in template-method tests');
  }

  async generateStructured(): Promise<unknown> {
    throw new Error('generateStructured not expected in template-method tests');
  }

  async generateWithTools(
    messages: { role: string; content: string }[],
  ): Promise<{ content: string; toolCalls: unknown[]; messages: { role: string; content: string }[] }> {
    this.calls.push({ messages });
    return {
      content: this.responseContent,
      toolCalls: [],
      messages,
    };
  }
}

/**
 * SkillRegistry with one minimal valid skill pre-loaded, bypassing fs reads.
 * Avoids depending on real skills/ files in unit tests.
 */
class StubSkillRegistry extends SkillRegistry {
  constructor(private readonly skill: Skill) {
    super();
  }

  async loadFullSkill(name: string): Promise<Skill | null> {
    return name === this.skill.name ? this.skill : null;
  }
}

const buildStubSkillRegistry = () =>
  new StubSkillRegistry({
    name: 'test-skill',
    description: 'Test skill',
    body: 'ORIGINAL_SKILL_BODY_MARKER',
  });

describe('SubAgent template method hooks (default behavior)', () => {
  test('默认 SubAgent 的 allowedSkillNames 返回 null(向后兼容)', () => {
    const sa = new SubAgent(buildStubSkillRegistry(), new StubLLM());
    expect(sa.allowedSkillNames()).toBeNull();
  });

  test('默认 SubAgent 的 systemPromptPrefix 返回 ""(零行为差异)', () => {
    const sa = new SubAgent(buildStubSkillRegistry(), new StubLLM());
    expect(sa.systemPromptPrefix()).toBe('');
  });

  test('默认 SubAgent 的 resultRewriter 返回 null(passthrough)', () => {
    const sa = new SubAgent(buildStubSkillRegistry(), new StubLLM());
    expect(sa.resultRewriter()).toBeNull();
  });
});

describe('SubAgent template method hooks (skill whitelist)', () => {
  test('VirtualEmployee override allowedSkillNames → 不在白名单的 skill 抛 SKILL_NOT_ALLOWED', async () => {
    class StrictEmployee extends VirtualEmployee {
      readonly config = { id: 'strict', displayName: 'Strict', intentKeywords: [] };
      protected allowedSkillNames() { return new Set(['allowed-skill']); }
    }
    const emp = new StrictEmployee(buildStubSkillRegistry(), new StubLLM());
    const task = {
      id: 't1', requirement: 'r', skillName: 'forbidden-skill', sessionId: 's', userId: 'u',
    } as Task;
    try {
      await emp.execute(task);
      throw new Error('应该抛错但没有');
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      expect(e.code).toBe('SKILL_NOT_ALLOWED');
      expect(e.message).toMatch(/不允许调用 skill/);
    }
  });

  test('VirtualEmployee override allowedSkillNames → 白名单内的 skill 放行', async () => {
    class PermissiveEmployee extends VirtualEmployee {
      readonly config = { id: 'perm', displayName: 'Permissive', intentKeywords: [] };
      protected allowedSkillNames() { return new Set(['any-skill']); }
    }
    const emp = new PermissiveEmployee(buildStubSkillRegistry(), new StubLLM());
    const task = {
      id: 't1', requirement: 'r', skillName: 'any-skill', sessionId: 's', userId: 'u',
    } as Task;
    try {
      await emp.execute(task);
      throw new Error('应该抛错但没有');
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      expect(e.message).toMatch(/Skill not found/);
      expect(e.code).not.toBe('SKILL_NOT_ALLOWED');
    }
  });
});

describe('SubAgent template method integration — persona prefix', () => {
  test('persona prefix 拼到 skill.body 前,出现在首次执行的 system message 里', async () => {
    const PERSONA = '>>> PERSONA_INTRO_MARKER <<<';

    class PersonaEmployee extends VirtualEmployee {
      readonly config = { id: 'persona', displayName: 'Persona', intentKeywords: [] };
      protected systemPromptPrefix() { return PERSONA; }
    }

    const llm = new StubLLM();
    const emp = new PersonaEmployee(buildStubSkillRegistry(), llm);

    await emp.execute({
      id: 't1', requirement: 'do thing', skillName: 'test-skill',
      sessionId: 's', userId: 'u',
    } as Task);

    // 首次执行路径: 只有 system + user 两条消息;system 应包含 persona + ORIGINAL_SKILL_BODY_MARKER
    expect(llm.calls.length).toBe(1);
    const messages = llm.calls[0].messages;
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain(PERSONA);
    expect(systemMsg!.content).toContain('ORIGINAL_SKILL_BODY_MARKER');
    // persona 必须排在 skill body 之前
    const personaIdx = systemMsg!.content.indexOf(PERSONA);
    const bodyIdx = systemMsg!.content.indexOf('ORIGINAL_SKILL_BODY_MARKER');
    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(personaIdx).toBeLessThan(bodyIdx);
  });

  test('persona prefix 同样出现在断点续执行路径的 system message 里', async () => {
    const PERSONA = '>>> RESUME_PERSONA_MARKER <<<';

    class PersonaResumeEmployee extends VirtualEmployee {
      readonly config = { id: 'pr', displayName: 'PR', intentKeywords: [] };
      protected systemPromptPrefix() { return PERSONA; }
    }

    const llm = new StubLLM();
    const emp = new PersonaResumeEmployee(buildStubSkillRegistry(), llm);

    // 注入已存在的 conversationContext,触发断点续执行分支
    const savedContext = [
      { role: 'user' as const, content: 'prior user message' },
      { role: 'assistant' as const, content: 'prior assistant reply' },
    ];
    await emp.execute({
      id: 't2', requirement: 'resume task', skillName: 'test-skill',
      sessionId: 's', userId: 'u',
      conversationContext: savedContext,
    } as Task);

    expect(llm.calls.length).toBe(1);
    const messages = llm.calls[0].messages;
    // 断点续路径下,buildResumedContext 会把 refreshed system prompt 拼成第一条
    // 这里只要 messages 任一处含 PERSONA + ORIGINAL_SKILL_BODY_MARKER 即可
    const hasPersona = messages.some(m => typeof m.content === 'string' && m.content.includes(PERSONA));
    const hasBody = messages.some(m => typeof m.content === 'string' && m.content.includes('ORIGINAL_SKILL_BODY_MARKER'));
    expect(hasPersona).toBe(true);
    expect(hasBody).toBe(true);
  });
});

describe('SubAgent template method integration — result rewriter', () => {
  test('resultRewriter 实际改写 finalResult.data.response', async () => {
    const APPENDED = '<<< REWRITER_APPENDED >>>';
    const RAW = 'raw LLM response';

    class RewritingEmployee extends VirtualEmployee {
      readonly config = { id: 'rw', displayName: 'RW', intentKeywords: [] };
      protected resultRewriter() {
        return (raw: string) => `${raw} ${APPENDED}`;
      }
    }

    const llm = new StubLLM();
    llm.responseContent = RAW;
    const emp = new RewritingEmployee(buildStubSkillRegistry(), llm);

    const result = await emp.execute({
      id: 't3', requirement: 'run', skillName: 'test-skill',
      sessionId: 's', userId: 'u',
    } as Task);

    expect(result.success).toBe(true);
    const data = result.data as { response?: string };
    expect(data.response).toBe(`${RAW} ${APPENDED}`);
    // 避免结果改写器创建新内容时恰好与原内容相同导致测试误过
    expect(data.response).not.toBe(RAW);
  });

  // 修复 Final Review Minor #1: rewriter 不应对 waiting_user_input 的提问文本起作用
  test('resultRewriter 在 waiting_user_input 状态不被调用(避免给提问追加"转人工"尾注)', async () => {
    const APPENDED = '<<< SHOULD_NOT_APPEAR >>>';
    const QUESTION = '请问您遇到的是什么具体问题?';
    let rewriterCalled = false;

    class WaitingRewritingEmployee extends VirtualEmployee {
      readonly config = { id: 'wr', displayName: 'WR', intentKeywords: [] };
      protected resultRewriter() {
        return (raw: string) => {
          rewriterCalled = true;
          return `${raw} ${APPENDED}`;
        };
      }
      // 用 SubAgent 子类 stub executeSkill 直接返回 waiting_user_input,
      // 绕开 ask_user 工具检测的复杂 setup;这是合法且更轻量的单元级断言。
      protected async executeSkill(): Promise<unknown> {
        return {
          response: QUESTION,
          status: 'waiting_user_input',
          question: { type: 'skill_question', content: QUESTION },
        };
      }
    }

    const emp = new WaitingRewritingEmployee(buildStubSkillRegistry(), new StubLLM());
    const result = await emp.execute({
      id: 't4', requirement: 'ask', skillName: 'test-skill',
      sessionId: 's', userId: 'u',
    } as Task);

    expect(result.success).toBe(true);
    const data = result.data as { response?: string; status?: string };
    expect(data.status).toBe('waiting_user_input');
    expect(data.response).toBe(QUESTION);
    expect(data.response).not.toContain(APPENDED);
    expect(rewriterCalled).toBe(false);
  });
});

// Suppress the unused-spyon warning by re-exporting it; tests below don't need
// it directly but the import kept to make future hook-spying tests easy to add.
void spyOn;
