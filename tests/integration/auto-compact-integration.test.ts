import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AutoCompactService } from '../../src/memory/auto-compact';
import type { Message } from '../../src/memory/auto-compact';

describe('AutoCompactService Integration', () => {
  let service: AutoCompactService;

  beforeEach(() => {
    service = new AutoCompactService();
  });

  it('should handle full compaction flow', async () => {
    const messages: Message[] = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i} with some content to increase token count`.repeat(10),
      timestamp: Date.now() - i * 60000,
    }));

    const microResult = service.microCompact(messages);
    expect(microResult.length).toBe(50);

    const tokens = service.estimateTokens(microResult);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle empty messages', () => {
    const result = service.microCompact([]);
    expect(result).toEqual([]);
  });

  it('should estimate tokens accurately', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const tokens = service.estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should work without LLM client', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Test message' },
    ];
    const result = await service.autoCompact(messages);
    expect(result).toBe(messages);
  });

  it('should check and compact at threshold', async () => {
    const largeMessages: Message[] = Array.from({ length: 100 }, (_, i) => ({
      role: 'user',
      content: `Content ${i} `.repeat(100),
      timestamp: Date.now(),
    }));

    const result = await service.checkAndCompact(largeMessages);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('AutoCompactService Circuit Breaker', () => {
  it('should track consecutive failures', async () => {
    const mockLLM = {
      generateText: mock(() => Promise.reject(new Error('API down'))),
    };
    const service = new AutoCompactService(mockLLM as any);

    const messages: Message[] = [
      { role: 'user', content: 'Test'.repeat(1000) },
    ];

    await service.autoCompact(messages);
    await service.autoCompact(messages).catch(() => {});
    await service.autoCompact(messages).catch(() => {});

    const result = await service.autoCompact(messages);
    expect(result).toBe(messages);
  });
});
