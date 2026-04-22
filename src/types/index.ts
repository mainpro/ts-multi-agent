import { z } from 'zod';

// ============================================================================
// Tool System Types (re-exported for convenience)
// ============================================================================

export type { Tool, ToolContext, ToolResult } from '../tools/interfaces';

// ============================================================================
// Skill System Types
// ============================================================================

// Skill metadata from SKILL.md frontmatter
export interface SkillMetadata {
  name: string;
  description: string;
  type?: SkillType;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
  hidden?: boolean;
}

/**
 * Complete Skill definition including body and file paths
 */
export interface Skill extends SkillMetadata {
  /** Body content from SKILL.md (everything after frontmatter) */
  body: string;
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
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'suspended' | 'waiting'; // 挂起状态 + 等待用户输入

// ============================================================================
// 询问机制类型（v3 统一重构）
// ============================================================================

/** 请求状态 */
export type RequestStatus = 'pending' | 'processing' | 'waiting' | 'suspended' | 'completed' | 'failed';

/** 询问来源 */
export type QuestionSource = 'main_agent' | 'sub_agent';

/** 统一的询问条目（主智能体和子智能体通用） */
export interface QAEntry {
  questionId: string;
  content: string;
  source: QuestionSource;
  taskId: string | null;
  skillName: string | null;
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
}

/** 请求中的任务 */
export interface RequestTask {
  taskId: string;
  content: string;
  status: TaskStatus;
  skillName: string | null;
  createdAt: string;
  updatedAt: string;
  result: string | null;
  questions: QAEntry[];
  currentQuestion: QAEntry | null;
  // 断点续执行上下文（仅内存，不持久化）
  conversationContext?: Task['conversationContext'];
  completedToolCalls?: CompletedToolCall[];
}

/** 请求 */
export interface Request {
  requestId: string;
  content: string;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  questions: QAEntry[];
  currentQuestion: QAEntry | null;
  tasks: RequestTask[];
  result: string | null;
  /** 执行进度（用于断点续传，仅内存） */
  executionProgress?: ExecutionProgress;
}

/** 会话 */
export interface Session {
  sessionId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  requests: Request[];
  activeRequestId: string | null;
}

/** RequestManager.handleUserInput 返回结果 */
export type HandleResult =
  | { type: 'continue'; request: Request; question: QAEntry }
  | { type: 'new_request'; request: Request }
  | { type: 'recall_prompt'; request: Request; suspendedRequest: Request }
  | { type: 'no_action'; message: string };

/** 延续判断结果 */
export type ContinuationResult =
  | { isContinuation: true; confidence: number }
  | { isContinuation: false; confidence: number; reason: string };

/** 已完成的工具调用记录（用于断点续执行） */
export interface CompletedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  timestamp: Date;
}

/**
 * @internal 询问历史条目（Task.questionHistory 使用，兼容 sub-agent 断点续执行）
 * 新代码应优先使用 QAEntry
 */
export interface QuestionHistoryEntry {
  question: { type: string; content: string; taskId?: string; metadata?: Record<string, unknown> };
  answer: string;
  timestamp: Date;
}

/**
 * Error types for task failures
 */
export type ErrorType = 'RETRYABLE' | 'FATAL' | 'USER_ERROR' | 'SKILL_ERROR';

/**
 * LLM error types for retry classification
 */
export type LLMErrorType = 'RATE_LIMIT' | 'TIMEOUT' | 'INVALID_KEY' | 'API_ERROR' | 'NETWORK_ERROR' | 'CONTEXT_TOO_LONG' | 'OUTPUT_TOO_LONG';

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
export type SkillType = 'business' | 'professional';

export interface Task {
  id: string;
  requirement: string;
  skillName?: string;
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
  sessionId?: string;
  userId?: string;
  imageAttachment?: {
    data: Buffer;
    mimeType: string;
    originalName?: string;
  };
  
  // 询问历史（统一询问机制 v2）
  questionHistory?: QuestionHistoryEntry[];
  
  // 执行状态（技能自己决定格式）
  executionState?: Record<string, unknown>;

  // ===== 断点续执行字段（v2 重构新增） =====

