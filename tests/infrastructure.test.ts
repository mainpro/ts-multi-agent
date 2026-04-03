import { describe, it, expect } from 'bun:test';
import { createTestMessage } from './helpers/message-factory';
import { MockLLMClient } from './mocks/llm-mock';

describe('Test Helpers', () => {
  it('should create test message with defaults', () => {
    const msg = createTestMessage();
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('test message');
  });

  it('should create test message with overrides', () => {
    const msg = createTestMessage({ role: 'assistant', content: 'custom' });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('custom');
  });
});

describe('Test Mocks', () => {
  it('should create mock LLM client', () => {
    const client = new MockLLMClient();
    expect(client).toBeDefined();
  });

  it('should return mock response', async () => {
    const client = new MockLLMClient();
    const response = await client.generateText('test prompt');
    expect(response).toBe('mock response');
  });
});
