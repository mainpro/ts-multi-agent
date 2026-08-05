// __tests__/virtual-employee-it-ops-consultant.test.ts
import { describe, expect, test } from 'bun:test';
import { ITOperationsConsultantEmployee } from '../src/agents/virtual-employee/employees/it-operations-consultant';
import { SkillRegistry } from '../src/skill-registry';
import { ILLMClient } from '../src/llm';

class StubLLM implements ILLMClient {
  async generateWithTools() { return { content: '', toolCalls: [], messages: [] }; }
}

describe('ITOperationsConsultantEmployee', () => {
  const emp = new ITOperationsConsultantEmployee(new SkillRegistry(), new StubLLM() as any);

  test('config.id 和 displayName 正确', () => {
    expect(emp.config.id).toBe('it-ops-consultant');
    expect(emp.config.displayName).toContain('IT 运维顾问');
  });

  test('persona prefix 包含职责 / 边界 / 风格', () => {
    const prefix = (emp as any).systemPromptPrefix();
    expect(prefix).toContain('职责');
    expect(prefix).toContain('边界');
    expect(prefix).toContain('风格');
    expect(prefix).toContain('销售');  // 边界示例
  });

  test('allowedSkillNames 包含全部 7 个 IT skill', () => {
    const allowed = (emp as any).allowedSkillNames();
    expect(allowed).toBeInstanceOf(Set);
    expect(allowed.size).toBe(7);
    expect(allowed.has('ees-qa')).toBe(true);
    expect(allowed.has('fallback-service-desk')).toBe(true);
    expect(allowed.has('fawu')).toBe(true);
    expect(allowed.has('geam-qa')).toBe(true);
    expect(allowed.has('sulfuric-acid-price-prediction')).toBe(true);
    expect(allowed.has('time-management-qa')).toBe(true);
    expect(allowed.has('travel-expense-apply')).toBe(true);
  });

  test('resultRewriter 实际产出 = raw + 转人工提示', () => {
    const rewriter = (emp as any).resultRewriter();
    expect(typeof rewriter).toBe('function');
    const result = rewriter('这是解决方案');
    expect(result).toContain('这是解决方案');
    expect(result).toContain('转人工');
    expect(result).toContain('评价');
  });

  test('intentKeywords 覆盖 IT 高频关键词', () => {
    expect(emp.config.intentKeywords).toContain('OA');
    expect(emp.config.intentKeywords).toContain('VPN');
    expect(emp.config.intentKeywords).toContain('EES');
  });
});
