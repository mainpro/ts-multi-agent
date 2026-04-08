import { z } from 'zod';

// ============================================================================
// Tool System Types (re-exported for convenience)
// ============================================================================

export type { Tool, ToolContext, ToolResult } from '../tools/interfaces';

// ============================================================================
// Skill System Types
// ============================================================================

/**
 * Skill metadata from SKILL.md frontmatter
 * Used for skill discovery and matching
 */
export interface SkillMetadata {
  /** Unique name of the skill */
  name: string;
  /** Human-readable description */
  description: string;
  /** License identifier (e.g., MIT, Apache-2.0) */
  license?: string;
  /** Compatibility information */
  compatibility?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** List of allowed tools for this skill */
  allowedTools?: string[];
  /** Whether this skill is hidden from skill list (built-in) */
  hidden?: boolean;
}

/**
 * Complete Skill definition including body and file paths
 */
export interface Skill extends SkillMetadata {
  /** Body content from SKILL.md (everything after frontmatter) */
  body: string;
  /** Path to scripts directory */
  scriptsDir?: string;
  /** Path to references directory */
  referencesDir?: string;
  /** Path to assets directory */
  assetsDir?: string;
}

/**
 * User profile for personalization and tracking
 */
export interface UserProfile {
  /** Unique user identifier */
  userId: string;
  /** User's department (optional) */
  department?: string;
  /** List of commonly used systems */
  commonSystems: string[];
  /** User tags for categorization */
  tags: string[];
  /** Number of conversations with this user */
  conversationCount: number;
  /** Last active timestamp (ISO 8601) */
  lastActiveAt: string;
  /** Profile creation timestamp (ISO 8601) */
  createdAt: string;
  /** Profile update timestamp (ISO 8601) */
  updatedAt: string;
}

/**
 * Task status values
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Error types for task failures
 */
export type ErrorType = 'RETRYABLE' | 'FATAL' | 'USER_ERROR' | 'SKILL_ERROR';

/**
 * Task error information
 */
export interface TaskError {
  /** Error classification */
  type: ErrorType;
  /** Human-readable error message */
  message: string;
  /** Error code (optional) */
  code?: string;
  /** Stack trace (optional, for debugging) */
  stack?: string;
}

/**
 * Task definition
 */
export interface Task {
  id: string;
  requirement: string;
  skillName: string;
  dependencies: string[];
  dependents?: string[];
  status?: TaskStatus;
  result?: TaskResult;
  error?: TaskError;
  startedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  retryCount?: number;
  params?: Record<string, unknown>;
  imageAttachment?: {
    data: Buffer;
    mimeType: string;
    originalName?: string;
  };
}

/**
 * LLM message for chat completions
 */
export interface Message {
  /** Message role */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Message content */
  content: string;
  /** Tool call ID (for tool responses) */
  tool_call_id?: string;
  /** Tool calls (for assistant messages with function calling) */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

/**
 * Tool definition for function calling
 */
export interface ToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Tool parameters schema */
  parameters: Record<string, unknown>;
}

/**
 * Tool call result
 */
export interface ToolCall {
  /** Tool call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Tool arguments */
  arguments: Record<string, unknown>;
}

/**
 * Tool call execution result
 */
export interface ToolCallResult {
  /** Tool name */
  name: string;
  /** Tool arguments */
  arguments: Record<string, unknown>;
  /** Tool execution result */
  result: string;
}

/**
 * Task execution result
 */
export interface SkillExecutionResult {
  response: string;
  needRefs?: string[];
}

export interface TaskResult {
  success: boolean;
  data?: SkillExecutionResult | unknown;
  error?: TaskError;
}

/**
 * Requirement analysis result
 */
export interface RequirementAnalysis {
  /** Summary of the requirement */
  summary: string;
  /** Key entities mentioned */
  entities?: string[];
  /** Intent classification */
  intent?: string;
  /** Suggested skills */
  suggestedSkills?: string[];
}

/**
 * 需求分析结果（新）
 */
export interface RequirementAnalysisResult {
  /** 是否闲聊 */
  isSmallTalk: boolean;
  /** 匹配的技能名称列表 */
  matchedSkills: string[];
  /** 分析过程（可选） */
  reasoning?: string;
  /** 闲聊时的建议回复 */
  suggestedResponse?: string;
  /** 保底时的推荐列表 */
  guessRecommendations?: Array<{ system: string; reason: string; }>;
}

