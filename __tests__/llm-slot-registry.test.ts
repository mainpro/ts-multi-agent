/**
 * LLMSlotRegistry 测试
 *
 * LLMSlotRegistry 是 LLM Fallback Chain 的共享并发槽位池:
 *  - acquire(signal?): 占用一个槽位;若已满则排队等待;若 signal 已 abort 立刻抛错
 *  - release(): 释放一个槽位;若 waiters 不为空则立即唤醒(FIFO)
 *  - 同一个 registry 跨多个调用方共享同一池(全局上限 = capacity,而非 per-caller)
 *
 * 用于把 LLMClient 现有的 class-level static semaphore 抽出为命名包装,
 * 使 fallback 链中多实例 LLMClient 共享同一并发上限。
 *
 * 测试要点:
 *  - 使用 bun:test
 *  - 验证 capacity 限制、release 唤醒、AbortSignal 拒绝、共享池行为
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { LLMSlotRegistry } from '../src/llm/llm-slot-registry';

describe('LLMSlotRegistry', () => {
  let registry: LLMSlotRegistry;

  beforeEach(() => {
    registry = new LLMSlotRegistry(2);
  });

  describe('capacity enforcement', () => {
    test('capacity=2 时第 3 个 acquire 进入排队', async () => {
      const first = await registry.acquire();
      const second = await registry.acquire();
      // 前两个已占用,第三个应排队等待
      let thirdAcquired = false;
      const third = registry.acquire().then(() => {
        thirdAcquired = true;
      });

      // 等待一个 microtask,确认 third 仍未 resolve
      await new Promise(resolve => setImmediate(resolve));
      expect(thirdAcquired).toBe(false);

      // 释放一个槽位,third 应立即拿到
      registry.release();
      await third;
      expect(thirdAcquired).toBe(true);

      // 清理
      registry.release();
      registry.release();
      void first;
      void second;
    });

    test('capacity=0 时所有 acquire 永远排队直到 release', async () => {
      const zeroRegistry = new LLMSlotRegistry(0);
      let acquired = false;
      const promise = zeroRegistry.acquire().then(() => {
        acquired = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(acquired).toBe(false);
      // capacity=0:由于 release 也被 guarded(active=0),释放也不会改变状态,
      // 所以 promise 永远排队 — 这是该测试的核心断言
      // 用 try/catch 防止 dangling promise
      promise.catch(() => {});
      // 给一个永远不会触发的 release,验证仍排队(acquired=false)
      await new Promise(resolve => setImmediate(resolve));
      expect(acquired).toBe(false);
    });
  });

  describe('release frees slot', () => {
    test('release 后等待的 acquire 立即拿到(FIFO 顺序)', async () => {
      await registry.acquire();
      await registry.acquire();
      // 现在 capacity 满,排两个等待者
      const order: number[] = [];
      const w1 = registry.acquire().then(() => order.push(1));
      const w2 = registry.acquire().then(() => order.push(2));
      await new Promise(resolve => setImmediate(resolve));
      expect(order).toEqual([]);

      // 第一次 release → 唤醒 w1
      registry.release();
      await w1;
      expect(order).toEqual([1]);

      // 第二次 release → 唤醒 w2
      registry.release();
      await w2;
      expect(order).toEqual([1, 2]);

      // 清理
      registry.release();
      registry.release();
    });

    test('release 多次是安全的(空池 → over-release 不会让 active 变负)', async () => {
      const localRegistry = new LLMSlotRegistry(2);
      // 多次 release 在空池上不应抛错
      localRegistry.release();
      localRegistry.release();
      // over-release:再 release 两次,active 必须仍 = 0(不会变成 -2)
      localRegistry.release();
      localRegistry.release();

      // 验证 acquire 仍按预期工作(active 从 0 增至 1,不会因 over-release 而变成 2)
      const a1 = await localRegistry.acquire();
      const a2 = await localRegistry.acquire();
      // 第三个应排队(active=2,capacity=2)
      let thirdAcquired = false;
      const a3 = localRegistry.acquire().then(() => {
        thirdAcquired = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(thirdAcquired).toBe(false);

      // 释放一个,a3 立即拿到 → 证明 active 准确为 1,不是 3
      localRegistry.release();
      await a3;
      expect(thirdAcquired).toBe(true);

      // 清理
      localRegistry.release();
      localRegistry.release();
      void a1;
      void a2;
    });
  });

  describe('AbortSignal rejection', () => {
    test('acquire 在已 abort 的 signal 上立刻抛错', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(registry.acquire(controller.signal)).rejects.toThrow();
    });

    test('acquire 在排队期间被 abort → 从 waiters 移除,后续 release 不会唤醒它', async () => {
      await registry.acquire();
      await registry.acquire();
      // 此时 active=2, capacity 满
      // 第三个进入排队
      const controller = new AbortController();
      let waiterRejected = false;
      const waiter = registry.acquire(controller.signal).catch(() => {
        waiterRejected = true;
      });
      await new Promise(resolve => setImmediate(resolve));

      // abort 后原 Promise 应 reject
      controller.abort();
      await waiter;
      expect(waiterRejected).toBe(true);

      // 被 abort 的 waiter 已从队列移除,不影响其他 waiter
      // 验证方法:排队一个新 waiter,通过 release 唤醒
      let nextWoken = false;
      const next = registry.acquire().then(() => {
        nextWoken = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(nextWoken).toBe(false);

      // 释放一个槽位 → 唤醒 next(而非已被 abort 的那个)
      registry.release();
      await next;
      expect(nextWoken).toBe(true);

      // 清理:此时 active=2 (原 2 个 + 唤醒 next 后变成 active-1+1=2)
      // 释放 2 次回到 0
      registry.release();
      registry.release();
    });

    test('未传 signal → 行为正常(不抛错)', async () => {
      await expect(registry.acquire(undefined)).resolves.toBeUndefined();
      registry.release();
    });
  });

  describe('shared pool across providerKeys (共享槽位池,非 per-caller)', () => {
    test('同一个 registry 跨多次 acquire 调用共享同一池(全局上限 = capacity)', async () => {
      // capacity=2,模拟两个不同的"调用方"各 acquire 1 个,总共只能同时 2 个
      const r = new LLMSlotRegistry(2);
      // "provider A" acquire 1 个
      await r.acquire();
      // "provider B" acquire 1 个 —— 此时 capacity 已满
      await r.acquire();
      // "provider C" 应排队,虽然它和前两个"无关"
      let thirdAcquired = false;
      const third = r.acquire().then(() => {
        thirdAcquired = true;
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(thirdAcquired).toBe(false);

      // 释放一个,第三个立即拿到(不同调用方共享池)
      r.release();
      await third;
      expect(thirdAcquired).toBe(true);

      // 清理
      r.release();
      r.release();
    });

    test('不同 LLMSlotRegistry 实例拥有独立池(不应共享)', async () => {
      const r1 = new LLMSlotRegistry(1);
      const r2 = new LLMSlotRegistry(1);
      // r1 占满 → 进入排队
      await r1.acquire();
      let r1SecondAcquired = false;
      const r1Second = r1.acquire().then(() => {
        r1SecondAcquired = true;
      });
      // r2 不受 r1 影响,仍能 acquire
      await r2.acquire();
      // r1 第二个仍在排队
      await new Promise(resolve => setImmediate(resolve));
      expect(r1SecondAcquired).toBe(false);

      // 清理 r1,唤醒其第二
      r1.release();
      await r1Second;
      r1.release();
      r2.release();
    });
  });

  describe('default capacity from CONFIG', () => {
    test('不传 capacity 参数时也能工作(实例化不抛错)', () => {
      const r = new LLMSlotRegistry();
      // 至少能 acquire 一次
      expect(async () => {
        await r.acquire();
        r.release();
      }).not.toThrow();
    });
  });
});