  /** 子智能体的 LLM 对话上下文（用于断点续执行） */
  conversationContext?: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }>;

  /** 子智能体已完成的工具调用记录 */
  completedToolCalls?: CompletedToolCall[];

  /** 子智能体的执行进度描述（自然语言，由子智能体自己维护） */
  executionProgress?: string;

  weakDependencies?: string[];  // P3-4: 弱依赖列表
  
  // 错误记忆
  errorHistory?: Array<{
    error: TaskError;
    attemptedSolutions: Array<{
      solution: string;
      timestamp: Date;
      success: boolean;
    }>;
    timestamp: Date;
  }>;
  
  // 执行路径
  executionPath?: Array<{
    step: string;
    timestamp: Date;
    result: 'success' | 'failure' | 'skipped';
  }>;
}

export interface ProfessionalSkill extends Skill {
  type: 'professional';
  targetAgent: 'reflector' | 'optimizer';
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
  status?: 'completed' | 'waiting_user_input' | 'needs_intent_reclassification';
  question?: {
    type: 'skill_question';
    content: string;
    metadata?: Record<string, unknown>;
  };
}

export interface TaskResult {
  success: boolean;
  status?: 'completed' | 'waiting_user_input';
  data?: SkillExecutionResult | unknown;
  error?: TaskError;
  
  // 统一询问字段
  question?: {
    type: 'skill_question';
    content: string;
    metadata?: Record<string, unknown>;
  };
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
 * 任务图节点（Plan-Execute-Summarize 架构）
 */
export interface TaskGraphNode {
  /** 任务 ID（在 plan 内唯一） */
  taskId: string;
  /** 任务描述 */
  content: string;
  /** 使用的技能 */
  skillName: string;
  /** 依赖的 taskId 列表（空数组=可立即执行） */
  dependencies: string[];
  /** 任务参数（可能引用上游任务输出，如 "$task-1.result"） */
  params?: Record<string, unknown>;
}

/**
 * 任务执行图
 */
export interface TaskGraph {
  /** 图 ID */
  id: string;
  /** 原始需求 */
  requirement: string;
  /** 所有节点 */
  nodes: TaskGraphNode[];
  /** 拓扑排序后的执行层级（layers[0]=可立即执行, layers[1]=依赖layers[0]的任务...） */
  layers: string[][];
}

/**
 * 汇总判断结果
 */
export interface SummaryJudgment {
  /** 是否满足用户需求 */
  completed: boolean;
  /** 汇总文本 */
  summary: string;
}

/**
 * 执行进度（用于断点续传）
 */
export interface ExecutionProgress {
  /** 当前执行到的层级索引 */
  currentLayerIndex: number;
  /** 已完成的任务结果 { taskId: result } */
  completedResults: Record<string, any>;
  /** 任务图快照 */
  taskGraph: TaskGraph;
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
  type: z.enum(['business', 'professional']).optional(),
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
export const TaskStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'suspended', 'waiting']);

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
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  questionHistory: z.array(z.object({
    question: z.object({
      type: z.string(),
      content: z.string(),
      metadata: z.record(z.unknown()).optional(),
      taskId: z.string().optional(),
      skillName: z.string().optional(),
    }),
    answer: z.string(),
    timestamp: z.date(),
  })).optional(),
  executionState: z.record(z.unknown()).optional(),
  conversationContext: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({
      id: z.string(),
      type: z.enum(['function']),
      function: z.object({ name: z.string(), arguments: z.string() }),
    })).optional(),
  })).optional(),
  completedToolCalls: z.array(z.object({
    name: z.string(),
    arguments: z.record(z.unknown()),
    result: z.string(),
    timestamp: z.date(),
  })).optional(),
  executionProgress: z.string().optional(),
  weakDependencies: z.array(z.string()).optional(),
  errorHistory: z.array(z.object({
    error: TaskErrorSchema,
    attemptedSolutions: z.array(z.object({
      solution: z.string(),
      timestamp: z.date(),
      success: z.boolean(),
    })),
    timestamp: z.date(),
  })).optional(),
  executionPath: z.array(z.object({
    step: z.string(),
    timestamp: z.date(),
    result: z.enum(['success', 'failure', 'skipped']),
  })).optional(),
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
