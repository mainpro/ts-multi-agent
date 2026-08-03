/**
 * 未知工具死循环熔断
 *
 * 参考 OpenClaw src/agents/embedded-agent-runner/run/attempt.tool-call-normalization.ts:38
 * 当 LLM 连续 N 次调用同一未知工具时,改写 toolResult 让 LLM 换路径。
 * 状态机:同一工具名 → 计数器+1,切换工具 → 重置。
 */
export class UnknownToolLoopGuard {
  private lastToolName: string | null = null;
  private count: number = 0;

  constructor(private threshold: number = 3) {}

  /**
   * 检查当前工具调用是否需要熔断
   * @returns 若需要熔断,返回改写后的 toolResult;否则返回 null
   */
  check(toolName: string): string | null {
    if (this.lastToolName === toolName) {
      this.count++;
      if (this.count > this.threshold) {
        return this.buildRewriteMessage(toolName);
      }
    } else {
      this.lastToolName = toolName;
      this.count = 1;
    }
    return null;
  }

  /** 切换到合法工具后调用,重置计数 */
  reset(): void {
    this.lastToolName = null;
    this.count = 0;
  }

  private buildRewriteMessage(toolName: string): string {
    return `I can't use the tool '${toolName}' — it doesn't exist in this environment. ` +
           `I need to stop retrying it and answer without that tool.`;
  }
}
