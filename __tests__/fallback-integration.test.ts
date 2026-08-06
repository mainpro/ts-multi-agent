/**
 * LLM Fallback Chain — 端到端集成测试(Task 8)
 *
 * 与 `fallback-client.test.ts`(单元测试,只盯 FallbackLLMClient 一个类)不同,
 * 本文件走**完整链路**:
 *
 *   JSON 配置字符串
 *     → parseFallbackConfig (Task 5 zod schema)
 *     → FallbackLLMClient   (Task 6 装饰器)
 *     → classifyFailoverReason (Task 2)
 *     → cooldown 单例 TTL 退避 (Task 3)
 *     → sharedSlot / AbortError (Task 4)
 *     → FailoverError (Task 1)
 *
 * 所有 provider 都是 mock ILLMClient,抛真实的 `LLMError`,断言只看**外部可观测行为**
 * (返回值 / 抛出的错误 / 各 mock 被调用了几次),不 stub 内部实现。
 *
 * 时间用 `setSystemTime` 冻结/推进,以确定性验证 cooldown TTL 的过期与恢复。
 *
 * 覆盖场景:
 *  1. Rate limit failover + cooldown recovery(60s 后 A 恢复)
 *  2. Auth failed → 长 cooldown(300s)
 *  3. Context too long → 不切换,原样上抛,且不进 cooldown
 *  4. 全部候选失败 → FailoverError,attempts 长度 = 3
 *  5. AbortSignal 跨 candidate → A 失败后 abort,B 不被调用,抛 AbortError
 *  6. generateStructured 链路 → 与场景 1 同语义
 */
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { z } from 'zod';
import { LLMError } from '../src/llm';
import { AbortError } from '../src/llm/llm-slot-registry';
import { FailoverError } from '../src/llm/failover-types';
import { parseFallbackConfig } from '../src/llm/failover-config';
import { FallbackLLMClient } from '../src/llm/fallback-client';
import { cooldown } from '../src/llm/cooldown-cache';
import type { ILLMClient } from '../src/llm/interfaces';

/** 3 候选链的真实 JSON 配置(与 `config/llm-fallback.json` 同结构) */
const CHAIN_JSON = JSON.stringify({
  candidates: [
    { providerKey: 'openrouter:model-a', priority: 1, model: 'model-a' },
    { providerKey: 'openrouter:model-b', priority: 2, model: 'model-b' },
    { providerKey: 'zhipu:model-c', priority: 3, model: 'model-c' },
  ],
});

const KEY_A = 'openrouter:model-a';
const KEY_B = 'openrouter:model-b';
const KEY_C = 'zhipu:model-c';

/**
 * Mock provider:每次调用按顺序消费 `script` 中的一项。
 *  - `Error` 实例 → 抛出
 *  - 其他值       → 作为结果返回
 * script 耗尽后重复最后一项(便于"多次调用都成功"的场景)。
 */
class MockProvider {
  calls = 0;
  constructor(private readonly script: unknown[]) {}

  private next(): unknown {
    const item = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    if (item instanceof Error) throw item;
    return item;
  }

  asClient(): ILLMClient {
    const self = this;
    return {
      async generateText() {
        return self.next() as string;
      },
      async generateStructured() {
        return self.next() as any;
      },
      async generateWithTools() {
        return self.next() as any;
      },
    } as unknown as ILLMClient;
  }
}

/** 用 3 个 mock provider 组装一条经过 zod 校验的 fallback 链 */
function buildChain(a: MockProvider, b: MockProvider, c: MockProvider): FallbackLLMClient {
  const config = parseFallbackConfig(CHAIN_JSON);
  const clients: Record<string, ILLMClient> = {
    [KEY_A]: a.asClient(),
    [KEY_B]: b.asClient(),
    [KEY_C]: c.asClient(),
  };
  return new FallbackLLMClient(config, key => clients[key]);
}

