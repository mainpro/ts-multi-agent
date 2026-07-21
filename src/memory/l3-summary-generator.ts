/**
 * L3: 摘要生成器(请求级摘要 → 会话级聚合)
 *
 * - generateRequestSummary: 请求完成时调用,LLM 生成 ≤500 字符摘要
 * - generateAndStoreSessionSummary: 会话结束时聚合所有 requestSummaries 为 ≤2000 字符
 *
 * 失败处理:
 * - 请求级失败 → 返回 null,跳过(不阻塞主流程)
 * - 会话级失败 → 降级为拼接前 N 条 requestSummaries
 */

import { ILLMClient } from '../llm/interfaces';
import { L3SummaryStore } from './l3-summary-store';
import type { L3RequestSummary, L3SessionSummary } from './types';
import { L3_REQUEST_SUMMARY_MAX_CHARS, L3_SESSION_SUMMARY_MAX_CHARS } from './types';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'L3SummaryGenerator' });

const TIMEOUT_MS = 30000;

export interface GenerateRequestSummaryArgs {
  userId: string;
  sessionId: string;
  requestId: string;
  userMessage: string;
  assistantMessage: string;
  skillName?: string;
  system?: string;
}

export interface GenerateSessionSummaryArgs {
  userId: string;
  sessionId: string;
}

/**
 * L3SummaryGenerator - LLM 驱动的摘要生成
 *
 * 由 SemanticExtractor 改造而来。核心差异:
 * - 旧版:提取语义知识条目(preference/fact/knowledge/rule)
 * - 新版:生成对话摘要(请求级 + 会话级聚合),用于语义召回
 */
export class L3SummaryGenerator {
  constructor(
    private llmClient: ILLMClient,
    private l3Store: L3SummaryStore,
    private timeout: number = TIMEOUT_MS,
  ) {}

  /**
   * 生成请求级摘要(≤500 字符)
   *
   * 失败 → 返回 null,不阻塞主流程
   */
  async generateRequestSummary(args: GenerateRequestSummaryArgs): Promise<L3RequestSummary | null> {
    const prompt = this.buildRequestSummaryPrompt(args);

    try {
      const traceId = `l3req-${args.requestId}`;
      log.info('llm.request', {
        traceId,
        type: 'l3RequestSummary',
        requestId: args.requestId,
        userMessageLength: args.userMessage.length,
        assistantMessageLength: args.assistantMessage.length,
      });

      const response = await this.callLLMWithTimeout(prompt);
      if (!response) {
        log.warn(`[L3] 请求摘要 LLM 返回空,跳过: ${args.requestId}`);
        return null;
      }

      log.info('llm.response', { traceId, responseLength: response.length });

      const summary = this.cleanSummary(response, L3_REQUEST_SUMMARY_MAX_CHARS);
      if (!summary) {
        log.warn(`[L3] 请求摘要清洗后为空,跳过: ${args.requestId}`);
        return null;
      }

      const requestSummary: L3RequestSummary = {
        requestId: args.requestId,
        sessionId: args.sessionId,
        summary,
        skillName: args.skillName,
        system: args.system,
        createdAt: new Date().toISOString(),
      };

      log.info(`[L3] ✅ 生成请求摘要: ${args.requestId} (${summary.length} 字符)`);
      return requestSummary;
    } catch (e) {
      log.error(`[L3] 请求摘要生成失败: ${args.requestId}`, { error: e });
      return null;
    }
  }

