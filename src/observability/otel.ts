// src/observability/otel.ts
//
// 缺口 4.1: OpenTelemetry Bootstrap
//
// - initOtel(): 幂等初始化 MeterProvider + PrometheusExporter
//   (preventServerStart: true,生产环境可改 false 暴露 /metrics endpoint)
// - meter: 全局 Meter 实例,版本固定便于 Grafana 看板过滤
// - collectOtelMetrics(): 收集所有 metric 当前累积值,返回 JSON 友好结构
//
// 注:阶段 1 的 collectOtelMetrics 走"shadow buffer"路径。
//   OTel SDK 1.30 内部 MetricData 数据结构复杂,直接 JSON 序列化成本高且不稳定;
//   在每个 Counter/Histogram 调用点同步累加,得到简单的 { name: { count|sum|min|max }} 视图。
//   阶段 2 如需严格 OTel 原生采集,可改用 reader.collect() + PrometheusSerializer。

import { metrics, type Meter, type Counter, type Histogram } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

let initialized = false;
let _provider: MeterProvider | null = null;

/**
 * 幂等初始化 OTel。
 * - 默认 PrometheusExporter 不启动 HTTP server(测试 / 不依赖 Prometheus 抓取场景适用)
 * - 生产环境如需抓取,把 preventServerStart 设为 false
 *
 * 注:@opentelemetry/exporter-prometheus v0.40 自带 sdk-metrics@1.14 (由于 npm 解析),
 *     而本项目顶层 sdk-metrics 是 1.30。两者 MetricReader 类型名义不同但结构兼容。
 *     使用 `as any` cast 是 OTel 官方 npm 解析下常见做法,见 OTel issue #4605。
 */
export function initOtel(options: { preventServerStart?: boolean } = { preventServerStart: true }): void {
  if (initialized) return;

  const exporter = new PrometheusExporter({ preventServerStart: options.preventServerStart });
  // 双重 cast:绕过 exporter 内嵌 sdk-metrics 与顶层 sdk-metrics 的同名类型错位
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _provider = new MeterProvider({ readers: [exporter as any] });
  metrics.setGlobalMeterProvider(_provider);

  initialized = true;
}

/**
 * 全局 Meter 实例。固定 name='ts-multi-agent' + version='1.0.0',
 * 让 Grafana / Prometheus 能够按仪表化库名称聚合过滤。
 *
 * 注:meter 在 initOtel 之前可能已被使用(模块顶层 import),
 *     OTel API 在 setGlobalMeterProvider 之前返回一个 NoopMeter,后续 set 调用
 *     会将所有已创建的 instrument 委托给真正的 Provider(OTel 标准行为)。
 */
export const meter: Meter = metrics.getMeter('ts-multi-agent', '1.0.0');

// ─────────────────────────────────────────────────────────────────
// Shadow buffer:阶段 1 简化 collectOtelMetrics
// ─────────────────────────────────────────────────────────────────
//
// 由 metrics.ts 在创建 instrument 时注册回调,使 collectOtelMetrics 能够
// 返回 `{ llm_calls: { count: N }, llm_latency: { count, sum, min, max } }`
// 这种 JSON-friendly 视图,供 /metrics endpoint 或调试输出。
//
// 不写入磁盘 / 不影响 OTel 真实采集路径,仅是镜像。

type CounterValue = { type: 'counter'; count: number };
type HistogramValue = {
  type: 'histogram';
  count: number;
  sum: number;
  min: number;
  max: number;
};

const shadowBuffer: Record<string, CounterValue | HistogramValue> = {};

export function _shadowRecordCounter(name: string, delta: number): void {
  const existing = shadowBuffer[name];
  if (existing && existing.type === 'counter') {
    existing.count += delta;
  } else {
    shadowBuffer[name] = { type: 'counter', count: delta };
  }
}

export function _shadowRecordHistogram(name: string, value: number): void {
  const existing = shadowBuffer[name];
  if (existing && existing.type === 'histogram') {
    existing.count += 1;
    existing.sum += value;
    if (value < existing.min) existing.min = value;
    if (value > existing.max) existing.max = value;
  } else {
    shadowBuffer[name] = {
      type: 'histogram',
      count: 1,
      sum: value,
      min: value,
      max: value,
    };
  }
}

/**
 * Wrap an OTel Counter,同步累加到 shadowBuffer。
 * 返回的 counter 在 add 时既走 OTel,又走 buffer。外部代码无感。
 */
export function _wrapCounter(counter: Counter, name: string): Counter {
  const originalAdd = counter.add.bind(counter);
  return new Proxy(counter, {
    get(target, prop) {
      if (prop === 'add') {
        return (value: number, attrs?: any, ctx?: any) => {
          _shadowRecordCounter(name, value);
          return originalAdd(value, attrs, ctx);
        };
      }
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Counter;
}

/**
 * Wrap an OTel Histogram,同步累加 count/sum/min/max 到 shadowBuffer。
 */
export function _wrapHistogram(histogram: Histogram, name: string): Histogram {
  const originalRecord = histogram.record.bind(histogram);
  return new Proxy(histogram, {
    get(target, prop) {
      if (prop === 'record') {
        return (value: number, attrs?: any, ctx?: any) => {
          _shadowRecordHistogram(name, value);
          return originalRecord(value, attrs, ctx);
        };
      }
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Histogram;
}

/**
 * 收集所有 metric 累积值,返回 JSON 友好结构。
 * 阶段 1:使用 shadow buffer(counter / histogram 计数 + sum + min + max)。
 * 阶段 2:可替换为 reader.collect() + PrometheusSerializer。
 */
export async function collectOtelMetrics(): Promise<Record<string, CounterValue | HistogramValue>> {
  // Force flush pending OTel data into readers,确保 shadow 与 OTel 视图一致
  if (_provider) {
    try {
      await _provider.forceFlush();
    } catch {
      // ignore flush errors in collect path
    }
  }
  // 返回浅拷贝,避免外部误改 shadow buffer
  const out: Record<string, CounterValue | HistogramValue> = {};
  for (const [k, v] of Object.entries(shadowBuffer)) {
    out[k] = { ...v };
  }
  return out;
}

/**
 * 内部测试钩子:获取 raw shadow buffer(不经 Proxy/copy)。
 * 仅用于测试内部一致性验证,不开放给业务代码。
 */
export function _peekShadowBuffer(): Record<string, CounterValue | HistogramValue> {
  return shadowBuffer;
}

/**
 * 内部测试钩子:重置 shadow buffer。
 */
export function _resetShadowBuffer(): void {
  for (const k of Object.keys(shadowBuffer)) delete shadowBuffer[k];
}

/**
 * 是否已初始化(测试断言用)
 */
export function _isOtelInitialized(): boolean {
  return initialized;
}
