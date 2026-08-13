import { describe, expect, test } from 'bun:test';
import { computeAllowedTools } from '../src/agents/employee/tools';

const DEFAULT_SAFE = ['conversation-get', 'read', 'glob', 'grep', 'ask_user'];

describe('computeAllowedTools', () => {
  test('skill.allowedTools 存在，无 employee tools → 用 skill 白名单', () => {
    const result = computeAllowedTools(['read', 'bash'], undefined);
    expect(result).toEqual(new Set(['read', 'bash']));
  });

  test('skill.allowedTools 为空数组，无 employee tools → 走 DEFAULT_SAFE_TOOLS', () => {
    const result = computeAllowedTools([], undefined);
    expect(result).toEqual(new Set(DEFAULT_SAFE));
  });

  test('skill.allowedTools 未定义，无 employee tools → 走 DEFAULT_SAFE_TOOLS', () => {
    const result = computeAllowedTools(undefined, undefined);
    expect(result).toEqual(new Set(DEFAULT_SAFE));
  });

  test('employee.tools.enabled 存在 → 与 skill 列表求交集', () => {
    const result = computeAllowedTools(
      ['read', 'bash', 'grep'],
      { enabled: ['read', 'grep'] },
    );
    expect(result).toEqual(new Set(['read', 'grep']));
  });

  test('employee.tools.enabled 与 skill 无交集 → 返回空集', () => {
    const result = computeAllowedTools(
      ['bash', 'curl'],
      { enabled: ['read'] },
    );
    expect(result).toEqual(new Set([]));
  });

  test('employee.tools.denied 存在 → 从 skill 列表差集', () => {
    const result = computeAllowedTools(
      ['read', 'bash', 'grep'],
      { denied: ['bash'] },
    );
    expect(result).toEqual(new Set(['read', 'grep']));
  });

  test('employee.tools.enabled 和 denied 同时存在 → 先交后差', () => {
    const result = computeAllowedTools(
      ['read', 'bash', 'grep', 'glob'],
      { enabled: ['read', 'grep', 'glob'], denied: ['grep'] },
    );
    expect(result).toEqual(new Set(['read', 'glob']));
  });

  test('黑名单优先级最高：即使在 enabled 列表中，也被排除', () => {
    const result = computeAllowedTools(
      ['send_email'],
      { enabled: ['send_email'], denied: ['send_email'] },
    );
    expect(result).toEqual(new Set([]));
  });

  test('skill.allowedTools 为空 + employee.tools.enabled 有值 → 交集(DEFAULT_SAFE ∩ enabled)', () => {
    const result = computeAllowedTools([], { enabled: ['read', 'bash'] });
    expect(result).toEqual(new Set(['read']));
  });
});
