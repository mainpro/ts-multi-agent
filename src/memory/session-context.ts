/**
 * SessionContext - 短期会话上下文
 *
 * 特点：
 * - 内存存储，重启/关闭即消失
 * - 优先级最高，覆盖持久化记忆
 * - 用于当前聊天窗口内的状态保持
 */

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface SessionContextData {
  /** 当前激活的技能 */
  currentSkill?: string;
  /** 当前处理的系统 */
  currentSystem?: string;
  /** 对话主题/意图 */
  currentTopic?: string;
  /** 上次交互时间戳 */
  lastInteractionAt: number;
  /** 会话开始时间 */
  sessionStartAt: number;
  /** 临时变量存储 */
  tempVariables: Map<string, unknown>;
  /** 当前对话轮次 */
  turnCount: number;
  /** 当前会话的完整对话内容（不压缩，包括闲聊） */
  conversation: SessionMessage[];
}

/**
 * SessionContextService - 会话上下文管理器
 *
 * 提供当前聊天窗口级别的短期记忆
 */
export class SessionContextService {
  private contexts: Map<string, SessionContextData> = new Map();

  /**
   * 获取或创建会话上下文
   */
  getContext(sessionId: string): SessionContextData {
    let context = this.contexts.get(sessionId);

    if (!context) {
      context = {
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

  /**
   * 更新会话上下文
   */
  updateContext(
    sessionId: string,
    updates: Partial<Omit<SessionContextData, 'tempVariables' | 'conversation'>> & { tempVariables?: Record<string, unknown> }
  ): void {
    const context = this.getContext(sessionId);

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

  /**
   * 添加用户消息到当前会话
   */
  addUserMessage(sessionId: string, content: string): void {
    const context = this.getContext(sessionId);
    context.conversation.push({ role: 'user', content, timestamp: Date.now() });
  }

  /**
   * 添加助手回复到当前会话
   */
  addAssistantMessage(sessionId: string, content: string): void {
    const context = this.getContext(sessionId);
    context.conversation.push({ role: 'assistant', content, timestamp: Date.now() });
  }

  /**
   * 获取临时变量
   */
  getTempVariable<T>(sessionId: string, key: string): T | undefined {
    const context = this.contexts.get(sessionId);
    return context?.tempVariables.get(key) as T | undefined;
  }

  /**
   * 设置临时变量
   */
  setTempVariable(sessionId: string, key: string, value: unknown): void {
    const context = this.getContext(sessionId);
    context.tempVariables.set(key, value);
  }

  /**
   * 检查是否有活跃的会话上下文
   */
  hasActiveContext(sessionId: string): boolean {
    const context = this.contexts.get(sessionId);
    if (!context) return false;

    const thirtyMinutes = 30 * 60 * 1000;
    return Date.now() - context.lastInteractionAt < thirtyMinutes;
  }

  /**
   * 获取当前技能
   */
  getCurrentSkill(sessionId: string): string | undefined {
    return this.getContext(sessionId).currentSkill;
  }

  /**
   * 清除会话上下文
   */
  clearContext(sessionId: string): void {
    this.contexts.delete(sessionId);
  }

  /**
   * 清理过期会话
   */
  cleanupExpiredSessions(maxInactiveMinutes: number = 30): void {
    const maxInactiveMs = maxInactiveMinutes * 60 * 1000;
    const now = Date.now();

    for (const [sessionId, context] of this.contexts.entries()) {
      if (now - context.lastInteractionAt > maxInactiveMs) {
        this.contexts.delete(sessionId);
      }
    }
  }

  /**
   * 构建优先级提示 - 包含完整对话内容
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
        parts.push(`${role}: ${msg.content}`);
      }
    }

    parts.push('\n【重要】请优先结合当前会话上下文理解用户意图，判断是否是闲聊、追问还是新话题。');

    return parts.join('\n');
  }
}

export const sessionContextService = new SessionContextService();
