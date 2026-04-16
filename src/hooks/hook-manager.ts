/**
 * Hook 管理器
 * P2-2: Hooks 生命周期系统
 */
import { HookEvent, HookContext, HookHandler } from './types';

export class HookManager {
  private hooks: Map<HookEvent, HookHandler[]> = new Map();

  /**
   * 注册 Hook
   */
  on(event: HookEvent, handler: HookHandler): void {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    this.hooks.get(event)!.push(handler);
  }

  /**
   * 移除 Hook
   */
  off(event: HookEvent, handler?: HookHandler): void {
    if (!handler) {
      this.hooks.delete(event);
      return;
    }
    const handlers = this.hooks.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  /**
   * 触发 Hook（异步，不阻塞主流程）
   */
  async emit(event: HookEvent, context: Partial<HookContext> = {}): Promise<void> {
    const handlers = this.hooks.get(event) || [];
    if (handlers.length === 0) return;

    const fullContext: HookContext = {
      event,
      timestamp: new Date(),
      data: {},
      ...context,
    };

    // 并行执行所有 handler，单个失败不影响其他
    await Promise.allSettled(
      handlers.map(async (handler) => {
        try {
          await handler(fullContext);
        } catch (error) {
          console.error(`[Hook] ${event} handler error:`, error);
        }
      })
    );
  }

  /**
   * 获取某个事件注册的 handler 数量
   */
  getHandlerCount(event: HookEvent): number {
    return this.hooks.get(event)?.length || 0;
  }
}

// 全局单例
export const hookManager = new HookManager();
