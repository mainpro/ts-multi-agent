/**
 * FallbackLLMClient (ILLMClient 装饰器) 测试
 *
 * 覆盖:
 *  1. failover success — 候选 A 抛 RATE_LIMIT,B 成功 → 返回 B 的结果
 *  2. all exhausted — 所有候选抛 RATE_LIMIT → 抛 FailoverError,attempts 长度 = 候选数
 *  3. context_too_long 不切换 — 抛 LLMError(CONTEXT_TOO_LONG) 立即上抛,不切到下一个
 *  4. cooldown skip — 候选 A 被 cooldown(预设) → 跳过 A 直接试 B
 *  5. AbortSignal 跨 candidate — 第 2 个 candidate 还没轮到,signal 已 abort → 抛 AbortError,不再继续
 *  6. FailoverError 信息脱敏 — originalError.message 含 'sk-xxx' → FailoverError.message 不含
 *  7. 并发 mark 不延长 TTL — 3 个并发 mark → expiresAt 与首次 mark 一致
 *  8. generateStructured 也 fallback — 同 (1) 的语义,走 generateStructured
 *  9. generateText 也 fallback — 同 (1),走 generateText
 * 10. success 不影响 cooldown — 候选 A 成功 → cooldown 单例不出现 A 的 entry
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setSystemTime } from 'bun:test';
import { z } from 'zod';
import { LLMError } from '../src/llm';
import { FailoverError } from '../src/llm/failover-types';
import type { ILLMClient } from '../src/llm/interfaces';
import type { Message, ToolDefinition, ToolCallResult } from '../src/types';
import type { LLMFallbackConfig } from '../src/llm/failover-config';
import { FallbackLLMClient } from '../src/llm/fallback-client';
import { cooldown } from '../src/llm/cooldown-cache';
import { sharedSlot } from '../src/llm/llm-slot-registry';

/**
 * 构造一个 mock ILLMClient,行为由 `behaviors` 描述:每次调用按 key 返回对应的结果/异常。
 * 同时记录调用历史(通过 `__calls`)。
 */
function buildMockClient(
  behaviors: Record<string, () => Promise<any>>
): ILLMClient & { __calls: string[] } {
  const calls: string[] = [];
  return {
    __calls: calls,
    async generateText(_prompt: string, _systemPrompt?: string) {
      calls.push('generateText');
      return behaviors['generateText']();
    },
    async generateStructured(_prompt: string, _schema: any, _systemPrompt?: string, _signal?: AbortSignal) {
      calls.push('generateStructured');
      return behaviors['generateStructured']();
    },
    async generateWithTools(
      _messages: Message[],
      _tools: ToolDefinition[],
      _toolExecutor: (call: { name: string; arguments: Record<string, unknown> }) => Promise<string>,
      _signal?: AbortSignal,
      _concurrencyChecker?: any,
      _onIterationStart?: any,
      _requestId?: string,
    ) {
      calls.push('generateWithTools');
      return behaviors['generateWithTools']();
    },
  } as unknown as ILLMClient & { __calls: string[] };
}

