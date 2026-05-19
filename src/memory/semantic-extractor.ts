import { LLMClient } from '../llm/index';
import { MemoryService } from './memory-service';

export interface ExtractedKnowledge {
  category: 'preference' | 'fact' | 'knowledge' | 'rule';
  content: string;
  confidence: number;
}

export class SemanticExtractor {
  private llmClient: LLMClient;
  private memoryService: MemoryService;
  private timeout: number;

  constructor(llmClient: LLMClient, memoryService: MemoryService, timeout: number = 30000) {
    this.llmClient = llmClient;
    this.memoryService = memoryService;
    this.timeout = timeout;
  }

  async extract(
    userId: string,
    userMessage: string,
    assistantMessage: string,
    skillName?: string,
  ): Promise<void> {
    const prompt = this.buildPrompt(userMessage, assistantMessage, skillName);

    let response: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Semantic extraction timed out')), this.timeout),
        );
        response = await Promise.race([
          this.llmClient.generateText(prompt),
          timeoutPromise,
        ]);
        if (response) break;
      } catch (e) {
        if (attempt === 0) {
          console.warn('[SemanticExtractor] Attempt 1 failed, retrying:', (e as Error).message);
        } else {
          console.error('[SemanticExtractor] Extraction failed after 2 attempts:', (e as Error).message);
          return;
        }
      }
    }

    if (!response) {
      console.warn('[SemanticExtractor] LLM returned empty response, skipping extraction');
      return;
    }

    const knowledge = this.parseResponse(response);
    if (!knowledge || knowledge.length === 0) return;

    for (const item of knowledge) {
      if (!item.content || item.content.trim().length === 0) continue;
      try {
        await this.memoryService.saveSemanticMemory(
          userId,
          item.content,
          item.category,
          'inferred',
          item.confidence,
        );
      } catch (e) {
        console.error('[SemanticExtractor] Failed to save semantic entry:', e);
      }
    }
  }

  private buildPrompt(userMessage: string, assistantMessage: string, skillName?: string): string {
    return `从以下用户与助手的对话中，提取有价值的语义知识。只提取长期有效的信息，不要提取临时性的对话内容。

用户: ${userMessage}
助手: ${assistantMessage}
${skillName ? `使用的技能: ${skillName}` : ''}

请提取以下类型的知识（如果没有则不输出）：
- preference: 用户偏好（如语言、风格、格式偏好）
- fact: 用户相关的事实（如部门、岗位、常用系统）
- knowledge: 用户提及的知识或规则
- rule: 业务规则或流程规则

直接输出JSON数组，不要用markdown代码块包裹，不要输出任何其他文字。
每项格式: {"category":"preference|fact|knowledge|rule","content":"具体内容","confidence":0.8}
如果没有可提取的知识，输出: []`;
  }

  private parseResponse(response: string): ExtractedKnowledge[] {
    try {
      let cleaned = response.trim();
      // Strip markdown code block wrappers that LLMs often add
      const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (codeBlockMatch) {
        cleaned = codeBlockMatch[1].trim();
      }
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn('[SemanticExtractor] No JSON array found in LLM response:', response.substring(0, 200));
        return [];
      }
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item: unknown): item is ExtractedKnowledge =>
          typeof item === 'object' &&
          item !== null &&
          'category' in item &&
          'content' in item &&
          'confidence' in item &&
          typeof (item as ExtractedKnowledge).content === 'string' &&
          typeof (item as ExtractedKnowledge).confidence === 'number' &&
          ['preference', 'fact', 'knowledge', 'rule'].includes((item as ExtractedKnowledge).category),
      );
    } catch (e) {
      console.error('[SemanticExtractor] JSON parse failed:', (e as Error).message, 'response:', response.substring(0, 200));
      return [];
    }
  }
}
