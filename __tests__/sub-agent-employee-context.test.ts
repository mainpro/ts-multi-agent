// __tests__/sub-agent-employee-context.test.ts
/**
 * SubAgent.setEmployeeContext / 日志带 employeeId 验证:
 *  - 默认 employeeId 是 'unknown'
 *  - setEmployeeContext(id) 后 this.employeeId = id
 *  - 后续 this.log.info 调用输出 JSON 带 employeeId 字段
 *  - unset 时(默认)不带 employeeId
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { SubAgent } from '../src/agents/sub-agent';

describe('SubAgent.setEmployeeContext', () => {
  let logSpy: any;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('默认 logger 不带 employeeId 字段', () => {
    const emp = new SubAgent(null as any, null as any);
    const log = (emp as any).log;
    log.info('default logger test');

    const output = logSpy.mock.calls[0][0] as string;
    const entry = JSON.parse(output);
    expect(entry.employeeId).toBeUndefined();
    expect(entry.message).toBe('default logger test');
  });

  test('setEmployeeContext(id) 后 this.log 被替换', () => {
    const emp = new SubAgent(null as any, null as any);
    const oldLog = (emp as any).log;
    emp.setEmployeeContext('it-ops-consultant');
    const newLog = (emp as any).log;
    expect(newLog).not.toBe(oldLog);  // 新的 child logger
  });

  test('setEmployeeContext 后 this.log 输出带 employeeId 字段', () => {
    const emp = new SubAgent(null as any, null as any);
    emp.setEmployeeContext('legal-assistant');

    // 反射访问 this.log
    const log = (emp as any).log;
    log.info('test message', { extra: 'data' });

    // 验证 console.log 被调用,参数是 JSON 字符串含 employeeId
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    const entry = JSON.parse(output);
    expect(entry.employeeId).toBe('legal-assistant');
    expect(entry.message).toBe('test message');
    expect(entry.extra).toBe('data');
    expect(entry.module).toBe('SubAgent');
  });

  test('未调 setEmployeeContext 时,日志不带 employeeId', () => {
    const emp = new SubAgent(null as any, null as any);
    const log = (emp as any).log;
    log.info('test message without ctx');

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    const entry = JSON.parse(output);
    expect(entry.employeeId).toBeUndefined();
    expect(entry.message).toBe('test message without ctx');
  });

  test('setEmployeeContext 可重入(切换 employee)', () => {
    const emp = new SubAgent(null as any, null as any);
    emp.setEmployeeContext('emp-A');
    emp.setEmployeeContext('emp-B');

    const log = (emp as any).log;
    log.info('after switch');
    const output = logSpy.mock.calls[0][0] as string;
    const entry = JSON.parse(output);
    expect(entry.employeeId).toBe('emp-B');
  });
});
