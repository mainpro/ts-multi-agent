import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { SemanticExtractor } from './semantic-extractor';
import { MemoryService } from './memory-service';
import { MemoryLayer } from './types';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

function uniqueDir(): string {
  return join(tmpdir(), `semantic-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('SemanticExtractor', () => {
  let testDir: string;
  let memoryService: MemoryService;

  beforeEach(() => {
    testDir = uniqueDir();
    mkdirSync(testDir, { recursive: true });
    memoryService = new MemoryService(testDir, { storagePath: testDir });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  test('extracts semantic knowledge from conversation', async () => {
    const mockLLM = {
      generateText: mock(async () =>
        JSON.stringify([
          { category: 'fact', content: '用户是财务部员工', confidence: 0.8 },
          { category: 'preference', content: '用户偏好简洁回答', confidence: 0.6 },
        ])
      ),
    };
    const extractor = new SemanticExtractor(mockLLM as any, memoryService);
    await extractor.extract('test-user', '我是财务部的', '好的，已记录');

    const store = memoryService.getStore();
    const entries = await store.getEntries('test-user', MemoryLayer.SEMANTIC);
    expect(entries.length).toBe(2);
    expect(entries[0].metadata.category).toBe('fact');
    expect(entries[0].content).toBe('用户是财务部员工');
    expect(entries[0].importance).toBe(0.8);
    expect(entries[1].metadata.category).toBe('preference');
    expect(entries[1].content).toBe('用户偏好简洁回答');
    expect(entries[1].importance).toBe(0.6);
  });

  test('handles LLM failure gracefully', async () => {
    const mockLLM = {
      generateText: mock(async () => { throw new Error('LLM error'); }),
    };
    const extractor = new SemanticExtractor(mockLLM as any, memoryService);
    await expect(extractor.extract('test-user', 'hello', 'hi')).resolves.toBeUndefined();

    const store = memoryService.getStore();
    const entries = await store.getEntries('test-user', MemoryLayer.SEMANTIC);
    expect(entries.length).toBe(0);
  });

  test('handles timeout gracefully', async () => {
    const mockLLM = {
      generateText: mock(async () => new Promise(resolve => setTimeout(resolve, 60000))),
    };
    const extractor = new SemanticExtractor(mockLLM as any, memoryService, 100);
    await expect(extractor.extract('test-user', 'hello', 'hi')).resolves.toBeUndefined();

    const store = memoryService.getStore();
    const entries = await store.getEntries('test-user', MemoryLayer.SEMANTIC);
    expect(entries.length).toBe(0);
  });

  test('handles empty LLM response', async () => {
    const mockLLM = {
      generateText: mock(async () => '[]'),
    };
    const extractor = new SemanticExtractor(mockLLM as any, memoryService);
    await extractor.extract('test-user', 'hello', 'hi');

    const store = memoryService.getStore();
    const entries = await store.getEntries('test-user', MemoryLayer.SEMANTIC);
    expect(entries.length).toBe(0);
  });

  test('handles non-JSON LLM response', async () => {
    const mockLLM = {
      generateText: mock(async () => 'I cannot extract any knowledge from this conversation.'),
    };
    const extractor = new SemanticExtractor(mockLLM as any, memoryService);
    await extractor.extract('test-user', 'hello', 'hi');

    const store = memoryService.getStore();
    const entries = await store.getEntries('test-user', MemoryLayer.SEMANTIC);
    expect(entries.length).toBe(0);
  });

  test('skips items with empty content', async () => {
    const mockLLM = {
      generateText: mock(async () =>
        JSON.stringify([
          { category: 'fact', content: '', confidence: 0.5 },
          { category: 'preference', content: '用户偏好中文', confidence: 0.9 },
        ])
      ),
    };
    const extractor = new SemanticExtractor(mockLLM as any, memoryService);
    await extractor.extract('test-user', 'hello', 'hi');

    const store = memoryService.getStore();
    const entries = await store.getEntries('test-user', MemoryLayer.SEMANTIC);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('用户偏好中文');
  });

  test('filters items with invalid category', async () => {
    const mockLLM = {
      generateText: mock(async () =>
        JSON.stringify([
          { category: 'invalid', content: 'something', confidence: 0.5 },
        ])
      ),
    };
    const extractor = new SemanticExtractor(mockLLM as any, memoryService);
    await extractor.extract('test-user', 'hello', 'hi');

    const store = memoryService.getStore();
    const entries = await store.getEntries('test-user', MemoryLayer.SEMANTIC);
    expect(entries.length).toBe(0);
  });

  test('passes skillName in prompt', async () => {
    let capturedPrompt = '';
    const mockLLM = {
      generateText: mock(async (prompt: string) => {
        capturedPrompt = prompt;
        return '[]';
      }),
    };
    const extractor = new SemanticExtractor(mockLLM as any, memoryService);
    await extractor.extract('test-user', '帮我查数据', '好的', 'data-query');

    expect(capturedPrompt).toContain('data-query');
    expect(capturedPrompt).toContain('使用的技能');
  });
});
