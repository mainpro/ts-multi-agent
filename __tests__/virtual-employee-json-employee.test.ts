// __tests__/virtual-employee-json-employee.test.ts
/**
 * JsonVirtualEmployee 行为测试:
 *  - 4 个 hook(从 JSON 配置生成)
 *  - 模板变量 ${displayName} 替换
 *  - skillWhitelist allowlist / unrestricted 两种模式
 *  - resultRewriter 三种 transform
 */
import { describe, test, expect } from 'bun:test';
import { JsonVirtualEmployee } from '../src/agents/virtual-employee/json-employee';
import { parseJsonEmployeeConfig } from '../src/agents/virtual-employee/json-types';

/** Reflection helper:访问 protected 方法 */
function callProtected<T>(obj: any, method: string, ...args: any[]): T {
  return obj[method](...args) as T;
}

describe('JsonVirtualEmployee', () => {
  test('config 字段从 JSON 派生', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test',
      displayName: '测试员',
      intentKeywords: ['OA'],
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    expect(emp.config.id).toBe('test');
    expect(emp.config.displayName).toBe('测试员');
    expect(emp.config.intentKeywords).toEqual(['OA']);
  });

  test('systemPromptPrefix 替换 ${displayName} 模板变量', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test', displayName: '小李', intentKeywords: ['OA'],
      persona: { prefix: '你是「${displayName}」,欢迎咨询。' },
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    const prefix = callProtected<string>(emp, 'systemPromptPrefix');
    expect(prefix).toBe('你是「小李」,欢迎咨询。');
  });

  test('未配置 persona → prefix 为空字符串', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test', displayName: 'X', intentKeywords: ['OA'],
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    expect(callProtected<string>(emp, 'systemPromptPrefix')).toBe('');
  });

  test('skillWhitelist=allowlist → 返回 Set', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test', displayName: 'X', intentKeywords: ['OA'],
      skillWhitelist: { type: 'allowlist', skills: ['ees-qa', 'fawu'] },
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    const allowed = callProtected<Set<string> | null>(emp, 'allowedSkillNames');
    expect(allowed).toBeInstanceOf(Set);
    expect(allowed!.has('ees-qa')).toBe(true);
    expect(allowed!.has('fawu')).toBe(true);
    expect(allowed!.has('other-skill')).toBe(false);
  });

  test('skillWhitelist=unrestricted → 返回 null(不限制)', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test', displayName: 'X', intentKeywords: ['OA'],
      skillWhitelist: { type: 'unrestricted' },
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    expect(callProtected<Set<string> | null>(emp, 'allowedSkillNames')).toBeNull();
  });

  test('未配置 skillWhitelist → 默认 null(不限制)', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test', displayName: 'X', intentKeywords: ['OA'],
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    expect(callProtected<Set<string> | null>(emp, 'allowedSkillNames')).toBeNull();
  });

  test('resultRewriter.transform=append → 追加尾注', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test', displayName: 'X', intentKeywords: ['OA'],
      resultRewriter: { transform: 'append', value: '\n\n---\n转人工' },
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    const rewriter = callProtected<any>(emp, 'resultRewriter');
    expect(rewriter).not.toBeNull();
    expect(rewriter('原始结果')).toBe('原始结果\n\n---\n转人工');
  });

  test('resultRewriter.transform=passthrough → 不改写', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test', displayName: 'X', intentKeywords: ['OA'],
      resultRewriter: { transform: 'passthrough' },
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    const rewriter = callProtected<any>(emp, 'resultRewriter');
    expect(rewriter('原始结果')).toBe('原始结果');
  });

  test('resultRewriter.transform=replace → 完全替换', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test', displayName: 'X', intentKeywords: ['OA'],
      resultRewriter: { transform: 'replace', value: '统一回复' },
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    const rewriter = callProtected<any>(emp, 'resultRewriter');
    expect(rewriter('原始结果')).toBe('统一回复');
  });

  test('未配置 resultRewriter → 返回 null', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test', displayName: 'X', intentKeywords: ['OA'],
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    expect(callProtected<any>(emp, 'resultRewriter')).toBeNull();
  });

  test('configId() override 返回 JSON 里的 id', () => {
    const json = parseJsonEmployeeConfig(JSON.stringify({
      id: 'test-emp', displayName: 'X', intentKeywords: ['OA'],
    }));
    const emp = new JsonVirtualEmployee(json, null, null);
    expect(callProtected<string>(emp, 'configId')).toBe('test-emp');
  });
});
