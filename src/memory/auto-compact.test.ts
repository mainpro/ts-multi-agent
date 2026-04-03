import { describe, it, expect } from 'vitest';
import { AutoCompactService, CompactStrategy } from './auto-compact.js';

describe('AutoCompactService', () => {
  it('should be instantiable', () => {
    const service = new AutoCompactService();
    expect(service).toBeInstanceOf(AutoCompactService);
  });

  it('should have CompactStrategy enum', () => {
    expect(CompactStrategy.MICRO).toBe('MICRO');
    expect(CompactStrategy.AUTO).toBe('AUTO');
    expect(CompactStrategy.SESSION).toBe('SESSION');
    expect(CompactStrategy.REACTIVE).toBe('REACTIVE');
  });

  it('should have microCompact method', () => {
    const service = new AutoCompactService();
    expect(typeof service.microCompact).toBe('function');
  });

  it('should have autoCompact method', () => {
    const service = new AutoCompactService();
    expect(typeof service.autoCompact).toBe('function');
  });

  it('should have checkAndCompact method', () => {
    const service = new AutoCompactService();
    expect(typeof service.checkAndCompact).toBe('function');
  });

  it('should have estimateTokens method', () => {
    const service = new AutoCompactService();
    expect(typeof service.estimateTokens).toBe('function');
  });

  it('microCompact should return empty array (skeleton)', () => {
    const service = new AutoCompactService();
    const messages = [{ role: 'user', content: 'test' }];
    const result = service.microCompact(messages);
    expect(result).toEqual([]);
  });

  it('autoCompact should resolve to empty array (skeleton)', async () => {
    const service = new AutoCompactService();
    const messages = [{ role: 'user', content: 'test' }];
    const result = await service.autoCompact(messages);
    expect(result).toEqual([]);
  });

  it('checkAndCompact should return messages unchanged (skeleton)', async () => {
    const service = new AutoCompactService();
    const messages = [{ role: 'user', content: 'test' }];
    const result = await service.checkAndCompact(messages);
    expect(result).toBe(messages);
  });

  it('estimateTokens should return 0 (skeleton)', () => {
    const service = new AutoCompactService();
    const messages = [{ role: 'user', content: 'test' }];
    const result = service.estimateTokens(messages);
    expect(result).toBe(0);
  });
});
