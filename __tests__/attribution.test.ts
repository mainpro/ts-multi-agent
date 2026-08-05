// __tests__/attribution.test.ts
import { describe, expect, test } from 'bun:test';
import { Attribution, attributionCounter } from '../src/observability/attribution';

describe('Attribution classification', () => {
  test('has 8 categories', () => {
    const categories = Object.values(Attribution);
    expect(categories).toHaveLength(8);
  });

  test('LLM-related categories', () => {
    expect(Attribution.LLM_TIMEOUT).toBe('LLM_TIMEOUT');
    expect(Attribution.LLM_RATE_LIMIT).toBe('LLM_RATE_LIMIT');
  });

  test('Skill-related categories', () => {
    expect(Attribution.SKILL_TIMEOUT).toBe('SKILL_TIMEOUT');
    expect(Attribution.SKILL_PARAM).toBe('SKILL_PARAM');
  });

  test('System categories', () => {
    expect(Attribution.HOOK_FAIL).toBe('HOOK_FAIL');
    expect(Attribution.STEER_RACE).toBe('STEER_RACE');
    expect(Attribution.INJECT_DENY).toBe('INJECT_DENY');
    expect(Attribution.UNKNOWN).toBe('UNKNOWN');
  });

  test('attributionCounter increments count', () => {
    attributionCounter.reset();
    attributionCounter.inc({ kind: 'LLM_TIMEOUT' });
    attributionCounter.inc({ kind: 'LLM_TIMEOUT' });
    attributionCounter.inc({ kind: 'SKILL_TIMEOUT' });
    const counts = attributionCounter.snapshot();
    expect(counts).toEqual({ LLM_TIMEOUT: 2, SKILL_TIMEOUT: 1 });
  });
});
