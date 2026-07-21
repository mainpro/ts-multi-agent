/**
 * L3: 历史会话摘要(JSON + embedding,30d TTL,语义检索)
 *
 * - 写入触发:会话结束(L3SummaryGenerator 调用)
 * - 读取触发:语义召回(recall)
 * - 清理策略:30 天 TTL
 * - 优先级:中
 *
 * 数据文件:data/memory/{userId}/summaries.json
 * 复用 KnowledgeStore 的 writeLock + embedding 重试(3 次) + 关键词回退模式。
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { EmbeddingService } from './embedding-service';
import type {
  L3SessionSummary,
  L3RequestSummary,
  L3SummaryData,
} from './types';
import { L3_SUMMARY_TTL_MS } from './types';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'L3SummaryStore' });

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * L3SummaryStore - 会话摘要 + 请求摘要存储
 *
 * 由 KnowledgeStore 改造而来。复用:
 * - writeLock(防并发写入)
 * - embedding 重试(3 次失败)
 * - 关键词回退(无 embedding 时用 keyword match)
 */
export class L3SummaryStore {
  private writeLock: Promise<void> = Promise.resolve();
  private storagePath: string;
  private maxSizeBytes: number;
  private embeddingService: EmbeddingService;

  constructor(
    storagePath: string = 'data/memory',
    embeddingService: EmbeddingService,
    maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
  ) {
    this.storagePath = storagePath;
    this.embeddingService = embeddingService;
    this.maxSizeBytes = maxSizeBytes;
  }

