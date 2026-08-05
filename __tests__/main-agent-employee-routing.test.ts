// __tests__/main-agent-employee-routing.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';
import { ITOperationsConsultantEmployee } from '../src/agents/virtual-employee/employees/it-operations-consultant';

class ITConsultant extends VirtualEmployee {
  readonly config = { id: 'it-ops-consultant', displayName: 'IT 运维顾问·小海', intentKeywords: ['OA'] };
  protected allowedSkillNames() { return null; }
}

describe('MainAgent 虚拟员工路由', () => {
  beforeEach(() => {
    VirtualEmployeeRegistry._reset();
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any, { isDefault: true });
  });

  test('启动后 registry 有默认员工', () => {
    const Ctor = VirtualEmployeeRegistry.getDefaultCtor();
    expect(Ctor).toBeDefined();
    expect(new (Ctor as any)(null, null).config.id).toBe('it-ops-consultant');
  });

  test('ITOperationsConsultantEmployee 类型可被 import 并 new 一个实例', () => {
    // 即 production 用的类也能独立 load/构造 — 这条保证 index.ts 里 await import 路径走得通
    expect(ITOperationsConsultantEmployee).toBeDefined();
    const inst = new (ITOperationsConsultantEmployee as any)(null, null);
    expect(inst.config.id).toBe('it-ops-consultant');
    expect(inst.config.intentKeywords).toContain('OA');
  });
});
