import { describe, expect, test } from 'bun:test';
import { parseEmployeeArg } from '../src/index';

describe('parseEmployeeArg', () => {
  test('argv 包含 --employee=legal-assistant → 返回 id', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--employee=legal-assistant'])).toBe('legal-assistant');
  });

  test('argv 包含 --employee legal-assistant(空格分隔) → 返回 id', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--employee', 'legal-assistant'])).toBe('legal-assistant');
  });

  test('argv 不包含 --employee → 返回 undefined', () => {
    expect(parseEmployeeArg(['node', 'index.js'])).toBeUndefined();
  });

  test('argv 包含 --employee= (空值) → 返回 undefined', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--employee='])).toBeUndefined();
  });

  test('argv 包含 --help(非 employee 参数)→ 返回 undefined', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--help'])).toBeUndefined();
  });

  test('argv 中 --employee 在中间位置 → 仍能找到', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--port=3000', '--employee=foo', '--verbose'])).toBe('foo');
  });
});
