import { describe, test, expect } from 'bun:test';
import { errorToResponse } from '../src/api/error-handler';
import { LlmError, BusinessError, SkillError, ConfigError } from '../src/errors';

describe('errorToResponse', () => {
  test('LlmError → envelope with type RETRYABLE and LLM_* code', () => {
    const r = errorToResponse(new LlmError('RATE_LIMIT', 'too many'));
    expect(r.status).toBe(429);
    expect(r.body.success).toBe(false);
    expect(r.body.error?.type).toBe('RETRYABLE');
    expect(r.body.error?.code).toBe('LLM_RATE_LIMIT');
    expect(r.body.error?.message).toBe('too many');
  });

  test('BusinessError → 400 USER_ERROR', () => {
    const r = errorToResponse(new BusinessError('INVALID_INPUT', 'bad'));
    expect(r.status).toBe(400);
    expect(r.body.error?.type).toBe('USER_ERROR');
    expect(r.body.error?.code).toBe('INVALID_INPUT');
  });

  test('SkillError → 422 SKILL_ERROR', () => {
    const r = errorToResponse(new SkillError('EXEC_FAIL', 'crash'));
    expect(r.status).toBe(422);
    expect(r.body.error?.type).toBe('SKILL_ERROR');
  });

  test('ConfigError → 500 FATAL', () => {
    const r = errorToResponse(new ConfigError('NO_KEY', 'missing'));
    expect(r.status).toBe(500);
    expect(r.body.error?.type).toBe('FATAL');
  });

  test('plain Error → 500 INTERNAL_ERROR (no leakage)', () => {
    const r = errorToResponse(new Error('internal stack trace details'));
    expect(r.status).toBe(500);
    expect(r.body.error?.code).toBe('INTERNAL_ERROR');
    expect(r.body.error?.message).toBe('An unexpected error occurred');
    expect(r.body.error?.message).not.toContain('stack trace');
  });

  test('non-Error throw → 500 UNKNOWN_ERROR', () => {
    const r = errorToResponse('something weird');
    expect(r.status).toBe(500);
    expect(r.body.error?.code).toBe('UNKNOWN_ERROR');
    expect(r.body.error?.message).toBe('something weird');
  });

  test('envelope always has success: false on error', () => {
    const r = errorToResponse(new BusinessError('X', 'y'));
    expect(r.body.success).toBe(false);
    expect(r.body.data).toBeUndefined();
  });
});