/**
 * Memory Types
 * Type definitions for layered memory architecture
 */

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

// ── Recall Configuration ──────────────────────────────────────────

/**
 * 记忆召回的默认配置
 */
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

// ── Memory Layer Architecture ────────────────────────────────────

/** Memory layer classification */
export enum MemoryLayer {
  WORKING = 'working',
  EPISODIC = 'episodic',
  SEMANTIC = 'semantic',
  PROCEDURAL = 'procedural',
}

/** Working memory entry - current request context */
export interface WorkingMemoryEntry {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  requestId?: string;
  taskId: string;
  taskStatus?: 'pending' | 'running' | 'completed' | 'failed' | 'suspended' | 'waiting';
  metadata?: Record<string, unknown>;
}

/** Episodic memory entry - conversation history */
export interface EpisodicMemoryEntry {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: string;
  system?: string;
  skill?: string;
  references?: string[];
  importance: number;
  intent?: string;
  topic?: string;
  taskId?: string;
  embedding?: number[] | null;
}

/** Semantic memory entry - user knowledge/preferences */
export interface SemanticMemoryEntry {
  id: string;
  content: string;
  category: 'preference' | 'fact' | 'knowledge' | 'rule';
  source: 'inferred' | 'explicit';
  confidence: number;
  timestamp: string;
  updatedAt: string;
  embedding?: number[] | null;
  metadata?: Record<string, unknown>;
}

/** Procedural memory entry - skill execution experience */
export interface ProceduralMemoryEntry {
  id: string;
  skillName: string;
  content: string;
  params?: Record<string, unknown>;
  result?: string;
  success: boolean;
  timestamp: string;
  usageCount: number;
  embedding?: number[] | null;
}

// ── Unified Memory Entry ─────────────────────────────────────────

/** Unified memory entry - generic container for all layers */
export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: number[] | null;
  importance: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  namespace: string;
  /** Time-to-live in milliseconds. Entry is considered expired if Date.now() - updatedAt > ttl */
  ttl?: number;
  /** Number of times this entry has been retrieved */
  hitCount?: number;
  /** ISO timestamp of the last retrieval */
  lastHitAt?: string;
}

/** Type-specific payload accessor */
export type LayeredMemoryEntry =
  | (MemoryEntry & { layer: MemoryLayer.WORKING; payload: WorkingMemoryEntry })
  | (MemoryEntry & { layer: MemoryLayer.EPISODIC; payload: EpisodicMemoryEntry })
  | (MemoryEntry & { layer: MemoryLayer.SEMANTIC; payload: SemanticMemoryEntry })
  | (MemoryEntry & { layer: MemoryLayer.PROCEDURAL; payload: ProceduralMemoryEntry });

// ── Memory Backend ───────────────────────────────────────────────

/** Query filter for memory search */
export interface MemoryQuery {
  layer?: MemoryLayer;
  namespace?: string;
  importanceMin?: number;
  importanceMax?: number;
  createdAfter?: string;
  createdBefore?: string;
  metadata?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}

/** Search options for semantic retrieval */
export interface SearchOptions {
  topK?: number;
  minScore?: number;
  layers?: MemoryLayer[];
  useEmbedding?: boolean;
}

/** Result from semantic retrieval */
export interface RetrievalResult {
  entry: MemoryEntry;
  score: number;
  scoreBreakdown: {
    recency: number;
    keyword: number;
    importance: number;
  };
}

/** MemoryBackend - pluggable storage interface */
export interface MemoryBackend {
  save(namespace: string, entry: MemoryEntry): Promise<void>;
  load(namespace: string, id: string): Promise<MemoryEntry | null>;
  query(namespace: string, filter: MemoryQuery): Promise<MemoryEntry[]>;
  delete(namespace: string, id: string): Promise<void>;
  search(namespace: string, query: string, options?: SearchOptions): Promise<RetrievalResult[]>;
  searchVector(namespace: string, queryEmbedding: number[], topK?: number): Promise<RetrievalResult[]>;
  listNamespaces?(prefix: string): Promise<string[]>;
}

// ── TTL Defaults ─────────────────────────────────────────────────

export const DEFAULT_TTL: Record<MemoryLayer, number> = {
  [MemoryLayer.WORKING]: 300000,         // 5 min — keep completed entries briefly for getActiveTasks
  [MemoryLayer.EPISODIC]: 2592000000, // 30 days
  [MemoryLayer.SEMANTIC]: Infinity,    // Never expire
  [MemoryLayer.PROCEDURAL]: Infinity,  // Never expire
};

// ── Context Budget ───────────────────────────────────────────────

/** Budget allocation for a memory layer */
export interface LayerBudget {
  layer: MemoryLayer;
  allocatedTokens: number;
  usedTokens: number;
  entries: number;
}

/** Context budget allocation result */
export interface BudgetAllocation {
  totalBudget: number;
  layers: LayerBudget[];
  systemPromptTokens: number;
  remaining: number;
}

/** Context budget configuration */
export interface ContextBudgetConfig {
  totalTokenBudget: number;
  layerWeights: Record<MemoryLayer, number>;
  systemPromptReserve: number;
  minImportanceThreshold: number;
}

// ── Recall Options ───────────────────────────────────────────────

/** Options for recall operation */
export interface RecallOptions {
  layers?: MemoryLayer[];
  topK?: number;
  minScore?: number;
  includeWorking?: boolean;
  namespace?: string;
}

/** Default recall options */
export const DEFAULT_RECALL_OPTIONS: RecallOptions = {
  topK: 10,
  minScore: 0.1,
  includeWorking: false,
};
