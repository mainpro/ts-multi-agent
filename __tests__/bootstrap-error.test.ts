import { describe, test, expect } from 'bun:test';
import { AppError, BootstrapError } from '../src/errors';

describe('BootstrapError', () => {
  test('defaults to statusCode 500', () => {
    const e = new BootstrapError('LLM_INIT_FAILED', 'init failed');
    expect(e.statusCode).toBe(500);
  });

  test('has type BOOTSTRAP_FAILED', () => {
    const e = new BootstrapError('SERVER_START_FAILED', 'server failed');
    expect(e.type).toBe('BOOTSTRAP_FAILED');
  });

  test('preserves code and message', () => {
    const e = new BootstrapError('LLM_INIT_FAILED', 'no api key');
    expect(e.code).toBe('LLM_INIT_FAILED');
    expect(e.message).toBe('no api key');
  });

  test('preserves custom statusCode', () => {
    const e = new BootstrapError('CODE', 'msg', { statusCode: 503 });
    expect(e.statusCode).toBe(503);
  });

  test('preserves cause', () => {
    const cause = new Error('original failure');
    const e = new BootstrapError('CODE', 'msg', { cause });
    expect(e.cause).toBe(cause);
  });

  test('name matches constructor name', () => {
    const e = new BootstrapError('CODE', 'msg');
    expect(e.name).toBe('BootstrapError');
  });

  test('is instance of Error and AppError', () => {
    const e = new BootstrapError('CODE', 'msg');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AppError);
  });

  test('has a stack trace', () => {
    const e = new BootstrapError('CODE', 'msg');
    expect(typeof e.stack).toBe('string');
    expect(e.stack).toContain('BootstrapError');
  });
});
