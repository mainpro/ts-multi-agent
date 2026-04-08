import { z } from 'zod';

// ============================================================================
// SubRequirement Types
// ============================================================================

/**
 * 子需求类型枚举
 * - skill_task: 技能任务，需要调用特定技能处理
 * - clarification: 澄清问题，需要用户进一步说明
 * - context_reference: 上下文引用，依赖前文内容（如"那怎么重新提交"）
 */
export type SubRequirementType = 'skill_task' | 'clarification' | 'context_reference';

/**
 * 子需求在原文中的位置
 */
export interface SubRequirementPosition {
  /** 起始位置（字符索引） */
  start: number;
  /** 结束位置（字符索引） */
  end: number;
}

/**
 * 子需求定义
 * 表示从复合需求中拆解出的独立子需求
 */
export interface SubRequirement {
  /** 子需求唯一标识 */
  id: string;
  /** 原始内容 */
  content: string;
  /** 标准化后的内容（去除连接词、标点等） */
  normalizedContent: string;
  /** 在原文中的位置 */
  position: SubRequirementPosition;
  /** 子需求类型 */
  type: SubRequirementType;
  /** 置信度 (0.0-1.0) */
  confidence: number;
}

// ============================================================================
// SkillMatchResult Types
// ============================================================================

/**
 * 技能匹配类型
 * - direct: 直接匹配，用户明确提到技能相关关键词
 * - inferred: 推断匹配，根据语义推断可能需要的技能
 * - none: 无匹配
 */
export type SkillMatchType = 'direct' | 'inferred' | 'none';

/**
 * 技能匹配结果
 * 表示子需求与技能的匹配关系
 */
export interface SkillMatchResult {
  /** 关联的子需求ID */
  subReqId: string;
  /** 匹配的技能名称（可选） */
  skill?: string;
  /** 匹配置信度 (0.0-1.0) */
  confidence: number;
  /** 匹配类型 */
  matchType: SkillMatchType;
  /** 匹配推理过程（可选） */
  reasoning?: string;
}

// ============================================================================
// DecompositionResult Types
// ============================================================================

/**
 * 整体意图类型
 * - skill_task: 技能任务，需要调用技能处理
 * - small_talk: 闲聊，如问候、感谢等
 * - unclear: 不明确，需要进一步澄清
 */
export type OverallIntent = 'skill_task' | 'small_talk' | 'unclear';

/**
 * 拆解结果元数据
 */
export interface DecompositionMetadata {
  /** 处理耗时（毫秒） */
  processingTime: number;
  /** 拆解置信度 (0.0-1.0) */
  decompositionConfidence: number;
}

/**
 * 需求拆解结果
 * 表示对用户需求的完整拆解分析结果
 */
export interface DecompositionResult {
  /** 是否为复合需求（包含多个子需求） */
  isComposite: boolean;
  /** 拆解出的子需求列表 */
  subRequirements: SubRequirement[];
  /** 整体意图 */
  overallIntent: OverallIntent;
  /** 元数据 */
  metadata: DecompositionMetadata;
}

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

/**
 * Zod schema for SubRequirementPosition
 */
export const SubRequirementPositionSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

/**
 * Zod schema for SubRequirementType
 */
export const SubRequirementTypeSchema = z.enum(['skill_task', 'clarification', 'context_reference']);

/**
 * Zod schema for SubRequirement
 */
export const SubRequirementSchema = z.object({
  id: z.string(),
  content: z.string(),
  normalizedContent: z.string(),
  position: SubRequirementPositionSchema,
  type: SubRequirementTypeSchema,
  confidence: z.number().min(0).max(1),
});

/**
 * Zod schema for SkillMatchType
 */
export const SkillMatchTypeSchema = z.enum(['direct', 'inferred', 'none']);

/**
 * Zod schema for SkillMatchResult
 */
export const SkillMatchResultSchema = z.object({
  subReqId: z.string(),
  skill: z.string().optional(),
  confidence: z.number().min(0).max(1),
  matchType: SkillMatchTypeSchema,
  reasoning: z.string().optional(),
});

/**
 * Zod schema for OverallIntent
 */
export const OverallIntentSchema = z.enum(['skill_task', 'small_talk', 'unclear']);

/**
 * Zod schema for DecompositionMetadata
 */
export const DecompositionMetadataSchema = z.object({
  processingTime: z.number().nonnegative(),
  decompositionConfidence: z.number().min(0).max(1),
});

/**
 * Zod schema for DecompositionResult
 */
export const DecompositionResultSchema = z.object({
  isComposite: z.boolean(),
  subRequirements: z.array(SubRequirementSchema),
  overallIntent: OverallIntentSchema,
  metadata: DecompositionMetadataSchema,
});

// ============================================================================
// Type inference from schemas
// ============================================================================

/** Inferred SubRequirementPosition type from schema */
export type SubRequirementPositionInferred = z.infer<typeof SubRequirementPositionSchema>;
/** Inferred SubRequirement type from schema */
export type SubRequirementInferred = z.infer<typeof SubRequirementSchema>;
/** Inferred SkillMatchResult type from schema */
export type SkillMatchResultInferred = z.infer<typeof SkillMatchResultSchema>;
/** Inferred DecompositionMetadata type from schema */
export type DecompositionMetadataInferred = z.infer<typeof DecompositionMetadataSchema>;
/** Inferred DecompositionResult type from schema */
export type DecompositionResultInferred = z.infer<typeof DecompositionResultSchema>;
