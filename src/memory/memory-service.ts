import { UserProfileService } from '../user-profile';
import { DEFAULT_TTL, MemoryConfig, MemoryEntry, MemoryLayer, RecallOptions, RetrievalResult, SearchOptions } from './types';
import { EpisodicStore } from './episodic-store';
import { UserProfile } from '../types';
import { AutoCompactService, Message } from './auto-compact';
import { LLMClient } from '../llm';
import { UserMemoryStore } from './user-memory-store';
import { SemanticRetrievalEngine } from './semantic-retrieval';
import { EmbeddingService } from './embedding-service';
import { MemoryDedupService } from './memory-dedup';
import { ImportanceInferencer, InferenceResult } from './importance-inferencer';
import { evictCompletedWorkingMemory as evictCompleted } from './working-memory-lifecycle';
import { SharedMemoryPool } from './shared-memory-pool';

export interface UserMemory {
  profile: UserProfile;
  episodicEntries: MemoryEntry[];
}

export class MemoryService {
  private userProfileService: UserProfileService;
  private autoCompactService: AutoCompactService;
  private store: UserMemoryStore;
  private semanticRetrieval: SemanticRetrievalEngine;
  private embeddingService: EmbeddingService;
  private dedupService: MemoryDedupService;
  private importanceInferencer: ImportanceInferencer;
  private sharedPool: SharedMemoryPool;
  private episodicStore: EpisodicStore;

  constructor(
    dataDir: string = 'data',
    config: Partial<MemoryConfig> = {},
    llmClient?: LLMClient
  ) {
    this.userProfileService = new UserProfileService(dataDir);
    this.autoCompactService = new AutoCompactService(llmClient);
    this.embeddingService = new EmbeddingService(llmClient);
    this.store = new UserMemoryStore(config.storagePath || 'data/memory');
    this.semanticRetrieval = new SemanticRetrievalEngine(this.embeddingService, undefined, 24, undefined, llmClient);
    this.dedupService = new MemoryDedupService();
    this.importanceInferencer = new ImportanceInferencer(llmClient);
    this.sharedPool = new SharedMemoryPool(this.store);
    this.episodicStore = new EpisodicStore(this.store);
  }

  async loadUserMemory(userId: string): Promise<UserMemory> {
    await this.evictExpired(userId);
    const [profile, episodicEntries] = await Promise.all([
      this.userProfileService.loadProfile(userId),
      this.episodicStore.loadEpisodicEntries(userId),
    ]);
    return { profile, episodicEntries };
  }

  /** @deprecated Use loadUserMemory instead */
  async loadMemory(userId: string): Promise<UserMemory> {
    return this.loadUserMemory(userId);
  }

  buildContextPrompt(memory: UserMemory): string {
    return this.episodicStore.buildContextPrompt(memory.episodicEntries);
  }

  async clearMemory(userId: string): Promise<void> {
    for (const layer of [MemoryLayer.EPISODIC, MemoryLayer.SEMANTIC, MemoryLayer.WORKING, MemoryLayer.PROCEDURAL]) {
      const entries = await this.store.getEntries(userId, layer);
      for (const entry of entries) {
        await this.store.removeEntry(userId, layer, entry.id);
      }
    }
  }

  async saveUserMessage(userId: string, content: string, options?: { system?: string; skill?: string }): Promise<void> {
    await this.episodicStore.saveUserMessage(userId, content, options);
  }

  async saveAssistantMessage(userId: string, content: string, options?: { system?: string; skill?: string }): Promise<void> {
    await this.episodicStore.saveAssistantMessage(userId, content, options);
  }

  // ── Core Memory Operations ────────────────────────────────────────

  async remember(entry: MemoryEntry): Promise<void> {
    if (entry.importance === 0.5) {
      const inferred = await this.importanceInferencer.infer(entry);
      entry.importance = inferred.importance;
    }
    const existing = await this.store.getEntries(entry.namespace, entry.layer);
    if (this.dedupService.shouldDedup(entry, existing)) {
      return;
    }
    await this.store.appendEntry(entry.namespace, entry.layer, entry);
  }

  async recall(userId: string, query: string, options?: RecallOptions): Promise<RetrievalResult[]> {
    const layers = options?.layers || [MemoryLayer.EPISODIC, MemoryLayer.SEMANTIC, MemoryLayer.PROCEDURAL];
    const namespace = options?.namespace || userId;
    let entries: MemoryEntry[] = [];
    for (const layer of layers) {
      const layerEntries = await this.store.getEntries(namespace, layer);
      entries.push(...layerEntries);
    }
    if (entries.length === 0) return [];
    const results = await this.semanticRetrieval.adaptiveRetrieve(query, entries, {
      topK: options?.topK,
      minScore: options?.minScore,
      layers,
    });

    for (const result of results) {
      try {
        await this.store.updateEntry(
          result.entry.namespace,
          result.entry.layer,
          result.entry.id,
          (e) => {
            e.hitCount = result.entry.hitCount;
            e.lastHitAt = result.entry.lastHitAt;
          },
        );
      } catch (e) { console.error('[MemoryService] Failed to update hit count:', e); }
    }

    return results;
  }

