/**
 * classifyFailoverReason:将任意 thrown error 映射为 FailoverReason(或不映射)
 *
 * 用法:上层(cooldown cache、fallback client)在捕获错误后调用,决定
 * 是否应当切换 provider。返回 null 表示:
 *  - 不是 LLMError(普通 Error / null / undefined 都不处理,留给上层抛)
 *  - 是 LLMError 但类型不应触发 failover(CANCELLED / QUEUE_FULL / UNKNOWN_ERROR)
 */
import { LLMError } from './index';
import { FailoverReason, LLMErrorTypeToFailoverReason } from './failover-types';

export function classifyFailoverReason(err: unknown): FailoverReason | null {
  if (!(err instanceof LLMError)) return null;
  return LLMErrorTypeToFailoverReason[err.type] ?? null;
}
