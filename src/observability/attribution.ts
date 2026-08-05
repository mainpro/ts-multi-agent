// src/observability/attribution.ts
//
// 缺口 3.1: 归因分类常量 + 归因计数器
//
// 阶段 1(本任务): 内存计数桩
// 阶段 2(Task 10): 由 OpenTelemetry Counter 替换,见 `import { meter } from './otel'`(届时解除注释)

export const Attribution = {
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_RATE_LIMIT: 'LLM_RATE_LIMIT',
  SKILL_TIMEOUT: 'SKILL_TIMEOUT',
  SKILL_PARAM: 'SKILL_PARAM',
  HOOK_FAIL: 'HOOK_FAIL',
  STEER_RACE: 'STEER_RACE',
  INJECT_DENY: 'INJECT_DENY',
  UNKNOWN: 'UNKNOWN',
} as const;

export type AttributionType = typeof Attribution[keyof typeof Attribution];

interface Counter {
  inc(tags: Record<string, string>): void;
  reset(): void;
  snapshot(): Record<string, number>;
  dump(): Array<{ tags: Record<string, string>; count: number }>;
}

/**
 * 归因计数器(全局单例)
 * 阶段 1: 桩实现,内存计数
 * 阶段 2(Task 10): 由 OTel Counter 替换
 */
class AttributionCounter implements Counter {
  private counts = new Map<string, number>();

  inc(tags: Record<string, string>): void {
    const key = AttributionKey.from(tags);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  reset(): void {
    this.counts.clear();
  }

  /**
   * 扁平快照:以 `kind` 字段为顶层 key(若 inc 调用仅传 `{ kind }` 则退化为原始 kind 字符串)
   * 多 tag 场景下保留完整 key 以避免碰撞
   */
  snapshot(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, count] of this.counts) {
      const tags = AttributionKey.parse(key);
      // 单 tag 且 key 为 kind 时,直接用 kind 值作为顶层 key,
      // 以便 `snapshot()` 输出 `{ LLM_TIMEOUT: 2, SKILL_TIMEOUT: 1 }` 这种便于阅读的形态。
      const topKey = tags.kind && Object.keys(tags).length === 1 ? tags.kind : key;
      result[topKey] = count;
    }
    return result;
  }

  dump(): Array<{ tags: Record<string, string>; count: number }> {
    return Array.from(this.counts.entries()).map(([key, count]) => ({
      tags: AttributionKey.parse(key),
      count,
    }));
  }
}

class AttributionKey {
  static from(tags: Record<string, string>): string {
    return Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
  }
  static parse(key: string): Record<string, string> {
    return Object.fromEntries(
      key.split('&').map((kv) => kv.split('=') as [string, string])
    );
  }
}

export const attributionCounter = new AttributionCounter();
