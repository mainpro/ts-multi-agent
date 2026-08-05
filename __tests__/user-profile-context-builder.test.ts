import { describe, expect, test } from 'bun:test';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import type { UserMemory } from '../src/memory/memory-service';

describe('DynamicContextBuilder extended fields', () => {
  function makeMemory(profile: any): UserMemory {
    return { profile, episodicEntries: [] };
  }

  test('formats role and department', async () => {
    const builder = new DynamicContextBuilder({} as any);
    const memory = makeMemory({
      userId: 'u-1',
      role: 'admin',
      department: '财务部',
      commonSystems: ['OA'],
      tags: [],
      conversationCount: 5,
    });

    const out = (builder as any).formatMemorySection(memory, 'test');
    expect(out).toContain('**用户ID**: u-1');
    expect(out).toContain('**角色**: admin');
  });

  test('formats history top-10', async () => {
    const builder = new DynamicContextBuilder({} as any);
    const memory = makeMemory({
      userId: 'u-1',
      role: 'employee',
      department: '财务部',
      commonSystems: [],
      tags: [],
      conversationCount: 0,
      history: Array.from({ length: 15 }, (_, i) => ({
        topic: `topic-${i}`,
        summary: `summary-${i}`,
        lastOccurredAt: '2026-08-01',
        occurrences: 1,
      })),
    });

    const out = (builder as any).formatMemorySection(memory, 'test');
    expect(out).toContain('历史问题');
    const lineCount = (out.match(/topic-/g) || []).length;
    expect(lineCount).toBe(10); // topN=10
  });

  test('formats preferences top-10', async () => {
    const builder = new DynamicContextBuilder({} as any);
    const memory = makeMemory({
      userId: 'u-1',
      role: 'employee',
      department: '财务部',
      commonSystems: [],
      tags: [],
      conversationCount: 0,
      preferences: [
        { key: 'response_style', value: 'concise', confidence: 0.8 },
      ],
    });

    const out = (builder as any).formatMemorySection(memory, 'test');
    expect(out).toContain('偏好');
    expect(out).toContain('response_style');
  });

  test('omits history when empty', async () => {
    const builder = new DynamicContextBuilder({} as any);
    const memory = makeMemory({
      userId: 'u-1',
      role: 'employee',
      department: '财务部',
      commonSystems: [],
      tags: [],
      conversationCount: 0,
    });

    const out = (builder as any).formatMemorySection(memory, 'test');
    expect(out).not.toContain('历史问题');
  });
});
