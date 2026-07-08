import { promises as fs } from 'fs';
import * as path from 'path';
import { MemoryEntry, RetrievalResult, SearchOptions } from './types';
import { UserMemoryStore } from './user-memory-store';

type SubscriptionCallback = (entry: MemoryEntry) => void;

interface SharedData {
  entries: Record<string, MemoryEntry[]>;
  updatedAt: string;
}

export class SharedMemoryPool {
  private writeLock: Promise<void> = Promise.resolve();
  private subscriptions: Map<string, SubscriptionCallback[]> = new Map();

  constructor(private store: UserMemoryStore) {}

  async publish(agentId: string, entry: MemoryEntry): Promise<void> {
    const ns = `shared/${agentId}`;
    entry.metadata = { ...entry.metadata, publishedBy: agentId, publishedAt: new Date().toISOString() };

    const prev = this.writeLock;
    const next = prev.then(async () => {
      const data = await this.loadShared();
      if (!data.entries[ns]) data.entries[ns] = [];
      data.entries[ns].push(entry);
      data.updatedAt = new Date().toISOString();
      await this.saveShared(data);
    });
    this.writeLock = next.catch((err) => { console.error('[SharedMemoryPool] Write lock error:', err); });
    await next;

    this.notifySubscribers(agentId, entry);
  }

  async retrieve(agentId: string, query: string, options?: SearchOptions): Promise<RetrievalResult[]> {
    const data = await this.loadShared();
    const allResults: RetrievalResult[] = [];
    const queryLower = query.toLowerCase();

    for (const ns of Object.keys(data.entries)) {
      if (ns === `shared/${agentId}`) continue;
      for (const entry of data.entries[ns]) {
        const keyword = entry.content.toLowerCase().includes(queryLower) ? 1.0 : 0.0;
        if (keyword === 0) continue;
        const recency = this.recencyScore(entry.updatedAt || entry.createdAt);
        const importance = entry.importance ?? 0.5;
        const score = 0.3 * recency + 0.5 * keyword + 0.2 * importance;
        allResults.push({
          entry,
          score,
          scoreBreakdown: { recency, keyword, importance, semantic: 0 },
        });
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    const topK = options?.topK ?? allResults.length;
    return allResults.slice(0, topK);
  }

  subscribe(agentId: string, callback: SubscriptionCallback): void {
    if (!this.subscriptions.has(agentId)) {
      this.subscriptions.set(agentId, []);
    }
    this.subscriptions.get(agentId)!.push(callback);
  }

  unsubscribe(agentId: string, callback: SubscriptionCallback): void {
    const subs = this.subscriptions.get(agentId);
    if (subs) {
      const idx = subs.indexOf(callback);
      if (idx > -1) subs.splice(idx, 1);
    }
  }

  async getAgentEntries(agentId: string): Promise<MemoryEntry[]> {
    const ns = `shared/${agentId}`;
    const data = await this.loadShared();
    return data.entries[ns] || [];
  }

  async getNamespaces(): Promise<string[]> {
    const data = await this.loadShared();
    return Object.keys(data.entries);
  }

  private async loadShared(): Promise<SharedData> {
    const filePath = path.join(this.store.getBasePath(), 'shared.json');
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data: SharedData = JSON.parse(raw);
      return data;
    } catch (error: unknown) {
      if (error instanceof Error && (error as Error & { code: string }).code === 'ENOENT') {
        return { entries: {}, updatedAt: new Date().toISOString() };
      }
      throw error;
    }
  }

  private async saveShared(data: SharedData): Promise<void> {
    const basePath = this.store.getBasePath();
    const filePath = path.join(basePath, 'shared.json');
    await fs.mkdir(basePath, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private notifySubscribers(agentId: string, entry: MemoryEntry): void {
    const subs = this.subscriptions.get(agentId);
    if (subs) {
      for (const cb of subs) {
        try { cb(entry); } catch { /* skip failed callbacks */ }
      }
    }
  }

  private recencyScore(timestamp: string): number {
    if (!timestamp) return 0.5;
    const ageMs = Date.now() - new Date(timestamp).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    return Math.max(0, 1 - ageHours / 24);
  }
}
