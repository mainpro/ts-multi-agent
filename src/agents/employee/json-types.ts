import { z } from 'zod';

// ── 身份层 ──
export const EmployeeIdentitySchema = z.object({
  id: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  enabled: z.boolean().optional().default(true),
});

// ── 角色层 ──
export const PersonaSchema = z.object({
  prefix: z.string(),
  style: z.string().optional(),
  boundaries: z.string().optional(),
});

// ── 能力层 ──
export const SkillWhitelistSchema = z.union([
  z.object({ type: z.literal('allowlist'), skills: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('unrestricted') }),
]);

export const ToolPolicySchema = z.object({
  enabled: z.array(z.string()).optional(),
  denied: z.array(z.string()).optional(),
}).refine(
  (p) => (p.enabled !== undefined && p.enabled.length > 0) || (p.denied !== undefined && p.denied.length > 0),
  { message: 'tools 至少需要非空 enabled 或非空 denied 之一' },
);

export const LLMProviderSchema = z.enum(['haier', 'siliconflow']);

export const LLMConfigSchema = z.object({
  provider: LLMProviderSchema,
  fallbackProvider: LLMProviderSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const ExecutionSchema = z.object({
  maxRetries: z.number().int().min(0).max(10).optional().default(2),
  retryableErrorTypes: z.array(z.string()).optional()
    .default(['TIMEOUT', 'NETWORK_ERROR', 'API_ERROR']),
  transferOnPartialFailure: z.boolean().optional().default(false),
});

export type ExecutionConfig = z.infer<typeof ExecutionSchema>;

export const CapabilitiesSchema = z.object({
  skillWhitelist: SkillWhitelistSchema.optional(),
  tools: ToolPolicySchema.optional(),
  llm: LLMConfigSchema,
  execution: ExecutionSchema.optional(),
});

// ── 规划层 ──
export const PlanningSchema = z.object({
  maxParallelTasks: z.number().int().positive().max(50).optional().default(5),
  decompositionHint: z.string().optional(),
});

// ── 输出行为层 ──
export const ResultRewriterMatchSchema = z.object({
  status: z.enum(['completed', 'waiting_user_input', 'failed']).optional(),
});

export const ResultRewriterSchema = z.object({
  match: ResultRewriterMatchSchema.optional(),
  transform: z.enum(['append', 'passthrough', 'replace']),
  value: z.string().optional(),
}).refine(
  (d) => d.transform !== 'append' || (typeof d.value === 'string' && d.value.length > 0),
  { message: 'resultRewriter.transform=append 时 value 必填且非空' },
);

export const OutputBehaviorSchema = z.object({
  resultRewriter: ResultRewriterSchema.optional(),
});

// ── 顶层 ──
export const EmployeeConfigSchema = z.object({
  employee: EmployeeIdentitySchema,
  persona: PersonaSchema.optional(),
  capabilities: CapabilitiesSchema,
  planning: PlanningSchema.optional(),
  outputBehavior: OutputBehaviorSchema.optional(),
});

export type EmployeeConfig = z.infer<typeof EmployeeConfigSchema>;
export type EmployeeIdentityConfig = z.infer<typeof EmployeeIdentitySchema>;
export type PersonaConfig = z.infer<typeof PersonaSchema>;
export type CapabilitiesConfig = z.infer<typeof CapabilitiesSchema>;
export type PlanningConfig = z.infer<typeof PlanningSchema>;
export type OutputBehaviorConfig = z.infer<typeof OutputBehaviorSchema>;
export type SkillWhitelist = z.infer<typeof SkillWhitelistSchema>;
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type LLMProvider = z.infer<typeof LLMProviderSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type ResultRewriter = z.infer<typeof ResultRewriterSchema>;

/**
 * 校验一个 JSON 字符串,返回校验后的 config。
 * 失败抛 ZodError(原样透传,调用方决定如何处理)。
 */
export function parseEmployeeConfig(json: string): EmployeeConfig {
  return EmployeeConfigSchema.parse(JSON.parse(json));
}