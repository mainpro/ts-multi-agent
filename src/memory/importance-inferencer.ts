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

const SYSTEM_PROMPT = `You are a memory importance analyzer. Analyze the given memory content and return a JSON object with exactly these fields:
- "importance": a number between 0 and 1 indicating how important this memory is (0 = trivial, 1 = critical)
- "scope": one of "personal", "team", "organization" indicating the scope of relevance
- "category": one of "preference", "fact", "procedure", "event", "question" indicating the type of content

Return ONLY valid JSON, no additional text.`;

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
    const prompt = `Analyze this memory content and return JSON with importance (0-1), scope (personal/team/organization), category (preference/fact/procedure/event/question):

Content: ${entry.content}
Layer: ${entry.layer}
Namespace: ${entry.namespace}
Metadata: ${JSON.stringify(entry.metadata)}`;

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
