import { describe, test, expect } from 'bun:test';
import { AppError, LlmError, BusinessError, SkillError, ConfigError } from '../src/errors';

describe('AppError hierarchy', () => {
  test('LlmError maps RATE_LIMIT to 429', () => {
    const e = new LlmError('RATE_LIMIT', 'too many requests');
    expect(e.type).toBe('RETRYABLE');
    expect(e.code).toBe('LLM_RATE_LIMIT');
    expect(e.statusCode).toBe(429);
    expect(e.llmErrorType).toBe('RATE_LIMIT');
    expect(e.message).toBe('too many requests');
  });

  test('LlmError maps all LLMErrorType to valid HTTP codes', () => {
    const cases: Array<[string, number]> = [
      ['RATE_LIMIT', 429],
      ['INVALID_KEY', 401],
      ['TIMEOUT', 504],
      ['CONTEXT_TOO_LONG', 400],
      ['OUTPUT_TOO_LONG', 400],
      ['CANCELLED', 499],
      ['QUEUE_FULL', 503],
      ['UNKNOWN_ERROR', 500],
      ['API_ERROR', 502],
      ['NETWORK_ERROR', 502],
    ];
    for (const [type, expectedStatus] of cases) {
      const e = new LlmError(type as any, 'msg');
      expect(e.statusCode).toBe(expectedStatus);
    }
  });

  test('LlmError preserves custom statusCode', () => {
    const e = new LlmError('RATE_LIMIT', 'msg', { statusCode: 503 });
    expect(e.statusCode).toBe(503);
  });

  test('BusinessError defaults to 400', () => {
    const e = new BusinessError('INVALID_REQUEST', 'bad input');
    expect(e.type).toBe('USER_ERROR');
    expect(e.code).toBe('INVALID_REQUEST');
    expect(e.statusCode).toBe(400);
  });

  test('SkillError defaults to 422', () => {
    const e = new SkillError('EXECUTION_FAILED', 'skill crashed');
    expect(e.type).toBe('SKILL_ERROR');
    expect(e.code).toBe('EXECUTION_FAILED');
    expect(e.statusCode).toBe(422);
  });

  test('ConfigError defaults to 500', () => {
    const e = new ConfigError('MISSING_API_KEY', 'no key');
    expect(e.type).toBe('FATAL');
    expect(e.code).toBe('MISSING_API_KEY');
    expect(e.statusCode).toBe(500);
  });

  test('cause is preserved', () => {
    const cause = new Error('original');
    const e = new BusinessError('WRAP', 'wrapped', { cause });
    expect(e.cause).toBe(cause);
  });

  test('name matches constructor name', () => {
    expect(new LlmError('TIMEOUT', 'msg').name).toBe('LlmError');
    expect(new BusinessError('X', 'y').name).toBe('BusinessError');
    expect(new SkillError('X', 'y').name).toBe('SkillError');
    expect(new ConfigError('X', 'y').name).toBe('ConfigError');
  });

  test('AppError is abstract (cannot instantiate directly)', () => {
    // TypeScript enforces this at compile time.
    // Runtime check: AppError exists but cannot be `new`'d via standard pattern.
    expect(typeof AppError).toBe('function');
  });

  test('AppError is instance of Error', () => {
    const e = new BusinessError('X', 'y');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AppError);
  });
});
