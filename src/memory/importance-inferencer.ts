import { z } from 'zod';
import { LLMClient } from '../llm/index';
import { MemoryEntry } from './types';

/** Result of importance/scope/category inference */
export interface InferenceResult {
  importance: number;
  scope: string;
  category: string;
}

const InferenceSchema = z.object({
  importance: z.number().min(0).max(1),
  scope: z.enum(['personal', 'team', 'organization']),
  category: z.enum(['preference', 'fact', 'procedure', 'event', 'question']),
});

const SYSTEM_PROMPT = `你是记忆重要性分析器。分析给定的记忆内容，返回一个 JSON 对象，包含以下字段：
- "importance": 0 到 1 之间的数字，表示记忆的重要性（0 = 不重要，1 = 非常重要）
- "scope": "personal"（个人）、"team"（团队）或 "organization"（组织），表示适用范围
- "category": "preference"（偏好）、"fact"（事实）、"procedure"（流程）、"event"（事件）或 "question"（问题），表示内容类型

只返回有效的 JSON，不要包含其他文本。`;

/**
 * ImportanceInferencer uses LLM to analyze memory content and infer
 * importance/scope/category, with a heuristic fallback when no LLM is available.
 */
export class ImportanceInferencer {
  private llmClient: LLMClient | undefined;

  constructor(llmClient?: LLMClient) {
    this.llmClient = llmClient;
  }

  /**
   * Infer importance, scope, and category for a memory entry.
   * Uses LLM when available; falls back to heuristic otherwise.
   */
  async infer(entry: MemoryEntry): Promise<InferenceResult> {
    if (this.llmClient) {
      try {
        return await this.inferWithLLM(entry);
      } catch {
      }
    }
    return this.heuristicInfer(entry);
  }

  /**
   * Batch inference — processes entries sequentially to avoid rate limits,
   * and updates each entry's importance field in place.
   */
  async inferBatch(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    for (const entry of entries) {
      const result = await this.infer(entry);
      entry.importance = result.importance;
    }
    return entries;
  }

  private async inferWithLLM(entry: MemoryEntry): Promise<InferenceResult> {
    const prompt = `分析以下记忆内容，返回包含 importance (0-1)、scope (personal/team/organization)、category (preference/fact/procedure/event/question) 的 JSON：

内容：${entry.content}
层级：${entry.layer}
命名空间：${entry.namespace}
元数据：${JSON.stringify(entry.metadata)}`;

    const result = await this.llmClient!.generateStructured(
      prompt,
      InferenceSchema,
      SYSTEM_PROMPT,
    );

    return {
      importance: result.importance,
      scope: result.scope,
      category: result.category,
    };
  }

  private heuristicInfer(entry: MemoryEntry): InferenceResult {
    const hasMetadata =
      entry.metadata && Object.keys(entry.metadata).length > 0;

    const importance =
      Math.min(1, entry.content.length / 500) * 0.5 +
      (hasMetadata ? 0.2 : 0) +
      0.3;

    return {
      importance,
      scope: 'personal',
      category: 'event',
    };
  }
}
