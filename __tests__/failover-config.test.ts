/**
 * failover-config(zod schema)测试
 *
 * parseFallbackConfig 必须严格校验:
 *  - 合法 JSON 解析成功,字段映射正确
 *  - 缺 candidates 字段 → throw
 *  - candidates 为空数组 → throw
 *  - candidate 缺 providerKey → throw
 *  - candidate 缺 priority 或 priority 非数字 → throw
 *  - priority 重复 → throw
 *  - providerKey 必须符合 providerKey:modelId 格式
 */
import { describe, test, expect } from 'bun:test';
import {
  parseFallbackConfig,
  LLMFallbackConfigSchema,
  CandidateSchema,
} from '../src/llm/failover-config';

describe('parseFallbackConfig', () => {
  describe('合法配置', () => {
    test('合法 JSON 解析成功,字段映射正确', () => {
      const json = JSON.stringify({
        candidates: [
          { providerKey: 'openrouter:anthropic/claude-opus-4-7', priority: 1, model: 'anthropic/claude-opus-4-7' },
          { providerKey: 'openrouter:anthropic/claude-sonnet-4-6', priority: 2, model: 'anthropic/claude-sonnet-4-6' },
        ],
      });

      const cfg = parseFallbackConfig(json);

      expect(cfg.candidates).toHaveLength(2);
      expect(cfg.candidates[0]).toEqual({
        providerKey: 'openrouter:anthropic/claude-opus-4-7',
        priority: 1,
        model: 'anthropic/claude-opus-4-7',
      });
      expect(cfg.candidates[1]).toEqual({
        providerKey: 'openrouter:anthropic/claude-sonnet-4-6',
        priority: 2,
        model: 'anthropic/claude-sonnet-4-6',
      });
    });

    test('单 candidate 也合法', () => {
      const json = JSON.stringify({
        candidates: [
          { providerKey: 'zhipu:glm-4-plus', priority: 1, model: 'glm-4-plus' },
        ],
      });

      const cfg = parseFallbackConfig(json);
      expect(cfg.candidates).toHaveLength(1);
    });

    test('providerKey 允许下划线、点、横线', () => {
      // providerKey: ^[a-z0-9_-]+:[a-zA-Z0-9_./-]+$
      const json = JSON.stringify({
        candidates: [
          { providerKey: 'openrouter:anthropic/claude-sonnet-4.6', priority: 1, model: 'm' },
          { providerKey: 'silicon_flow:model_v2', priority: 2, model: 'm' },
        ],
      });

      const cfg = parseFallbackConfig(json);
      expect(cfg.candidates).toHaveLength(2);
    });
  });

  describe('拒绝非法配置', () => {
    test('缺 candidates 字段 → throw', () => {
      const json = JSON.stringify({});
      expect(() => parseFallbackConfig(json)).toThrow();
    });

    test('candidates 为空数组 → throw', () => {
      const json = JSON.stringify({ candidates: [] });
      expect(() => parseFallbackConfig(json)).toThrow();
    });

    test('candidate 缺 providerKey → throw', () => {
      const json = JSON.stringify({
        candidates: [{ priority: 1, model: 'm' }],
      });
      expect(() => parseFallbackConfig(json)).toThrow();
    });

    test('candidate 缺 priority 或 priority 非数字 → throw', () => {
      const jsonMissingPriority = JSON.stringify({
        candidates: [{ providerKey: 'p:m', model: 'm' }],
      });
      expect(() => parseFallbackConfig(jsonMissingPriority)).toThrow();

      const jsonStringPriority = JSON.stringify({
        candidates: [{ providerKey: 'p:m', priority: '1', model: 'm' }],
      });
      expect(() => parseFallbackConfig(jsonStringPriority)).toThrow();
    });

    test('priority 重复 → throw', () => {
      const json = JSON.stringify({
        candidates: [
          { providerKey: 'p:a', priority: 1, model: 'a' },
          { providerKey: 'p:b', priority: 1, model: 'b' },
        ],
      });
      expect(() => parseFallbackConfig(json)).toThrow();
    });

    test('providerKey 格式不合法(无冒号)→ throw', () => {
      const json = JSON.stringify({
        candidates: [{ providerKey: 'invalid-no-colon', priority: 1, model: 'm' }],
      });
      expect(() => parseFallbackConfig(json)).toThrow();
    });

    test('priority < 1 → throw', () => {
      const json = JSON.stringify({
        candidates: [{ providerKey: 'p:m', priority: 0, model: 'm' }],
      });
      expect(() => parseFallbackConfig(json)).toThrow();
    });

    test('model 为空字符串 → throw', () => {
      const json = JSON.stringify({
        candidates: [{ providerKey: 'p:m', priority: 1, model: '' }],
      });
      expect(() => parseFallbackConfig(json)).toThrow();
    });

    test('JSON 不是合法 JSON → throw', () => {
      expect(() => parseFallbackConfig('not-json')).toThrow();
    });
  });

  describe('schema 导出', () => {
    test('LLMFallbackConfigSchema 和 CandidateSchema 可独立使用', () => {
      // 验证 schema 是 zod object(不 throw 即为可用)
      const candidateResult = CandidateSchema.safeParse({
        providerKey: 'p:m',
        priority: 1,
        model: 'm',
      });
      expect(candidateResult.success).toBe(true);

      const configResult = LLMFallbackConfigSchema.safeParse({
        candidates: [{ providerKey: 'p:m', priority: 1, model: 'm' }],
      });
      expect(configResult.success).toBe(true);
    });
  });
});