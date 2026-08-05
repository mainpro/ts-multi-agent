// __tests__/virtual-employee-resolver.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { VirtualEmployeeResolver } from '../src/agents/virtual-employee/resolver';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';

class EmployeeA extends VirtualEmployee {
  readonly config = { id: 'a', displayName: '员工 A', intentKeywords: ['OA'] };
}
class EmployeeB extends VirtualEmployee {
  readonly config = { id: 'b', displayName: '员工 B', intentKeywords: ['HR'] };
}
class ITConsultant extends VirtualEmployee {
  readonly config = { id: 'it-ops-consultant', displayName: 'IT 运维顾问·小海', intentKeywords: ['OA', 'VPN'] };
}

describe('VirtualEmployeeResolver', () => {
  beforeEach(() => VirtualEmployeeRegistry._reset());

  test('hintedId 命中 → 直接返回该员工实例', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    const emp = new VirtualEmployeeResolver().resolve({
      hintedId: 'a',
      userMessage: '随便',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('a');
  });

  test('@IT小海 → 通过 displayName 模糊匹配', () => {
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any);
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '@IT小海 我的 OA 登录不上',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('it-ops-consultant');
  });

  test('@it-ops-consultant → 直接按 id 命中', () => {
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any);
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '@it-ops-consultant 帮我',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('it-ops-consultant');
  });

  test('@ 提到不存在的员工 → 抛 UNKNOWN_EMPLOYEE', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(() => new VirtualEmployeeResolver().resolve({
      userMessage: '@ghost 帮我',
      skillRegistry: null, llm: null,
    })).toThrow(/UNKNOWN_EMPLOYEE/);
  });

  test('hintedId 不存在 → 抛 UNKNOWN_EMPLOYEE', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(() => new VirtualEmployeeResolver().resolve({
      hintedId: 'nonexistent',
      userMessage: '随便',
      skillRegistry: null, llm: null,
    })).toThrow(/UNKNOWN_EMPLOYEE/);
  });

  test('无 @ + 意图关键词命中 → 派给对应员工', () => {
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any);
    VirtualEmployeeRegistry.register('a', EmployeeA as any, { isDefault: true });
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '我的 OA 登录不上了',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('it-ops-consultant');
  });

  test('无 @ + 没命中意图 → 走默认员工', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any, { isDefault: true });
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '随便问点什么',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('a');
  });

  test('没注册默认 + 没命中意图 → 抛 NO_DEFAULT_EMPLOYEE', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(() => new VirtualEmployeeResolver().resolve({
      userMessage: '随便',
      skillRegistry: null, llm: null,
    })).toThrow(/NO_DEFAULT_EMPLOYEE/);
  });

  test('hintedId 优先于意图识别', () => {
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any);
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    const emp = new VirtualEmployeeResolver().resolve({
      hintedId: 'a',
      userMessage: '我的 OA 登录不上',  // 意图命中 IT 员工
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('a');  // 但 hintedId 优先
  });
});
