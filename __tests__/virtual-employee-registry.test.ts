// __tests__/virtual-employee-registry.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';

class EmployeeA extends VirtualEmployee {
  readonly config = { id: 'a', displayName: '员工 A', intentKeywords: ['OA'] };
}
class EmployeeB extends VirtualEmployee {
  readonly config = { id: 'b', displayName: '员工 B', intentKeywords: ['HR'] };
}

describe('VirtualEmployeeRegistry', () => {
  beforeEach(() => VirtualEmployeeRegistry._reset());

  test('register + getCtor 返回构造函数', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(VirtualEmployeeRegistry.getCtor('a')).toBe(EmployeeA);
  });

  test('重复注册同一 id 抛错', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(() => VirtualEmployeeRegistry.register('a', EmployeeA as any)).toThrow(/already registered/);
  });

  test('getDefaultCtor 返回 isDefault=true 的员工', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    VirtualEmployeeRegistry.register('b', EmployeeB as any, { isDefault: true });
    expect(VirtualEmployeeRegistry.getDefaultCtor()).toBe(EmployeeB);
  });

  test('没注册默认时 getDefaultCtor 返回 undefined', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(VirtualEmployeeRegistry.getDefaultCtor()).toBeUndefined();
  });

  test('list() 列出所有员工的 config', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    VirtualEmployeeRegistry.register('b', EmployeeB as any);
    const list = VirtualEmployeeRegistry.list();
    expect(list.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(list.find(c => c.id === 'a')?.displayName).toBe('员工 A');
  });

  test('getCtor 不存在 id 返回 undefined', () => {
    expect(VirtualEmployeeRegistry.getCtor('nonexistent')).toBeUndefined();
  });

  test('_reset 清空 registry', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    VirtualEmployeeRegistry._reset();
    expect(VirtualEmployeeRegistry.getCtor('a')).toBeUndefined();
  });
});
