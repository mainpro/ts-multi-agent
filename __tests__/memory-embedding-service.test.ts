import { describe, test, expect } from 'bun:test';
import { EmbeddingService } from './embedding-service';

describe('EmbeddingService', () => {
  test('generateEmbedding returns null by default', async () => {
    const svc = new EmbeddingService(undefined);
    const result = await svc.generateEmbedding('test text');
    expect(result).toBeNull();
  });

  test('generateEmbeddings returns array of nulls', async () => {
    const svc = new EmbeddingService(undefined);
    const results = await svc.generateEmbeddings(['hello', 'world']);
    expect(results).toEqual([null, null]);
  });

  test('keywordMatchScore works', () => {
    const svc = new EmbeddingService(undefined);
    const score = svc.keywordMatchScore('报销流程', '费用报销流程说明');
    expect(score).toBeGreaterThan(0);
  });

  test('keywordMatchScore returns 0 for no matches', () => {
    const svc = new EmbeddingService(undefined);
    const score = svc.keywordMatchScore('xyz', 'abc');
    expect(score).toBe(0);
  });

  test('cosineSimilarity works', () => {
    const svc = new EmbeddingService(undefined);
    const v = [1, 0, 0];
    const score = svc.cosineSimilarity(v, v);
    expect(Math.abs(score - 1)).toBeLessThan(0.001);
  });

  test('cosineSimilarity orthogonal vectors', () => {
    const svc = new EmbeddingService(undefined);
    const score = svc.cosineSimilarity([1, 0, 0], [0, 1, 0]);
    expect(Math.abs(score)).toBeLessThan(0.001);
  });

  test('cosineSimilarity returns 0 for empty/different-length vectors', () => {
    const svc = new EmbeddingService(undefined);
    expect(svc.cosineSimilarity([], [])).toBe(0);
    expect(svc.cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  test('isAvailable returns false without apiUrl', () => {
    const svc = new EmbeddingService(undefined);
    expect(svc.isAvailable()).toBe(false);
  });

  test('isAvailable returns true with apiUrl', () => {
    const svc = new EmbeddingService(undefined, { dimension: 1024, apiUrl: 'https://example.com/embeddings' });
    expect(svc.isAvailable()).toBe(true);
  });
});