  /**
   * Embedding 生成(3 次重试,失败返回 null)
   */
  private async generateEmbeddingWithRetry(text: string, maxRetries: number = 3): Promise<number[] | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.embeddingService.generateEmbedding(text) ?? null;
      } catch (e) {
        lastError = e;
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 200 * attempt));
        }
      }
    }
    log.error(`embedding 生成失败 (已重试 ${maxRetries} 次): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    return null;
  }

  /**
   * 添加请求级摘要(纯文本,不生成 embedding)
   *
   * 在请求完成时调用。等待会话结束时聚合为 session summary。
   */
  async addRequestSummary(userId: string, summary: L3RequestSummary): Promise<void> {
    const prev = this.writeLock;
    const next = prev.then(async () => {
      const data = await this.loadData(userId);
      // 同 requestId 不重复添加
      const existing = data.requestSummaries.find(s => s.requestId === summary.requestId);
      if (existing) {
        log.warn(`[L3] 请求摘要已存在,覆盖: ${summary.requestId}`);
        Object.assign(existing, summary);
      } else {
        data.requestSummaries.push(summary);
      }
      data.updatedAt = new Date().toISOString();
      await this.saveData(userId, data);
    });
    this.writeLock = next.catch((err) => {
      log.error('Write lock error:', { error: err });
    });
    await next;
  }

  /**
   * 添加会话级摘要(聚合后,生成 embedding,失败仍写入 content)
   *
   * 在会话结束(closeSession)时调用。
   */
  async addSessionSummary(
    userId: string,
    content: string,
    sessionId: string,
    requestSummaries: L3RequestSummary[],
    metadata: { skillNames: string[]; systems: string[]; [k: string]: unknown },
  ): Promise<L3SessionSummary> {
    const id = `sum-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + L3_SUMMARY_TTL_MS).toISOString();

    const embedding = this.embeddingService.isAvailable()
      ? await this.generateEmbeddingWithRetry(content)
      : null;

    const summary: L3SessionSummary = {
      id,
      userId,
      sessionId,
      content,
      embedding,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      requestSummaries,
      metadata,
    };

    const prev = this.writeLock;
    const next = prev.then(async () => {
      const data = await this.loadData(userId);
      // 同 sessionId 已有则更新,否则新增
      const existingIdx = data.sessionSummaries.findIndex(s => s.sessionId === sessionId);
      if (existingIdx >= 0) {
        data.sessionSummaries[existingIdx] = { ...summary, createdAt: data.sessionSummaries[existingIdx].createdAt };
      } else {
        data.sessionSummaries.push(summary);
      }
      // 清理已聚合到 session summary 的 request summaries
      const aggregatedRequestIds = new Set(requestSummaries.map(s => s.requestId));
      data.requestSummaries = data.requestSummaries.filter(s => !aggregatedRequestIds.has(s.requestId));

      data.updatedAt = now;
      await this.saveData(userId, data);
    });
    this.writeLock = next.catch((err) => {
      log.error('Write lock error:', { error: err });
    });
    await next;

    return summary;
  }

  /**
   * 获取指定 session 的所有请求级摘要(未聚合的)
   */
  async getRequestSummariesBySession(userId: string, sessionId: string): Promise<L3RequestSummary[]> {
    const data = await this.loadData(userId);
    return data.requestSummaries.filter(s => s.sessionId === sessionId);
  }

  /**
   * 语义检索(用 query embedding 搜索 sessionSummaries,返回 topK 条最相似结果)
   *
   * 过滤已过期的(expiresAt < now)。
   */
  async search(
    userId: string,
    query: string,
    topK: number = 5,
  ): Promise<Array<{ summary: L3SessionSummary; score: number }>> {
    const data = await this.loadData(userId);
    const now = Date.now();
    const valid = data.sessionSummaries.filter(s => new Date(s.expiresAt).getTime() > now);
    if (valid.length === 0) return [];

    let queryEmbedding: number[] | null = null;
    if (this.embeddingService.isAvailable()) {
      queryEmbedding = await this.generateEmbeddingWithRetry(query);
    }

    const scored = valid.map(summary => {
      let score = 0;
      if (queryEmbedding && summary.embedding) {
        score = this.embeddingService.cosineSimilarity(queryEmbedding, summary.embedding);
      } else {
        score = this.embeddingService.keywordMatchScore(query, summary.content);
      }
      return { summary, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * 清空用户所有摘要
   */
  async clear(userId: string): Promise<void> {
    const prev = this.writeLock;
    const next = prev.then(async () => {
      await this.saveData(userId, {
        sessionSummaries: [],
        requestSummaries: [],
        updatedAt: new Date().toISOString(),
      });
    });
    this.writeLock = next.catch((err) => {
      log.error('Write lock error:', { error: err });
    });
    await next;
  }

  /**
   * 获取所有 session 摘要(用于调试或迁移)
   */
  async getAllSessionSummaries(userId: string): Promise<L3SessionSummary[]> {
    const data = await this.loadData(userId);
    return data.sessionSummaries;
  }

  // ── 私有方法 ──────────────────────────────────────────────

  private getFilePath(userId: string): string {
    return path.join(this.storagePath, userId, 'summaries.json');
  }

  private async loadData(userId: string): Promise<L3SummaryData> {
    const filePath = this.getFilePath(userId);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as L3SummaryData;
      if (!Array.isArray(data.sessionSummaries)) data.sessionSummaries = [];
      if (!Array.isArray(data.requestSummaries)) data.requestSummaries = [];
      return data;
    } catch (error: unknown) {
      if (error instanceof Error && (error as Error & { code: string }).code === 'ENOENT') {
        return {
          sessionSummaries: [],
          requestSummaries: [],
          updatedAt: new Date().toISOString(),
        };
      }
      throw error;
    }
  }

  private async saveData(userId: string, data: L3SummaryData): Promise<void> {
    const filePath = this.getFilePath(userId);
    const userDir = path.dirname(filePath);
    await fs.mkdir(userDir, { recursive: true });

    const serialized = JSON.stringify(data, null, 2);

    if (Buffer.byteLength(serialized, 'utf-8') > this.maxSizeBytes) {
      // 淘汰最旧的 sessionSummaries
      const evictCount = Math.max(1, Math.floor(data.sessionSummaries.length * 0.3));
      log.warn(`[L3] ⚠️ 数据超限 (${Buffer.byteLength(serialized, 'utf-8')} bytes),淘汰最旧的 ${evictCount} 条 session summary`);
      data.sessionSummaries = data.sessionSummaries
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .slice(evictCount);
    }

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

export default L3SummaryStore;
