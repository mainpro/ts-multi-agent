import { describe, expect, test } from 'bun:test';
import { parseEmployeeDirArg } from '../src/index';

describe('parseEmployeeDirArg', () => {
  test('argv 包含 --employees-dir=./custom → 返回 path', () => {
    expect(parseEmployeeDirArg(['node', 'index.js', '--employees-dir=./custom'])).toBe('./custom');
  });

  test('argv 包含 --employees-dir ./custom(空格分隔) → 返回 path', () => {
    expect(parseEmployeeDirArg(['node', 'index.js', '--employees-dir', './custom'])).toBe('./custom');
  });

  test('argv 不包含 --employees-dir → 返回 undefined', () => {
    expect(parseEmployeeDirArg(['node', 'index.js'])).toBeUndefined();
  });

  test('argv 包含 --employees-dir= (空值) → 返回 undefined', () => {
    expect(parseEmployeeDirArg(['node', 'index.js', '--employees-dir='])).toBeUndefined();
  });

  test('argv 包含 --help(非 employees-dir 参数)→ 返回 undefined', () => {
    expect(parseEmployeeDirArg(['node', 'index.js', '--help'])).toBeUndefined();
  });

  test('argv 中 --employees-dir 在中间位置 → 仍能找到', () => {
    expect(parseEmployeeDirArg(['node', 'index.js', '--port=3000', '--employees-dir=/etc/emp', '--verbose'])).toBe('/etc/emp');
  });
});