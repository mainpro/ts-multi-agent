/**
 * Memory Module - Unified exports
 */

// Types - use 'export type' for interfaces (they don't exist at runtime)
export type { ConversationMessage, MemoryConfig } from './types';

export { DEFAULT_MEMORY_CONFIG } from './types';

export { ConversationMemoryService } from './conversation-memory';
export { MemoryService } from './memory-service';
export { SessionContextService, sessionContextService } from './session-context';

export type { UserMemory } from './memory-service';
export type { SessionContextData, SessionMessage } from './session-context';
