import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { MemoryLayer, MemoryEntry } from './types';
import { UserMemoryStore } from './user-memory-store';

const TEST_DIR = '/tmp/test-user-memory-store';

function makeEntry(id: string, layer: MemoryLayer, overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id,
    layer,
    content: `content-${id}`,
    metadata: {},
    importance: 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    namespace: 'test',
    ...overrides,
  };
}

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('UserMemoryStore', () => {
  test('write and read', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    const entry = makeEntry('e1', MemoryLayer.EPISODIC);
    await store.appendEntry('user1', MemoryLayer.EPISODIC, entry);
    const results = await store.getEntries('user1', MemoryLayer.EPISODIC);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e1');
    expect(results[0].content).toBe('content-e1');
  });

  test('immediate persistence - no debounce loss', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    const entry = makeEntry('e2', MemoryLayer.SEMANTIC);
    await store.appendEntry('user1', MemoryLayer.SEMANTIC, entry);

    // Destroy old store, create new instance — data must survive
    const store2 = new UserMemoryStore(TEST_DIR);
    const results = await store2.getEntries('user1', MemoryLayer.SEMANTIC);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e2');
  });

  test('multiple layers are separate', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    await store.appendEntry('user1', MemoryLayer.WORKING, makeEntry('w1', MemoryLayer.WORKING));
    await store.appendEntry('user1', MemoryLayer.EPISODIC, makeEntry('ep1', MemoryLayer.EPISODIC));
    await store.appendEntry('user1', MemoryLayer.SEMANTIC, makeEntry('s1', MemoryLayer.SEMANTIC));
    await store.appendEntry('user1', MemoryLayer.PROCEDURAL, makeEntry('p1', MemoryLayer.PROCEDURAL));

    const w = await store.getEntries('user1', MemoryLayer.WORKING);
    const ep = await store.getEntries('user1', MemoryLayer.EPISODIC);
    const s = await store.getEntries('user1', MemoryLayer.SEMANTIC);
    const p = await store.getEntries('user1', MemoryLayer.PROCEDURAL);

    expect(w).toHaveLength(1);
    expect(w[0].id).toBe('w1');

    expect(ep).toHaveLength(1);
    expect(ep[0].id).toBe('ep1');

    expect(s).toHaveLength(1);
    expect(s[0].id).toBe('s1');

    expect(p).toHaveLength(1);
    expect(p[0].id).toBe('p1');
  });

  test('remove entry', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    const entry = makeEntry('e1', MemoryLayer.WORKING);
    await store.appendEntry('user1', MemoryLayer.WORKING, entry);

    let results = await store.getEntries('user1', MemoryLayer.WORKING);
    expect(results).toHaveLength(1);

    await store.removeEntry('user1', MemoryLayer.WORKING, 'e1');
    results = await store.getEntries('user1', MemoryLayer.WORKING);
    expect(results).toHaveLength(0);
  });

  test('filter with MemoryQuery', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    await store.appendEntry('user1', MemoryLayer.EPISODIC, makeEntry('low', MemoryLayer.EPISODIC, { importance: 0.2 }));
    await store.appendEntry('user1', MemoryLayer.EPISODIC, makeEntry('mid', MemoryLayer.EPISODIC, { importance: 0.5 }));
    await store.appendEntry('user1', MemoryLayer.EPISODIC, makeEntry('high', MemoryLayer.EPISODIC, { importance: 0.9 }));

    const results = await store.getEntries('user1', MemoryLayer.EPISODIC, { importanceMin: 0.5 });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.importance >= 0.5)).toBe(true);
  });

  test('concurrent writes - mutex prevents data corruption', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        store.appendEntry('user1', MemoryLayer.EPISODIC, makeEntry(`e${i}`, MemoryLayer.EPISODIC)),
      );
    }
    await Promise.all(promises);

    const results = await store.getEntries('user1', MemoryLayer.EPISODIC);
    expect(results).toHaveLength(10);
    const ids = new Set(results.map((e) => e.id));
    expect(ids.size).toBe(10);
  });

  test('updateEntry modifies entry in-place', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    const entry = makeEntry('e1', MemoryLayer.EPISODIC, { importance: 0.3 });
    await store.appendEntry('user1', MemoryLayer.EPISODIC, entry);

    await store.updateEntry('user1', MemoryLayer.EPISODIC, 'e1', (e) => {
      e.importance = 0.9;
      e.content = 'updated content';
    });

    const results = await store.getEntries('user1', MemoryLayer.EPISODIC);
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe(0.9);
    expect(results[0].content).toBe('updated content');
  });

  test('updateEntry is atomic - entry persists after update', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    const entry = makeEntry('e2', MemoryLayer.SEMANTIC);
    await store.appendEntry('user1', MemoryLayer.SEMANTIC, entry);

    await store.updateEntry('user1', MemoryLayer.SEMANTIC, 'e2', (e) => {
      e.metadata.updated = true;
    });

    const store2 = new UserMemoryStore(TEST_DIR);
    const results = await store2.getEntries('user1', MemoryLayer.SEMANTIC);
    expect(results).toHaveLength(1);
    expect(results[0].metadata.updated).toBe(true);
  });

  test('updateEntry no-op for non-existent entry', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    await store.appendEntry('user1', MemoryLayer.EPISODIC, makeEntry('e1', MemoryLayer.EPISODIC));

    await store.updateEntry('user1', MemoryLayer.EPISODIC, 'nonexistent', (e) => {
      e.importance = 1.0;
    });

    const results = await store.getEntries('user1', MemoryLayer.EPISODIC);
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe(0.5);
  });

  // ── M6: Corrupted JSON returns empty data ─────────────────────

  test('M6: corrupted JSON file returns empty data instead of throwing', async () => {
    const corruptDir = join('/tmp', 'test-corrupt-json-' + Date.now());
    await mkdir(corruptDir, { recursive: true });
    try {
      await writeFile(join(corruptDir, 'corrupt-user.json'), '{ invalid json !!!', 'utf-8');

      const store = new UserMemoryStore(corruptDir);
      const data = await store.load('corrupt-user');

      expect(data).toBeDefined();
      expect(data.userId).toBe('corrupt-user');
      expect(data.episodic).toHaveLength(0);
      expect(data.working).toHaveLength(0);
      expect(data.semantic).toHaveLength(0);
      expect(data.procedural).toHaveLength(0);
      expect(data.shared).toHaveLength(0);
    } finally {
      await rm(corruptDir, { recursive: true, force: true });
    }
  });

  // ── M3: userId path traversal sanitized ───────────────────────

  test('M3: userId with path traversal is sanitized', async () => {
    const store = new UserMemoryStore(TEST_DIR);
    const data = await store.load('../../../etc/passwd');
    expect(data).toBeDefined();

    await store.appendEntry('../../../etc/passwd', MemoryLayer.EPISODIC, makeEntry('e1', MemoryLayer.EPISODIC));

    const store2 = new UserMemoryStore(TEST_DIR);
    const results = await store2.getEntries('../../../etc/passwd', MemoryLayer.EPISODIC);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e1');
  });

  // ── L1: LRU cache eviction ───────────────────────────────────

  test('L1: recently accessed entries survive cache eviction (LRU)', async () => {
    const store = new UserMemoryStore(TEST_DIR);

    await store.appendEntry('lru-user-1', MemoryLayer.EPISODIC, makeEntry('e1', MemoryLayer.EPISODIC));

    for (let i = 2; i <= 51; i++) {
      await store.appendEntry(`lru-user-${i}`, MemoryLayer.EPISODIC, makeEntry(`e${i}`, MemoryLayer.EPISODIC));
    }

    const data1 = await store.getEntries('lru-user-1', MemoryLayer.EPISODIC);
    expect(data1).toHaveLength(1);
    expect(data1[0].id).toBe('e1');

    for (let i = 52; i <= 101; i++) {
      await store.appendEntry(`lru-user-${i}`, MemoryLayer.EPISODIC, makeEntry(`e${i}`, MemoryLayer.EPISODIC));
    }

    const data1Again = await store.getEntries('lru-user-1', MemoryLayer.EPISODIC);
    expect(data1Again).toHaveLength(1);
    expect(data1Again[0].id).toBe('e1');
  });

  // ── L2: writeLocks cleanup ───────────────────────────────────

  test('L2: writeLocks entries are cleaned up after resolution', async () => {
    const store = new UserMemoryStore(TEST_DIR);

    for (let i = 0; i < 100; i++) {
      await store.appendEntry('lock-user', MemoryLayer.EPISODIC, makeEntry(`le${i}`, MemoryLayer.EPISODIC));
    }

    const results = await store.getEntries('lock-user', MemoryLayer.EPISODIC);
    expect(results).toHaveLength(100);

    const locks = (store as any).writeLocks as Map<string, unknown>;
    expect(locks.size).toBe(0);
  });

  // ── H3: appendEntry evicts oldest when exceeding maxEntriesPerLayer ──

  test('H3: appendEntry evicts oldest entries when exceeding maxEntriesPerLayer', async () => {
    const store = new UserMemoryStore(TEST_DIR, { maxEntriesPerLayer: 5 });

    for (let i = 1; i <= 6; i++) {
      await store.appendEntry('limit-user', MemoryLayer.EPISODIC, makeEntry(`h${i}`, MemoryLayer.EPISODIC));
    }

    const results = await store.getEntries('limit-user', MemoryLayer.EPISODIC);
    expect(results).toHaveLength(5);

    // The oldest entry (h1) should have been evicted
    const ids = results.map((e) => e.id);
    expect(ids).not.toContain('h1');
    // The newest entry (h6) should still be present
    expect(ids).toContain('h6');
  });
});
