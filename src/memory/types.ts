/**
 * Memory 4-Layer Architecture Types
 *
 * L1: 会话元数据 - 内存 Map, 30min TTL, 不持久化
 * L2: 用户档案   - JSON 单文件, 永久, 精确检索
 * L3: 历史摘要   - JSON + embedding, 30d TTL, 语义检索
 * L4: 会话历史   - JSON 单会话, 永久(预留归档), 完整还原
 *
 * L1~L4 类型 + RecallConfig
 */

import type { UserProfile } from '../types';

// ── L1: 会话元数据(内存) ──────────────────────────────────────────

export interface L1Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  skillName?: string;
  requestId?: string;
}

export interface L1SessionMetadata {
  sessionId: string;
  userId: string;
  currentSkill?: string;
  currentSystem?: string;
  currentTopic?: string;
  turnCount: number;
  sessionStartAt: number;
  lastInteractionAt: number;
  /** L4 历史的内存缓存副本,进程重启后从 L4 恢复 */
  conversation: L1Message[];
  /** 临时变量(技能之间共享) */
  tempVariables: Map<string, unknown>;
  /** 当前请求的摘要草稿,在 closeSession 时聚合到 L3 */
  pendingRequestSummary?: string;
}

// ── L2: 用户档案(JSON 单文件,支持扩展) ───────────────────────────

/**
 * L2 用户档案 - 继承 UserProfile 向后兼容,新增 extensions 开放 schema
 *
 * 核心字段固定(向后兼容),扩展字段通过 extensions 注入,
 * 例如:用户偏好风格、沟通方式、技术栈、常用 IDE 等。
 */
export interface L2UserProfile extends UserProfile {
  /** 开放扩展(未来偏好/风格等),深度 merge 不覆盖 */
  extensions?: Record<string, unknown>;
}

export interface L2BehaviorUpdate {
  mentionedSystems?: string[];
  department?: string;
}

// ── L3: 历史摘要(JSON + embedding) ────────────────────────────────

export interface L3RequestSummary {
  requestId: string;
  sessionId: string;
  summary: string;          // ≤500 字符
  skillName?: string;
  system?: string;
  createdAt: string;
}

export interface L3SessionSummary {
  id: string;
  userId: string;
  sessionId: string;
  content: string;          // ≤2000 字符(聚合后)
  embedding: number[] | null;
  createdAt: string;
  updatedAt: string;
  /** createdAt + 30d,超过后语义检索时跳过 */
  expiresAt: string;
  requestSummaries: L3RequestSummary[];
  metadata: {
    skillNames: string[];
    systems: string[];
    [k: string]: unknown;
  };
}

export interface L3SummaryData {
  sessionSummaries: L3SessionSummary[];
  requestSummaries: L3RequestSummary[];
  updatedAt: string;
}

// ── L4: 会话历史(JSON 单会话) ─────────────────────────────────────

export interface L4HistoryEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;        // ISO 8601
  sessionId: string;
  userId: string;
  requestId?: string;
  skillName?: string;
  /** 归档状态:active(本地可读) / archived(已迁移到外部存储) */
  archiveStatus?: 'active' | 'archived';
  /** 归档外部引用(预留,后续接 DB/S3 时填入) */
  archiveRef?: string;
}

export interface L4HistoryFile {
  userId: string;
  sessionId: string;
  entries: L4HistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

/** L4 归档适配器接口,本地默认实现为 noop */
export interface L4ArchiveAdapter {
  archive(entries: L4HistoryEntry[]): Promise<{ archivedIds: string[]; archiveRefs: string[] }>;
  retrieve(refs: string[]): Promise<L4HistoryEntry[]>;
}

// ── Recall Configuration ──────────────────────────────────────────

/** 记忆召回的默认配置 */
export const DEFAULT_RECALL_CONFIG = {
  /** 主智能体通用召回数量 */
  MAIN_AGENT_RECALL_TOP_K: 5,
  /** 主智能体共享记忆召回数量 */
  MAIN_AGENT_SHARED_TOP_K: 3,
  /** 主智能体程序记忆召回数量 */
  MAIN_AGENT_PROCEDURAL_TOP_K: 5,
  /** 子智能体语义记忆召回数量 */
  SUB_AGENT_SEMANTIC_TOP_K: 5,
} as const;

// ── L3 Summary Length Constraints ────────────────────────────────

export const L3_REQUEST_SUMMARY_MAX_CHARS = 500;
export const L3_SESSION_SUMMARY_MAX_CHARS = 2000;

/** L3 摘要 30 天 TTL */
export const L3_SUMMARY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** L1 会话 30 分钟空闲超时 */
export const L1_SESSION_IDLE_MS = 30 * 60 * 1000;

/** L1 清理扫描间隔(10 分钟) */
export const L1_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// ── Recall Result ─────────────────────────────────────────────────

export interface RecallResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

// ── Memory Service Facade Types ───────────────────────────────────

export interface SaveMessageOptions {
  skillName?: string;
  requestId?: string;
}

export interface SummarizeRequestArgs {
  userId: string;
  sessionId: string;
  requestId: string;
  userMessage: string;
  assistantMessage: string;
  skillName?: string;
  system?: string;
}
