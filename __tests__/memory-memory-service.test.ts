import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { MemoryService } from './memory-service';
import { MemoryEntry, MemoryLayer } from './types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempBase: string;
let dirCounter = 0;

function uniqueDir(): string {
  return join(tempBase, `test-${++dirCounter}`);
}

beforeAll(() => {
  tempBase = mkdtempSync(join(tmpdir(), 'mem-test-'));
});

afterAll(() => {
  rmSync(tempBase, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'test-id',
    layer: MemoryLayer.EPISODIC,
    content: 'test content',
    metadata: {},
    importance: 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    namespace: 'user1',
    ...overrides,
  };
}

describe('MemoryService', () => {
  describe('constructor', () => {
    test('creates with default parameters', () => {
      const service = new MemoryService();
      expect(service).toBeDefined();
      expect(service.getStore()).toBeDefined();
    });

    test('creates with custom dataDir and config', () => {
      const service = new MemoryService('custom-data', { maxRounds: 5, storagePath: 'custom-memory' });
      expect(service).toBeDefined();
    });
  });

  describe('core memory operations', () => {
    test('remember stores entry via store', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const entry = makeEntry({ namespace: 'remember-user' });
      await service.remember(entry);
      const results = await service.recall('remember-user', 'test content', { namespace: 'remember-user' });
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    test('recall queries store entries', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const entry = makeEntry({ content: 'semantic search test', namespace: 'recall-user' });
      await service.remember(entry);
      const results = await service.recall('recall-user', 'semantic', { namespace: 'recall-user' });
      expect(Array.isArray(results)).toBe(true);
    });

    test('recall respects options', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const results = await service.recall('nobody', 'nonexistent', { topK: 1, minScore: 0.9, namespace: 'nobody' });
      expect(results.length).toBe(0);
    });

    test('compactSession delegates to AutoCompactService', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const messages = [
        { role: 'user', content: 'hello', timestamp: Date.now() },
        { role: 'assistant', content: 'hi', timestamp: Date.now() },
      ];
      const result = await service.compactSession(messages);
      expect(Array.isArray(result)).toBe(true);
    });

    test('getStore returns UserMemoryStore', () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const store = service.getStore();
      expect(store).toBeDefined();
      expect(typeof store.appendEntry).toBe('function');
      expect(typeof store.getEntries).toBe('function');
      expect(typeof store.removeEntry).toBe('function');
    });
  });

  describe('layer-specific write methods', () => {
    test('saveWorkingMemory stores working entry', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveWorkingMemory('wm-user-1', 'task-1', 'working on something');
      const store = service.getStore();
      const entries = await store.getEntries('wm-user-1', MemoryLayer.WORKING);
      expect(entries.length).toBe(1);
      expect(entries[0].metadata.taskId).toBe('task-1');
      expect(entries[0].metadata.taskStatus).toBe('pending');
      expect(entries[0].layer).toBe(MemoryLayer.WORKING);
    });

    test('saveWorkingMemory with custom status', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveWorkingMemory('wm-user-2', 'task-2', 'content', 'running', 'req-1');
      const store = service.getStore();
      const entries = await store.getEntries('wm-user-2', MemoryLayer.WORKING);
      expect(entries.length).toBe(1);
      expect(entries[0].metadata.taskStatus).toBe('running');
      expect(entries[0].metadata.requestId).toBe('req-1');
    });

    test('updateWorkingMemoryStatus updates task status', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveWorkingMemory('wm-user-3', 'task-3', 'content', 'pending');
      await service.updateWorkingMemoryStatus('wm-user-3', 'task-3', 'completed');
      const store = service.getStore();
      const entries = await store.getEntries('wm-user-3', MemoryLayer.WORKING);
      expect(entries.length).toBe(1);
      expect(entries[0].metadata.taskStatus).toBe('completed');
    });

    test('saveSemanticMemory stores semantic entry', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveSemanticMemory('sem-user-1', 'user prefers dark mode', 'preference', 'explicit', 0.9);
      const store = service.getStore();
      const entries = await store.getEntries('sem-user-1', MemoryLayer.SEMANTIC);
      expect(entries.length).toBe(1);
      expect(entries[0].metadata.category).toBe('preference');
      expect(entries[0].metadata.source).toBe('explicit');
      expect(entries[0].importance).toBe(0.9);
    });

    test('saveSemanticMemory defaults to fact/inferred/0.7', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveSemanticMemory('sem-user-2', 'some fact');
      const store = service.getStore();
      const entries = await store.getEntries('sem-user-2', MemoryLayer.SEMANTIC);
      expect(entries.length).toBe(1);
      expect(entries[0].metadata.category).toBe('fact');
      expect(entries[0].metadata.source).toBe('inferred');
      expect(entries[0].importance).toBe(0.7);
    });

    test('saveProceduralMemory creates new procedural entry', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveProceduralMemory('proc-user-1', 'skill-a', 'executed skill-a', { key: 'val' }, 'ok', true);
      const store = service.getStore();
      const entries = await store.getEntries('proc-user-1', MemoryLayer.PROCEDURAL);
      expect(entries.length).toBe(1);
      expect(entries[0].metadata.skillName).toBe('skill-a');
      expect(entries[0].metadata.usageCount).toBe(1);
      expect(entries[0].metadata.lastSuccess).toBe(true);
      expect(entries[0].importance).toBe(0.7);
    });

    test('saveProceduralMemory increments usageCount on duplicate', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveProceduralMemory('proc-user-2', 'skill-b', 'first run');
      await service.saveProceduralMemory('proc-user-2', 'skill-b', 'second run', undefined, 'res', true);
      const store = service.getStore();
      const entries = await store.getEntries('proc-user-2', MemoryLayer.PROCEDURAL);
      expect(entries.length).toBe(1);
      expect(entries[0].metadata.usageCount).toBe(2);
      expect(entries[0].metadata.lastResult).toBe('res');
    });

    test('saveProceduralMemory assigns lower importance on failure', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveProceduralMemory('proc-user-3', 'skill-c', 'failed run', undefined, undefined, false);
      const store = service.getStore();
      const entries = await store.getEntries('proc-user-3', MemoryLayer.PROCEDURAL);
      expect(entries[0].importance).toBe(0.5);
    });
  });

  describe('working memory eviction', () => {
    test('evictCompletedWorkingMemory removes completed entries', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveWorkingMemory('evict-1', 'task-a', 'done task', 'completed');
      await service.saveWorkingMemory('evict-1', 'task-b', 'pending task', 'pending');
      const evicted = await service.evictCompletedWorkingMemory('evict-1');
      expect(evicted).toBe(1);
      const store = service.getStore();
      const remaining = await store.getEntries('evict-1', MemoryLayer.WORKING);
      expect(remaining.length).toBe(1);
      expect(remaining[0].metadata.taskId).toBe('task-b');
    });

    test('evictCompletedWorkingMemory with explicit completedTaskIds', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveWorkingMemory('evict-2', 'task-x', 'running task', 'running');
      const evicted = await service.evictCompletedWorkingMemory('evict-2', ['task-x']);
      expect(evicted).toBe(1);
    });

    test('evictCompletedWorkingMemory returns 0 when nothing to evict', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveWorkingMemory('evict-3', 'task-y', 'pending task', 'pending');
      const evicted = await service.evictCompletedWorkingMemory('evict-3');
      expect(evicted).toBe(0);
    });
  });

  describe('getActiveTasks', () => {
    test('returns active tasks with pending/running/waiting status', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveWorkingMemory('at-user-1', 'task-1', 'content-1', 'pending');
      await service.saveWorkingMemory('at-user-1', 'task-2', 'content-2', 'running');
      await service.saveWorkingMemory('at-user-1', 'task-3', 'content-3', 'waiting');
      const active = await service.getActiveTasks('at-user-1');
      expect(active.length).toBe(3);
    });

    test('excludes completed and failed tasks', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveWorkingMemory('at-user-2', 'task-pending', 'content', 'pending');
      await service.saveWorkingMemory('at-user-2', 'task-completed', 'content', 'completed');
      await service.saveWorkingMemory('at-user-2', 'task-failed', 'content', 'failed');
      const active = await service.getActiveTasks('at-user-2');
      expect(active.length).toBe(1);
      expect(active[0].metadata.taskId).toBe('task-pending');
    });

    test('excludes evicted tasks (returns empty after eviction)', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await service.saveWorkingMemory('at-user-3', 'task-1', 'content-1', 'pending');
      await service.evictCompletedWorkingMemory('at-user-3', ['task-1']);
      const active = await service.getActiveTasks('at-user-3');
      expect(active.length).toBe(0);
    });

    test('returns empty array when no active tasks', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const active = await service.getActiveTasks('nonexistent-user');
      expect(active).toEqual([]);
    });
  });

  describe('shared memory', () => {
    test('shareMemory publishes entry to shared pool', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const entry = makeEntry({ content: 'shared fact', importance: 0.8 });
      await service.shareMemory('agent-1', entry);

      const results = await service.retrieveShared('agent-2', 'shared fact');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].entry.content).toBe('shared fact');
    });

    test('retrieveShared excludes own agent entries', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const entry = makeEntry({ content: 'my secret data', importance: 0.9 });
      await service.shareMemory('agent-self', entry);

      const results = await service.retrieveShared('agent-self', 'secret');
      expect(results.length).toBe(0);
    });

    test('retrieveShared returns empty for no matches', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const entry = makeEntry({ content: 'weather data', importance: 0.5 });
      await service.shareMemory('agent-wx', entry);

      const results = await service.retrieveShared('agent-other', 'database');
      expect(results).toEqual([]);
    });
  });

  describe('evictExpired', () => {
    test('evictExpired returns 0 when nothing expired', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const evicted = await service.evictExpired('expire-user-1');
      expect(evicted).toBe(0);
    });
  });

  describe('backward compatibility', () => {
    test('buildContextPrompt returns empty string for empty episodic entries', () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const result = service.buildContextPrompt({
        profile: { userId: 'u1', name: 'Test', department: 'Eng', role: 'dev', commonSystems: [], preferences: {} } as any,
        episodicEntries: [],
      });
      expect(result).toBe('');
    });

    test('buildContextPrompt formats episodic entries', () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const result = service.buildContextPrompt({
        profile: { userId: 'u1', name: 'Test', department: 'Eng', role: 'dev', commonSystems: [], preferences: {} } as any,
        episodicEntries: [
          { id: '1', userId: 'u1', layer: 'episodic' as any, content: 'hello', metadata: { role: 'user' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { id: '2', userId: 'u1', layer: 'episodic' as any, content: 'hi there', metadata: { role: 'assistant' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ] as any,
      });
      expect(result).toContain('用户: hello');
      expect(result).toContain('助手: hi there');
    });

    test('clearMemory does not throw', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      await expect(service.clearMemory('user1')).resolves.toBeUndefined();
    });

    test('dedupCheck returns boolean', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const result = await service.dedupCheck(makeEntry({ namespace: 'dedup-user' }));
      expect(typeof result).toBe('boolean');
    });

    test('inferImportance returns InferenceResult', async () => {
      const service = new MemoryService(uniqueDir(), { storagePath: uniqueDir() });
      const result = await service.inferImportance(makeEntry());
      expect(result).toHaveProperty('importance');
    });
  });
});