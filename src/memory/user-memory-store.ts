import { promises as fs } from 'fs';
import * as path from 'path';
import { MemoryEntry, MemoryLayer, MemoryQuery } from './types';

export interface UserMemoryData {
  userId: string;
  working: MemoryEntry[];
  episodic: MemoryEntry[];
  semantic: MemoryEntry[];
  procedural: MemoryEntry[];
  shared: MemoryEntry[];
  updatedAt: string;
}

type LayerKey = 'working' | 'episodic' | 'semantic' | 'procedural' | 'shared';

const MAX_CACHE_SIZE = 50;

const LAYER_KEYS: Record<MemoryLayer, LayerKey> = {
  [MemoryLayer.WORKING]: 'working',
  [MemoryLayer.EPISODIC]: 'episodic',
  [MemoryLayer.SEMANTIC]: 'semantic',
  [MemoryLayer.PROCEDURAL]: 'procedural',
};

export class UserMemoryStore {
  private cache: Map<string, UserMemoryData> = new Map();
  private writeLocks: Map<string, Promise<void>> = new Map();
  private writeVersions: Map<string, number> = new Map();
  private accessOrder: string[] = [];

  constructor(
    private basePath: string = 'data/memory',
    private options: { maxEntriesPerLayer?: number } = {},
  ) {}

  getBasePath(): string {
    return this.basePath;
  }

  private emptyData(userId: string): UserMemoryData {
    return {
      userId,
      working: [],
      episodic: [],
      semantic: [],
      procedural: [],
      shared: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private sanitizeUserId(userId: string): string {
    return userId.replace(/[/\\]/g, '_').replace(/\.\./g, '__');
  }

  private filePath(userId: string): string {
    return path.join(this.basePath, `${this.sanitizeUserId(userId)}.json`);
  }

  private layerKey(layer: MemoryLayer): LayerKey {
    return LAYER_KEYS[layer];
  }

  private touchAccess(userId: string): void {
    const idx = this.accessOrder.indexOf(userId);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(userId);
  }

  private evictCache(): void {
    while (this.cache.size > MAX_CACHE_SIZE) {
      const oldestKey = this.accessOrder.shift();
      if (oldestKey) this.cache.delete(oldestKey);
    }
  }

  async load(userId: string): Promise<UserMemoryData> {
    const cached = this.cache.get(userId);
    if (cached) {
      this.touchAccess(userId);
      return cached;
    }

    const fp = this.filePath(userId);
    try {
      const raw = await fs.readFile(fp, 'utf-8');
      const data: UserMemoryData = JSON.parse(raw);
      this.cache.set(userId, data);
      this.touchAccess(userId);
      this.evictCache();
      return data;
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        const data = this.emptyData(userId);
        this.cache.set(userId, data);
        this.touchAccess(userId);
        this.evictCache();
        return data;
      }
      if (error instanceof SyntaxError) {
        console.error(`[UserMemoryStore] Corrupted JSON file for user ${userId}, resetting:`, error.message);
        const data = this.emptyData(userId);
        this.cache.set(userId, data);
        this.touchAccess(userId);
        this.evictCache();
        return data;
      }
      throw error;
    }
  }

  async save(userId: string, data: UserMemoryData): Promise<void> {
    data.updatedAt = new Date().toISOString();
    this.cache.set(userId, data);
    this.touchAccess(userId);
    this.evictCache();

    await this.enqueue(userId, async () => {
      await this.writeToDisk(userId, data);
    });
  }

  private async writeToDisk(userId: string, data: UserMemoryData): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
    const fp = this.filePath(userId);
    await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf-8');
  }

