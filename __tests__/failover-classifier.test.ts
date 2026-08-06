/**
 * classifyFailoverReason 工具测试
 *
 * 验证 LLMError → FailoverReason 的映射:
 *  - LLMError 实例按 LLMErrorTypeToFailoverReason 静态表查表
 *  - 非 LLMError 异常(普通 Error / null / undefined)→ null(留给上层处理)
 *  - CANCELLED / QUEUE_FULL / UNKNOWN_ERROR → null(不切换 provider)
 *
 * 注意:LLMErrorType 是 TypeScript 字面量联合类型,无运行时值,测试中
 * 全部使用字符串字面量构造 LLMError.type。LLMError 必须按 type-only
 * 导入(`import type { LLMError }`),因为这是类型,但运行时通过
 * `instanceof` 检查类。
 */
import { describe, test, expect } from 'bun:test';
import { LLMError } from '../src/llm';
import { classifyFailoverReason } from '../src/llm/failover-classifier';

describe('classifyFailoverReason', () => {
  test('LLMError(RATE_LIMIT) → "rate_limit"', () => {
    const err = new LLMError('RATE_LIMIT', 'rate limited');
    expect(classifyFailoverReason(err)).toBe('rate_limit');
  });

  test('LLMError(CONTEXT_TOO_LONG) → "context_too_long"', () => {
    const err = new LLMError('CONTEXT_TOO_LONG', 'input too long');
    expect(classifyFailoverReason(err)).toBe('context_too_long');
  });

  test('LLMError(CANCELLED) → null (no failover for user cancellation)', () => {
    const err = new LLMError('CANCELLED', 'cancelled by user');
    expect(classifyFailoverReason(err)).toBeNull();
  });

  test('普通 Error → null (non-LLMError passed through)', () => {
    const err = new Error('something else');
    expect(classifyFailoverReason(err)).toBeNull();
  });

  test('null → null', () => {
    expect(classifyFailoverReason(null)).toBeNull();
  });

  test('undefined → null', () => {
    expect(classifyFailoverReason(undefined)).toBeNull();
  });
});
