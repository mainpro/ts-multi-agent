// __tests__/sla-watcher.test.ts
//
// 缺口 3.2: SLA Watcher 静默告警测试
//
// 验证:
//  1. start/end 记录耗时
//  2. check 返回 breached 状态
//  3. reportSlaBreach 通过 attributionCounter.inc 计数
//  4. 未启动的 requestId 返回 no-records
//  5. reportSlaBreach 同时触达 OTel slaBreached counter(缺口 4.3,Final Review fix #1)
//
// 注意:attributionCounter.inc({ kind: 'SLA_BREACH', type: kind }) 是 2-tag 形式,
// snapshot() 会用序列化 key 作为顶层 key(不是 kind 单一值),
// 所以断言用 'kind=SLA_BREACH&type=LLM' 形式,而不是 'LLM_TIMEOUT'。

import { describe, expect, test, beforeEach } from 'bun:test';
import { slaTracker, reportSlaBreach } from '../src/observability/sla-watcher';
import { attributionCounter } from '../src/observability/attribution';
import { collectOtelMetrics, _resetShadowBuffer } from '../src/observability/otel';

describe('SlaTracker', () => {
  beforeEach(() => {
    attributionCounter.reset();
    _resetShadowBuffer();
    // 清掉可能残留的 records
    slaTracker.clear('r-1');
    slaTracker.clear('r-2');
    slaTracker.clear('r-3');
    slaTracker.clear('not-started');
  });

  test('start/end records elapsed', () => {
    slaTracker.start('r-1', 1000);
    const check = slaTracker.check('r-1');
    expect(check.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(check.slaMs).toBe(1000);
    expect(check.breached).toBe(false);
    // cleanup
    slaTracker.clear('r-1');
  });

  test('check returns breached when over budget', async () => {
    slaTracker.start('r-2', 0);  // SLA=0 立即触发
    await new Promise((r) => setTimeout(r, 2));
    const check = slaTracker.check('r-2');
    expect(check.breached).toBe(true);
    expect(check.slaMs).toBe(0);
    // cleanup
    slaTracker.clear('r-2');
  });

  test('reportSlaBreach increments attribution counter', () => {
    reportSlaBreach('r-3', 'LLM', 5000, 3000);
    const counts = attributionCounter.snapshot();
    // 2-tag inc → 序列化为 'kind=SLA_BREACH&type=LLM'
    expect(counts).toHaveProperty('kind=SLA_BREACH&type=LLM');
    expect(counts['kind=SLA_BREACH&type=LLM']).toBe(1);
  });

  test('unknown request returns no-records', () => {
    const check = slaTracker.check('not-started');
    expect(check.breached).toBe(false);
    expect(check.elapsedMs).toBe(0);
    expect(check.slaMs).toBe(0);
  });

  test('mark with breached=true reports via attribution', () => {
    slaTracker.start('r-mark', 0);
    slaTracker.mark('r-mark', true);
    const counts = attributionCounter.snapshot();
    // mark() 调用 reportSlaBreach(..., 'GENERIC', ...)
    expect(counts).toHaveProperty('kind=SLA_BREACH&type=GENERIC');
  });

  test('mark with breached=false does NOT report', () => {
    slaTracker.start('r-mark-ok', 60000);
    slaTracker.mark('r-mark-ok', false);
    const counts = attributionCounter.snapshot();
    expect(Object.keys(counts)).toHaveLength(0);
  });

  test('reportSlaBreach also bumps OTel sla.breached counter (Final Review fix #1)', async () => {
    // Reset shadow buffer for clean baseline.
    _resetShadowBuffer();

    reportSlaBreach('r-otel-1', 'LLM', 5000, 3000);
    reportSlaBreach('r-otel-2', 'SKILL', 7000, 4000);
    reportSlaBreach('r-otel-3', 'LLM', 5500, 3000);

    const metrics = await collectOtelMetrics();
    // sla.breached is the OTel counter key registered in metrics.ts
    expect(metrics['sla.breached']).toBeDefined();
    expect(metrics['sla.breached'].type).toBe('counter');
    // 3 次 SLA breach → counter 应为 3
    expect((metrics['sla.breached'] as { type: 'counter'; count: number }).count).toBe(3);
  });

  test('mark with breached=true also bumps OTel sla.breached counter', async () => {
    _resetShadowBuffer();

    slaTracker.start('r-mark-otel', 0);
    slaTracker.mark('r-mark-otel', true);

    const metrics = await collectOtelMetrics();
    expect(metrics['sla.breached']).toBeDefined();
    expect((metrics['sla.breached'] as { type: 'counter'; count: number }).count).toBe(1);
  });
});