/**
 * Task plan generated by MainAgent
 */
export interface TaskPlan {
  /** Plan ID */
  id: string;
  /** Original requirement */
  requirement: string;
  /** Whether the requirement needs clarification */
  needsClarification?: boolean;
  /** Prompt for clarifying the requirement */
  clarificationPrompt?: string | null;
  /** List of tasks in the plan */
  tasks: Array<{
    id: string;
    requirement: string;
    skillName: string;
    params?: Record<string, unknown>;
    dependencies: string[];
  }>;
}

/**
 * System configuration constants
 */
export const CONFIG = {
  /** Maximum concurrent subagents */
  MAX_CONCURRENT_SUBAGENTS: 5,
  /** Maximum task queue size */
  MAX_QUEUE_SIZE: 100,
  /** Maximum replan attempts for failed tasks */
  MAX_REPLAN_ATTEMPTS: 3,
  /** Individual task timeout - must cover LLM retries (90s × 3 + backoff ≈ 300s) */
  TASK_TIMEOUT_MS: parseInt(process.env.TASK_TIMEOUT_MS || '400000', 10),
  /** Total workflow timeout - for multiple sequential tasks */
  TOTAL_TIMEOUT_MS: parseInt(process.env.TOTAL_TIMEOUT_MS || '600000', 10),
  /** LLM API timeout - 工具调用需要更长超时 (120s) */
  LLM_TIMEOUT_MS: parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10),
  /** Script execution timeout - should be less than TASK_TIMEOUT_MS */
  SCRIPT_TIMEOUT_MS: parseInt(process.env.SCRIPT_TIMEOUT_MS || '180000', 10),
  /** Skill directory path */
  SKILL_DIRECTORY: './skills/',
  /** LLM Provider: nvidia | openrouter */
  LLM_PROVIDER: process.env.LLM_PROVIDER || 'openrouter',
  /** LLM model name */
  LLM_MODEL: process.env.LLM_MODEL || 'minimax/minimax-m2.5:free',
  /** LLM API base URL */
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
  /** LLM temperature */
  LLM_TEMPERATURE: 0.7,
  LLM_MAX_TOKENS: 4096,
  /** Task cleanup interval (5 minutes) */
  TASK_CLEANUP_INTERVAL_MS: 300000,
  /** Task retention time (1 hour) */
  TASK_RETENTION_TIME_MS: 3600000,
  /** Zhipu Vision API Key */
  ZHIPU_API_KEY: process.env.ZHIPU_API_KEY || '',
  /** Vision model name */
  VISION_MODEL: process.env.VISION_MODEL || 'glm-4v-flash',
  /** Vision API timeout in milliseconds */
  VISION_TIMEOUT_MS: parseInt(process.env.VISION_TIMEOUT_MS || '60000', 10),
  /** Vision API max retries */
  VISION_MAX_RETRIES: parseInt(process.env.VISION_MAX_RETRIES || '3', 10),
  // Feature Flags for Requirement Decomposition
  ENABLE_REQUIREMENT_DECOMPOSITION: process.env.ENABLE_REQUIREMENT_DECOMPOSITION === 'true',
  ENABLE_SKILL_MATCHER_EXTRACTION: process.env.ENABLE_SKILL_MATCHER_EXTRACTION === 'true',
  DECOMPOSITION_MIN_CONFIDENCE: parseFloat(process.env.DECOMPOSITION_MIN_CONFIDENCE || '0.7'),
} as const;

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

/**
 * Zod schema for SkillMetadata
 */
export const SkillMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  allowedTools: z.array(z.string()).optional(),
});

/**
 * Zod schema for Skill
 */
export const SkillSchema = SkillMetadataSchema.extend({
  body: z.string(),
  scriptsDir: z.string().optional(),
  referencesDir: z.string().optional(),
  assetsDir: z.string().optional(),
});

/**
 * Zod schema for UserProfile
 */
