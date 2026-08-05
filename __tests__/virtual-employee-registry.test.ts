// __tests__/virtual-employee-registry.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';
import type { EmployeeConfig } from '../src/agents/virtual-employee/types';

class EmployeeA extends VirtualEmployee {
  static readonly config: EmployeeConfig = { id: 'a', displayName: '员工 A', intentKeywords: ['OA'] };
  readonly config: EmployeeConfig = EmployeeA.config;
}
class EmployeeB extends VirtualEmployee {
  static readonly config: EmployeeConfig = { id: 'b', displayName: '员工 B', intentKeywords: ['HR'] };
  readonly config: EmployeeConfig = EmployeeB.config;
}

describe('VirtualEmployeeRegistry', () => {
  beforeEach(() => VirtualEmployeeRegistry._reset());

  test('register + getCtor 返回构造函数', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA, EmployeeA.config);
    expect(VirtualEmployeeRegistry.getCtor('a')).toBe(EmployeeA);
  });

  test('重复注册同一 id 抛错', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA, EmployeeA.config);
    expect(() => VirtualEmployeeRegistry.register('a', EmployeeA, EmployeeA.config)).toThrow(/already registered/);
  });

  test('getDefaultCtor 返回 isDefault=true 的员工', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA, EmployeeA.config);
    VirtualEmployeeRegistry.register('b', EmployeeB, EmployeeB.config, { isDefault: true });
    expect(VirtualEmployeeRegistry.getDefaultCtor()).toBe(EmployeeB);
  });

  test('没注册默认时 getDefaultCtor 返回 undefined', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA, EmployeeA.config);
    expect(VirtualEmployeeRegistry.getDefaultCtor()).toBeUndefined();
  });

  test('list() 列出所有员工的 config(无需实例化)', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA, EmployeeA.config);
    VirtualEmployeeRegistry.register('b', EmployeeB, EmployeeB.config);
    const list = VirtualEmployeeRegistry.list();
    expect(list.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(list.find(c => c.id === 'a')?.displayName).toBe('员工 A');
  });

  test('list() 直接返回静态 config,不调用 constructor', () => {
    // 验证:即使 constructor 抛错,list() 也不受影响
    class CtorUnsafe extends VirtualEmployee {
      static readonly config: EmployeeConfig = { id: 'unsafe', displayName: 'X', intentKeywords: [] };
      readonly config: EmployeeConfig = CtorUnsafe.config;
      constructor() {
        super(null as any, null as any);
        throw new Error('constructor should not be called by list()');
      }
    }
    VirtualEmployeeRegistry.register('unsafe', CtorUnsafe, CtorUnsafe.config);
    expect(() => VirtualEmployeeRegistry.list()).not.toThrow();
    expect(VirtualEmployeeRegistry.list().find(c => c.id === 'unsafe')).toBeDefined();
  });

  test('getCtor 不存在 id 返回 undefined', () => {
    expect(VirtualEmployeeRegistry.getCtor('nonexistent')).toBeUndefined();
  });

  test('_reset 清空 registry', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA, EmployeeA.config);
    VirtualEmployeeRegistry._reset();
    expect(VirtualEmployeeRegistry.getCtor('a')).toBeUndefined();
  });
});
