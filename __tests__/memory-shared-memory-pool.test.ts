import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SharedMemoryPool } from './shared-memory-pool';
import { UserMemoryStore } from './user-memory-store';
import { MemoryEntry, MemoryLayer } from './types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempBase: string;
let dirCounter = 0;

function uniqueDir(): string {
  return join(tempBase, `smp-test-${++dirCounter}`);
}

beforeAll(() => {
  tempBase = mkdtempSync(join(tmpdir(), 'smp-test-'));
});

afterAll(() => {
  rmSync(tempBase, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'test-id',
    layer: MemoryLayer.SEMANTIC,
    content: 'shared knowledge',
    metadata: {},
    importance: 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    namespace: 'shared',
    ...overrides,
  };
}

describe('SharedMemoryPool', () => {
  describe('publish', () => {
    test('publishes entry for an agent', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);
      const entry = makeEntry({ id: 'pub-1', content: 'agent A knowledge' });

      await pool.publish('agent-a', entry);

      const agentEntries = await pool.getAgentEntries('agent-a');
      expect(agentEntries.length).toBe(1);
      expect(agentEntries[0].content).toBe('agent A knowledge');
    });

    test('adds publishedBy and publishedAt metadata', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);
      const entry = makeEntry({ id: 'pub-meta-1' });

      await pool.publish('agent-b', entry);

      const agentEntries = await pool.getAgentEntries('agent-b');
      expect(agentEntries[0].metadata.publishedBy).toBe('agent-b');
      expect(agentEntries[0].metadata.publishedAt).toBeDefined();
    });

    test('publishes multiple entries for same agent', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      await pool.publish('agent-c', makeEntry({ id: 'pub-2', content: 'first' }));
      await pool.publish('agent-c', makeEntry({ id: 'pub-3', content: 'second' }));

      const agentEntries = await pool.getAgentEntries('agent-c');
      expect(agentEntries.length).toBe(2);
    });
  });

  describe('retrieve', () => {
    test('retrieves entries from other agents matching query', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      await pool.publish('agent-x', makeEntry({ id: 'ret-1', content: 'database connection string', importance: 0.8 }));
      await pool.publish('agent-y', makeEntry({ id: 'ret-2', content: 'unrelated data', importance: 0.5 }));

      const results = await pool.retrieve('agent-z', 'database');
      expect(results.length).toBe(1);
      expect(results[0].entry.content).toBe('database connection string');
    });

    test('excludes own agent entries from retrieval', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      await pool.publish('agent-self', makeEntry({ id: 'ret-self-1', content: 'my own secret' }));

      const results = await pool.retrieve('agent-self', 'secret');
      expect(results.length).toBe(0);
    });

    test('returns empty when no matching entries', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      await pool.publish('agent-q', makeEntry({ id: 'ret-nomatch', content: 'weather data' }));

      const results = await pool.retrieve('agent-r', 'database');
      expect(results.length).toBe(0);
    });

    test('respects topK option', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      await pool.publish('agent-a1', makeEntry({ id: 'topk-1', content: 'api endpoint database', importance: 0.9 }));
      await pool.publish('agent-a2', makeEntry({ id: 'topk-2', content: 'database schema', importance: 0.7 }));
      await pool.publish('agent-a3', makeEntry({ id: 'topk-3', content: 'database credentials', importance: 0.6 }));

      const results = await pool.retrieve('agent-consumer', 'database', { topK: 2 });
      expect(results.length).toBe(2);
    });

    test('sorts results by score descending', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      await pool.publish('agent-s1', makeEntry({ id: 'sort-1', content: 'database low importance', importance: 0.3 }));
      await pool.publish('agent-s2', makeEntry({ id: 'sort-2', content: 'database high importance', importance: 0.9 }));

      const results = await pool.retrieve('agent-consumer', 'database');
      expect(results.length).toBe(2);
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    });
  });

  describe('subscribe', () => {
    test('receives published entries via subscription', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      const received: MemoryEntry[] = [];
      pool.subscribe('agent-sub', (entry) => received.push(entry));

      const entry = makeEntry({ id: 'sub-1', content: 'subscribed content' });
      await pool.publish('agent-sub', entry);

      expect(received.length).toBe(1);
      expect(received[0].content).toBe('subscribed content');
    });

    test('does not receive entries after unsubscribe', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      const received: MemoryEntry[] = [];
      const callback = (entry: MemoryEntry) => received.push(entry);

      pool.subscribe('agent-unsub', callback);
      await pool.publish('agent-unsub', makeEntry({ id: 'unsub-1', content: 'before unsub' }));
      expect(received.length).toBe(1);

      pool.unsubscribe('agent-unsub', callback);
      await pool.publish('agent-unsub', makeEntry({ id: 'unsub-2', content: 'after unsub' }));
      expect(received.length).toBe(1);
    });
  });

  describe('getAgentEntries', () => {
    test('returns empty array for agent with no entries', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      const entries = await pool.getAgentEntries('nonexistent-agent');
      expect(entries).toEqual([]);
    });
  });

  describe('getNamespaces', () => {
    test('returns all published namespaces', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      await pool.publish('ns-agent-1', makeEntry({ id: 'ns-1' }));
      await pool.publish('ns-agent-2', makeEntry({ id: 'ns-2' }));

      const namespaces = await pool.getNamespaces();
      expect(namespaces.length).toBe(2);
      expect(namespaces).toContain('shared/ns-agent-1');
      expect(namespaces).toContain('shared/ns-agent-2');
    });

    test('returns empty array when nothing published', async () => {
      const dir = uniqueDir();
      const store = new UserMemoryStore(dir);
      const pool = new SharedMemoryPool(store);

      const namespaces = await pool.getNamespaces();
      expect(namespaces).toEqual([]);
    });
  });
});
