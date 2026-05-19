import { describe, test, expect } from 'bun:test';
import { shouldEvictWorkingMemory, evictCompletedWorkingMemory } from './working-memory-lifecycle';
import { MemoryEntry, MemoryLayer } from './types';

function makeEntry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'layer' | 'content'>): MemoryEntry {
  return {
    importance: 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    namespace: 'test',
    metadata: {},
    ...overrides,
  };
}

describe('shouldEvictWorkingMemory', () => {
  test('running task not evictable', () => {
    const entry = makeEntry({ id: '1', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskStatus: 'running' } });
    expect(shouldEvictWorkingMemory(entry)).toBe(false);
  });

  test('pending task not evictable', () => {
    const entry = makeEntry({ id: '2', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskStatus: 'pending' } });
    expect(shouldEvictWorkingMemory(entry)).toBe(false);
  });

  test('suspended task not evictable', () => {
    const entry = makeEntry({ id: '3', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskStatus: 'suspended' } });
    expect(shouldEvictWorkingMemory(entry)).toBe(false);
  });

  test('waiting task not evictable', () => {
    const entry = makeEntry({ id: '4', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskStatus: 'waiting' } });
    expect(shouldEvictWorkingMemory(entry)).toBe(false);
  });

  test('completed task evictable', () => {
    const entry = makeEntry({ id: '5', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskStatus: 'completed' } });
    expect(shouldEvictWorkingMemory(entry)).toBe(true);
  });

  test('failed task evictable', () => {
    const entry = makeEntry({ id: '6', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskStatus: 'failed' } });
    expect(shouldEvictWorkingMemory(entry)).toBe(true);
  });

  test('non-WORKING layer not evictable', () => {
    const entry = makeEntry({ id: '7', layer: MemoryLayer.SEMANTIC, content: 'c', metadata: { taskStatus: 'completed' } });
    expect(shouldEvictWorkingMemory(entry)).toBe(false);
  });

  test('no taskStatus not evictable', () => {
    const entry = makeEntry({ id: '8', layer: MemoryLayer.WORKING, content: 'c' });
    expect(shouldEvictWorkingMemory(entry)).toBe(false);
  });
});

describe('evictCompletedWorkingMemory', () => {
  test('with completedTaskIds removes matching entries', () => {
    const entries = [
      makeEntry({ id: '1', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskId: 't1', taskStatus: 'running' } }),
      makeEntry({ id: '2', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskId: 't2', taskStatus: 'completed' } }),
      makeEntry({ id: '3', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskId: 't3', taskStatus: 'running' } }),
    ];
    const result = evictCompletedWorkingMemory(entries, ['t2']);
    expect(result).toHaveLength(2);
    expect(result.map(e => e.id)).toEqual(['1', '3']);
  });

  test('without completedTaskIds removes all completed and failed', () => {
    const entries = [
      makeEntry({ id: '1', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskStatus: 'running' } }),
      makeEntry({ id: '2', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskStatus: 'completed' } }),
      makeEntry({ id: '3', layer: MemoryLayer.WORKING, content: 'c', metadata: { taskStatus: 'failed' } }),
      makeEntry({ id: '4', layer: MemoryLayer.SEMANTIC, content: 'c', metadata: { taskStatus: 'completed' } }),
    ];
    const result = evictCompletedWorkingMemory(entries);
    expect(result).toHaveLength(2);
    expect(result.map(e => e.id)).toEqual(['1', '4']);
  });
});