export const UserProfileSchema = z.object({
  userId: z.string(),
  department: z.string().optional(),
  commonSystems: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  conversationCount: z.number().default(0),
  lastActiveAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Zod schema for ErrorType
 */
export const ErrorTypeSchema = z.enum(['RETRYABLE', 'FATAL', 'USER_ERROR', 'SKILL_ERROR']);

/**
 * Zod schema for TaskError
 */
export const TaskErrorSchema = z.object({
  type: ErrorTypeSchema,
  message: z.string(),
  code: z.string().optional(),
  stack: z.string().optional(),
});

/**
 * Zod schema for TaskStatus
 */
export const TaskStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);

/**
 * Zod schema for Task
 */
export const TaskSchema = z.object({
  id: z.string(),
  requirement: z.string(),
  status: TaskStatusSchema,
  subagentId: z.string().optional(),
  skillName: z.string().optional(),
  params: z.record(z.unknown()).optional(),
  result: z.unknown().optional(),
  error: TaskErrorSchema.optional(),
  dependencies: z.array(z.string()),
  dependents: z.array(z.string()),
  createdAt: z.date(),
  startedAt: z.date().optional(),
  completedAt: z.date().optional(),
  retryCount: z.number(),
});

/**
 * Zod schema for Message
 */
export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_call_id: z.string().optional(),
});

/**
 * Zod schema for ToolDefinition
 */
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
});

/**
 * Zod schema for ToolCall
 */
export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()),
});

/**
 * Zod schema for TaskResult
 */
export const SkillExecutionResultSchema = z.object({
  response: z.string(),
  needRefs: z.array(z.string()).optional().default([]),
});

export const TaskResultSchema = z.object({
  success: z.boolean(),
  data: SkillExecutionResultSchema.or(z.unknown()).optional(),
  error: TaskErrorSchema.optional(),
});

/**
 * Zod schema for RequirementAnalysis
 */
export const RequirementAnalysisSchema = z.object({
  summary: z.string(),
  entities: z.array(z.string()).optional(),
  intent: z.string().optional(),
  suggestedSkills: z.array(z.string()).optional(),
});

/**
 * Zod Schema for RequirementAnalysisResult
 */
export const RequirementAnalysisResultSchema = z.object({
  isSmallTalk: z.boolean().describe('是否闲聊，如你好、谢谢、你是谁等'),
  matchedSkills: z.array(z.string()).describe('匹配的技能名称列表，按相关性排序'),
  reasoning: z.string().optional().describe('分析过程'),
  suggestedResponse: z.string().optional().describe('闲聊时的建议回复'),
  guessRecommendations: z.array(z.object({
    system: z.string().describe('推荐的系统名称'),
    reason: z.string().describe('推荐理由'),
  })).optional().describe('保底时的推荐列表'),
});

/**
 * Zod schema for TaskPlan
 */
export const TaskPlanSchema = z.object({
  id: z.string(),
  requirement: z.string(),
  needsClarification: z.boolean().optional(),
  clarificationPrompt: z.string().optional().nullable(),
  tasks: z.array(z.object({
    id: z.string(),
    requirement: z.string(),
    skillName: z.string(),
    params: z.record(z.unknown()).optional(),
    dependencies: z.array(z.string()),
  })),
});

// ============================================================================
// Type inference from schemas (for runtime validation)
// ============================================================================

/** Inferred SkillMetadata type from schema */
export type SkillMetadataInferred = z.infer<typeof SkillMetadataSchema>;
/** Inferred UserProfile type from schema */
export type UserProfileInferred = z.infer<typeof UserProfileSchema>;
/** Inferred Skill type from schema */
export type SkillInferred = z.infer<typeof SkillSchema>;
/** Inferred TaskError type from schema */
export type TaskErrorInferred = z.infer<typeof TaskErrorSchema>;
/** Inferred Task type from schema */
export type TaskInferred = z.infer<typeof TaskSchema>;
/** Inferred TaskResult type from schema */
export type TaskResultInferred = z.infer<typeof TaskResultSchema>;
/** Inferred RequirementAnalysis type from schema */
export type RequirementAnalysisInferred = z.infer<typeof RequirementAnalysisSchema>;
/** Inferred TaskPlan type from schema */
export type TaskPlanInferred = z.infer<typeof TaskPlanSchema>;
