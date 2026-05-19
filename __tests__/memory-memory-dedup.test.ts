import { describe, expect, it } from 'bun:test';
import { MemoryDedupService, DEFAULT_DEDUP_THRESHOLD, DEFAULT_CONSOLIDATION_THRESHOLD } from './memory-dedup';
import type { MemoryEntry } from './types';
import { MemoryLayer } from './types';

function makeEntry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'content'>): MemoryEntry {
  return {
    layer: MemoryLayer.EPISODIC,
    importance: 0.5,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    namespace: 'default',
    metadata: {},
    ...overrides,
  };
}

function nearDuplicateEmbedding(base: number[], noise = 0.001): number[] {
  return base.map(v => v + noise);
}

describe('MemoryDedupService', () => {
  const service = new MemoryDedupService();

  describe('dedup', () => {
    it('removes exact content duplicates (no embeddings)', () => {
      const entries = [
        makeEntry({ id: '1', content: 'hello world', importance: 0.6 }),
        makeEntry({ id: '2', content: 'hello world', importance: 0.4 }),
      ];
      const result = service.dedup(entries);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('removes near-duplicates with high cosine similarity', () => {
      const emb = [1, 0, 0];
      const entries = [
        makeEntry({ id: '1', content: 'cat', importance: 0.7, embedding: emb }),
        makeEntry({ id: '2', content: 'feline', importance: 0.5, embedding: nearDuplicateEmbedding(emb, 0.0001) }),
        makeEntry({ id: '3', content: 'dog', importance: 0.8, embedding: [0, 1, 0] }),
      ];
      const result = service.dedup(entries);
      expect(result).toHaveLength(2);
      expect(result.map(e => e.id).sort()).toEqual(['1', '3']);
    });

    it('keeps all entries below threshold', () => {
      const entries = [
        makeEntry({ id: '1', content: 'alpha', embedding: [1, 0, 0] }),
        makeEntry({ id: '2', content: 'beta', embedding: [0, 1, 0] }),
      ];
      const result = service.dedup(entries, 0.98);
      expect(result).toHaveLength(2);
    });

    it('returns empty for empty input', () => {
      expect(service.dedup([])).toHaveLength(0);
    });
  });

  describe('consolidate', () => {
    it('merges similar entries', () => {
      const emb = [1, 0, 0];
      const entries = [
        makeEntry({ id: '1', content: 'user likes python', importance: 0.7, embedding: emb, updatedAt: '2025-01-02T00:00:00Z', metadata: { source: 'chat' } }),
        makeEntry({ id: '2', content: 'user loves python', importance: 0.9, embedding: nearDuplicateEmbedding(emb, 0.01), updatedAt: '2025-01-03T00:00:00Z', metadata: { verified: true } }),
      ];
      const result = service.consolidate(entries, 0.85);
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('user likes python');
      expect(result[0].content).toContain('user loves python');
      expect(result[0].importance).toBe(0.9);
      expect(result[0].updatedAt).toBe('2025-01-03T00:00:00Z');
      expect(result[0].metadata).toEqual({ source: 'chat', verified: true });
    });

    it('keeps dissimilar entries separate', () => {
      const entries = [
        makeEntry({ id: '1', content: 'alpha', embedding: [1, 0, 0] }),
        makeEntry({ id: '2', content: 'beta', embedding: [0, 1, 0] }),
      ];
      const result = service.consolidate(entries, 0.85);
      expect(result).toHaveLength(2);
    });

    it('returns empty for empty input', () => {
      expect(service.consolidate([])).toHaveLength(0);
    });
  });

  describe('shouldDedup', () => {
    it('returns true for duplicate entry', () => {
      const emb = [1, 0, 0];
      const existing = [makeEntry({ id: '1', content: 'test', embedding: emb })];
      const newEntry = makeEntry({ id: '2', content: 'test near', embedding: nearDuplicateEmbedding(emb, 0.0001) });
      expect(service.shouldDedup(newEntry, existing)).toBe(true);
    });

    it('returns false for unique entry', () => {
      const existing = [makeEntry({ id: '1', content: 'test', embedding: [1, 0, 0] })];
      const newEntry = makeEntry({ id: '2', content: 'different', embedding: [0, 1, 0] });
      expect(service.shouldDedup(newEntry, existing)).toBe(false);
    });

    it('returns true for exact string match without embeddings', () => {
      const existing = [makeEntry({ id: '1', content: 'hello' })];
      const newEntry = makeEntry({ id: '2', content: 'hello' });
      expect(service.shouldDedup(newEntry, existing)).toBe(true);
    });

    it('returns false for different strings without embeddings', () => {
      const existing = [makeEntry({ id: '1', content: 'hello' })];
      const newEntry = makeEntry({ id: '2', content: 'world' });
      expect(service.shouldDedup(newEntry, existing)).toBe(false);
    });
  });

  describe('default thresholds', () => {
    it('exports correct values', () => {
      expect(DEFAULT_DEDUP_THRESHOLD).toBe(0.98);
      expect(DEFAULT_CONSOLIDATION_THRESHOLD).toBe(0.85);
    });
  });
});
