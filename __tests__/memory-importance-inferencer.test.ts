import { describe, test, expect, mock } from 'bun:test';
import { ImportanceInferencer, InferenceResult } from './importance-inferencer';
import { MemoryEntry, MemoryLayer } from './types';

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'test-1',
    layer: MemoryLayer.EPISODIC,
    content: 'User asked about EES system configuration',
    metadata: {},
    importance: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    namespace: 'default',
    ...overrides,
  };
}

describe('ImportanceInferencer', () => {
  test('infer returns valid importance 0-1 without LLM (heuristic)', async () => {
    const inferencer = new ImportanceInferencer(undefined);
    const entry = makeEntry();
    const result = await inferencer.infer(entry);

    expect(result.importance).toBeGreaterThanOrEqual(0);
    expect(result.importance).toBeLessThanOrEqual(1);
    expect(result.scope).toBe('personal');
    expect(result.category).toBe('event');
  });

  test('heuristic fallback: longer content yields higher importance', async () => {
    const inferencer = new ImportanceInferencer(undefined);
    const short = makeEntry({ content: 'hi' });
    const long = makeEntry({ content: 'a'.repeat(500) });

    const shortResult = await inferencer.infer(short);
    const longResult = await inferencer.infer(long);

    expect(longResult.importance).toBeGreaterThan(shortResult.importance);
  });

  test('heuristic fallback: metadata presence boosts importance', async () => {
    const inferencer = new ImportanceInferencer(undefined);
    const noMeta = makeEntry({ metadata: {} });
    const withMeta = makeEntry({ metadata: { source: 'user', priority: 'high' } });

    const noMetaResult = await inferencer.infer(noMeta);
    const withMetaResult = await inferencer.infer(withMeta);

    expect(withMetaResult.importance).toBeGreaterThan(noMetaResult.importance);
  });

  test('heuristic fallback importance formula matches spec', async () => {
    const inferencer = new ImportanceInferencer(undefined);
    const entry = makeEntry({ content: 'test', metadata: {} });
    const result = await inferencer.infer(entry);

    const expected = Math.min(1, 'test'.length / 500) * 0.5 + 0 + 0.3;
    expect(result.importance).toBeCloseTo(expected);
  });

  test('inferBatch updates all entries', async () => {
    const inferencer = new ImportanceInferencer(undefined);
    const entries = [
      makeEntry({ id: '1', content: 'short' }),
      makeEntry({ id: '2', content: 'a'.repeat(300) }),
      makeEntry({ id: '3', content: 'a'.repeat(600), metadata: { key: 'val' } }),
    ];

    const result = await inferencer.inferBatch(entries);

    expect(result).toHaveLength(3);
    for (const entry of result) {
      expect(entry.importance).toBeGreaterThan(0);
      expect(entry.importance).toBeLessThanOrEqual(1);
    }
  });

  test('inferBatch processes sequentially and returns same references', async () => {
    const inferencer = new ImportanceInferencer(undefined);
    const entries = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })];

    const result = await inferencer.inferBatch(entries);

    expect(result[0]).toBe(entries[0]);
    expect(result[1]).toBe(entries[1]);
  });

  test('LLM inference succeeds with valid response', async () => {
    const mockClient = {
      generateStructured: mock(async () => ({
        importance: 0.8,
        scope: 'team',
        category: 'fact',
      })),
      generateText: mock(async () => ''),
    } as unknown as InstanceType<typeof import('../llm/index').LLMClient>;

    const inferencer = new ImportanceInferencer(mockClient);
    const entry = makeEntry();
    const result = await inferencer.infer(entry);

    expect(result.importance).toBe(0.8);
    expect(result.scope).toBe('team');
    expect(result.category).toBe('fact');
  });

  test('invalid LLM response falls back to heuristic', async () => {
    const mockClient = {
      generateStructured: mock(async () => {
        throw new Error('Schema validation failed');
      }),
      generateText: mock(async () => ''),
    } as unknown as InstanceType<typeof import('../llm/index').LLMClient>;

    const inferencer = new ImportanceInferencer(mockClient);
    const entry = makeEntry();
    const result = await inferencer.infer(entry);

    expect(result.scope).toBe('personal');
    expect(result.category).toBe('event');
    expect(result.importance).toBeGreaterThanOrEqual(0);
    expect(result.importance).toBeLessThanOrEqual(1);
  });
});
