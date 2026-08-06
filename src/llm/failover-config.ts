import { z } from 'zod';

/**
 * 单个 fallback candidate 的 schema:
 *  - providerKey: <provider>:<modelId>, provider 仅允许小写字母/数字/下划线/横线,modelId 允许字母/数字/下划线/点/斜线/横线
 *  - priority: 整数, >= 1
 *  - model: 非空字符串
 */
export const CandidateSchema = z.object({
  providerKey: z.string().regex(/^[a-z0-9_-]+:[a-zA-Z0-9_./-]+$/),
  priority: z.number().int().min(1),
  model: z.string().min(1),
});

/**
 * 整体 fallback 链 schema:
 *  - candidates: 至少 1 个 candidate
 *  - refine: 所有 candidate 的 priority 必须唯一
 */
export const LLMFallbackConfigSchema = z.object({
  candidates: z.array(CandidateSchema).min(1),
}).refine(
  cfg => new Set(cfg.candidates.map(c => c.priority)).size === cfg.candidates.length,
  { message: 'priority must be unique' },
);

export type LLMFallbackConfig = z.infer<typeof LLMFallbackConfigSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;

/**
 * 解析 JSON 字符串为 LLMFallbackConfig。
 * JSON 解析失败 → throw SyntaxError
 * schema 校验失败 → throw ZodError
 */
export function parseFallbackConfig(json: string): LLMFallbackConfig {
  return LLMFallbackConfigSchema.parse(JSON.parse(json));
}