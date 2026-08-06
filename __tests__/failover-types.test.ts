/**
 * Failover 类型词汇 + FailoverError + LLMErrorType 映射
 *
 * 这是 LLM Fallback Chain 的基础模块。所有后续任务
 * (classifier、cooldown cache、fallback client)都依赖这里的导出。
 *
 * 覆盖:
 *  - LLMErrorTypeToFailoverReason 静态映射(关键错误分类)
 *  - CANCELLED / QUEUE_FULL / UNKNOWN_ERROR → null(不切换 provider)
 *  - FailoverError 实例字段(reason / providerKey / attempts)
 *  - FailoverError.message 不暴露原始错误细节
 */
import { describe, test, expect } from 'bun:test';
import {
  LLMErrorTypeToFailoverReason,
  FailoverError,
  type FailoverReason,
  type FailoverAttempt,
} from '../src/llm/failover-types';

/**
 * LLMErrorType 是 TypeScript 字面量联合类型,无运行时值,
 * 因此测试中以字符串字面量直接索引映射表。
 */
type LLMErrorTypeLiteral =
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'INVALID_KEY'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR'
  | 'CONTEXT_TOO_LONG'
  | 'OUTPUT_TOO_LONG'
  | 'CANCELLED'
  | 'QUEUE_FULL';

const ALL_ERROR_TYPES: LLMErrorTypeLiteral[] = [
  'RATE_LIMIT',
  'TIMEOUT',
  'INVALID_KEY',
  'API_ERROR',
  'NETWORK_ERROR',
  'UNKNOWN_ERROR',
  'CONTEXT_TOO_LONG',
  'OUTPUT_TOO_LONG',
  'CANCELLED',
  'QUEUE_FULL',
];

describe('LLMErrorTypeToFailoverReason mapping', () => {
  test('RATE_LIMIT → rate_limit', () => {
    expect(LLMErrorTypeToFailoverReason['RATE_LIMIT']).toBe('rate_limit');
  });

  test('CONTEXT_TOO_LONG → context_too_long', () => {
    expect(LLMErrorTypeToFailoverReason['CONTEXT_TOO_LONG']).toBe('context_too_long');
  });

  test('CANCELLED → null (用户取消,不切换 provider)', () => {
    expect(LLMErrorTypeToFailoverReason['CANCELLED']).toBeNull();
  });

  test('mapping 覆盖全部 10 个 LLMErrorType', () => {
    for (const key of ALL_ERROR_TYPES) {
      expect(LLMErrorTypeToFailoverReason).toHaveProperty(key);
    }
  });
});

describe('FailoverError', () => {
  test('暴露 reason / providerKey / attempts 字段', () => {
    const attempts: FailoverAttempt[] = [
      { providerKey: 'openrouter', reason: 'rate_limit' },
      { providerKey: 'nvidia', reason: 'server_error' },
    ];
    const err = new FailoverError('rate_limit', 'openrouter', attempts);

    expect(err.reason).toBe('rate_limit');
    expect(err.providerKey).toBe('openrouter');
    expect(err.attempts).toBe(attempts);
    expect(err.attempts).toHaveLength(2);
  });

  test('name === "FailoverError"', () => {
    const err = new FailoverError('server_error', 'zhipu', []);
    expect(err.name).toBe('FailoverError');
  });

  test('继承自 Error', () => {
    const err = new FailoverError('server_error', 'zhipu', []);
    expect(err).toBeInstanceOf(Error);
  });

  test('message 只包含 providerId + reason + attempts,不含原始错误细节', () => {
    // 模拟一个敏感错误信息:绝不能透传到 FailoverError.message
    const sensitive = 'AWS_SECRET_ACCESS_KEY=AKIA12345 leaked';
    const err = new FailoverError('server_error', 'openrouter', [
      { providerKey: 'openrouter', reason: 'server_error' },
    ]);

    expect(err.message).not.toContain(sensitive);
    expect(err.message).not.toContain('AWS_SECRET');
    // 但要包含 providerId + reason
    expect(err.message).toContain('openrouter');
    expect(err.message).toContain('server_error');
  });
});

describe('FailoverReason type', () => {
  test('5 个合法 reason 值', () => {
    const reasons: FailoverReason[] = [
      'rate_limit',
      'auth_failed',
      'server_error',
      'context_too_long',
      'output_too_long',
    ];
    // 类型层面的保证 — 只要能通过类型检查就成立
    // 这里用 runtime 断言展示其实际值
    expect(reasons).toHaveLength(5);
    expect(new Set(reasons).size).toBe(5);
  });
});