/**
 * AutoCompactService - Automatic message compression service
 *
 * Implements a four-layer compression strategy inspired by Claude Code:
 * - MICRO: Lightweight, frequent compaction
 * - AUTO: Automatic threshold-based compaction
 * - SESSION: Session-level compaction
 * - REACTIVE: Reactive compaction based on context pressure
 */

import { countTokens } from './token-counter';

/**
* Time threshold for micro compaction (5 minutes)
* Tool results older than this will be cleared
*/
export const MICRO_COMPACT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
* Placeholder text for cleared tool results
*/
export const CLEARED_TOOL_RESULT_PLACEHOLDER = '[Old tool result content cleared]';

/**
* Auto-compact threshold: 167K tokens (83.5% of 200K context window)
* Triggers LLM-based summarization when exceeded
*/
export const AUTO_COMPACT_THRESHOLD = 167000;

/**
* Circuit breaker: Maximum consecutive failures before stopping
*/
export const MAX_FAILURES = 3;

/**
 * Compression strategy levels
 */
export enum CompactStrategy {
  MICRO = 'MICRO',
  AUTO = 'AUTO',
  SESSION = 'SESSION',
  REACTIVE = 'REACTIVE'
}

/**
 * Message interface (placeholder - should match existing Message type)
 */
export interface Message {
  role: string;
  content: string;
  /** Optional timestamp for the message (milliseconds since epoch) */
  timestamp?: number;
  [key: string]: unknown;
}

export class AutoCompactService {
  private consecutiveFailures = 0;
  private llmClient?: import('../llm').LLMClient;

  constructor(llmClient?: import('../llm').LLMClient) {
    this.llmClient = llmClient;
  }

  microCompact(messages: Message[]): Message[] {
    const now = Date.now();
    const threshold = now - MICRO_COMPACT_THRESHOLD_MS;

    return messages.map(msg => {
      if (msg.role === 'tool' && msg.timestamp && msg.timestamp <= threshold) {
        return {
          ...msg,
          content: CLEARED_TOOL_RESULT_PLACEHOLDER
        };
      }
      return msg;
    });
  }

  async autoCompact(
    messages: Message[],
    context?: {
      currentSkill?: string;
      recentFiles?: string[];
      sessionVariables?: Map<string, unknown>;
      userProfile?: { department: string; commonSystems: string[] };
    }
  ): Promise<Message[]> {
    if (this.consecutiveFailures >= MAX_FAILURES) {
      console.log('[AutoCompact] Circuit breaker open, skipping compaction');
      return messages;
    }

    if (!this.llmClient) {
      console.log('[AutoCompact] No LLM client available');
      return messages;
    }

    try {
      const summary = await this.llmClient.generateText(
        'Summarize the following conversation history concisely, preserving key information, decisions, and context:\n\n' +
        messages.map(m => `${m.role}: ${m.content}`).join('\n\n'),
        'You are a helpful assistant that creates concise summaries of conversations.'
      );

      this.consecutiveFailures = 0;

      const resultMessages: Message[] = [
        { role: 'system', content: 'Previous conversation summary: ' + summary },
        messages[messages.length - 1]
      ];

      // P1-4: 压缩后关键上下文重注入
      if (context) {
        const contextInjection: string[] = ['[压缩后关键上下文]'];
        if (context.currentSkill) contextInjection.push(`当前技能: ${context.currentSkill}`);
        if (context.recentFiles?.length) contextInjection.push(`最近访问的文件: ${context.recentFiles.slice(-5).join(', ')}`);
        if (context.sessionVariables?.size) {
          const vars = Array.from(context.sessionVariables.entries()).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('; ');
          contextInjection.push(`会话变量: ${vars}`);
        }
        if (context.userProfile) {
          contextInjection.push(`用户: ${context.userProfile.department}, 常用系统: ${context.userProfile.commonSystems.join(', ')}`);
        }
        // Add context injection as a system message after the summary
        resultMessages.push({ role: 'system', content: contextInjection.join('\n') });
      }

      return resultMessages;
    } catch (error) {
      this.consecutiveFailures++;
      console.error(`[AutoCompact] Compaction failed (${this.consecutiveFailures}/${MAX_FAILURES}):`, error);
      return messages;
    }
  }

  async checkAndCompact(messages: Message[]): Promise<Message[]> {
    const tokens = await this.estimateTokens(messages);

    if (tokens > AUTO_COMPACT_THRESHOLD) {
      console.log(`[AutoCompact] Token count ${tokens} exceeds threshold ${AUTO_COMPACT_THRESHOLD}, triggering compaction`);
      return this.autoCompact(messages);
    }

    return messages;
  }

  async estimateTokens(messages: any[]): Promise<number> {
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      total += await countTokens(content);
    }
    return total;
  }
}
