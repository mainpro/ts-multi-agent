// src/agents/virtual-employee/json-types.ts

import { z } from 'zod';

/**
 * JSON 驱动的虚拟员工配置 Schema
 *
 * 一个 JSON 文件 = 一个虚拟员工的完整业务属性:
 *   - 路由关键词 (intentKeywords)
 *   - persona prompt 模板
 *   - skill 白名单(allowlist / null 不限制)
 *   - resultRewriter 策略(append / passthrough / replace)
 *
 * 设计原则:
 *  - 字段严格校验,启动时 fail-fast(坏 config 不进生产)
 *  - 模板变量只支持 `${displayName}` 简单插值,不做完整模板引擎
 *  - resultRewriter 只支持 3 种 transform(append/passthrough/replace),
 *    复杂逻辑保留 TS 类扩展点
 *  - 字段命名跟运行时 EmployeeConfig 一致,便于对照
 */

/** 路由关键词:非空字符串数组,每项 1-50 字符,大小写不敏感 */
export const IntentKeywordsSchema = z.array(
  z.string().min(1).max(50),
).min(1);

/** Persona prefix: 模板字符串,支持 ${displayName} 简单变量 */
export const PersonaSchema = z.object({
  prefix: z.string(),
});

/** Skill 白名单:type=allowlist 时 skills 必填,type=null 任意(等价于不限制) */
export const SkillWhitelistSchema = z.union([
  z.object({
    type: z.literal('allowlist'),
    skills: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('unrestricted'),
  }),
]);

/** ResultRewriter.match: 决定是否改写,默认只改 completed(避免给 waiting 提问加尾注) */
export const ResultRewriterMatchSchema = z.object({
  status: z.enum(['completed', 'waiting_user_input', 'failed']).optional(),
});

/** ResultRewriter 主体:目前支持 3 种 transform */
export const ResultRewriterSchema = z.object({
  match: ResultRewriterMatchSchema.optional(),
  transform: z.enum(['append', 'passthrough', 'replace']),
  value: z.string().optional(),
}).refine(
  (data) => data.transform !== 'append' || (typeof data.value === 'string' && data.value.length > 0),
  { message: 'resultRewriter.transform=append 时 value 必填且非空' },
);

/** 顶层 JSON employee config */
export const JsonEmployeeConfigSchema = z.object({
  id: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  intentKeywords: IntentKeywordsSchema,
  enabled: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),

  persona: PersonaSchema.optional(),
  skillWhitelist: SkillWhitelistSchema.optional(),
  resultRewriter: ResultRewriterSchema.optional(),
});

/** 校验后的 JSON config 类型 */
export type JsonEmployeeConfig = z.infer<typeof JsonEmployeeConfigSchema>;

/**
 * 校验一个 JSON 字符串,返回校验后的 config。
 * 失败抛 ZodError(原样透传,调用方决定如何处理)。
 */
export function parseJsonEmployeeConfig(json: string): JsonEmployeeConfig {
  return JsonEmployeeConfigSchema.parse(JSON.parse(json));
}