describe('LLM Fallback Chain (end-to-end)', () => {
  beforeEach(() => {
    cooldown.reset();
    setSystemTime();
  });

  afterEach(() => {
    cooldown.reset();
    setSystemTime();
  });

  // ─── 场景 1:Rate limit failover + cooldown recovery ──────────────────────
  test('场景 1: A RATE_LIMIT → 切 B;A 进 60s cooldown,期间被跳过;60s 后恢复', async () => {
    const t0 = Date.now();
    setSystemTime(new Date(t0));

    // A: 第 1 次限流,之后恢复正常
    const a = new MockProvider([new LLMError('RATE_LIMIT', 'rate limited'), 'from-A']);
    const b = new MockProvider(['from-B']);
    const c = new MockProvider(['from-C']);
    const chain = buildChain(a, b, c);

    // (1) 第一次调用:A 限流 → 切到 B
    expect(await chain.generateText('hi')).toBe('from-B');
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(c.calls).toBe(0);
    expect(cooldown.isAvailable(KEY_A)).toBe(false);

    // (2) 立即第二次调用:A 在冷却中被直接跳过(a.calls 不增长),B 再次成功
    expect(await chain.generateText('hi again')).toBe('from-B');
    expect(a.calls).toBe(1); // 完全没被调用
    expect(b.calls).toBe(2);

    // (3) B 的成功不影响 A 的 cooldown 状态:59.9s 时 A 仍在冷却
    setSystemTime(new Date(t0 + 59_999));
    expect(cooldown.isAvailable(KEY_A)).toBe(false);

    // (4) 推进过 60s base TTL → A 恢复可用,重新成为首选
    setSystemTime(new Date(t0 + 60_001));
    expect(cooldown.isAvailable(KEY_A)).toBe(true);
    expect(await chain.generateText('recovered')).toBe('from-A');
    expect(a.calls).toBe(2);
    expect(b.calls).toBe(2); // B 不再被调用
  });

  // ─── 场景 2:Auth failed → 300s 长 cooldown ───────────────────────────────
  test('场景 2: A INVALID_KEY → 切 B;A 进 300s cooldown(远长于 rate_limit 的 60s)', async () => {
    const t0 = Date.now();
    setSystemTime(new Date(t0));

    const a = new MockProvider([new LLMError('INVALID_KEY', 'invalid api key', 401), 'from-A']);
    const b = new MockProvider(['from-B']);
    const c = new MockProvider(['from-C']);
    const chain = buildChain(a, b, c);

    expect(await chain.generateText('hi')).toBe('from-B');
    expect(cooldown.isAvailable(KEY_A)).toBe(false);

    // rate_limit 的 60s 已过,但 auth_failed 是 300s → A 仍在冷却
    setSystemTime(new Date(t0 + 61_000));
    expect(cooldown.isAvailable(KEY_A)).toBe(false);
    expect(await chain.generateText('still cooling')).toBe('from-B');
    expect(a.calls).toBe(1);

    // 299s:仍在冷却
    setSystemTime(new Date(t0 + 299_000));
    expect(cooldown.isAvailable(KEY_A)).toBe(false);

    // 300s+:恢复
    setSystemTime(new Date(t0 + 300_001));
    expect(cooldown.isAvailable(KEY_A)).toBe(true);
    expect(await chain.generateText('recovered')).toBe('from-A');
    expect(a.calls).toBe(2);
  });

  // ─── 场景 3:Context too long 不切换 ──────────────────────────────────────
  test('场景 3: A CONTEXT_TOO_LONG → 原样上抛,不切 B/C,也不进 cooldown', async () => {
    const a = new MockProvider([new LLMError('CONTEXT_TOO_LONG', 'context length exceeded')]);
    const b = new MockProvider(['from-B']);
    const c = new MockProvider(['from-C']);
    const chain = buildChain(a, b, c);

    let caught: unknown;
    try {
      await chain.generateText('a very long prompt');
    } catch (e) {
      caught = e;
    }

    // 上抛的是原始 LLMError,而不是 FailoverError —— 换 provider 也解决不了输入超长
    expect(caught).toBeInstanceOf(LLMError);
    expect(caught).not.toBeInstanceOf(FailoverError);
    expect((caught as LLMError).type).toBe('CONTEXT_TOO_LONG');

    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
    expect(c.calls).toBe(0);

    // 不切换 ⇒ 不 mark cooldown:A 依然可用(下一条正常长度的请求还该走 A)
    expect(cooldown.isAvailable(KEY_A)).toBe(true);
    expect(cooldown.size()).toBe(0);
  });

  // ─── 场景 4:全部失败 → FailoverError ─────────────────────────────────────
  test('场景 4: A/B/C 全部 RATE_LIMIT → FailoverError,attempts 长度 = 3', async () => {
    const a = new MockProvider([new LLMError('RATE_LIMIT', 'a limited')]);
    const b = new MockProvider([new LLMError('RATE_LIMIT', 'b limited')]);
    const c = new MockProvider([new LLMError('RATE_LIMIT', 'c limited')]);
    const chain = buildChain(a, b, c);

    let caught: unknown;
    try {
      await chain.generateText('hi');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(FailoverError);
    const err = caught as FailoverError;
    expect(err.attempts).toHaveLength(3);
    expect(err.attempts.map(x => x.providerKey)).toEqual([KEY_A, KEY_B, KEY_C]);
    expect(err.attempts.every(x => x.reason === 'rate_limit')).toBe(true);
    expect(err.reason).toBe('rate_limit');
    expect(err.providerKey).toBe(KEY_C);

    // 三个候选各被试了一次,且全部进入 cooldown
    expect([a.calls, b.calls, c.calls]).toEqual([1, 1, 1]);
    expect(cooldown.size()).toBe(3);
  });

  // ─── 场景 5:AbortSignal 跨 candidate ─────────────────────────────────────
  test('场景 5: A 失败后 signal abort → 抛 AbortError,B/C 不被调用', async () => {
    const controller = new AbortController();

    // A 在抛 RATE_LIMIT 的同时触发 abort(模拟用户在切换途中取消请求)
    const a = new MockProvider([]);
    const b = new MockProvider(['from-B']);
    const c = new MockProvider(['from-C']);

    const aClient: ILLMClient = {
      async generateWithTools() {
        a.calls++;
        controller.abort();
        throw new LLMError('RATE_LIMIT', 'rate limited');
      },
    } as unknown as ILLMClient;

    const config = parseFallbackConfig(CHAIN_JSON);
    const clients: Record<string, ILLMClient> = {
      [KEY_A]: aClient,
      [KEY_B]: b.asClient(),
      [KEY_C]: c.asClient(),
    };
    const chain = new FallbackLLMClient(config, key => clients[key]);

    let caught: unknown;
    try {
      await chain.generateWithTools([], [], async () => '', controller.signal);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AbortError);
    expect((caught as Error).name).toBe('AbortError');
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0); // abort 后不再尝试下一个候选
    expect(c.calls).toBe(0);

    // A 的失败仍然被记账(cooldown 已 mark),abort 只是终止了后续尝试
    expect(cooldown.isAvailable(KEY_A)).toBe(false);
  });

  // ─── 场景 6:generateStructured 链路 ──────────────────────────────────────
  test('场景 6: generateStructured 同样走 failover + cooldown recovery', async () => {
    const t0 = Date.now();
    setSystemTime(new Date(t0));

    const schema = z.object({ answer: z.string() });
    const a = new MockProvider([
      new LLMError('API_ERROR', 'upstream 503', 503),
      { answer: 'from-A' },
    ]);
    const b = new MockProvider([{ answer: 'from-B' }]);
    const c = new MockProvider([{ answer: 'from-C' }]);
    const chain = buildChain(a, b, c);

    // API_ERROR → server_error,可切换
    expect(await chain.generateStructured('q', schema)).toEqual({ answer: 'from-B' });
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(c.calls).toBe(0);

    // server_error base TTL = 30s:29s 时 A 仍被跳过
    setSystemTime(new Date(t0 + 29_000));
    expect(await chain.generateStructured('q', schema)).toEqual({ answer: 'from-B' });
    expect(a.calls).toBe(1);

    // 30s 后 A 恢复,重新成为首选
    setSystemTime(new Date(t0 + 30_001));
    expect(await chain.generateStructured('q', schema)).toEqual({ answer: 'from-A' });
    expect(a.calls).toBe(2);
    expect(b.calls).toBe(2);
  });
});
