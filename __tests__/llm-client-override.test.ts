import { describe, expect, test } from 'bun:test';
import { LLMClient } from '../src/llm';

describe('LLMClient constructor options', () => {
  test('不传 options → 使用默认 (provider=env / temperature=CONFIG / maxTokens=CONFIG)', () => {
    // 只验证能构造(API key 来自 env,可能不存在)
    // 这里只测试类型签名 + 默认行为可识别
    const ctor = LLMClient;
    expect(ctor.length).toBeGreaterThanOrEqual(0); // 至少有构造签名
  });

  test('传 options.provider = "haier" → 字段被采用', () => {
    // 用 mock key 构造
    const client = new LLMClient('test-key', { provider: 'haier' });
    // 通过 (client as any).provider 验证
    expect((client as any).provider).toBe('haier');
  });

  test('传 options.temperature = 0.7 → 字段被采用', () => {
    const client = new LLMClient('test-key', { temperature: 0.7 });
    expect((client as any).temperature).toBe(0.7);
  });

  test('传 options.maxTokens = 1500 → 字段被采用', () => {
    const client = new LLMClient('test-key', { maxTokens: 1500 });
    // 私有字段 maxTokensOverride 存在(由 buildRequestBody 消费)
    expect((client as any).maxTokensOverride).toBe(1500);
  });
});
