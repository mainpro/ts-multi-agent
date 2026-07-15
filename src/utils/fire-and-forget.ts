/**
 * 在后台执行异步操作，失败时通过结构化日志记录错误。
 * 替代直接 .catch(e => console.error(...)) 模式。
 */
export function fireAndForget(
  promise: Promise<unknown>,
  context: string,
  onError?: (error: unknown) => void,
): void {
  promise.catch((error) => {
    console.error(`[fireAndForget] ${context} failed:`, error instanceof Error ? error.message : String(error));
    onError?.(error);
  });
}

export default fireAndForget;