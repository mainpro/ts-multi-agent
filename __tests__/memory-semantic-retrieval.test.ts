import { describe, test, expect } from 'bun:test';
import { EmbeddingService } from './embedding-service';
import { SemanticRetrievalEngine, RetrievalWeights } from './semantic-retrieval';
import { MemoryEntry, MemoryLayer } from './types';

function makeEntry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'content'>): MemoryEntry {
  return {
    layer: MemoryLayer.EPISODIC,
    metadata: {},
    importance: 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    namespace: 'test',
    ...overrides,
  };
}

describe('SemanticRetrievalEngine', () => {
  const embeddingService = new EmbeddingService();

  test('keyword matching retrieves relevant entries', async () => {
    const engine = new SemanticRetrievalEngine(embeddingService);
    const entries = [
      makeEntry({ id: '1', content: 'EES报销流程需要先提交申请' }),
      makeEntry({ id: '2', content: '考勤打卡规则每天九点前' }),
      makeEntry({ id: '3', content: 'GEAM权限申请联系管理员' }),
    ];

    const results = await engine.retrieve('报销', entries);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.id).toBe('1');
  });

  test('works without embeddings', async () => {
    const engine = new SemanticRetrievalEngine(embeddingService);
    const entries = [
      makeEntry({ id: '1', content: 'EES报销流程', embedding: undefined }),
      makeEntry({ id: '2', content: '考勤打卡规则', embedding: undefined }),
    ];

    const results = await engine.retrieve('报销', entries);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.id).toBe('1');
  });

  test('recency scoring: newer entries score higher', async () => {
    const engine = new SemanticRetrievalEngine(embeddingService, undefined, 24);
    const now = new Date();
    const oldDate = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const entries = [
      makeEntry({ id: 'old', content: '报销流程说明', createdAt: oldDate.toISOString(), importance: 0.5 }),
      makeEntry({ id: 'new', content: '报销流程说明', createdAt: now.toISOString(), importance: 0.5 }),
    ];

    const results = await engine.retrieve('报销', entries);
    const oldResult = results.find(r => r.entry.id === 'old')!;
    const newResult = results.find(r => r.entry.id === 'new')!;
    expect(newResult.scoreBreakdown.recency).toBeGreaterThan(oldResult.scoreBreakdown.recency);
    expect(newResult.score).toBeGreaterThan(oldResult.score);
  });

  test('importance boosting: high importance entries score higher', async () => {
    const engine = new SemanticRetrievalEngine(embeddingService);
    const entries = [
      makeEntry({ id: 'low', content: '报销流程说明', importance: 0.2 }),
      makeEntry({ id: 'high', content: '报销流程说明', importance: 0.9 }),
    ];

    const results = await engine.retrieve('报销', entries);
    const lowResult = results.find(r => r.entry.id === 'low')!;
    const highResult = results.find(r => r.entry.id === 'high')!;
    expect(highResult.scoreBreakdown.importance).toBeGreaterThan(lowResult.scoreBreakdown.importance);
    expect(highResult.score).toBeGreaterThan(lowResult.score);
  });

  test('default weights are keyword=0.5, recency=0.3, importance=0.2', () => {
    const engine = new SemanticRetrievalEngine(embeddingService);
    const weights = engine.getWeights();
    expect(weights.keyword).toBe(0.5);
    expect(weights.recency).toBe(0.3);
    expect(weights.importance).toBe(0.2);
  });

  test('topK limits results', async () => {
    const engine = new SemanticRetrievalEngine(embeddingService);
    const entries = [
      makeEntry({ id: '1', content: 'EES报销流程', importance: 0.9 }),
      makeEntry({ id: '2', content: '报销流程简化版', importance: 0.7 }),
      makeEntry({ id: '3', content: '报销补充说明', importance: 0.5 }),
      makeEntry({ id: '4', content: '考勤打卡', importance: 0.3 }),
    ];

    const results = await engine.retrieve('报销', entries, { topK: 2 });
    expect(results.length).toBe(2);
  });

  test('scoreBreakdown uses keyword instead of semantic', async () => {
    const engine = new SemanticRetrievalEngine(embeddingService);
    const entries = [makeEntry({ id: '1', content: 'EES报销流程' })];

    const results = await engine.retrieve('报销', entries);
    expect(results[0].scoreBreakdown).toHaveProperty('keyword');
    expect(results[0].scoreBreakdown).not.toHaveProperty('semantic');
  });

  test('computeKeywordScore falls back to keywordMatchScore when no embedding', () => {
    const engine = new SemanticRetrievalEngine(embeddingService);
    const entry = makeEntry({ id: '1', content: 'EES报销流程' });
    const score = engine.computeKeywordScore('报销', entry);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test('computeKeywordScore uses cosineSimilarity when embedding available', () => {
    const engine = new SemanticRetrievalEngine(embeddingService);
    const entry = makeEntry({ id: '1', content: 'EES报销流程', embedding: [1, 0, 0] });
    const score = engine.computeKeywordScore('报销', entry);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
