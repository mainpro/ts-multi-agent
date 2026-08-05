// src/observability/sla-watcher.ts
//
// 缺口 3.2: SLA Watcher(归因 SLA 触发 + 静默告警)
//
// 阶段 1(本任务):内存 Map + 归因计数器 + 审计日志三重落地
// 阶段 2(Task 10):归因计数器由 OpenTelemetry Counter 替换

import { attributionCounter } from './attribution';
import { auditLogger } from '../guardrail/audit-logger';
import { slaBreached } from './metrics';

interface SlaRecord {
  startMs: number;
  slaMs: number;
}

/**
 * SLA 监控器:跟踪每个 requestId 的开始时间 + 预算,
 * 在 finally / 异常路径上判定是否超阈值并发出归因。
 *
 * 用法(参考 brief Step 9.6 / 9.7):
 *   slaTracker.start(req.requestId, CONFIG.SLA_REQUEST_MS);
 *   try {
 *     // ... existing logic
 *   } finally {
 *     const check = slaTracker.check(req.requestId);
 *     if (check.breached) slaTracker.mark(req.requestId, true);
 *     else slaTracker.clear(req.requestId);
 *   }
 */
export class SlaTracker {
  private records = new Map<string, SlaRecord>();

  start(requestId: string, slaMs: number): void {
    this.records.set(requestId, { startMs: Date.now(), slaMs });
  }

  check(requestId: string): { breached: boolean; elapsedMs: number; slaMs: number } {
    const r = this.records.get(requestId);
    if (!r) return { breached: false, elapsedMs: 0, slaMs: 0 };
    const elapsedMs = Date.now() - r.startMs;
    return { breached: elapsedMs > r.slaMs, elapsedMs, slaMs: r.slaMs };
  }

  mark(requestId: string, breached: boolean): void {
    const r = this.records.get(requestId);
    if (!r) return;
    this.records.delete(requestId);
    if (breached) {
      reportSlaBreach(requestId, 'GENERIC', Date.now() - r.startMs, r.slaMs);
    }
  }

  clear(requestId: string): void {
    this.records.delete(requestId);
  }
}

export const slaTracker = new SlaTracker();

/**
 * 静默告警类型:用于 reportSlaBreach 的第二个参数,
 * 区分 LLM / Skill / Request 整链路 / Steer drain 等不同 SLA 类别。
 *
 * 阶段 2(Task 10)会替换为 OTel Counter,此处仅占位。
 */
export type SlaBreachType = 'GENERIC' | 'LLM' | 'SKILL' | 'REQUEST' | 'STEER_DRAIN';

/**
 * 上报一次 SLA 突破:走归因计数器 + OTel slaBreached + 审计日志三条独立通道,
 * 阶段 1 内存计数 + JSONL 文件,阶段 2 替换为 OTel。
 */
export function reportSlaBreach(requestId: string, kind: SlaBreachType, elapsedMs: number, slaMs: number): void {
  // 1. 归因(2-tag 形式,经 attributionCounter.snapshot() 会序列化为 'kind=SLA_BREACH&type=XXX')
  attributionCounter.inc({ kind: 'SLA_BREACH', type: kind });

  // 1b. OTel 缺口 4.3 SLA 计数器 — 走 shadow buffer + 真实 OTel 通道,
  //     让 `collectOtelMetrics()` 与 Prometheus 抓取都能看到 sla.breached 计数。
  //     tag 维度:type ∈ {GENERIC,LLM,SKILL,REQUEST,STEER_DRAIN}
  slaBreached.add(1, { type: kind });

  // 2. 审计(静默告警落审计日志,运维可 query)
  void auditLogger.log({
    userId: 'system',
    action: 'alert',
    ruleName: `SLA_BREACH_${kind}`,
    reason: `${kind} SLA breached: ${elapsedMs}ms > ${slaMs}ms for ${requestId}`,
    contentPreview: `${kind} ${elapsedMs}/${slaMs}ms`,
    profile: { role: 'system', permissions: [] },
    decision: { action: 'alert', reason: `${kind} exceeded ${slaMs}ms`, ruleName: `SLA_BREACH_${kind}` },
  });
}