  async appendEntry(userId: string, layer: MemoryLayer, entry: MemoryEntry): Promise<void> {
    const op = async (): Promise<void> => {
      const data = await this.load(userId);
      const key = this.layerKey(layer);
      data[key].push(entry);
      const maxEntries = this.options.maxEntriesPerLayer ?? Infinity;
      if (data[key].length > maxEntries) {
        data[key] = data[key].slice(data[key].length - maxEntries);
      }
      data.updatedAt = new Date().toISOString();
      this.cache.set(userId, data);
      this.touchAccess(userId);
      this.evictCache();
      await this.writeToDisk(userId, data);
    };
    await this.enqueue(userId, op);
  }

  async removeEntry(userId: string, layer: MemoryLayer, entryId: string): Promise<void> {
    const op = async (): Promise<void> => {
      const data = await this.load(userId);
      const key = this.layerKey(layer);
      data[key] = data[key].filter((e) => e.id !== entryId);
      data.updatedAt = new Date().toISOString();
      this.cache.set(userId, data);
      this.touchAccess(userId);
      this.evictCache();
      await this.writeToDisk(userId, data);
    };
    await this.enqueue(userId, op);
  }

  async updateEntry(userId: string, layer: MemoryLayer, entryId: string, updater: (entry: MemoryEntry) => void): Promise<void> {
    const op = async (): Promise<void> => {
      const data = await this.load(userId);
      const key = this.layerKey(layer);
      const entry = data[key].find((e) => e.id === entryId);
      if (!entry) return;
      updater(entry);
      data.updatedAt = new Date().toISOString();
      this.cache.set(userId, data);
      this.touchAccess(userId);
      this.evictCache();
      await this.writeToDisk(userId, data);
    };
    await this.enqueue(userId, op);
  }

  private async enqueue(userId: string, op: () => Promise<void>): Promise<void> {
    const version = (this.writeVersions.get(userId) || 0) + 1;
    this.writeVersions.set(userId, version);

    const prev = this.writeLocks.get(userId) ?? Promise.resolve();
    const next = prev.then(() => op());
    this.writeLocks.set(userId, next.catch((err) => { console.error('[UserMemoryStore] Write lock error in enqueue():', err); }));
    await next;
    if (this.writeVersions.get(userId) === version) {
      this.writeLocks.delete(userId);
      this.writeVersions.delete(userId);
    }
  }

  async getEntries(userId: string, layer?: MemoryLayer, filter?: MemoryQuery): Promise<MemoryEntry[]> {
    const data = await this.load(userId);
    let entries: MemoryEntry[];

    if (layer) {
      entries = data[this.layerKey(layer)];
    } else {
      entries = [...data.working, ...data.episodic, ...data.semantic, ...data.procedural];
    }

    if (!filter) return entries;

    if (filter.layer) {
      entries = entries.filter((e) => e.layer === filter.layer);
    }
    if (filter.namespace) {
      entries = entries.filter((e) => e.namespace === filter.namespace);
    }
    if (filter.importanceMin !== undefined) {
      entries = entries.filter((e) => e.importance >= filter.importanceMin!);
    }
    if (filter.importanceMax !== undefined) {
      entries = entries.filter((e) => e.importance <= filter.importanceMax!);
    }
    if (filter.createdAfter) {
      entries = entries.filter((e) => e.createdAt > filter.createdAfter!);
    }
    if (filter.createdBefore) {
      entries = entries.filter((e) => e.createdAt < filter.createdBefore!);
    }
    if (filter.metadata) {
      entries = entries.filter((e) => {
        for (const [k, v] of Object.entries(filter.metadata!)) {
          if (e.metadata[k] !== v) return false;
        }
        return true;
      });
    }

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? entries.length;
    return entries.slice(offset, offset + limit);
  }

  async getLayers(userId: string): Promise<Record<MemoryLayer, MemoryEntry[]>> {
    const data = await this.load(userId);
    return {
      [MemoryLayer.WORKING]: data.working,
      [MemoryLayer.EPISODIC]: data.episodic,
      [MemoryLayer.SEMANTIC]: data.semantic,
      [MemoryLayer.PROCEDURAL]: data.procedural,
    };
  }
}