  /**
   * 生成会话级摘要(≤2000 字符)并存储
   *
   * 流程:
   * 1. 读取该 session 所有未聚合的 requestSummaries
   * 2. LLM 聚合为 ≤2000 字符
   * 3. 生成 embedding(失败仍写入 content)
   * 4. L3Store.addSessionSummary(同时清理已聚合的 request summaries)
   *
   * 失败降级:拼接前 N 条 requestSummaries
   */
  async generateAndStoreSessionSummary(args: GenerateSessionSummaryArgs): Promise<L3SessionSummary | null> {
    const requestSummaries = await this.l3Store.getRequestSummariesBySession(args.userId, args.sessionId);

    if (requestSummaries.length === 0) {
      log.info(`[L3] 会话无请求摘要,跳过聚合: ${args.sessionId}`);
      return null;
    }

    let content: string | null = null;

    try {
      const prompt = this.buildSessionSummaryPrompt(requestSummaries);
      const traceId = `l3sess-${args.sessionId}`;
      log.info('llm.request', {
        traceId,
        type: 'l3SessionSummary',
        sessionId: args.sessionId,
        requestSummariesCount: requestSummaries.length,
      });

      const response = await this.callLLMWithTimeout(prompt);
      if (response) {
        content = this.cleanSummary(response, L3_SESSION_SUMMARY_MAX_CHARS);
      }

      log.info('llm.response', { traceId, responseLength: response?.length || 0 });
    } catch (e) {
      log.error(`[L3] 会话摘要 LLM 生成失败,降级拼接: ${args.sessionId}`, { error: e });
    }

    // 降级:拼接前 N 条 requestSummaries
    if (!content) {
      const fallback = this.fallbackConcatenate(requestSummaries, L3_SESSION_SUMMARY_MAX_CHARS);
      if (fallback) {
        content = fallback;
        log.info(`[L3] 降级拼接会话摘要: ${args.sessionId} (${content.length} 字符)`);
      }
    }

    if (!content) {
      log.warn(`[L3] 会话摘要生成完全失败,跳过: ${args.sessionId}`);
      return null;
    }

    // 收集 metadata
    const skillNames = Array.from(new Set(
      requestSummaries.map(s => s.skillName).filter((n): n is string => !!n)
    ));
    const systems = Array.from(new Set(
      requestSummaries.map(s => s.system).filter((n): n is string => !!n)
    ));

    try {
      const summary = await this.l3Store.addSessionSummary(
        args.userId,
        content,
        args.sessionId,
        requestSummaries,
        { skillNames, systems },
      );
      log.info(`[L3] ✅ 生成会话摘要: ${args.sessionId} (${content.length} 字符, ${requestSummaries.length} 条请求)`);
      return summary;
    } catch (e) {
      log.error(`[L3] 会话摘要存储失败: ${args.sessionId}`, { error: e });
      return null;
    }
  }

  // ── 私有方法 ──────────────────────────────────────────────

  private buildRequestSummaryPrompt(args: GenerateRequestSummaryArgs): string {
    return `请用一句话(不超过 500 字符)总结以下对话的核心内容,包括用户意图、执行的操作、关键结果。

用户消息: ${args.userMessage}
助手回复: ${args.assistantMessage}
${args.skillName ? `使用的技能: ${args.skillName}` : ''}
${args.system ? `涉及系统: ${args.system}` : ''}

要求:
- 直接输出摘要文本,不要加 markdown 代码块、不要加前后缀说明
- 保留关键实体(系统名、操作、结果)
- 不要包含寒暄、问候等无关内容`;
  }

  private buildSessionSummaryPrompt(requestSummaries: L3RequestSummary[]): string {
    const list = requestSummaries.map((s, i) =>
      `${i + 1}. ${s.summary}${s.skillName ? ` [技能: ${s.skillName}]` : ''}`
    ).join('\n');

    return `以下是一个会话中的多个请求摘要,请将它们聚合为一个会话级摘要(不超过 2000 字符):

${list}

要求:
- 直接输出摘要文本,不要加 markdown 代码块
- 按时间顺序组织,保留关键实体和操作链
- 突出用户的核心需求和最终结果
- 合并重复信息,去除冗余`;
  }

  private async callLLMWithTimeout(prompt: string): Promise<string | null> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('L3 summary generation timed out')), this.timeout),
    );

    try {
      return await Promise.race([
        this.llmClient.generateText(prompt),
        timeoutPromise,
      ]);
    } catch (e) {
      log.warn(`[L3] LLM 调用失败: ${(e as Error).message}`);
      return null;
    }
  }

  private cleanSummary(response: string, maxChars: number): string | null {
    let cleaned = response.trim();

    // 去除 markdown 代码块包裹
    const codeBlockMatch = cleaned.match(/```(?:json|text)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    }

    if (cleaned.length === 0) return null;

    if (cleaned.length > maxChars) {
      cleaned = cleaned.substring(0, maxChars - 3) + '...';
    }

    return cleaned;
  }

  private fallbackConcatenate(requestSummaries: L3RequestSummary[], maxChars: number): string | null {
    if (requestSummaries.length === 0) return null;

    const parts: string[] = [];
    let total = 0;

    for (const s of requestSummaries) {
      const part = `${s.summary}`;
      if (total + part.length + 1 > maxChars) break;
      parts.push(part);
      total += part.length + 1;
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }
}

export default L3SummaryGenerator;
