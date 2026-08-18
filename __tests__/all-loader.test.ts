import { describe, it, expect } from 'bun:test';
import { loadAllEnabledEmployees } from '../src/agents/employee/all-loader';
import { BootstrapError } from '../src/errors/bootstrap-error';

describe('loadAllEnabledEmployees', () => {
  it('加载目录中所有 enabled 员工', async () => {
    const reg = await loadAllEnabledEmployees({ directory: './employees', deps: {} as any });
    expect(reg.has('legal-assistant')).toBe(true);
    expect(reg.has('it-ops-consultant')).toBe(true);
    expect(reg.has('fallback-service-desk')).toBe(true);
  });

  it('加载完成后 defaultFallback() 可用', async () => {
    const reg = await loadAllEnabledEmployees({ directory: './employees', deps: {} as any });
    const fb = reg.defaultFallback();
    expect(fb.id).toBe('fallback-service-desk');
  });

  it('目录不存在抛 BootstrapError(NO_EMPLOYEE_CONFIG)', async () => {
    let caught: unknown;
    try {
      await loadAllEnabledEmployees({ directory: './nonexistent', deps: {} as any });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BootstrapError);
    expect((caught as BootstrapError).code).toBe('NO_EMPLOYEE_CONFIG');
  });
});