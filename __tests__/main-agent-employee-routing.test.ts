// __tests__/main-agent-employee-routing.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';
import { ITOperationsConsultantEmployee } from '../src/agents/virtual-employee/employees/it-operations-consultant';
import type { EmployeeConfig } from '../src/agents/virtual-employee/types';

class ITConsultant extends VirtualEmployee {
  static readonly config: EmployeeConfig = {
    id: 'it-ops-consultant',
    displayName: 'IT 运维顾问·小海',
    intentKeywords: ['OA'],
  };
  readonly config: EmployeeConfig = ITConsultant.config;
  protected allowedSkillNames() { return null; }
}

describe('MainAgent 虚拟员工路由', () => {
  beforeEach(() => {
    VirtualEmployeeRegistry._reset();
    VirtualEmployeeRegistry.register(
      'it-ops-consultant',
      ITConsultant,
      ITConsultant.config,
      { isDefault: true },
    );
  });

  test('启动后 registry 有默认员工', () => {
    const Ctor = VirtualEmployeeRegistry.getDefaultCtor();
    expect(Ctor).toBeDefined();
    expect(Ctor!.config.id).toBe('it-ops-consultant');
  });

  test('ITOperationsConsultantEmployee 类型可被 import 并有 static config', () => {
    // 验证 production 用的类:静态 config 字段可以直接读取,无需 new 实例
    expect(ITOperationsConsultantEmployee).toBeDefined();
    expect(ITOperationsConsultantEmployee.config.id).toBe('it-ops-consultant');
    expect(ITOperationsConsultantEmployee.config.intentKeywords).toContain('OA');
  });
});