describe('FallbackLLMClient', () => {
  beforeEach(() => {
    cooldown.reset();
    setSystemTime();
  });

  afterEach(() => {
    cooldown.reset();
    setSystemTime();
  });

  /**
   * helper: 用 3 个候选构造 FallbackLLMClient(priority 1/2/3)
   */
  function buildClient(mockA: ILLMClient, mockB: ILLMClient, mockC: ILLMClient) {
    const cfg: LLMFallbackConfig = {
      candidates: [
        { providerKey: 'a:model', priority: 1, model: 'model-a' },
        { providerKey: 'b:model', priority: 2, model: 'model-b' },
        { providerKey: 'c:model', priority: 3, model: 'model-c' },
      ],
    };
    const clients: Record<string, ILLMClient> = {
      'a:model': mockA,
      'b:model': mockB,
      'c:model': mockC,
    };
    return new FallbackLLMClient(cfg, (key) => clients[key]);
  }

  // ─── 测试 1:failover success ────────────────────────────────────────────
  test('test 1 (failover success): 候选 A 抛 RATE_LIMIT → 候选 B 成功 → 返回 B 的结果', async () => {
    const mockA = buildMockClient({
      generateText: async () => { throw new LLMError('RATE_LIMIT', 'rate limited'); },
    });
    const mockB = buildMockClient({
      generateText: async () => 'ok-text-from-B',
    });
    const mockC = buildMockClient({
      generateText: async () => 'should-not-call',
    });

    const client = buildClient(mockA, mockB, mockC);
    const result = await client.generateText('hello');

    expect(result).toBe('ok-text-from-B');
    expect((mockA as any).__calls).toEqual(['generateText']);
    expect((mockB as any).__calls).toEqual(['generateText']);
    expect((mockC as any).__calls).toEqual([]); // B 已成功,C 不应被调用
  });

  // ─── 测试 2:all exhausted ───────────────────────────────────────────────
  test('test 2 (all exhausted): 所有候选抛 RATE_LIMIT → 抛 FailoverError,attempts 长度 = 候选数', async () => {
    const mockA = buildMockClient({
      generateText: async () => { throw new LLMError('RATE_LIMIT', 'a limited'); },
    });
    const mockB = buildMockClient({
      generateText: async () => { throw new LLMError('RATE_LIMIT', 'b limited'); },
    });
    const mockC = buildMockClient({
      generateText: async () => { throw new LLMError('RATE_LIMIT', 'c limited'); },
    });

    const client = buildClient(mockA, mockB, mockC);

    let caught: any;
    try {
      await client.generateText('hello');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(FailoverError);
    expect(caught.attempts).toHaveLength(3);
    expect(caught.reason).toBe('rate_limit');
    expect(caught.providerKey).toBe('c:model');
  });

  // ─── 测试 3:context_too_long 不切换 ─────────────────────────────────────
  test('test 3 (context_too_long 不切换): A 抛 CONTEXT_TOO_LONG → 立即抛,不切到 B', async () => {
    const mockA = buildMockClient({
      generateText: async () => { throw new LLMError('CONTEXT_TOO_LONG', 'too big'); },
    });
    const mockB = buildMockClient({
      generateText: async () => 'should-not-call',
    });
    const mockC = buildMockClient({
      generateText: async () => 'should-not-call',
    });

    const client = buildClient(mockA, mockB, mockC);

    let caught: any;
    try {
      await client.generateText('hello');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LLMError);
    expect(caught.type).toBe('CONTEXT_TOO_LONG');
    expect((mockA as any).__calls).toEqual(['generateText']);
    expect((mockB as any).__calls).toEqual([]); // 切都不切
    expect((mockC as any).__calls).toEqual([]);
  });

  // ─── 测试 4:cooldown skip ───────────────────────────────────────────────
  test('test 4 (cooldown skip): 预设 A 在 cooldown → 跳过 A 直接试 B', async () => {
    // 预设 A 在 cooldown
    cooldown.mark('a:model', 'rate_limit');
    expect(cooldown.isAvailable('a:model')).toBe(false);

    const mockA = buildMockClient({
      generateText: async () => {
        throw new Error('A 应当被跳过,不应被调用');
      },
    });
    const mockB = buildMockClient({
      generateText: async () => 'b-result',
    });
    const mockC = buildMockClient({
      generateText: async () => 'should-not-call',
    });

    const client = buildClient(mockA, mockB, mockC);
    const result = await client.generateText('hello');

    expect(result).toBe('b-result');
    expect((mockA as any).__calls).toEqual([]); // A 被跳过
    expect((mockB as any).__calls).toEqual(['generateText']);
  });

  // ─── 测试 5:AbortSignal 跨 candidate ─────────────────────────────────────
  test('test 5 (AbortSignal 跨 candidate): 进入循环前 signal 已 abort → 立即抛 AbortError', async () => {
    const mockA = buildMockClient({
      generateStructured: async () => { throw new Error('A 不应被调用 — signal 已 abort'); },
    });
    const mockB = buildMockClient({
      generateStructured: async () => { throw new Error('B 不应被调用 — signal 已 abort'); },
    });
    const mockC = buildMockClient({
      generateStructured: async () => ({ ok: true }),
    });

    const cfg: LLMFallbackConfig = {
      candidates: [
        { providerKey: 'a:model', priority: 1, model: 'm' },
        { providerKey: 'b:model', priority: 2, model: 'm' },
        { providerKey: 'c:model', priority: 3, model: 'm' },
      ],
    };
    const client = new FallbackLLMClient(cfg, (key) => {
      if (key === 'a:model') return mockA;
      if (key === 'b:model') return mockB;
      return mockC;
    });

    const controller = new AbortController();
    controller.abort(); // 进入循环前就 abort

    let caught: any;
    try {
      await client.generateStructured('hi', z.object({}), undefined, controller.signal);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((mockA as any).__calls).toEqual([]);
    expect((mockB as any).__calls).toEqual([]);
    expect((mockC as any).__calls).toEqual([]);
  });

  // ─── 测试 6:FailoverError 信息脱敏 ──────────────────────────────────────
  test('test 6 (FailoverError 信息脱敏): originalError 含 sk-xxx → FailoverError.message 不含', async () => {
    const sensitive = 'Bearer sk-xxx-secret-credentials-12345';
    const original = new Error(sensitive);

    const mockA = buildMockClient({
      generateText: async () => {
        throw new LLMError('INVALID_KEY', 'auth failed', 401, original);
      },
    });
    const mockB = buildMockClient({
      generateText: async () => { throw new LLMError('INVALID_KEY', 'auth failed', 401, original); },
    });
    const mockC = buildMockClient({
      generateText: async () => { throw new LLMError('INVALID_KEY', 'auth failed', 401, original); },
    });

    const client = buildClient(mockA, mockB, mockC);

    let caught: any;
    try {
      await client.generateText('hi');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(FailoverError);
    // FailoverError.message 必须不包含 sk-xxx
    expect(caught.message).not.toContain('sk-xxx');
    expect(caught.message).not.toContain('Bearer sk-xxx-secret-credentials-12345');
    // 仅含标准 "LLM failover exhausted: ..." 格式
    expect(caught.message).toMatch(/LLM failover exhausted:/);
  });

  // ─── 测试 7:并发 mark 不延长 TTL ───────────────────────────────────────
  test('test 7 (并发 mark 不延长 TTL): 3 个并发请求都 mark A → expiresAt 与首次一致', async () => {
    const t0 = Date.now();
    setSystemTime(new Date(t0));

    // 并发 mark 3 次
    cooldown.mark('a:model', 'rate_limit');
    cooldown.mark('a:model', 'rate_limit');
    cooldown.mark('a:model', 'rate_limit');

    // rate_limit base TTL = 60_000
    // 推进到 t0 + 50s:仍在 TTL 内 → 不可用
    setSystemTime(new Date(t0 + 50_000));
    expect(cooldown.isAvailable('a:model')).toBe(false);

    // 推进到 t0 + 60s + 1ms:已超过首次 mark 后的 expiresAt → 可用
    // 如果 TTL 真的被延长(变成 ~180s),t0+60s+1 仍会不可用;本断言通过证明 TTL 未延长
    setSystemTime(new Date(t0 + 60_001));
    expect(cooldown.isAvailable('a:model')).toBe(true);
  });

  // ─── 测试 8:generateStructured 也 fallback ──────────────────────────────
  test('test 8 (generateStructured 也 fallback): A 抛 RATE_LIMIT → B 成功', async () => {
    const schema = z.object({ value: z.string() });
    const mockA = buildMockClient({
      generateStructured: async () => { throw new LLMError('RATE_LIMIT', 'a limited'); },
    });
    const mockB = buildMockClient({
      generateStructured: async () => ({ value: 'from-B' }),
    });
    const mockC = buildMockClient({
      generateStructured: async () => ({ value: 'should-not-call' }),
    });

    const client = buildClient(mockA, mockB, mockC);
    const result = await client.generateStructured('hi', schema);

    expect(result).toEqual({ value: 'from-B' });
    expect((mockA as any).__calls).toContain('generateStructured');
    expect((mockB as any).__calls).toContain('generateStructured');
    expect((mockC as any).__calls).not.toContain('generateStructured');
  });

  // ─── 测试 9:generateText 也 fallback ────────────────────────────────────
  test('test 9 (generateText 也 fallback): A 抛 TIMEOUT → B 成功(generateText 路径)', async () => {
    const mockA = buildMockClient({
      generateText: async () => { throw new LLMError('TIMEOUT', 'a timeout'); },
    });
    const mockB = buildMockClient({
      generateText: async () => 'b-result',
    });
    const mockC = buildMockClient({
      generateText: async () => 'should-not-call',
    });

    const client = buildClient(mockA, mockB, mockC);
    const result = await client.generateText('hi');

    expect(result).toBe('b-result');
    expect((mockA as any).__calls).toContain('generateText');
    expect((mockB as any).__calls).toContain('generateText');
    expect((mockC as any).__calls).not.toContain('generateText');
  });

  // ─── 测试 10:success 不影响 cooldown ───────────────────────────────────
  test('test 10 (success 不影响 cooldown): 候选 A 成功 → cooldown 单例不出现 A 的 entry', async () => {
    const mockA = buildMockClient({
      generateText: async () => 'A-success',
    });
    const mockB = buildMockClient({
      generateText: async () => 'should-not-call',
    });
    const mockC = buildMockClient({
      generateText: async () => 'should-not-call',
    });

    const sizeBefore = cooldown.size();
    const client = buildClient(mockA, mockB, mockC);
    const result = await client.generateText('hi');

    expect(result).toBe('A-success');
    expect(cooldown.isAvailable('a:model')).toBe(true);
    expect(cooldown.size()).toBe(sizeBefore);
  });
});
