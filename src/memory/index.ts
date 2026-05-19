/**
 * Memory Module - Unified exports
 */

// Types - use 'export type' for interfaces (they don't exist at runtime)
export type { MemoryConfig } from './types';

export { DEFAULT_MEMORY_CONFIG } from './types';

export { MemoryService } from './memory-service';
export { SessionContextService, sessionContextService } from './session-context';

export type { UserMemory } from './memory-service';
export type { SessionContextData, SessionMessage } from './session-context';

// Round 2 - Deep optimization modules
export { MemoryDedupService, DEFAULT_DEDUP_THRESHOLD, DEFAULT_CONSOLIDATION_THRESHOLD } from './memory-dedup';
export { ImportanceInferencer } from './importance-inferencer';
export type { InferenceResult } from './importance-inferencer';
export { SemanticRetrievalEngine } from './semantic-retrieval';
export type { RetrievalWeights, AdaptiveRetrievalConfig } from './semantic-retrieval';
export { EmbeddingService } from './embedding-service';
export type { EmbeddingConfig } from './embedding-service';
export { SharedMemoryPool } from './shared-memory-pool';
export { EpisodicStore } from './episodic-store';
export type { EpisodicStoreOptions } from './episodic-store';
export { ContextBudgetManager } from './context-budget';

// Round 2 - Extended types
export type { MemoryEntry, MemoryLayer as MemoryLayerType, MemoryBackend, RetrievalResult, SearchOptions, MemoryQuery } from './types';
export { MemoryLayer, DEFAULT_TTL } from './types';
export { SemanticExtractor } from './semantic-extractor';
export type { ExtractedKnowledge } from './semantic-extractor';
