/**
 * traceId 全链路日志关联测试
 *
 * 覆盖:
 *  - RequestContext.run 设置 traceId 后,Logger 自动注入到每条日志
 *  - RequestContext 外调用 Logger 时,traceId 字段缺失(不影响现有日志)
 *  - 跨模块调用(同一 RequestContext 内多次 log 调用)traceId 一致
 *  - getTraceId() 辅助函数正确返回
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { RequestContext, getTraceId } from '../src/context/request-context';
import { createLogger } from '../src/observability/logger';

describe('traceId 全链路日志关联', () => {
  let captured: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;

  beforeEach(() => {
    captured = [];
    console.log = (msg: string) => { captured.push(msg); };
    console.warn = (msg: string) => { captured.push(msg); };
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  });

  test('RequestContext.run 设置 traceId → Logger 自动注入', async () => {
    const log = createLogger({ module: 'Test' });
    await RequestContext.run({ traceId: 'trace-abc-123' }, async () => {
      log.info('hello');
    });
    expect(captured.length).toBe(1);
    const entry = JSON.parse(captured[0]);
    expect(entry.traceId).toBe('trace-abc-123');
    expect(entry.module).toBe('Test');
    expect(entry.message).toBe('hello');
  });

  test('RequestContext 外调用 → 不会注入 traceId(向后兼容)', async () => {
    const log = createLogger({ module: 'Test' });
    log.info('outside');
    expect(captured.length).toBe(1);
    const entry = JSON.parse(captured[0]);
    expect(entry.traceId).toBeUndefined();
  });

  test('跨模块调用(同一 context 内多个 logger 实例)traceId 一致', async () => {
    const moduleA = createLogger({ module: 'ModuleA' });
    const moduleB = createLogger({ module: 'ModuleB' });
    const moduleC = createLogger({ module: 'ModuleC' });

    await RequestContext.run({ traceId: 'trace-shared-xyz' }, async () => {
      moduleA.info('a-message');
      await Promise.resolve();
      moduleB.warn('b-message');
      moduleC.info('c-message', { extra: 'data' });
    });

    expect(captured.length).toBe(3);
    for (const raw of captured) {
      const entry = JSON.parse(raw);
      expect(entry.traceId).toBe('trace-shared-xyz');
    }
    expect(JSON.parse(captured[0]).module).toBe('ModuleA');
    expect(JSON.parse(captured[1]).module).toBe('ModuleB');
    expect(JSON.parse(captured[2]).module).toBe('ModuleC');
    expect(JSON.parse(captured[2]).extra).toBe('data');
  });

  test('显式传入的 traceId 覆盖 context 中的(优先级:显式 > context)', async () => {
    const log = createLogger({ module: 'Test' });
    await RequestContext.run({ traceId: 'context-trace' }, async () => {
      // 显式传 traceId: 'explicit-trace',应覆盖 context 的
      log.info('with-explicit', { traceId: 'explicit-trace' });
    });
    const entry = JSON.parse(captured[0]);
    expect(entry.traceId).toBe('explicit-trace');
  });

  test('getTraceId() 在 RequestContext 内返回正确值', async () => {
    await RequestContext.run({ traceId: 'trace-getter-test' }, async () => {
      expect(getTraceId()).toBe('trace-getter-test');
    });
    // 离开 context 后应返回 undefined
    expect(getTraceId()).toBeUndefined();
  });

  test('accessToken 与 traceId 共存于同一 context', async () => {
    const log = createLogger({ module: 'Test' });
    await RequestContext.run({ accessToken: 'tok-1', traceId: 'trace-coexist' }, async () => {
      log.info('both');
    });
    const entry = JSON.parse(captured[0]);
    expect(entry.traceId).toBe('trace-coexist');
    // accessToken 是 secret,不写入日志(避免泄漏)
    expect(entry.accessToken).toBeUndefined();
  });

  test('嵌套 RequestContext: 内层 traceId 覆盖外层', async () => {
    const log = createLogger({ module: 'Test' });
    await RequestContext.run({ traceId: 'outer-trace' }, async () => {
      log.info('in-outer');
      await RequestContext.run({ traceId: 'inner-trace' }, async () => {
        log.info('in-inner');
      });
      log.info('back-in-outer');
    });
    expect(captured.length).toBe(3);
    expect(JSON.parse(captured[0]).traceId).toBe('outer-trace');
    expect(JSON.parse(captured[1]).traceId).toBe('inner-trace');
    expect(JSON.parse(captured[2]).traceId).toBe('outer-trace');
  });
});