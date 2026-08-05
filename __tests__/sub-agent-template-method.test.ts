import { describe, expect, test } from 'bun:test';
import { SubAgent } from '../src/agents/sub-agent';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';
import { SkillRegistry } from '../src/skill-registry';
import { ILLMClient } from '../src/llm';
import { Task } from '../src/types';

class StubLLM implements ILLMClient {
  async generateWithTools() {
    return { content: 'stub response', toolCalls: [], messages: [] };
  }
}

describe('SubAgent template method hooks', () => {
  test('默认 SubAgent 的 allowedSkillNames 返回 null(向后兼容)', () => {
    const sa = new SubAgent(new SkillRegistry(), new StubLLM() as any);
    expect((sa as any).allowedSkillNames()).toBeNull();
  });

  test('默认 SubAgent 的 systemPromptPrefix 返回 ""(零行为差异)', () => {
    const sa = new SubAgent(new SkillRegistry(), new StubLLM() as any);
    expect((sa as any).systemPromptPrefix()).toBe('');
  });

  test('默认 SubAgent 的 resultRewriter 返回 null(passthrough)', () => {
    const sa = new SubAgent(new SkillRegistry(), new StubLLM() as any);
    expect((sa as any).resultRewriter()).toBeNull();
  });

  test('VirtualEmployee override allowedSkillNames → 不在白名单的 skill 抛 SKILL_NOT_ALLOWED', async () => {
    class StrictEmployee extends VirtualEmployee {
      readonly config = { id: 'strict', displayName: 'Strict', intentKeywords: [] };
      protected allowedSkillNames() { return new Set(['allowed-skill']); }
    }
    const emp = new StrictEmployee(new SkillRegistry(), new StubLLM() as any);
    const task = {
      id: 't1', requirement: 'r', skillName: 'forbidden-skill', sessionId: 's', userId: 'u',
    } as Task;
    // 验证:抛错 message 包含 '不允许调用 skill',且 code === 'SKILL_NOT_ALLOWED'
    try {
      await emp.execute(task);
      throw new Error('应该抛错但没有');
    } catch (err: any) {
      expect(err.code).toBe('SKILL_NOT_ALLOWED');
      expect(err.message).toMatch(/不允许调用 skill/);
    }
  });

  test('VirtualEmployee override allowedSkillNames → 白名单内的 skill 放行', async () => {
    class PermissiveEmployee extends VirtualEmployee {
      readonly config = { id: 'perm', displayName: 'Permissive', intentKeywords: [] };
      protected allowedSkillNames() { return new Set(['any-skill']); }
    }
    const emp = new PermissiveEmployee(new SkillRegistry(), new StubLLM() as any);
    const task = {
      id: 't1', requirement: 'r', skillName: 'any-skill', sessionId: 's', userId: 'u',
    } as Task;
    // 不抛 SKILL_NOT_ALLOWED(可能在 skill 加载时报 SKILL_NOT_FOUND,但不是 SKILL_NOT_ALLOWED)。
    // 验证方式:抛错 message 包含 'Skill not found',且 code 字段为 SKILL_NOT_FOUND
    // (用 try/catch 拿到完整 error 对象,确保不是 SKILL_NOT_ALLOWED)
    try {
      await emp.execute(task);
      throw new Error('应该抛错但没有');
    } catch (err: any) {
      expect(err.message).toMatch(/Skill not found/);
      expect(err.code).not.toBe('SKILL_NOT_ALLOWED');
    }
  });
});

describe('SubAgent result rewriting', () => {
  test('默认 SubAgent 不改写 result', async () => {
    const sa = new SubAgent(new SkillRegistry(), new StubLLM() as any);
    const task = {
      id: 't1', requirement: 'r', skillName: 'test-skill', sessionId: 's', userId: 'u',
    } as Task;
    // 期望抛 SKILL_NOT_FOUND,但不影响 rewrite 测试(rewrite 在抛错前不会跑)
    // 我们用 stub skill 验证更稳:这里只测 hook 调用默认行为
    const rewriter = (sa as any).resultRewriter();
    expect(rewriter).toBeNull();
  });
});
