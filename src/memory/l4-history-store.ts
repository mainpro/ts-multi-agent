/**
 * L4: 会话历史(JSON 单会话,永久,预留归档)
 *
 * - 写入触发:每条消息
 * - 读取触发:会话恢复 / 前端
 * - 清理策略:本地永久存储,预留 archiveAdapter 接口(后续接 DB/S3,超 3 个月归档)
 * - 优先级:低读高写
 *
 * 每会话一个 history.json,防抖 100ms 落盘。
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { L4HistoryEntry, L4HistoryFile, L4ArchiveAdapter } from './types';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'L4HistoryStore' });

const FLUSH_DEBOUNCE_MS = 100;
const ARCHIVE_THRESHOLD_MS = 3 * 30 * 24 * 60 * 60 * 1000; // 3 个月

/**
 * 本地 noop 归档适配器(预留,后续接 DB/S3)
 */
export class LocalNoopArchiveAdapter implements L4ArchiveAdapter {
  async archive(_entries: L4HistoryEntry[]): Promise<{ archivedIds: string[]; archiveRefs: string[] }> {
    return { archivedIds: [], archiveRefs: [] };
  }
  async retrieve(_refs: string[]): Promise<L4HistoryEntry[]> {
    return [];
  }
}

/**
 * L4HistoryStore - 每会话一个 history.json 的消息流存储
 *
 * 由 SessionStore 中消息流逻辑抽出。负责:
 * - append: 写入(防抖 100ms 落盘)
 * - listEntries: 读取(L1 restore 和前端恢复都用此 API)
 * - archiveOlderThan: 归档(接 L4ArchiveAdapter,本地 noop)
 * - flushToDisk: 进程退出时显式调用
 */
export class L4HistoryStore {
  private dataDir: string;
  private writeTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingWrites: Map<string, L4HistoryFile> = new Map();
  private archiveAdapter: L4ArchiveAdapter;

  constructor(
    dataDir: string = 'data',
    archiveAdapter?: L4ArchiveAdapter,
  ) {
    this.dataDir = dataDir;
    this.archiveAdapter = archiveAdapter ?? new LocalNoopArchiveAdapter();
  }

  private getFilePath(userId: string, sessionId: string): string {
    return path.join(this.dataDir, 'memory', userId, 'history', `${sessionId}.json`);
  }

  /**
   * 追加历史条目(防抖 100ms 落盘)
   */
  async append(userId: string, sessionId: string, entry: L4HistoryEntry): Promise<void> {
    const cacheKey = `${userId}:${sessionId}`;
    const file = this.pendingWrites.get(cacheKey) ?? await this.loadFile(userId, sessionId);

    file.entries.push(entry);
    file.updatedAt = new Date().toISOString();
    this.pendingWrites.set(cacheKey, file);

    // 防抖写入
    if (this.writeTimers.has(cacheKey)) {
      clearTimeout(this.writeTimers.get(cacheKey)!);
    }

    this.writeTimers.set(cacheKey, setTimeout(async () => {
      this.writeTimers.delete(cacheKey);
      const latest = this.pendingWrites.get(cacheKey);
      if (latest) {
        this.pendingWrites.delete(cacheKey);
        await this.flushToDisk(userId, sessionId, latest);
      }
    }, FLUSH_DEBOUNCE_MS));
  }

  /**
   * 读取会话所有历史条目
   */
  async listEntries(userId: string, sessionId: string): Promise<L4HistoryEntry[]> {
    const cacheKey = `${userId}:${sessionId}`;
    const pending = this.pendingWrites.get(cacheKey);
    if (pending) return [...pending.entries];

    const file = await this.loadFile(userId, sessionId);
    return file.entries;
  }

  /**
   * 读取会话最近 N 条历史
   */
  async listRecentEntries(userId: string, sessionId: string, limit: number): Promise<L4HistoryEntry[]> {
    const entries = await this.listEntries(userId, sessionId);
    if (entries.length <= limit) return entries;
    return entries.slice(-limit);
  }

  /**
   * 归档超过阈值的旧 entry(预留接口)
   *
   * 本地默认 noop,后续接 DB/S3 时实现 L4ArchiveAdapter。
   */
  async archiveOlderThan(
    userId: string,
    sessionId: string,
    olderThanMs: number = ARCHIVE_THRESHOLD_MS,
  ): Promise<{ archivedIds: string[]; archiveRefs: string[] }> {
    const entries = await this.listEntries(userId, sessionId);
    const threshold = Date.now() - olderThanMs;
    const toArchive = entries.filter(e => new Date(e.timestamp).getTime() < threshold);

    if (toArchive.length === 0) {
      return { archivedIds: [], archiveRefs: [] };
    }

    const result = await this.archiveAdapter.archive(toArchive);
    log.info(`[L4] 归档 ${result.archivedIds.length} 条旧历史 session=${sessionId}`);

    // 标记 archiveStatus(本地存储中保留元信息)
    if (result.archivedIds.length > 0) {
      const archivedIdSet = new Set(result.archivedIds);
      const refMap = new Map(result.archiveRefs.map((ref, i) => [result.archivedIds[i], ref]));

      const file = await this.loadFile(userId, sessionId);
      file.entries = file.entries.map(e => {
        if (archivedIdSet.has(e.id)) {
          return {
            ...e,
            archiveStatus: 'archived' as const,
            archiveRef: refMap.get(e.id),
          };
        }
        return e;
      });
      await this.flushToDisk(userId, sessionId, file);
    }

    return result;
  }

  /**
   * 立即写入磁盘(进程退出时显式调用,清理所有 pending)
   */
  async flushAll(): Promise<void> {
    const entries = Array.from(this.pendingWrites.entries());
    this.pendingWrites.clear();

    for (const [cacheKey, file] of entries) {
      const [userId, sessionId] = cacheKey.split(':');
      if (this.writeTimers.has(cacheKey)) {
        clearTimeout(this.writeTimers.get(cacheKey)!);
        this.writeTimers.delete(cacheKey);
      }
      try {
        await this.flushToDisk(userId, sessionId, file);
      } catch (e) {
        log.error(`[L4] flushAll 失败 session=${sessionId}:`, { error: e });
      }
    }
  }

  /**
   * 立即写入磁盘(单个会话,不防抖)
   */
  async flushToDisk(userId: string, sessionId: string, file: L4HistoryFile): Promise<void> {
    const filePath = this.getFilePath(userId, sessionId);
    const dir = path.dirname(filePath);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(file, null, 2), 'utf-8');
  }

  /**
   * 加载会话历史文件(不存在时创建空文件)
   */
  private async loadFile(userId: string, sessionId: string): Promise<L4HistoryFile> {
    const filePath = this.getFilePath(userId, sessionId);

    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const file = JSON.parse(data) as L4HistoryFile;
      if (!Array.isArray(file.entries)) file.entries = [];
      return file;
    } catch (error: unknown) {
      if (error instanceof Error && (error as Error & { code: string }).code === 'ENOENT') {
        const now = new Date().toISOString();
        return {
          userId,
          sessionId,
          entries: [],
          createdAt: now,
          updatedAt: now,
        };
      }
      throw error;
    }
  }
}

export default L4HistoryStore;
