import { UserMemoryStore } from './user-memory-store';
import { DEFAULT_TTL, MemoryEntry, MemoryLayer } from './types';

export interface EpisodicStoreOptions {
  maxContextEntries?: number;
}

export class EpisodicStore {
  constructor(
    private store: UserMemoryStore,
    private options: EpisodicStoreOptions = {},
  ) {}

  async saveUserMessage(
    userId: string,
    content: string,
    options?: { system?: string; skill?: string },
  ): Promise<void> {
    const entry = this.createEntry(userId, 'user', content, options);
    await this.store.appendEntry(userId, MemoryLayer.EPISODIC, entry);
  }

  async saveAssistantMessage(
    userId: string,
    content: string,
    options?: { system?: string; skill?: string },
  ): Promise<void> {
    const entry = this.createEntry(userId, 'assistant', content, options);
    await this.store.appendEntry(userId, MemoryLayer.EPISODIC, entry);
  }

  async loadEpisodicEntries(
    userId: string,
    options?: { maxEntries?: number },
  ): Promise<MemoryEntry[]> {
    const entries = await this.store.getEntries(userId, MemoryLayer.EPISODIC);
    const sorted = [...entries].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    if (options?.maxEntries && sorted.length > options.maxEntries) {
      return sorted.slice(sorted.length - options.maxEntries);
    }

    return sorted;
  }

  buildContextPrompt(entries: MemoryEntry[]): string {
    if (!entries || entries.length === 0) return '';

    const maxEntries = this.options.maxContextEntries ?? 50;
    const limited = entries.length > maxEntries
      ? entries.slice(entries.length - maxEntries)
      : entries;

    const lines: string[] = ['[对话历史]'];

    for (const entry of limited) {
      const role = entry.metadata?.role;
      let roleLabel: string;
      if (role === 'user') {
        roleLabel = '用户';
      } else if (role === 'assistant') {
        roleLabel = '助手';
      } else {
        roleLabel = typeof role === 'string' ? role : 'unknown';
      }
      lines.push(`${roleLabel}: ${entry.content}`);
    }

    return lines.join('\n');
  }

  async clearEpisodicEntries(userId: string): Promise<void> {
    const entries = await this.store.getEntries(userId, MemoryLayer.EPISODIC);
    for (const entry of entries) {
      await this.store.removeEntry(userId, MemoryLayer.EPISODIC, entry.id);
    }
  }

  private createEntry(
    userId: string,
    role: 'user' | 'assistant',
    content: string,
    options?: { system?: string; skill?: string },
  ): MemoryEntry {
    const now = new Date().toISOString();
    const id = `${userId}-${role}-${now}-${Math.random().toString(36).slice(2, 10)}`;
    return {
      id,
      layer: MemoryLayer.EPISODIC,
      content,
      metadata: {
        role,
        ...(options?.system && { system: options.system }),
        ...(options?.skill && { skill: options.skill }),
      },
      importance: 0.5,
      createdAt: now,
      updatedAt: now,
      namespace: userId,
      ttl: DEFAULT_TTL[MemoryLayer.EPISODIC],
    };
  }
}
