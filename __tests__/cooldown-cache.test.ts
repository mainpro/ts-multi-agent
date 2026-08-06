/**
 * CooldownCache(冷却表,带 TTL 指数退避)测试
 *
 * CooldownCache 是 LLM Fallback Chain 的核心组件:
 *  - mark(key, reason): 将 provider 标记为失败,根据 reason 计算 base TTL
 *  - isAvailable(key): 是否可用(未标记或 TTL 过期)
 *  - clear(key): 手动清除单个 entry
 *  - reset(): 清空所有 entry
 *
 * TTL 退避策略:
 *  - 第一次 mark:TTL = base * 2^0 = base
 *  - 第二次 mark(同 key):保留原 expiresAt(不延长),仅递增 hitCount
 *  - TTL 过期后 isAvailable 自动清理 entry
 *
 * 测试要点:
 *  - 使用 bun:test 的 setSystemTime 模拟时间推进,避免真实等待
 *  - BASE_TTL_MS 文档化的各 reason 的 TTL 常量必须与实现一致
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setSystemTime } from 'bun:test';
import { CooldownCache, cooldown } from '../src/llm/cooldown-cache';

describe('CooldownCache', () => {
  let cache: CooldownCache;

  beforeEach(() => {
    cache = new CooldownCache();
  });

  describe('isAvailable (initial state)', () => {
    test('初始未标记的 key → true', () => {
      expect(cache.isAvailable('never-marked')).toBe(true);
    });

    test('空 cache 的 size() === 0', () => {
      expect(cache.size()).toBe(0);
    });
  });

  describe('mark + isAvailable', () => {
    test('mark 后立即 isAvailable → false', () => {
      cache.mark('openrouter', 'rate_limit');
      expect(cache.isAvailable('openrouter')).toBe(false);
    });

    test('mark 后 30s 内 isAvailable 仍 false (rate_limit base=60s)', () => {
      cache.mark('openrouter', 'rate_limit');
      setSystemTime(new Date(Date.now() + 30_000));
      expect(cache.isAvailable('openrouter')).toBe(false);
    });

    test('rate_limit 60s 后 TTL 过期,isAvailable → true 且自动清理 entry', () => {
      cache.mark('openrouter', 'rate_limit');
      expect(cache.size()).toBe(1);
      setSystemTime(new Date(Date.now() + 60_001));
      expect(cache.isAvailable('openrouter')).toBe(true);
      // 顺手清理
      expect(cache.size()).toBe(0);
    });

    test('不同 key 互不影响:标记 A 不影响 B', () => {
      cache.mark('a', 'rate_limit');
      expect(cache.isAvailable('a')).toBe(false);
      expect(cache.isAvailable('b')).toBe(true);
    });
  });

  describe('BASE_TTL_MS(不同 reason 的 TTL 差异化)', () => {
    test('auth_failed base TTL = 300s (5 分钟,API key 失效需长冷却)', () => {
      cache.mark('p', 'auth_failed');
      setSystemTime(new Date(Date.now() + 299_999));
      expect(cache.isAvailable('p')).toBe(false);
      setSystemTime(new Date(Date.now() + 2)); // 推进到 300001ms
      expect(cache.isAvailable('p')).toBe(true);
    });

    test('rate_limit base TTL = 60s', () => {
      cache.mark('p', 'rate_limit');
      setSystemTime(new Date(Date.now() + 60_001));
      expect(cache.isAvailable('p')).toBe(true);
    });

    test('server_error base TTL = 30s (瞬时故障,冷却最短)', () => {
      cache.mark('p', 'server_error');
      setSystemTime(new Date(Date.now() + 30_001));
      expect(cache.isAvailable('p')).toBe(true);
    });

    test('context_too_long base TTL = 600s (10 分钟,几乎不会自愈)', () => {
      cache.mark('p', 'context_too_long');
      setSystemTime(new Date(Date.now() + 599_999));
      expect(cache.isAvailable('p')).toBe(false);
      setSystemTime(new Date(Date.now() + 2));
      expect(cache.isAvailable('p')).toBe(true);
    });
  });

  describe('连续 mark 行为(TTL 不延长,仅递增 hitCount)', () => {
    test('同 key 在 TTL 内连续 mark:保留原 expiresAt,仅 hitCount++', () => {
      const t0 = Date.now();
      cache.mark('p', 'rate_limit');
      // 第一次 mark 后 expiresAt = t0 + 60_000 (rate_limit base TTL)
      // 推进 30s (仍在 TTL 内)
      setSystemTime(new Date(t0 + 30_000));

      cache.mark('p', 'rate_limit'); // 第二次 mark

      // 按 spec:第二次 mark 保留原 expiresAt(不延长),仅递增 hitCount
      // expiresAt 仍 = t0 + 60_000
      // 在 t0 + 60_001 时 → 已过期 → isAvailable true
      setSystemTime(new Date(t0 + 60_001));
      expect(cache.isAvailable('p')).toBe(true);
    });

    test('同 key 在 TTL 内连续 mark:hitCount 递增到 2', () => {
      const t0 = Date.now();
      cache.mark('p', 'rate_limit');
      setSystemTime(new Date(t0 + 10_000));
      cache.mark('p', 'rate_limit'); // hitCount=2

      // 此时 expiresAt 仍 = t0 + 60_000 (保留原 expiresAt)
      // 推进到 t0 + 50_000,仍在 TTL 内 → 不可用
      setSystemTime(new Date(t0 + 50_000));
      expect(cache.isAvailable('p')).toBe(false);
    });

    test('mark 后 mark 不同 reason:覆盖 reason,但 hitCount 在已存在 entry 时仍递增', () => {
      const t0 = Date.now();
      cache.mark('p', 'rate_limit');
      // 推进 10s
      setSystemTime(new Date(t0 + 10_000));
      // 用 server_error 再 mark(更短 base TTL)
      cache.mark('p', 'server_error');
      // expiresAt 仍保留 = t0 + 60_000(rate_limit 的 expiresAt)
      // 即使 server_error base=30_000,也不缩短 TTL
      setSystemTime(new Date(t0 + 50_000));
      expect(cache.isAvailable('p')).toBe(false);
    });
  });

  describe('clear', () => {
    test('clear 单个 key:isAvailable 立即 true', () => {
      cache.mark('a', 'rate_limit');
      cache.clear('a');
      expect(cache.isAvailable('a')).toBe(true);
      expect(cache.size()).toBe(0);
    });

    test('clear 不存在的 key → noop', () => {
      expect(() => cache.clear('never-marked')).not.toThrow();
    });

    test('clear 一个 key 不影响其他 key', () => {
      cache.mark('a', 'rate_limit');
      cache.mark('b', 'server_error');
      cache.clear('a');
      expect(cache.isAvailable('a')).toBe(true);
      expect(cache.isAvailable('b')).toBe(false);
    });
  });

  describe('reset', () => {
    test('reset 清空所有 entry', () => {
      cache.mark('a', 'rate_limit');
      cache.mark('b', 'server_error');
      cache.mark('c', 'auth_failed');
      expect(cache.size()).toBe(3);
      cache.reset();
      expect(cache.size()).toBe(0);
      expect(cache.isAvailable('a')).toBe(true);
      expect(cache.isAvailable('b')).toBe(true);
      expect(cache.isAvailable('c')).toBe(true);
    });
  });
});

describe('exported singleton: cooldown', () => {
  afterEach(() => {
    // 每个测试后清理,避免跨测试污染
    cooldown.reset();
    // 时间也还原
    setSystemTime();
  });

  test('导出为 CooldownCache 实例', () => {
    expect(cooldown).toBeInstanceOf(CooldownCache);
  });

  test('mark 后 isAvailable 行为一致', () => {
    expect(cooldown.isAvailable('singleton-test')).toBe(true);
    cooldown.mark('singleton-test', 'rate_limit');
    expect(cooldown.isAvailable('singleton-test')).toBe(false);
  });
});