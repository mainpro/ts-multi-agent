// src/observability/metrics.ts
//
// 缺口 4.1: 指标字典
//
// 9 个全局 metric 实例,覆盖三大维度:
//   - LLM(calls / latency / errors)
//   - Skill(calls / latency / errors)
//   - Guardrail(denied / rewritten / alerted)
//   - SLA(breached)
//
// 所有 metric 走 OTel Meter + shadow buffer(`_wrapCounter` / `_wrapHistogram`),
// 既满足 OTel 仪表化规范,又让 collectOtelMetrics() 直接拿到 JSON 视图。
//
// 命名约定:`{domain}.{event}`,全小写 + 点号分隔,与 Prometheus 惯例一致。

import { meter, _wrapCounter, _wrapHistogram } from './otel';
import type { Counter, Histogram } from '@opentelemetry/api';

// ─────────────────────────────────────────────────────────────────
// LLM 维度
// ─────────────────────────────────────────────────────────────────
export const llmCalls: Counter = _wrapCounter(
  meter.createCounter('llm.calls', { description: 'LLM 调用次数(成功 + 失败)' }),
  'llm.calls'
);
export const llmLatency: Histogram = _wrapHistogram(
  meter.createHistogram('llm.latency', { description: 'LLM 端到端延迟', unit: 'ms' }),
  'llm.latency'
);
export const llmErrors: Counter = _wrapCounter(
  meter.createCounter('llm.errors', { description: 'LLM 错误次数(timeout / 5xx / 4xx 非业务)' }),
  'llm.errors'
);

// ─────────────────────────────────────────────────────────────────
// Skill 维度
// ─────────────────────────────────────────────────────────────────
export const skillCalls: Counter = _wrapCounter(
  meter.createCounter('skill.calls', { description: 'Skill 调用次数' }),
  'skill.calls'
);
export const skillLatency: Histogram = _wrapHistogram(
  meter.createHistogram('skill.latency', { description: 'Skill 执行延迟', unit: 'ms' }),
  'skill.latency'
);
export const skillErrors: Counter = _wrapCounter(
  meter.createCounter('skill.errors', { description: 'Skill 错误次数(超时 / 异常 / 权限)' }),
  'skill.errors'
);

// ─────────────────────────────────────────────────────────────────
// Guardrail 维度(缺口 1 拦截 3 档)
// ─────────────────────────────────────────────────────────────────
export const guardrailDenied: Counter = _wrapCounter(
  meter.createCounter('guardrail.denied', { description: 'Guardrail 拒绝次数(hard block)' }),
  'guardrail.denied'
);
export const guardrailRewritten: Counter = _wrapCounter(
  meter.createCounter('guardrail.rewritten', { description: 'Guardrail 改写次数(soft rewrite)' }),
  'guardrail.rewritten'
);
export const guardrailAlerted: Counter = _wrapCounter(
  meter.createCounter('guardrail.alerted', { description: 'Guardrail 静默告警次数(pass-through + audit)' }),
  'guardrail.alerted'
);

// ─────────────────────────────────────────────────────────────────
// SLA 维度(缺口 3 归因 SLA)
// ─────────────────────────────────────────────────────────────────
export const slaBreached: Counter = _wrapCounter(
  meter.createCounter('sla.breached', { description: 'SLA 触发次数(Llm/Skill/Request/Steer drain)' }),
  'sla.breached'
);

/**
 * 全量指标清单(供测试 + 运维自检使用)。
 */
export const ALL_METRICS = {
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
} as const;
