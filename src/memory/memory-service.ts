/**
 * MemoryService - 4 层架构 facade
 *
 * 收窄为「4 层编排」:
 * - L1: 内存 Map(会话元数据,30min TTL)
 * - L2: JSON 单文件(用户档案,永久)
 * - L3: JSON + embedding(会话摘要,30d TTL)
 * - L4: JSON 单会话(完整历史,永久预留归档)
 *
 * 核心 API:
 * - saveUserMessage/saveAssistantMessage(userId, sessionId, content, opts?) — L1+L4 同步
 * - summarizeRequest(args) — 请求级摘要(异步,失败不阻塞)
 * - closeSession(userId, sessionId) — 触发 L3 聚合 + L1 清理
 * - recall(userId, query, opts?) — L3 语义召回
 * - loadUserMemory(userId, sessionId?) — profile(L2) + 对话历史(L1/L4)
 * - buildContextPrompt(memory) — slice(-50)
 */

import * as path from 'path';
import { ILLMClient } from '../llm/interfaces';
import { L2ProfileService } from './l2-profile-service';
import { L3SummaryStore } from './l3-summary-store';
import { L3SummaryGenerator, GenerateRequestSummaryArgs, GenerateSessionSummaryArgs } from './l3-summary-generator';
import { L4HistoryStore } from './l4-history-store';
import { l1SessionMetadata } from './l1-session-metadata';
import { EmbeddingService } from './embedding-service';
import { createLogger } from '../observability/logger';
import type {
  L4HistoryEntry,
  RecallResult,
  SaveMessageOptions,
  SummarizeRequestArgs,
} from './types';
import type { UserProfile } from '../types';

const log = createLogger({ module: 'MemoryService' });

// ── Legacy Types(向后兼容) ────────────────────────────────────

export interface EpisodicEntry {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: string;
  skill?: string;
  metadata?: Record<string, unknown>;
}

export interface UserMemory {
  profile: UserProfile;
  episodicEntries: EpisodicEntry[];
}

// ── MemoryService ─────────────────────────────────────────────

export class MemoryService {
  private dataDir: string;
  private l1: typeof l1SessionMetadata;
  private l2: L2ProfileService;
  private l3Store: L3SummaryStore;
  private l3Generator: L3SummaryGenerator;
  private l4: L4HistoryStore;

  constructor(
    dataDir: string = 'data',
    llmClient?: ILLMClient,
  ) {
    this.dataDir = dataDir;
    const storagePath = path.join(dataDir, 'memory');

    // L1: 单例(由 l1-session-metadata.ts 导出)
    this.l1 = l1SessionMetadata;
    // 注册会话过期回调 → 触发 L3 聚合(fire-and-forget)
    this.l1.setOnSessionExpired((userId, sessionId) => {
      // 不 await,避免阻塞 L1 cleanup 循环
      this.closeSession(userId, sessionId).catch((e) => {
        log.error(`[MemoryService] L1 cleanup 触发的 closeSession 失败: ${sessionId}`, { error: e });
      });
    });

    // L2: 用户档案
    this.l2 = new L2ProfileService(dataDir);

    // L3: 摘要存储 + 摘要生成器
    const embeddingService = new EmbeddingService();
    this.l3Store = new L3SummaryStore(storagePath, embeddingService);
    this.l3Generator = new L3SummaryGenerator(llmClient!, this.l3Store);

    // L4: 历史存储
    this.l4 = new L4HistoryStore(dataDir);
  }

  // ── 显式分层访问 ────────────────────────────────────────────

  getL1(): typeof l1SessionMetadata {
    return this.l1;
  }

  getL2(): L2ProfileService {
    return this.l2;
  }

  getL3Store(): L3SummaryStore {
    return this.l3Store;
  }

  getL3Generator(): L3SummaryGenerator {
    return this.l3Generator;
  }

  getL4(): L4HistoryStore {
    return this.l4;
  }

