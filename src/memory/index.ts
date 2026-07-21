/**
 * Memory Module - 4-Layer Architecture
 *
 * L1: 内存 Map(会话元数据)
 * L2: JSON 单文件(用户档案)
 * L3: JSON + embedding(会话摘要)
 * L4: JSON 单会话(完整历史)
 */

// 4 层服务
export { L1SessionMetadataService, l1SessionMetadata, sessionContextService } from './l1-session-metadata';
export type { SessionContextData, SessionMessage } from './l1-session-metadata';

export { L2ProfileService } from './l2-profile-service';
export { L3SummaryStore } from './l3-summary-store';
export { L3SummaryGenerator } from './l3-summary-generator';
export type { GenerateRequestSummaryArgs, GenerateSessionSummaryArgs } from './l3-summary-generator';
export { L4HistoryStore, LocalNoopArchiveAdapter } from './l4-history-store';

// facade
export { MemoryService } from './memory-service';
export type { UserMemory, EpisodicEntry } from './memory-service';

// 基础设施(保留)
export { EmbeddingService } from './embedding-service';
export type { EmbeddingConfig } from './embedding-service';

// 类型
export type {
  L1SessionMetadata,
  L1Message,
  L2UserProfile,
  L2BehaviorUpdate,
  L3RequestSummary,
  L3SessionSummary,
  L3SummaryData,
  L4HistoryEntry,
  L4HistoryFile,
  L4ArchiveAdapter,
  RecallResult,
  SaveMessageOptions,
  SummarizeRequestArgs,
} from './types';
export {
  DEFAULT_RECALL_CONFIG,
  L3_REQUEST_SUMMARY_MAX_CHARS,
  L3_SESSION_SUMMARY_MAX_CHARS,
  L3_SUMMARY_TTL_MS,
  L1_SESSION_IDLE_MS,
  L1_CLEANUP_INTERVAL_MS,
} from './types';

// 迁移
export { migrateMemoryIfNeeded } from './migrate';
