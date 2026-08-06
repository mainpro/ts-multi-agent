/**
 * Failover 类型词汇 + FailoverError + LLMErrorType 映射
 *
 * 这是 LLM Fallback Chain 的基础模块:
 *  - 暴露给后续任务(classifier、cooldown cache、fallback client)
 *  - 定义哪些 LLMErrorType 触发 provider 切换、哪些不触发(CANCELLED/QUEUE_FULL/UNKNOWN_ERROR)
 *  - FailoverError 是切换穷尽后的最终错误,message 故意不含原始错误细节
 *    (避免凭据/PII 泄露到上游日志)
 */
import type { LLMErrorType } from './index';

/**
 * Failover 决策的语义原因。
 *
 * - rate_limit: 触发频率限流,应切到下一个 provider 并进入 cooldown
 * - auth_failed: API key 失效,应切到下一个 provider 并进入 cooldown(长)
 * - server_error: 5xx / 网络错误,瞬时故障,可切 + cooldown
 * - context_too_long: 输入超长,换 provider 也无解,但分类层仍视为可尝试
 * - output_too_long: 同上
 */
export type FailoverReason =
  | 'rate_limit'
  | 'auth_failed'
  | 'server_error'
  | 'context_too_long'
  | 'output_too_long';

/**
 * LLMErrorType → FailoverReason 的静态映射表。
 *
 * - null 表示不切换 provider(用户主动取消 / 队列已满 / 未知错误)。
 * - 类型 `Record<LLMErrorType, FailoverReason | null>` 强制要求覆盖全部
 *   10 个 LLMErrorType 值;新增枚举时必须同步更新本表(编译期保证)。
 *
 * 注意:键使用字符串字面量(而非 `LLMErrorType.RATE_LIMIT`)以保证运行时可用 —
 * `LLMErrorType` 是 TypeScript 字面量联合类型,无对应的运行时值。
 */
export const LLMErrorTypeToFailoverReason: Record<LLMErrorType, FailoverReason | null> = {
  RATE_LIMIT: 'rate_limit',
  INVALID_KEY: 'auth_failed',
  TIMEOUT: 'server_error',
  NETWORK_ERROR: 'server_error',
  API_ERROR: 'server_error',
  CONTEXT_TOO_LONG: 'context_too_long',
  OUTPUT_TOO_LONG: 'output_too_long',
  CANCELLED: null,
  QUEUE_FULL: null,
  UNKNOWN_ERROR: null,
};

/**
 * 单次 failover 尝试的记录(供上层日志 / 排障使用)。
 */
export interface FailoverAttempt {
  providerKey: string;
  reason: FailoverReason;
}

/**
 * Failover 穷尽错误:所有 provider 都尝试失败后抛出。
 *
 * 注意:message 仅包含 providerId + reason + attempts.length,
 * **不**包含任何原始错误的 message 或 stack。原始错误保留在调用方
 * 自己的日志里,本错误仅作为"切换失败"的语义信号上抛。
 */
export class FailoverError extends Error {
  constructor(
    public readonly reason: FailoverReason,
    public readonly providerKey: string,
    public readonly attempts: ReadonlyArray<FailoverAttempt>,
  ) {
    super(
      `LLM failover exhausted: ${providerKey} ${reason} after ${attempts.length} attempts`,
    );
    this.name = 'FailoverError';
  }
}