  async evictExpired(userId: string): Promise<number> {
    let total = 0;
    const layers = [MemoryLayer.EPISODIC, MemoryLayer.WORKING];
    for (const layer of layers) {
      const entries = await this.store.getEntries(userId, layer);
      for (const entry of entries) {
        if (entry.ttl != null && entry.ttl !== Infinity && Date.now() - new Date(entry.updatedAt).getTime() > entry.ttl) {
          await this.store.removeEntry(userId, layer, entry.id);
          total++;
        }
      }
    }
    return total;
  }

  async dedupCheck(entry: MemoryEntry): Promise<boolean> {
    const existing = await this.store.getEntries(entry.namespace, entry.layer);
    return this.dedupService.shouldDedup(entry, existing);
  }

  async inferImportance(entry: MemoryEntry): Promise<InferenceResult> {
    return this.importanceInferencer.infer(entry);
  }

  // ── Layer-Specific Write Methods ──────────────────────────────────

  async saveWorkingMemory(userId: string, taskId: string, content: string, taskStatus: string = 'pending', requestId?: string): Promise<void> {
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: `working-${taskId}-${Date.now()}`,
      layer: MemoryLayer.WORKING,
      content,
      metadata: { taskId, taskStatus, ...(requestId && { requestId }) },
      importance: 0.3,
      createdAt: now,
      updatedAt: now,
      namespace: userId,
      ttl: DEFAULT_TTL[MemoryLayer.WORKING],
    };
    await this.store.appendEntry(userId, MemoryLayer.WORKING, entry);
  }

  async updateWorkingMemoryStatus(userId: string, taskId: string, taskStatus: string): Promise<void> {
    const entries = await this.store.getEntries(userId, MemoryLayer.WORKING);
    for (const entry of entries) {
      if (entry.metadata?.taskId === taskId) {
        await this.store.updateEntry(userId, MemoryLayer.WORKING, entry.id, (e) => {
          e.metadata.taskStatus = taskStatus;
          e.updatedAt = new Date().toISOString();
        });
      }
    }
  }

  async saveSemanticMemory(userId: string, content: string, category: 'preference' | 'fact' | 'knowledge' | 'rule' = 'fact', source: 'inferred' | 'explicit' = 'inferred', confidence: number = 0.7): Promise<void> {
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: `semantic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      layer: MemoryLayer.SEMANTIC,
      content,
      metadata: { category, source, confidence },
      importance: confidence,
      createdAt: now,
      updatedAt: now,
      namespace: userId,
      ttl: DEFAULT_TTL[MemoryLayer.SEMANTIC],
    };
    await this.store.appendEntry(userId, MemoryLayer.SEMANTIC, entry);
  }

  async saveProceduralMemory(userId: string, skillName: string, content: string, params?: Record<string, unknown>, result?: string, success: boolean = true): Promise<void> {
    const existing = await this.store.getEntries(userId, MemoryLayer.PROCEDURAL);
    const existingEntry = existing.find(e => e.metadata?.skillName === skillName);

    if (existingEntry) {
      await this.store.updateEntry(userId, MemoryLayer.PROCEDURAL, existingEntry.id, (e) => {
        e.metadata.usageCount = ((e.metadata.usageCount as number) || 0) + 1;
        e.metadata.lastResult = result;
        e.metadata.lastSuccess = success;
        e.updatedAt = new Date().toISOString();
      });
    } else {
      const now = new Date().toISOString();
      const entry: MemoryEntry = {
        id: `procedural-${skillName}-${Date.now()}`,
        layer: MemoryLayer.PROCEDURAL,
        content,
        metadata: { skillName, usageCount: 1, lastResult: result, lastSuccess: success, ...(params && { params }) },
        importance: success ? 0.7 : 0.5,
        createdAt: now,
        updatedAt: now,
        namespace: userId,
        ttl: DEFAULT_TTL[MemoryLayer.PROCEDURAL],
      };
      await this.store.appendEntry(userId, MemoryLayer.PROCEDURAL, entry);
    }
  }

  async evictCompletedWorkingMemory(userId: string, completedTaskIds?: string[]): Promise<number> {
    const entries = await this.store.getEntries(userId, MemoryLayer.WORKING);
    const remaining = evictCompleted(entries, completedTaskIds);
    const evicted = entries.filter(e => !remaining.some(r => r.id === e.id));
    for (const entry of evicted) {
      await this.store.removeEntry(userId, MemoryLayer.WORKING, entry.id);
    }
    return evicted.length;
  }

  async getActiveTasks(userId: string): Promise<MemoryEntry[]> {
    const entries = await this.store.getEntries(userId, MemoryLayer.WORKING);
    return entries.filter(e => {
      const status = e.metadata?.taskStatus as string;
      return status === 'pending' || status === 'running' || status === 'waiting';
    });
  }

  // ── Utility Methods ───────────────────────────────────────────────

  async compactSession(
    messages: Message[],
    context?: {
      currentSkill?: string;
      userProfile?: { department: string; commonSystems: string[] };
    }
  ): Promise<Message[]> {
    return this.autoCompactService.sessionCompact(messages, context);
  }

  getStore(): UserMemoryStore {
    return this.store;
  }

  async shareMemory(agentId: string, entry: MemoryEntry): Promise<void> {
    await this.sharedPool.publish(agentId, entry);
  }

  async retrieveShared(agentId: string, query: string, options?: SearchOptions): Promise<RetrievalResult[]> {
    return this.sharedPool.retrieve(agentId, query, options);
  }
}

export default MemoryService;
