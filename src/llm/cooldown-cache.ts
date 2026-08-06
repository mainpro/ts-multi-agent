/**
 * CooldownCache — 冷却表(带 TTL 指数退避)
 *
 * LLM Fallback Chain 的核心组件:process-wide 单例,
 * 记录哪些 LLM provider 暂时不可用,供 FallbackLLMClient 在
 * 选择候选 provider 时跳过冷却中的项。
 *
 * TTL 退避策略:
 *  - 不同 reason 的 base TTL 不同(API key 失效需要长冷却,5xx 瞬时故障只需短冷却)
 *  - 第一次 mark:TTL = base * 2^0 = base
 *  - 同一 key 在 TTL 内连续 mark:不延长 TTL(保留原 expiresAt),仅递增 hitCount
 *    — hitCount 主要用于排障日志,不参与 TTL 计算(避免反复失败导致冷却无限延长,
 *    阻塞恢复路径)
 *  - TTL 过期后 isAvailable 自动清理 entry
 *
 * 注意:这是内存表,无持久化。进程重启即清空,与设计预期一致(下次启动时所有
 * provider 都"重新可用",避免陈旧冷却状态持续阻碍恢复)。
 */
import { createLogger } from '../observability/logger';
import { type FailoverReason } from './failover-types';

const log = createLogger({ module: 'CooldownCache' });

interface CooldownEntry {
  reason: FailoverReason;
  expiresAt: number;
  hitCount: number;
}

/**
 * 各 reason 的 base TTL。
 *
 *  - auth_failed:        5 分钟(API key 失效需要人工介入,长冷却)
 *  - context_too_long:  10 分钟(换 provider 也无解,几乎不会自愈)
 *  - rate_limit:         1 分钟(常见冷却策略)
 *  - output_too_long:    1 分钟(同上)
 *  - server_error:       30 秒(5xx / 网络错误,瞬时故障,冷却最短)
 */
const BASE_TTL_MS: Record<FailoverReason, number> = {
  rate_limit: 60_000,
  auth_failed: 300_000,
  server_error: 30_000,
  context_too_long: 600_000,
  output_too_long: 60_000,
};

export class CooldownCache {
  private entries = new Map<string, CooldownEntry>();

  /**
   * 查询 provider 是否可用。
   *  - 未标记 → true
   *  - 标记但 TTL 已过期 → true(顺手清理 entry)
   *  - 标记且仍在 TTL 内 → false
   */
  isAvailable(providerKey: string): boolean {
    const entry = this.entries.get(providerKey);
    if (!entry) return true;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(providerKey);
      return true;
    }
    return false;
  }

  /**
   * 将 provider 标记为失败。
   *  - 同一 key 首次 mark:TTL = base * 2^(1-1) = base
   *  - 同一 key 已存在 entry 且仍在 TTL 内:保留原 expiresAt,
   *    仅递增 hitCount(避免反复失败导致冷却无限延长)
   *  - 同一 key 已有 entry 但已过期:等同于首次 mark(重新计算 TTL)
   */
  mark(providerKey: string, reason: FailoverReason): void {
    const prev = this.entries.get(providerKey);
    const hitCount = (prev?.hitCount ?? 0) + 1;
    const ttl = BASE_TTL_MS[reason] * Math.pow(2, hitCount - 1);
    const expiresAt = prev?.expiresAt ?? Date.now() + ttl;
    this.entries.set(providerKey, { reason, expiresAt, hitCount });
    log.warn('LLM provider marked cooldown', {
      providerKey,
      reason,
      ttlMs: expiresAt - Date.now(),
      hitCount,
    });
  }

  /** 手动清除单个 entry(用于运维恢复 / 测试)。 */
  clear(providerKey: string): void {
    this.entries.delete(providerKey);
  }

  /** 清空所有 entry(用于测试隔离 / 运维重置)。 */
  reset(): void {
    this.entries.clear();
  }

  /** 当前 entry 数(仅用于测试与可观测性,不应在热路径调用)。 */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Process-wide 单例。
 *
 * 在 FallbackLLMClient 中,每次选 provider 之前会调用
 * `cooldown.isAvailable(key)` 过滤冷却中的项;失败后调用
 * `cooldown.mark(key, reason)` 加入冷却。
 *
 * 单例意味着测试间需要主动 `cooldown.reset()`,或重新创建
 * `new CooldownCache()` 实例进行隔离。
 */
export const cooldown = new CooldownCache();