import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutoCompactService, CompactStrategy, MICRO_COMPACT_THRESHOLD_MS, CLEARED_TOOL_RESULT_PLACEHOLDER, AUTO_COMPACT_THRESHOLD, MAX_FAILURES } from './auto-compact.js';

describe('AutoCompactService', () => {
  let service: AutoCompactService;

  beforeEach(() => {
    service = new AutoCompactService();
  });

  it('should be instantiable', () => {
    expect(service).toBeInstanceOf(AutoCompactService);
  });

  it('should have CompactStrategy enum', () => {
    expect(CompactStrategy.MICRO).toBe('MICRO');
    expect(CompactStrategy.AUTO).toBe('AUTO');
    expect(CompactStrategy.SESSION).toBe('SESSION');
    expect(CompactStrategy.REACTIVE).toBe('REACTIVE');
  });

  it('should have microCompact method', () => {
    expect(typeof service.microCompact).toBe('function');
  });

  it('should have autoCompact method', () => {
    expect(typeof service.autoCompact).toBe('function');
  });

  it('should have checkAndCompact method', () => {
    expect(typeof service.checkAndCompact).toBe('function');
  });

  it('should have estimateTokens method', () => {
    expect(typeof service.estimateTokens).toBe('function');
  });

  describe('microCompact', () => {
    it('should return empty array for empty input', () => {
      const result = service.microCompact([]);
      expect(result).toEqual([]);
    });

    it('should preserve non-tool messages unchanged', () => {
      const now = Date.now();
      const messages = [
        { role: 'system', content: 'System prompt', timestamp: now - 10 * 60 * 1000 },
        { role: 'user', content: 'User message', timestamp: now - 8 * 60 * 1000 },
        { role: 'assistant', content: 'Assistant response', timestamp: now - 6 * 60 * 1000 }
      ];

      const result = service.microCompact(messages);
      expect(result).toEqual(messages);
    });

    it('should clear old tool results (older than 5 minutes)', () => {
      const now = Date.now();
      const oldTimestamp = now - 6 * 60 * 1000; // 6 minutes ago

      const messages = [
        { role: 'tool', content: 'Old tool result data', timestamp: oldTimestamp, tool_call_id: 'call-1' }
      ];

      const result = service.microCompact(messages);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
      expect(result[0].role).toBe('tool');
      expect(result[0].timestamp).toBe(oldTimestamp);
      expect(result[0].tool_call_id).toBe('call-1');
    });

    it('should preserve recent tool results (within 5 minutes)', () => {
      const now = Date.now();
      const recentTimestamp = now - 3 * 60 * 1000; // 3 minutes ago

      const messages = [
        { role: 'tool', content: 'Recent tool result data', timestamp: recentTimestamp, tool_call_id: 'call-2' }
      ];

      const result = service.microCompact(messages);
      expect(result).toEqual(messages);
    });

    it('should handle tool results without timestamp (preserve unchanged)', () => {
      const messages = [
        { role: 'tool', content: 'Tool result without timestamp', tool_call_id: 'call-3' }
      ];

      const result = service.microCompact(messages);
      expect(result).toEqual(messages);
    });

    it('should handle mixed messages correctly', () => {
      const now = Date.now();
      const messages = [
        { role: 'system', content: 'System', timestamp: now - 10 * 60 * 1000 },
        { role: 'user', content: 'User', timestamp: now - 9 * 60 * 1000 },
        { role: 'tool', content: 'Old tool result', timestamp: now - 6 * 60 * 1000, tool_call_id: 'call-1' },
        { role: 'assistant', content: 'Assistant', timestamp: now - 5 * 60 * 1000 },
        { role: 'tool', content: 'Recent tool result', timestamp: now - 2 * 60 * 1000, tool_call_id: 'call-2' },
        { role: 'user', content: 'Follow-up', timestamp: now - 1 * 60 * 1000 }
      ];

      const result = service.microCompact(messages);

      expect(result).toHaveLength(6);
      expect(result[0].content).toBe('System');
      expect(result[1].content).toBe('User');
      expect(result[2].content).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
      expect(result[3].content).toBe('Assistant');
      expect(result[4].content).toBe('Recent tool result');
      expect(result[5].content).toBe('Follow-up');
    });

    it('should handle boundary case: exactly 5 minutes old', () => {
      const now = Date.now();
      const boundaryTimestamp = now - MICRO_COMPACT_THRESHOLD_MS;

      const messages = [
        { role: 'tool', content: 'Boundary tool result', timestamp: boundaryTimestamp, tool_call_id: 'call-1' }
      ];

      const result = service.microCompact(messages);
      expect(result[0].content).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
    });

    it('should handle boundary case: just under 5 minutes', () => {
      const now = Date.now();
      const justUnderTimestamp = now - MICRO_COMPACT_THRESHOLD_MS + 1000; // 1 second under threshold

      const messages = [
        { role: 'tool', content: 'Almost old tool result', timestamp: justUnderTimestamp, tool_call_id: 'call-1' }
      ];

      const result = service.microCompact(messages);
      expect(result[0].content).toBe('Almost old tool result');
    });

    it('should not mutate original messages array', () => {
      const now = Date.now();
      const messages = [
        { role: 'tool', content: 'Original content', timestamp: now - 6 * 60 * 1000, tool_call_id: 'call-1' }
      ];

      const result = service.microCompact(messages);

      expect(messages[0].content).toBe('Original content');
      expect(result[0].content).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
    });

    it('should preserve all message properties when clearing', () => {
      const now = Date.now();
      const messages = [
        {
          role: 'tool',
          content: 'Original content',
          timestamp: now - 6 * 60 * 1000,
          tool_call_id: 'call-123',
          customProperty: 'custom-value',
          anotherProperty: 42
        }
      ];

      const result = service.microCompact(messages);

      expect(result[0]).toMatchObject({
        role: 'tool',
        content: CLEARED_TOOL_RESULT_PLACEHOLDER,
        timestamp: now - 6 * 60 * 1000,
        tool_call_id: 'call-123',
        customProperty: 'custom-value',
        anotherProperty: 42
      });
    });

    it('should handle all tool results being old', () => {
      const now = Date.now();
      const messages = [
        { role: 'tool', content: 'Old result 1', timestamp: now - 10 * 60 * 1000, tool_call_id: 'call-1' },
        { role: 'tool', content: 'Old result 2', timestamp: now - 8 * 60 * 1000, tool_call_id: 'call-2' },
        { role: 'tool', content: 'Old result 3', timestamp: now - 6 * 60 * 1000, tool_call_id: 'call-3' }
      ];

      const result = service.microCompact(messages);

      expect(result.every(msg => msg.content === CLEARED_TOOL_RESULT_PLACEHOLDER)).toBe(true);
    });

    it('should handle all tool results being recent', () => {
      const now = Date.now();
      const messages = [
        { role: 'tool', content: 'Recent result 1', timestamp: now - 1 * 60 * 1000, tool_call_id: 'call-1' },
        { role: 'tool', content: 'Recent result 2', timestamp: now - 2 * 60 * 1000, tool_call_id: 'call-2' },
        { role: 'tool', content: 'Recent result 3', timestamp: now - 3 * 60 * 1000, tool_call_id: 'call-3' }
      ];

      const result = service.microCompact(messages);

      expect(result.every(msg => msg.content.startsWith('Recent result'))).toBe(true);
    });

    it('should be zero-cost: no LLM API calls', () => {
      const mockLLMClient = {
        generate: vi.fn(),
        generateStructured: vi.fn(),
        generateWithTools: vi.fn()
      };

      const serviceWithMock = new AutoCompactService();
      const messages = [
        { role: 'tool', content: 'Tool result', timestamp: Date.now() - 10 * 60 * 1000 }
      ];

      serviceWithMock.microCompact(messages);

      expect(mockLLMClient.generate).not.toHaveBeenCalled();
      expect(mockLLMClient.generateStructured).not.toHaveBeenCalled();
      expect(mockLLMClient.generateWithTools).not.toHaveBeenCalled();
    });
  });

  describe('estimateTokens', () => {
    it('should estimate tokens using character/4 formula', () => {
      const messages = [
        { role: 'user' as const, content: 'Hello world' },
        { role: 'assistant' as const, content: 'Hi there' }
      ];

      const tokens = service.estimateTokens(messages);

      expect(tokens).toBe(Math.ceil(11 / 4) + Math.ceil(8 / 4));
    });

    it('should handle empty messages', () => {
      const tokens = service.estimateTokens([]);
      expect(tokens).toBe(0);
    });

    it('should handle large messages', () => {
      const largeContent = 'x'.repeat(10000);
      const messages = [
        { role: 'user' as const, content: largeContent }
      ];

      const tokens = service.estimateTokens(messages);

      expect(tokens).toBe(Math.ceil(10000 / 4));
    });
  });

  describe('checkAndCompact', () => {
    it('should not compact when below threshold', async () => {
      const messages = [
        { role: 'user' as const, content: 'Hello' }
      ];

      const result = await service.checkAndCompact(messages);

      expect(result).toBe(messages);
    });

    it('should trigger compaction when above threshold', async () => {
      const mockLLMClient = {
        generateText: vi.fn().mockResolvedValueOnce('Summary of conversation')
      };
      const serviceWithLLM = new AutoCompactService(mockLLMClient as any);

      const largeContent = 'x'.repeat(AUTO_COMPACT_THRESHOLD * 4 + 1000);
      const messages = [
        { role: 'user' as const, content: largeContent },
        { role: 'assistant' as const, content: 'Response' }
      ];

      const result = await serviceWithLLM.checkAndCompact(messages);

      expect(mockLLMClient.generateText).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('system');
      expect(result[0].content).toContain('Previous conversation summary');
    });
  });

  describe('autoCompact', () => {
    it('should call LLM API for summarization', async () => {
      const mockLLMClient = {
        generateText: vi.fn().mockResolvedValueOnce('Summary text')
      };
      const serviceWithLLM = new AutoCompactService(mockLLMClient as any);

      const messages = [
        { role: 'user' as const, content: 'Question' },
        { role: 'assistant' as const, content: 'Answer' }
      ];

      const result = await serviceWithLLM.autoCompact(messages);

      expect(mockLLMClient.generateText).toHaveBeenCalledWith(
        expect.stringContaining('Question'),
        expect.any(String)
      );
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('system');
    });

    it('should reset failure count on success', async () => {
      const mockLLMClient = {
        generateText: vi.fn().mockResolvedValueOnce('Summary')
      };
      const serviceWithLLM = new AutoCompactService(mockLLMClient as any);

      const messages = [{ role: 'user' as const, content: 'Test' }];
      await serviceWithLLM.autoCompact(messages);

      expect((serviceWithLLM as any).consecutiveFailures).toBe(0);
    });

    it('should increment failure count on error', async () => {
      const mockLLMClient = {
        generateText: vi.fn().mockRejectedValueOnce(new Error('API error'))
      };
      const serviceWithLLM = new AutoCompactService(mockLLMClient as any);

      const messages = [{ role: 'user' as const, content: 'Test' }];
      const result = await serviceWithLLM.autoCompact(messages);

      expect((serviceWithLLM as any).consecutiveFailures).toBe(1);
      expect(result).toBe(messages);
    });

    it('should stop after MAX_FAILURES consecutive failures', async () => {
      const mockLLMClient = {
        generateText: vi.fn().mockRejectedValue(new Error('API error'))
      };
      const serviceWithLLM = new AutoCompactService(mockLLMClient as any);

      const messages = [{ role: 'user' as const, content: 'Test' }];

      for (let i = 0; i < MAX_FAILURES + 2; i++) {
        await serviceWithLLM.autoCompact(messages);
      }

      expect(mockLLMClient.generateText).toHaveBeenCalledTimes(MAX_FAILURES);
      expect((serviceWithLLM as any).consecutiveFailures).toBe(MAX_FAILURES);
    });

    it('should return original messages when circuit breaker is open', async () => {
      const mockLLMClient = {
        generateText: vi.fn().mockRejectedValue(new Error('API error'))
      };
      const serviceWithLLM = new AutoCompactService(mockLLMClient as any);

      const messages = [{ role: 'user' as const, content: 'Test' }];

      for (let i = 0; i < MAX_FAILURES; i++) {
        await serviceWithLLM.autoCompact(messages);
      }

      mockLLMClient.generateText.mockClear();
      const result = await serviceWithLLM.autoCompact(messages);

      expect(mockLLMClient.generateText).not.toHaveBeenCalled();
      expect(result).toBe(messages);
    });

    it('should handle missing LLM client', async () => {
      const serviceNoLLM = new AutoCompactService();
      const messages = [{ role: 'user' as const, content: 'Test' }];

      const result = await serviceNoLLM.autoCompact(messages);

      expect(result).toBe(messages);
    });

    it('should preserve last message after compaction', async () => {
      const mockLLMClient = {
        generateText: vi.fn().mockResolvedValueOnce('Summary')
      };
      const serviceWithLLM = new AutoCompactService(mockLLMClient as any);

      const messages = [
        { role: 'user' as const, content: 'First' },
        { role: 'assistant' as const, content: 'Response 1' },
        { role: 'user' as const, content: 'Second' },
        { role: 'assistant' as const, content: 'Response 2' }
      ];

      const result = await serviceWithLLM.autoCompact(messages);

      expect(result[result.length - 1]).toEqual(messages[messages.length - 1]);
    });
  });
});

describe('Constants', () => {
  it('MICRO_COMPACT_THRESHOLD_MS should be 5 minutes in milliseconds', () => {
    expect(MICRO_COMPACT_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });

  it('CLEARED_TOOL_RESULT_PLACEHOLDER should be defined', () => {
    expect(CLEARED_TOOL_RESULT_PLACEHOLDER).toBe('[Old tool result content cleared]');
  });

  it('AUTO_COMPACT_THRESHOLD should be 167000 tokens', () => {
    expect(AUTO_COMPACT_THRESHOLD).toBe(167000);
  });

  it('MAX_FAILURES should be 3', () => {
    expect(MAX_FAILURES).toBe(3);
  });
});
