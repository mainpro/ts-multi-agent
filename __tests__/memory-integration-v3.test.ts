import { describe, test, expect, afterAll } from 'bun:test';
import { MemoryService } from './memory-service';
import { MemoryLayer } from './types';
import { UserMemoryStore } from './user-memory-store';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmpBase = mkdtempSync(join(tmpdir(), 'int-v3-'));
afterAll(() => {
  try { rmSync(tmpBase, { recursive: true }); } catch {}
});

function uniqueDir(): string {
  return join(tmpBase, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('Integration v3: Full memory lifecycle', () => {
  test('working → episodic → semantic → procedural → recall', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'lifecycle-user';
    const taskId = 'task-full';

    await svc.saveWorkingMemory(userId, taskId, 'processing request', 'pending');
    const working = await svc.getStore().getEntries(userId, MemoryLayer.WORKING);
    expect(working.length).toBe(1);
    expect(working[0].metadata.taskStatus).toBe('pending');

    await svc.updateWorkingMemoryStatus(userId, taskId, 'running');
    const afterRunning = await svc.getStore().getEntries(userId, MemoryLayer.WORKING);
    expect(afterRunning[0].metadata.taskStatus).toBe('running');

    await svc.saveSemanticMemory(userId, '用户偏好中文', 'preference', 'inferred', 0.9);
    await svc.saveProceduralMemory(userId, 'ees-qa', '查询EES', {}, 'result', true);

    await svc.updateWorkingMemoryStatus(userId, taskId, 'completed');
    const evicted = await svc.evictCompletedWorkingMemory(userId, [taskId]);
    expect(evicted).toBe(1);

    const workingAfterEvict = await svc.getStore().getEntries(userId, MemoryLayer.WORKING);
    expect(workingAfterEvict.length).toBe(0);

    const semantic = await svc.getStore().getEntries(userId, MemoryLayer.SEMANTIC);
    expect(semantic.length).toBe(1);
    expect(semantic[0].content).toContain('中文');

    const procedural = await svc.getStore().getEntries(userId, MemoryLayer.PROCEDURAL);
    expect(procedural.length).toBe(1);
    expect(procedural[0].content).toBe('查询EES');

    const semanticRecall = await svc.recall(userId, '中文', {
      namespace: userId,
      layers: [MemoryLayer.SEMANTIC],
      topK: 5,
    });
    expect(semanticRecall.length).toBeGreaterThanOrEqual(1);
    expect(semanticRecall[0].entry.content).toContain('中文');

    const procRecall = await svc.recall(userId, 'EES', {
      namespace: userId,
      layers: [MemoryLayer.PROCEDURAL],
      topK: 5,
    });
    expect(procRecall.length).toBeGreaterThanOrEqual(1);
    expect(procRecall[0].entry.content).toContain('EES');
  });

  test('suspended task working memory preserved', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'suspended-user';
    const taskId = 'task-suspended';

    await svc.saveWorkingMemory(userId, taskId, 'suspended task content', 'suspended');
    await svc.evictCompletedWorkingMemory(userId);

    const working = await svc.getStore().getEntries(userId, MemoryLayer.WORKING);
    expect(working.length).toBe(1);
    expect(working[0].metadata.taskStatus).toBe('suspended');
  });

  test('data survives restart', async () => {
    const dir = uniqueDir();
    const userId = 'restart-user';
    const taskId = 'task-restart';

    const store1 = new UserMemoryStore(dir);
    await store1.appendEntry(userId, MemoryLayer.WORKING, {
      id: 'w1',
      layer: MemoryLayer.WORKING,
      content: 'working data',
      metadata: { taskId, taskStatus: 'running' },
      importance: 0.3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      namespace: userId,
    });
    await store1.appendEntry(userId, MemoryLayer.EPISODIC, {
      id: 'e1',
      layer: MemoryLayer.EPISODIC,
      content: 'episodic data',
      metadata: {},
      importance: 0.5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      namespace: userId,
    });
    await store1.appendEntry(userId, MemoryLayer.SEMANTIC, {
      id: 's1',
      layer: MemoryLayer.SEMANTIC,
      content: 'semantic data',
      metadata: { category: 'fact', source: 'explicit', confidence: 0.8 },
      importance: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      namespace: userId,
    });
    await store1.appendEntry(userId, MemoryLayer.PROCEDURAL, {
      id: 'p1',
      layer: MemoryLayer.PROCEDURAL,
      content: 'procedural data',
      metadata: { skillName: 'test-skill', usageCount: 1 },
      importance: 0.7,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      namespace: userId,
    });

    const store2 = new UserMemoryStore(dir);
    const working = await store2.getEntries(userId, MemoryLayer.WORKING);
    const episodic = await store2.getEntries(userId, MemoryLayer.EPISODIC);
    const semantic = await store2.getEntries(userId, MemoryLayer.SEMANTIC);
    const procedural = await store2.getEntries(userId, MemoryLayer.PROCEDURAL);

    expect(working.length).toBe(1);
    expect(working[0].content).toBe('working data');
    expect(episodic.length).toBe(1);
    expect(episodic[0].content).toBe('episodic data');
    expect(semantic.length).toBe(1);
    expect(semantic[0].content).toBe('semantic data');
    expect(procedural.length).toBe(1);
    expect(procedural[0].content).toBe('procedural data');
  });

  test('empty memory recall returns empty', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const results = await svc.recall('empty-user', 'anything', { namespace: 'empty-user', topK: 5 });
    expect(results).toEqual([]);
  });

  test('procedural memory usageCount increments', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'proc-count-user';

    await svc.saveProceduralMemory(userId, 'ees-qa', '查询EES', {}, 'result1', true);
    await svc.saveProceduralMemory(userId, 'ees-qa', '查询EES', {}, 'result2', true);

    const procedural = await svc.getStore().getEntries(userId, MemoryLayer.PROCEDURAL);
    expect(procedural.length).toBe(1);
    expect(procedural[0].metadata.usageCount).toBe(2);
  });

  test('working memory not evicted by TTL', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'ttl-user';
    const taskId = 'task-ttl';

    await svc.saveWorkingMemory(userId, taskId, 'running task', 'running');
    const evicted = await svc.evictExpired(userId);
    expect(evicted).toBe(0);

    const working = await svc.getStore().getEntries(userId, MemoryLayer.WORKING);
    expect(working.length).toBe(1);
  });
});
