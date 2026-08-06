import { CONFIG } from '../types';

/**
 * LLMSlotRegistry —— 共享并发槽位池
 *
 * 设计目的:把 LLMClient 的 class-level semaphore 抽出为命名包装,
 * 使 fallback 链中多实例 LLMClient 可显式共享同一并发上限。
 *
 * 关键不变量:
 *  - 全局上限 = capacity(共享池,非 per-caller)
 *  - FIFO 等待队列(shift() 取最早入队的 waiter)
 *  - AbortSignal 支持:已 abort 的 signal 立刻拒绝;排队期间 abort 会从队列移除
 */
export class LLMSlotRegistry {
  private active = 0;
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal }> = [];

  constructor(private readonly capacity: number = CONFIG.LLM_MAX_CONCURRENT_REQUESTS ?? 20) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('aborted');
    if (this.active < this.capacity) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject, signal };
      this.waiters.push(entry);
      if (signal) {
        signal.addEventListener('abort', () => {
          const idx = this.waiters.indexOf(entry);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error('aborted'));
        }, { once: true });
      }
    });
  }

  release(): void {
    // 防御 over-release:空池时 release 是 no-op,避免 active 变负数
    if (this.active === 0) return;
    this.active--;
    const next = this.waiters.shift();
    if (next) {
      this.active++;
      next.resolve();
    }
  }
}

/** 全局共享槽位池,默认 capacity = CONFIG.LLM_MAX_CONCURRENT_REQUESTS */
export const sharedSlot = new LLMSlotRegistry();
