// __tests__/virtual-employee-json-types.test.ts
/**
 * JSON Config schema 验证测试:
 *  - 字段缺失 / 类型错误 → fail-fast
 *  - resultRewriter.transform=append 必须有 value
 *  - enabled=false 应被 loader 跳过
 */
import { describe, test, expect } from 'bun:test';
import { JsonEmployeeConfigSchema, parseJsonEmployeeConfig } from '../src/agents/virtual-employee/json-types';

const validJson = JSON.stringify({
  id: 'test-emp',
  displayName: '测试员工',
  intentKeywords: ['OA', 'VPN'],
  enabled: true,
  isDefault: false,
  persona: { prefix: '你是「${displayName}」。' },
  skillWhitelist: { type: 'allowlist', skills: ['ees-qa'] },
  resultRewriter: {
    match: { status: 'completed' },
    transform: 'append',
    value: '\n\n末尾。',
  },
});

describe('JsonEmployeeConfigSchema', () => {
  test('完整合法 JSON 通过校验', () => {
    const config = parseJsonEmployeeConfig(validJson);
    expect(config.id).toBe('test-emp');
    expect(config.intentKeywords).toEqual(['OA', 'VPN']);
    expect(config.skillWhitelist).toEqual({ type: 'allowlist', skills: ['ees-qa'] });
  });

  test('缺少 id 字段 → 抛 ZodError', () => {
    const bad = JSON.stringify({ displayName: 'X', intentKeywords: ['OA'] });
    expect(() => parseJsonEmployeeConfig(bad)).toThrow();
  });

  test('缺少 displayName 字段 → 抛 ZodError', () => {
    const bad = JSON.stringify({ id: 'x', intentKeywords: ['OA'] });
    expect(() => parseJsonEmployeeConfig(bad)).toThrow();
  });

  test('intentKeywords 为空数组 → 抛 ZodError(至少 1 个关键词)', () => {
    const bad = JSON.stringify({ id: 'x', displayName: 'X', intentKeywords: [] });
    expect(() => parseJsonEmployeeConfig(bad)).toThrow();
  });

  test('resultRewriter.transform=append 但无 value → 抛 ZodError', () => {
    const bad = JSON.stringify({
      id: 'x', displayName: 'X', intentKeywords: ['OA'],
      resultRewriter: { transform: 'append' },
    });
    expect(() => parseJsonEmployeeConfig(bad)).toThrow(/value 必填/);
  });

  test('resultRewriter.transform=passthrough 不必 value', () => {
    const ok = JSON.stringify({
      id: 'x', displayName: 'X', intentKeywords: ['OA'],
      resultRewriter: { transform: 'passthrough' },
    });
    expect(() => parseJsonEmployeeConfig(ok)).not.toThrow();
  });

  test('resultRewriter.transform=replace', () => {
    const ok = JSON.stringify({
      id: 'x', displayName: 'X', intentKeywords: ['OA'],
      resultRewriter: { transform: 'replace', value: 'replaced' },
    });
    expect(() => parseJsonEmployeeConfig(ok)).not.toThrow();
  });

  test('未指定 enabled 默认 true', () => {
    const config = parseJsonEmployeeConfig(JSON.stringify({
      id: 'x', displayName: 'X', intentKeywords: ['OA'],
    }));
    expect(config.enabled).toBe(true);
  });

  test('未指定 isDefault 默认 false', () => {
    const config = parseJsonEmployeeConfig(JSON.stringify({
      id: 'x', displayName: 'X', intentKeywords: ['OA'],
    }));
    expect(config.isDefault).toBe(false);
  });

  test('skillWhitelist.type=unrestricted 表示不限制', () => {
    const config = parseJsonEmployeeConfig(JSON.stringify({
      id: 'x', displayName: 'X', intentKeywords: ['OA'],
      skillWhitelist: { type: 'unrestricted' },
    }));
    expect(config.skillWhitelist).toEqual({ type: 'unrestricted' });
  });

  test('合法 JSON 校验但字段都是 optional(persona / skillWhitelist / resultRewriter)', () => {
    const minimal = JSON.stringify({
      id: 'x', displayName: 'X', intentKeywords: ['OA'],
    });
    const config = parseJsonEmployeeConfig(minimal);
    expect(config.persona).toBeUndefined();
    expect(config.skillWhitelist).toBeUndefined();
    expect(config.resultRewriter).toBeUndefined();
  });
});
