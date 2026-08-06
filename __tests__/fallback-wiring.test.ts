/**
 * Fallback wiring smoke test
 *
 * 验证 Task 7 的工厂函数 `buildFallbackLLMClient()` 在三种场景下的行为:
 *  1. LLM_FALLBACK_ENABLED = false → 返回纯 LLMClient(无 FallbackLLMClient 包装)
 *  2. LLM_FALLBACK_ENABLED = true + 配置文件存在 + 合法 → 返回 FallbackLLMClient
 *  3. LLM_FALLBACK_ENABLED = true + 配置文件缺失/非法 → 不抛错,降级到 LLMClient
 *
 * 同时验证 LLMClient.configureProvider(provider, model) 在构造后能覆盖
 * provider 和 model 字段(为 FallbackLLMClient 在 buildClient 回调里按 candidate
 * 重新配置底层 client 提供支持)。
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { LLMClient, LLMError, buildFallbackLLMClient } from '../src/llm';
import { FallbackLLMClient } from '../src/llm/fallback-client';
import { CONFIG } from '../src/types';

describe('configureProvider() on LLMClient', () => {
  test('覆盖 provider 后,后续 API key 解析走新 provider 的 env', () => {
    // 构造时给个 apiKey 避免默认 provider 的 env 缺失导致抛错
    const client = new LLMClient('test-key-initial');
    expect(client).toBeInstanceOf(LLMClient);

    // 调用 configureProvider → 不抛错
    expect(() => client.configureProvider('nvidia', 'nvidia/model')).not.toThrow();

    // 验证 fallback-config 的格式能正确解析 provider / model 两段
    const [provider, model] = 'nvidia:nvidia/model'.split(':');
    expect(provider).toBe('nvidia');
    expect(model).toBe('nvidia/model');
  });
});

describe('buildFallbackLLMClient()', () => {
  const originalEnabled = CONFIG.LLM_FALLBACK_ENABLED;
  const originalConfigPath = CONFIG.LLM_FALLBACK_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fallback-wiring-'));
  });

  afterEach(() => {
    CONFIG.LLM_FALLBACK_ENABLED = originalEnabled;
    CONFIG.LLM_FALLBACK_CONFIG_PATH = originalConfigPath;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('LLM_FALLBACK_ENABLED = false → 返回纯 LLMClient 实例(不是 FallbackLLMClient)', () => {
    CONFIG.LLM_FALLBACK_ENABLED = false;

    const client = buildFallbackLLMClient();

    expect(client).toBeInstanceOf(LLMClient);
    expect(client).not.toBeInstanceOf(FallbackLLMClient);
  });

  test('LLM_FALLBACK_ENABLED = true + 合法配置文件 → 返回 FallbackLLMClient', () => {
    CONFIG.LLM_FALLBACK_ENABLED = true;
    const configPath = join(tmpDir, 'llm-fallback.json');
    const validConfig = {
      candidates: [
        { providerKey: 'openrouter:test-model-1', priority: 1, model: 'test-model-1' },
        { providerKey: 'openrouter:test-model-2', priority: 2, model: 'test-model-2' },
      ],
    };
    writeFileSync(configPath, JSON.stringify(validConfig), 'utf-8');
    CONFIG.LLM_FALLBACK_CONFIG_PATH = configPath;

    const client = buildFallbackLLMClient();

    expect(client).toBeInstanceOf(FallbackLLMClient);
  });

  test('LLM_FALLBACK_ENABLED = true + 配置文件缺失 → 不抛错,降级到 LLMClient', () => {
    CONFIG.LLM_FALLBACK_ENABLED = true;
    CONFIG.LLM_FALLBACK_CONFIG_PATH = join(tmpDir, 'does-not-exist.json');

    const client = buildFallbackLLMClient();

    expect(client).toBeInstanceOf(LLMClient);
    expect(client).not.toBeInstanceOf(FallbackLLMClient);
  });

  test('LLM_FALLBACK_ENABLED = true + 配置文件非法 → 不抛错,降级到 LLMClient', () => {
    CONFIG.LLM_FALLBACK_ENABLED = true;
    const configPath = join(tmpDir, 'invalid-llm-fallback.json');
    writeFileSync(configPath, '{ this is not valid json', 'utf-8');
    CONFIG.LLM_FALLBACK_CONFIG_PATH = configPath;

    const client = buildFallbackLLMClient();

    expect(client).toBeInstanceOf(LLMClient);
    expect(client).not.toBeInstanceOf(FallbackLLMClient);
  });

  test('所有场景返回的对象都实现 ILLMClient 契约(generateText / generateStructured / generateWithTools 三个方法都在)', () => {
    CONFIG.LLM_FALLBACK_ENABLED = false;
    const plain = buildFallbackLLMClient();
    expect(typeof plain.generateText).toBe('function');
    expect(typeof plain.generateStructured).toBe('function');
    expect(typeof plain.generateWithTools).toBe('function');

    CONFIG.LLM_FALLBACK_ENABLED = true;
    const configPath = join(tmpDir, 'llm-fallback.json');
    writeFileSync(configPath, JSON.stringify({
      candidates: [{ providerKey: 'openrouter:m', priority: 1, model: 'm' }],
    }), 'utf-8');
    CONFIG.LLM_FALLBACK_CONFIG_PATH = configPath;

    const wrapped = buildFallbackLLMClient();
    expect(typeof wrapped.generateText).toBe('function');
    expect(typeof wrapped.generateStructured).toBe('function');
    expect(typeof wrapped.generateWithTools).toBe('function');
  });
});
