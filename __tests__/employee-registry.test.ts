import { describe, it, expect } from 'bun:test';
import { EmployeeRegistry } from '../src/agents/employee/registry';
import { EmployeeAgent } from '../src/agents/employee/agent';
import { routeIntentToEmployee } from '../src/agents/employee/router';
import type { EmployeeConfig } from '../src/agents/employee/json-types';

const enabled = (id: string): EmployeeConfig => ({
  employee: { id, displayName: id, enabled: true },
  capabilities: { llm: { provider: 'haier' } },
});

const disabled = (id: string): EmployeeConfig => ({
  employee: { id, displayName: id, enabled: false },
  capabilities: { llm: { provider: 'haier' } },
});

const fallback = (): EmployeeConfig => ({
  ...enabled('fallback-service-desk'),
  persona: { prefix: '我是 ${displayName},兜底处理' },
});

const mockDeps: any = { llm: {}, memoryService: {}, sessionStore: {}, skillRegistry: {} };

describe('EmployeeRegistry', () => {
  describe('register / get / has', () => {
    it('register 后 get 返回同一实例', () => {
      const reg = new EmployeeRegistry();
      const agent = new EmployeeAgent(enabled('legal'), mockDeps);
      reg.register(agent);
      expect(reg.get('legal')).toBe(agent);
      expect(reg.has('legal')).toBe(true);
    });

    it('未注册时 get 返回 undefined', () => {
      const reg = new EmployeeRegistry();
      expect(reg.get('legal')).toBeUndefined();
      expect(reg.has('legal')).toBe(false);
    });

    it('重复注册抛 BootstrapError(DUPLICATE_EMPLOYEE)', () => {
      const reg = new EmployeeRegistry();
      reg.register(new EmployeeAgent(enabled('legal'), mockDeps));
      expect(() => reg.register(new EmployeeAgent(enabled('legal'), mockDeps)))
        .toThrow(/DUPLICATE_EMPLOYEE/);
    });
  });

  describe('list', () => {
    it('只返回 enabled 员工', () => {
      const reg = new EmployeeRegistry();
      reg.register(new EmployeeAgent(enabled('legal'), mockDeps));
      reg.register(new EmployeeAgent(disabled('hidden'), mockDeps));
      reg.register(new EmployeeAgent(enabled('it'), mockDeps));
      const ids = reg.list().map(a => a.id);
      expect(ids).toContain('legal');
      expect(ids).toContain('it');
      expect(ids).not.toContain('hidden');
    });
  });

  describe('defaultFallback', () => {
    it('找到 fallback-service-desk 时返回它', () => {
      const reg = new EmployeeRegistry();
      reg.register(new EmployeeAgent(enabled('legal'), mockDeps));
      reg.register(new EmployeeAgent(fallback(), mockDeps));
      const fb = reg.defaultFallback();
      expect(fb.id).toBe('fallback-service-desk');
    });

    it('缺失 fallback 时抛 BootstrapError(FALLBACK_EMPLOYEE_MISSING)', () => {
      const reg = new EmployeeRegistry();
      reg.register(new EmployeeAgent(enabled('legal'), mockDeps));
      expect(() => reg.defaultFallback())
        .toThrow(/FALLBACK_EMPLOYEE_MISSING/);
    });

    it('fallback 是 enabled=false 时抛 BootstrapError(FALLBACK_EMPLOYEE_DISABLED)', () => {
      const reg = new EmployeeRegistry();
      reg.register(new EmployeeAgent(disabled('fallback-service-desk'), mockDeps));
      expect(() => reg.defaultFallback())
        .toThrow(/FALLBACK_EMPLOYEE_DISABLED/);
    });
  });

  describe('listForLLM', () => {
    it('返回 {id, brief} 数组,只含 enabled', () => {
      const reg = new EmployeeRegistry();
      reg.register(new EmployeeAgent(enabled('legal'), mockDeps));
      reg.register(new EmployeeAgent({ ...enabled('it'), employee: { ...enabled('it').employee, displayName: 'IT 运维' } }, mockDeps));
      const ll = reg.listForLLM();
      expect(ll).toContainEqual({ id: 'legal', brief: 'legal' });
      expect(ll).toContainEqual({ id: 'it', brief: 'IT 运维' });
    });
  });
});

describe('routeIntentToEmployee', () => {
  it('LLM 返回有效 employeeId → 返回对应 EmployeeAgent', () => {
    const reg = new EmployeeRegistry();
    const legalAgent = new EmployeeAgent(enabled('legal-assistant'), mockDeps);
    const fallbackAgent = new EmployeeAgent(fallback(), mockDeps);
    reg.register(legalAgent);
    reg.register(fallbackAgent);
    const result = routeIntentToEmployee(
      { intent: 'skill_task', tasks: [], employeeId: 'legal-assistant' },
      reg,
    );
    expect(result.id).toBe('legal-assistant');
  });

  it('LLM 不返回 employeeId → 兜底到 fallback', () => {
    const reg = new EmployeeRegistry();
    reg.register(new EmployeeAgent(enabled('legal'), mockDeps));
    reg.register(new EmployeeAgent(fallback(), mockDeps));
    const result = routeIntentToEmployee(
      { intent: 'small_talk', tasks: [] },
      reg,
    );
    expect(result.id).toBe('fallback-service-desk');
  });

  it('LLM 返回不存在的 employeeId → 兜底到 fallback + 打 warn', () => {
    const reg = new EmployeeRegistry();
    reg.register(new EmployeeAgent(fallback(), mockDeps));
    const result = routeIntentToEmployee(
      { intent: 'skill_task', tasks: [], employeeId: 'unknown' },
      reg,
    );
    expect(result.id).toBe('fallback-service-desk');
  });

  it('intent === "unclear" → 兜底到 fallback', () => {
    const reg = new EmployeeRegistry();
    reg.register(new EmployeeAgent(enabled('legal'), mockDeps));
    reg.register(new EmployeeAgent(fallback(), mockDeps));
    const result = routeIntentToEmployee(
      { intent: 'unclear', tasks: [] },
      reg,
    );
    expect(result.id).toBe('fallback-service-desk');
  });
});
