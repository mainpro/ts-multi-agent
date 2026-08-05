// __tests__/metrics-endpoint.test.ts
//
// Task 11: `/metrics` 端点测试
// - 200 OK
// - JSON 结构包含 timestamp / task / otel
// - task 字段覆盖 TaskQueue 的 getMetrics 五个统计
// - otel 字段可观察到 shadow buffer 中的 10 个 metric

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { EventEmitter } from 'events';
import { createAPIServer } from '../src/api/index';
import { initOtel, collectOtelMetrics, _resetShadowBuffer } from '../src/observability/otel';
import { llmCalls, guardrailDenied } from '../src/observability/metrics';

// Mock TaskQueue 只暴露 metrics 端点需要的三个方法,避免拉起真实 agent 链路。
class MockTaskQueue extends EventEmitter {
  getMetrics() {
    return {
      tasksCompleted: 5,
      tasksFailed: 1,
      tasksTimedOut: 0,
      averageExecutionTime: 123.4,
      totalExecutionTime: 740.4,
    };
  }
  getAllTasks() {
    return [];
  }
  getRunningCount() {
    return 0;
  }
}

const mockMainAgent = {} as any;
const mockSkillRegistry = { getAllMetadata: () => [] } as any;
const taskQueue = new MockTaskQueue();

describe('/metrics endpoint', () => {
  let server: ReturnType<ReturnType<typeof createAPIServer>['listen']>;
  let port: number;

  beforeAll(async () => {
    // 隔离 shadow buffer:避免上一组测试污染计数
    _resetShadowBuffer();
    initOtel();
    // 注入已知计数,方便断言
    llmCalls.add(3);
    guardrailDenied.add(2);

    const app = createAPIServer(mockMainAgent, mockSkillRegistry, taskQueue as any);
    server = app.listen(0);
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(() => {
    server?.close();
  });

  test('returns 200 with combined metrics (task + otel)', async () => {
    const res = await fetch(`http://localhost:${port}/metrics`);
    expect(res.status).toBe(200);
    const json = await res.json();

    // 顶层三个字段
    expect(typeof json.timestamp).toBe('string');
    expect(json.task).toBeDefined();
    expect(json.otel).toBeDefined();
  });

  test('task block contains the five getMetrics fields', async () => {
    const res = await fetch(`http://localhost:${port}/metrics`);
    const json = await res.json();

    expect(json.task.tasksCompleted).toBe(5);
    expect(json.task.tasksFailed).toBe(1);
    expect(json.task.tasksTimedOut).toBe(0);
    // averageExecutionTime / totalExecutionTime 走 Math.round → 整数
    expect(typeof json.task.averageExecutionTime).toBe('number');
    expect(json.task.averageExecutionTime).toBe(123);
    expect(json.task.totalExecutionTime).toBe(740);
  });

  test('otel block reflects counter accumulation', async () => {
    const res = await fetch(`http://localhost:${port}/metrics`);
    const json = await res.json();

    // otel 是 shadow buffer 浅拷贝,至少有 llm.calls + guardrail.denied
    expect(json.otel['llm.calls']).toBeDefined();
    expect((json.otel['llm.calls'] as { type: string }).type).toBe('counter');
    expect((json.otel['llm.calls'] as { count: number }).count).toBeGreaterThanOrEqual(3);

    expect(json.otel['guardrail.denied']).toBeDefined();
    expect((json.otel['guardrail.denied'] as { count: number }).count).toBeGreaterThanOrEqual(2);
  });

  test('collectOtelMetrics directly returns the same shape that the endpoint embeds', async () => {
    // 端点把 otelMetrics 整个对象作为 `otel` 字段返回,因此函数返回值与字段一致
    const snapshot = await collectOtelMetrics();
    expect(snapshot).toBeDefined();

    const res = await fetch(`http://localhost:${port}/metrics`);
    const json = await res.json();
    expect(json.otel).toEqual(snapshot);
  });
});
