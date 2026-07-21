import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'fire-and-forget' });

/**
 * 在后台执行异步操作，失败时记录结构化日志。
 * 替代直接 .catch(e => console.error(...)) 模式。
 */
export function fireAndForget(
  promise: Promise<unknown>,
  context: string,
  onError?: (error: unknown) => void,
): void {
  promise.catch((error) => {
    log.error(`后台任务失败: ${context}`, { error: error instanceof Error ? error.message : String(error) });
    onError?.(error);
  });
}

export default fireAndForget;