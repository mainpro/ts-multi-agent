// __tests__/otel-bootstrap.test.ts
//
// Task 10: OpenTelemetry Bootstrap 冒烟测试
// - initOtel() 幂等初始化(MeterProvider + PrometheusExporter)
// - meter 实例可创建 Counter / Histogram
// - 9 个指标字典全量定义 + collectOtelMetrics 可读

import { describe, expect, test, beforeAll } from 'bun:test';
import { initOtel, meter, collectOtelMetrics } from '../src/observability/otel';
import {
  llmCalls,
  llmLatency,
  llmErrors,
  skillCalls,
  skillLatency,
  skillErrors,
  guardrailDenied,
  guardrailRewritten,
  guardrailAlerted,
  slaBreached,
  ALL_METRICS,
} from '../src/observability/metrics';

describe('OpenTelemetry bootstrap', () => {
  beforeAll(() => {
    initOtel();
  });

  test('meter is initialized', () => {
    expect(meter).toBeDefined();
  });

  test('can create counter', async () => {
    const counter = meter.createCounter('test.bootstrap.counter');
    expect(counter).toBeDefined();
    counter.add(1);
  });

  test('all 9 metric instances are defined', () => {
    expect(llmCalls).toBeDefined();
    expect(llmLatency).toBeDefined();
    expect(llmErrors).toBeDefined();
    expect(skillCalls).toBeDefined();
    expect(skillLatency).toBeDefined();
    expect(skillErrors).toBeDefined();
    expect(guardrailDenied).toBeDefined();
    expect(guardrailRewritten).toBeDefined();
    expect(guardrailAlerted).toBeDefined();
    expect(slaBreached).toBeDefined();
    expect(Object.keys(ALL_METRICS)).toHaveLength(10);
  });

  test('collectOtelMetrics returns JSON-friendly structure', async () => {
    llmCalls.add(3);
    llmErrors.add(1);
    llmLatency.record(42);
    llmLatency.record(58);

    const snapshot = await collectOtelMetrics();

    expect(snapshot['llm.calls']).toBeDefined();
    expect((snapshot['llm.calls'] as { type: string }).type).toBe('counter');
    expect((snapshot['llm.calls'] as { count: number }).count).toBeGreaterThanOrEqual(3);

    const latency = snapshot['llm.latency'] as { type: string; count: number; sum: number; min: number; max: number };
    expect(latency.type).toBe('histogram');
    expect(latency.count).toBeGreaterThanOrEqual(2);
    expect(latency.min).toBeLessThanOrEqual(42);
    expect(latency.max).toBeGreaterThanOrEqual(58);
  });
});
