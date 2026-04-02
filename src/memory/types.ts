/**
 * Memory Types
 * Type definitions for conversation memory management
 */

/**
 * Conversation message stored in memory
 */
export interface ConversationMessage {
  /** Message role */
  role: 'user' | 'assistant';
  /** Message content */
  content: string;
  /** Timestamp in ISO 8601 format */
  timestamp: string;
  /** 关联的系统名称 (如 EES, GEAM) */
  system?: string;
  /** 使用的技能名称 (如 ees-qa, geam-qa) */
  skill?: string;
  /** 读取的参考资料列表 */
  references?: string[];
}

/**
 * Memory configuration options
 */
export interface MemoryConfig {
  /** Maximum number of conversation rounds to retain (default: 10) */
  maxRounds: number;
  /** Path for memory storage (default: 'data/memory') */
  storagePath: string;
}

/**
 * Default memory configuration
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxRounds: 10,
  storagePath: 'data/memory',
};