  /**
   * 进程退出前的资源清理(flush L4 所有 pending)
   */
  async flushAll(): Promise<void> {
    try {
      await this.l4.flushAll();
    } catch (e) {
      log.error('[MemoryService] flushAll 失败', { error: e });
    }
  }

  // ── 新 API:L1+L4 同步写入 ──────────────────────────────────

  /**
   * 保存用户消息(L1 同步 + L4 防抖 100ms 落盘)
   */
  async saveUserMessage(
    userId: string,
    sessionId: string,
    content: string,
    options?: SaveMessageOptions,
  ): Promise<void> {
    // L1 同步
    this.l1.addUserMessage(sessionId, userId, content, {
      skillName: options?.skillName,
      requestId: options?.requestId,
    });

    // L4 异步落盘
    const entry: L4HistoryEntry = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      sessionId,
      userId,
      requestId: options?.requestId,
      skillName: options?.skillName,
    };
    await this.l4.append(userId, sessionId, entry);
  }

  /**
   * 保存助手消息(L1 同步 + L4 防抖 100ms 落盘)
   */
  async saveAssistantMessage(
    userId: string,
    sessionId: string,
    content: string,
    options?: SaveMessageOptions,
  ): Promise<void> {
    // L1 同步
    this.l1.addAssistantMessage(sessionId, userId, content, {
      skillName: options?.skillName,
      requestId: options?.requestId,
    });

    // L4 异步落盘
    const entry: L4HistoryEntry = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
      sessionId,
      userId,
      requestId: options?.requestId,
      skillName: options?.skillName,
    };
    await this.l4.append(userId, sessionId, entry);
  }

  /**
   * 弹出最后一条助手消息(回滚场景,用于意图重分类时撤销错误的助手回复)
   *
   * 同步清理 L1 内存 + L4 文件中的最后一条。
   */
  async popLastAssistantMessage(userId: string, sessionId: string): Promise<void> {
    this.l1.popLastMessage(sessionId);

    // L4 删除最后一条:读取全部 entries,pop 末尾,重写文件
    const entries = await this.l4.listEntries(userId, sessionId);
    if (entries.length === 0) return;

    const lastEntry = entries[entries.length - 1];
    if (lastEntry.role !== 'assistant') return;

    entries.pop();
    const { promises: fs } = await import('fs');
    const pathModule = await import('path');
    const filePath = pathModule.join(this.dataDir, 'memory', userId, 'history', `${sessionId}.json`);
    const now = new Date().toISOString();
    const file = {
      userId,
      sessionId,
      entries,
      createdAt: now,
      updatedAt: now,
    };
    const dir = pathModule.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(file, null, 2), 'utf-8');
  }

  // ── 新 API:请求级摘要 ──────────────────────────────────────

  /**
   * 生成请求级摘要(请求完成时调用)
   *
   * 失败不阻塞主流程,仅记日志。
   */
  async summarizeRequest(args: SummarizeRequestArgs): Promise<void> {
    try {
      const summary = await this.l3Generator.generateRequestSummary(args as GenerateRequestSummaryArgs);
      if (summary) {
        this.l1.setPendingRequestSummary(args.sessionId, summary.summary);
        await this.l3Store.addRequestSummary(args.userId, summary);
      }
    } catch (e) {
      log.error(`[MemoryService] summarizeRequest 失败: ${args.requestId}`, { error: e });
    }
  }

  // ── 新 API:会话结束闭环 ────────────────────────────────────

  /**
   * 关闭会话(触发 L3 聚合 + L1 清理)
   *
   * 在以下场景触发:
   * - L1 cleanupExpired 检测到 30min 空闲(fire-and-forget)
   * - 显式 POST /sessions/:id/close
   * - 进程退出前(可选)
   */
  async closeSession(userId: string, sessionId: string): Promise<void> {
    try {
      await this.l3Generator.generateAndStoreSessionSummary({ userId, sessionId } as GenerateSessionSummaryArgs);
      this.l1.clearContext(sessionId);
      log.info(`[MemoryService] 会话已关闭: ${sessionId}`);
    } catch (e) {
      log.error(`[MemoryService] closeSession 失败: ${sessionId}`, { error: e });
      // 即使 L3 失败,也清理 L1(避免内存泄漏)
      this.l1.clearContext(sessionId);
    }
  }

  // ── 新 API:语义召回(L3) ───────────────────────────────────

  /**
   * 语义召回(L3 sessionSummaries)
   */
  async recall(userId: string, query: string, options?: { topK?: number }): Promise<RecallResult[]> {
    const results = await this.l3Store.search(userId, query, options?.topK ?? 5);
    return results.map(r => ({
      id: r.summary.id,
      content: r.summary.content,
      score: r.score,
      metadata: {
        ...r.summary.metadata,
        sessionId: r.summary.sessionId,
        createdAt: r.summary.createdAt,
      },
    }));
  }

  // ── 旧 API 兼容层 ──────────────────────────────────────────

  /**
   * 加载用户记忆(profile + 对话历史)
   *
   * - profile 从 L2 加载
   * - episodicEntries 优先从 L1 内存读取,无则从 L4 文件读取
   */
  async loadUserMemory(userId: string, sessionId?: string): Promise<UserMemory> {
    const profile = await this.l2.loadProfile(userId);

    let episodicEntries: EpisodicEntry[] = [];

    if (sessionId) {
      // 优先从 L1 内存读取(快)
      const l1Context = this.l1.getContext(sessionId);
      if (l1Context.userId === userId && l1Context.conversation.length > 0) {
        episodicEntries = l1Context.conversation.map(m => ({
          id: `l1-${m.timestamp}`,
          content: m.content,
          role: m.role,
          timestamp: new Date(m.timestamp).toISOString(),
          skill: m.skillName,
          metadata: m.requestId ? { requestId: m.requestId, sessionId } : { sessionId },
        }));
      } else {
        // 从 L4 文件读取
        const l4Entries = await this.l4.listEntries(userId, sessionId);
        episodicEntries = l4Entries.map(e => this.l4EntryToEpisodic(e));
      }
    }

    return { profile, episodicEntries };
  }

  /** @deprecated Use loadUserMemory instead */
  async loadMemory(userId: string, sessionId?: string): Promise<UserMemory> {
    return this.loadUserMemory(userId, sessionId);
  }

  /**
   * 格式化对话历史为 prompt 上下文(最多 50 条)
   */
  buildContextPrompt(memory: UserMemory): string {
    const entries = memory.episodicEntries.slice(-50);
    if (entries.length === 0) return '';

    const lines = entries.map(e => {
      const prefix = e.role === 'user' ? '用户' : '助手';
      const skill = e.skill ? `[${e.skill}] ` : '';
      return `${prefix}: ${skill}${e.content}`;
    });

    return `【对话历史】\n${lines.join('\n')}`;
  }

  /**
   * 清空所有长期记忆(L3)
   */
  async clearLongTerm(userId: string): Promise<void> {
    await this.l3Store.clear(userId);
  }

  /**
   * 获取会话历史(L4)
   */
  async getSessionHistory(userId: string, sessionId: string): Promise<Array<{ role: string; content: string; timestamp: number }>> {
    const entries = await this.l4.listEntries(userId, sessionId);
    return entries.map(e => ({
      role: e.role,
      content: e.content,
      timestamp: new Date(e.timestamp).getTime(),
    }));
  }

  // ── 私有工具 ────────────────────────────────────────────────

  private l4EntryToEpisodic(e: L4HistoryEntry): EpisodicEntry {
    return {
      id: e.id,
      content: e.content,
      role: e.role,
      timestamp: e.timestamp,
      skill: e.skillName,
      metadata: {
        sessionId: e.sessionId,
        requestId: e.requestId,
        archiveStatus: e.archiveStatus,
      },
    };
  }
}

export default MemoryService;
