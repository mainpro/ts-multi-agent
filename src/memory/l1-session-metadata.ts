/**
 * L1: 会话元数据(内存 Map,30min TTL)
 *
 * - 写入触发:每次交互
 * - 读取触发:每次 LLM 调用前(buildPriorityPrompt)
 * - 清理策略:30min 超时 / 进程退出
 * - 优先级:最高
 *
 * 重启后通过 restoreFromHistory 从 L4 历史恢复 conversation。
 */

import type { L1SessionMetadata, L1Message, L4HistoryEntry } from './types';
import { L1_SESSION_IDLE_MS, L1_CLEANUP_INTERVAL_MS } from './types';

/**
 * L1SessionMetadataService - 会话级内存元数据管理
 *
 * 由旧 SessionContextService 改名而来。保留旧 API 别名供 sessionContextService 单例使用。
 */
export class L1SessionMetadataService {
  private contexts: Map<string, L1SessionMetadata> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  /** 会话过期清理时的回调(用于触发 L3 聚合) */
  private onSessionExpired?: (userId: string, sessionId: string) => void;

  constructor(
    cleanupIntervalMs: number = L1_CLEANUP_INTERVAL_MS,
    onSessionExpired?: (userId: string, sessionId: string) => void,
  ) {
    this.onSessionExpired = onSessionExpired;
    if (cleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpiredSessions();
      }, cleanupIntervalMs);
    }
  }

  /** 设置会话过期回调(用于触发 L3 聚合) */
  setOnSessionExpired(callback: (userId: string, sessionId: string) => void): void {
    this.onSessionExpired = callback;
  }

  /** 停止 cleanup 定时器(优雅关闭) */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /** 获取或创建会话上下文 */
  getContext(sessionId: string): L1SessionMetadata {
    let context = this.contexts.get(sessionId);

    if (!context) {
      context = {
        sessionId,
        userId: '',
        lastInteractionAt: Date.now(),
        sessionStartAt: Date.now(),
        tempVariables: new Map(),
        turnCount: 0,
        conversation: [],
      };
      this.contexts.set(sessionId, context);
    }

    return context;
  }

  /** 更新会话上下文(每次交互调用) */
  updateContext(
    sessionId: string,
    updates: Partial<Omit<L1SessionMetadata, 'tempVariables' | 'conversation' | 'userId' | 'sessionId' | 'sessionStartAt' | 'lastInteractionAt'>> & {
      tempVariables?: Record<string, unknown>;
      userId?: string;
    },
  ): void {
    const context = this.getContext(sessionId);

    if (updates.userId !== undefined) context.userId = updates.userId;
    if (updates.currentSkill !== undefined) context.currentSkill = updates.currentSkill;
    if (updates.currentSystem !== undefined) context.currentSystem = updates.currentSystem;
    if (updates.currentTopic !== undefined) context.currentTopic = updates.currentTopic;
    if (updates.turnCount !== undefined) context.turnCount = updates.turnCount;

    if (updates.tempVariables) {
      for (const [key, value] of Object.entries(updates.tempVariables)) {
        context.tempVariables.set(key, value);
      }
    }

    context.lastInteractionAt = Date.now();
    context.turnCount++;
  }

  /** 设置 userId(首次交互时) */
  setUserId(sessionId: string, userId: string): void {
    const context = this.getContext(sessionId);
    if (!context.userId) context.userId = userId;
  }

  /** 添加用户消息到 L1 内存(同步写入,与 L4 并行) */
  addUserMessage(sessionId: string, userId: string, content: string, opts?: { skillName?: string; requestId?: string }): void {
    const context = this.getContext(sessionId);
    if (!context.userId) context.userId = userId;
    context.conversation.push({
      role: 'user',
      content,
      timestamp: Date.now(),
      skillName: opts?.skillName,
      requestId: opts?.requestId,
    });
    context.lastInteractionAt = Date.now();
  }

  /** 添加助手回复到 L1 内存 */
  addAssistantMessage(sessionId: string, userId: string, content: string, opts?: { skillName?: string; requestId?: string }): void {
    const context = this.getContext(sessionId);
    if (!context.userId) context.userId = userId;
    context.conversation.push({
      role: 'assistant',
      content,
      timestamp: Date.now(),
      skillName: opts?.skillName,
      requestId: opts?.requestId,
    });
    context.lastInteractionAt = Date.now();
  }

  /** 弹出最后一条消息(回滚场景) */
  popLastMessage(sessionId: string): L1Message | undefined {
    const context = this.contexts.get(sessionId);
    if (!context) return undefined;
    return context.conversation.pop();
  }

  /** 设置当前请求摘要草稿(请求完成时,等待会话级聚合) */
  setPendingRequestSummary(sessionId: string, summary: string): void {
    const context = this.getContext(sessionId);
    context.pendingRequestSummary = summary;
  }

  /** 获取当前请求摘要草稿 */
  getPendingRequestSummary(sessionId: string): string | undefined {
    return this.contexts.get(sessionId)?.pendingRequestSummary;
  }

  /** 获取临时变量 */
  getTempVariable<T>(sessionId: string, key: string): T | undefined {
    const context = this.contexts.get(sessionId);
    return context?.tempVariables.get(key) as T | undefined;
  }

  /** 设置临时变量 */
  setTempVariable(sessionId: string, key: string, value: unknown): void {
    const context = this.getContext(sessionId);
    context.tempVariables.set(key, value);
  }

  /** 检查是否有活跃的会话上下文 */
  hasActiveContext(sessionId: string): boolean {
    const context = this.contexts.get(sessionId);
    if (!context) return false;
    return Date.now() - context.lastInteractionAt < L1_SESSION_IDLE_MS;
  }

  /** 获取当前技能 */
  getCurrentSkill(sessionId: string): string | undefined {
    return this.getContext(sessionId).currentSkill;
  }

  /** 清除会话上下文(主动 closeSession 时调用) */
  clearContext(sessionId: string): void {
    this.contexts.delete(sessionId);
  }

  /** 别名(向后兼容旧 SessionContextService API) */
  clear(sessionId: string): void {
    this.clearContext(sessionId);
  }

  /**
   * 清理过期会话(30min 空闲)
   *
   * 如果设置了 onSessionExpired 回调,清理前异步触发(不等待,失败仅记日志)
   */
  cleanupExpiredSessions(): string[] {
    const now = Date.now();
    const expired: string[] = [];

    for (const [sessionId, context] of this.contexts.entries()) {
      if (now - context.lastInteractionAt > L1_SESSION_IDLE_MS) {
        expired.push(sessionId);
        // 触发 L3 聚合(fire-and-forget)
        if (this.onSessionExpired && context.userId) {
          try {
            this.onSessionExpired(context.userId, sessionId);
          } catch (e) {
            console.error(`[L1] onSessionExpired 回调失败 session=${sessionId}:`, e);
          }
        }
        this.contexts.delete(sessionId);
      }
    }

    return expired;
  }

  /**
   * 从 L4 历史条目恢复会话上下文(服务重启后使用)
   *
   * 替代旧 restoreFromSession(session, Session) — 数据源从 Session 对象切到 L4 历史条目,更纯粹。
   */
  restoreFromHistory(sessionId: string, userId: string, history: L4HistoryEntry[]): void {
    // 如果内存中已有上下文且是活跃的,不覆盖
    if (this.contexts.has(sessionId) && this.hasActiveContext(sessionId)) {
      console.log(`[L1] ℹ️ 会话 ${sessionId} 已有活跃上下文,跳过恢复`);
      return;
    }

    const context = this.getContext(sessionId);
    context.userId = userId;
    context.conversation = history.map(entry => ({
      role: entry.role,
      content: entry.content,
      timestamp: new Date(entry.timestamp).getTime(),
      skillName: entry.skillName,
      requestId: entry.requestId,
    }));

    // 从最近的 entry 推断当前 skill
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.skillName) {
        context.currentSkill = entry.skillName;
        break;
      }
    }

    context.turnCount = Math.max(0, Math.floor(history.length / 2));
    context.lastInteractionAt = history.length > 0
      ? new Date(history[history.length - 1].timestamp).getTime()
      : Date.now();
    context.sessionStartAt = history.length > 0
      ? new Date(history[0].timestamp).getTime()
      : Date.now();

    console.log(`[L1] 🔄 从 L4 历史恢复会话 ${sessionId}: ${context.conversation.length} 条消息, turnCount=${context.turnCount}`);
  }

  /**
   * 构建优先级提示 - 包含完整对话内容
   *
   * 每次 LLM 调用前读取(最高优先级)
   */
  buildPriorityPrompt(sessionId: string): string {
    const context = this.getContext(sessionId);

    const parts: string[] = ['【当前会话上下文 - 最高优先级】'];

    if (context.currentSkill) {
      parts.push(`当前处理技能: ${context.currentSkill}`);
    }
    if (context.currentSystem) {
      parts.push(`当前系统: ${context.currentSystem}`);
    }
    if (context.currentTopic) {
      parts.push(`当前话题: ${context.currentTopic}`);
    }

    parts.push(`对话轮次: ${context.turnCount}`);

    if (context.conversation.length > 0) {
      parts.push('\n【当前会话完整对话】');
      for (const msg of context.conversation) {
        const role = msg.role === 'user' ? '用户' : '助手';
        const skill = msg.skillName ? `[${msg.skillName}] ` : '';
        parts.push(`${role}: ${skill}${msg.content}`);
      }
    }

    parts.push('\n【重要】请优先结合当前会话上下文理解用户意图,判断是否是闲聊、追问还是新话题。');

    return parts.join('\n');
  }
}

// 单例 + 向后兼容 alias
export const l1SessionMetadata = new L1SessionMetadataService();
/** @deprecated 使用 l1SessionMetadata 替代 */
export const sessionContextService = l1SessionMetadata;

// 向后兼容旧类型 alias
export type SessionContextData = L1SessionMetadata;
export type SessionMessage = L1Message;
export type { L1SessionMetadata, L1Message } from './types';
