/**
 * Fallback routing E2E tests.
 *
 * Verifies the silent-fallback contract for IntentRouter → routeIntentToEmployee:
 *   - LLM 返回不存在 employeeId → routeIntentToEmployee 静默兜底到 fallback-service-desk
 *   - intent=unclear → 兜底
 *   - 缺失 fallback → EmployeeRegistry.defaultBootstrap 抛 BootstrapError
 *
 * Test runner: bun test
 * Run: bun test __tests__/fallback-routing-e2e.test.ts
 */
import { describe, it, expect } from 'bun:test';
import { routeIntentToEmployee } from '../src/agents/employee/router';
import { EmployeeRegistry } from '../src/agents/employee/registry';
import { EmployeeAgent } from '../src/agents/employee/agent';

const mockDeps: any = {
  llm: {},
  memoryService: {},
  sessionStore: {},
  skillRegistry: {},
};

describe('兜底路由 E2E', () => {
  it('LLM 返回不存在 employeeId → 静默兜底', () => {
    const reg = new EmployeeRegistry();
    reg.register(new EmployeeAgent({
      employee: { id: 'fallback-service-desk', displayName: '兜底', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
    }, mockDeps));
    const agent = routeIntentToEmployee(
      { intent: 'skill_task', tasks: [], employeeId: 'unknown-employee' },
      reg,
    );
    expect(agent.id).toBe('fallback-service-desk');
  });

  it('intent=unclear → 兜底', () => {
    const reg = new EmployeeRegistry();
    reg.register(new EmployeeAgent({
      employee: { id: 'fallback-service-desk', displayName: '兜底', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
    }, mockDeps));
    const agent = routeIntentToEmployee(
      { intent: 'unclear', tasks: [] },
      reg,
    );
    expect(agent.id).toBe('fallback-service-desk');
  });

  it('fallback 缺失 → BootstrapError fail-fast(bootstrap 阶段)', () => {
    const reg = new EmployeeRegistry();
    expect(() => reg.defaultFallback()).toThrow(/FALLBACK_EMPLOYEE_MISSING/);
  });

  it('LLM 返回 undefined employeeId → 兜底', () => {
    const reg = new EmployeeRegistry();
    reg.register(new EmployeeAgent({
      employee: { id: 'legal-assistant', displayName: '法务', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
    }, mockDeps));
    reg.register(new EmployeeAgent({
      employee: { id: 'fallback-service-desk', displayName: '兜底', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
    }, mockDeps));
    // 多个 enabled 员工,LLM 没决定 → fallback
    const agent = routeIntentToEmployee(
      { intent: 'skill_task', tasks: [], employeeId: undefined as any },
      reg,
    );
    expect(agent.id).toBe('fallback-service-desk');
  });
});