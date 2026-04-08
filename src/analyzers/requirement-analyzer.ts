import { LLMClient } from '../llm';
import {
  DecompositionResult,
  SubRequirement,
  SubRequirementType,
  OverallIntent,
} from '../types/requirement-types';
import {
  REQUIREMENT_DECOMPOSER_SYSTEM_PROMPT,
  buildDecompositionPrompt,
  DecompositionResponseSchema,
  DecompositionResponse,
} from '../prompts/requirement-analyzer';

const CONFIDENCE_THRESHOLD = 0.7;

const CONNECTORS = ['另外', '还有', '以及', '同时', '也'];
const SENTENCE_DELIMITERS = ['。', '；'];
const CONTEXT_INDICATORS = ['那怎么', '那能不能', '如果是这样', '继续'];
const SMALL_TALK_PATTERNS = ['你好', '您好', '谢谢', '感谢', '好的', '没问题', '了解', '知道了'];

export class RequirementAnalyzer {
  private llmClient: LLMClient;

  constructor(llmClient?: LLMClient) {
    this.llmClient = llmClient || new LLMClient();
  }

  async decompose(requirement: string, signal?: AbortSignal): Promise<DecompositionResult> {
    const startTime = Date.now();

    const quickResult = this.quickPath(requirement, startTime);
    if (quickResult) {
      return quickResult;
    }

    return this.llmDecompose(requirement, startTime, signal);
  }

  private quickPath(requirement: string, startTime: number): DecompositionResult | null {
    const trimmed = requirement.trim();

    if (this.isSmallTalk(trimmed)) {
      return {
        isComposite: false,
        subRequirements: [],
        overallIntent: 'small_talk',
        metadata: {
          processingTime: Date.now() - startTime,
          decompositionConfidence: 0.99,
        },
      };
    }

    if (!this.hasMultipleRequirements(trimmed)) {
      const type = this.detectType(trimmed);
      return {
        isComposite: false,
        subRequirements: [
          {
            id: 'req-1',
            content: trimmed,
            normalizedContent: this.normalizeContent(trimmed),
            position: { start: 0, end: trimmed.length },
            type,
            confidence: 0.9,
          },
        ],
        overallIntent: type === 'clarification' ? 'unclear' : 'skill_task',
        metadata: {
          processingTime: Date.now() - startTime,
          decompositionConfidence: 0.9,
        },
      };
    }

    return null;
  }

  private isSmallTalk(text: string): boolean {
    const normalized = text.toLowerCase().trim();
    return SMALL_TALK_PATTERNS.some(pattern => normalized === pattern || normalized === pattern + '！');
  }

  private hasMultipleRequirements(text: string): boolean {
    for (const connector of CONNECTORS) {
      if (text.includes(connector)) {
        return true;
      }
    }

    const sentences = text.split(/[。；]/).filter(s => s.trim().length > 0);
    if (sentences.length > 1) {
      for (const connector of CONNECTORS) {
        if (sentences.some(s => s.includes(connector))) {
          return true;
        }
      }
    }

    return false;
  }

  private detectType(text: string): SubRequirementType {
    for (const indicator of CONTEXT_INDICATORS) {
      if (text.startsWith(indicator) || text.includes(indicator)) {
        return 'context_reference';
      }
    }

    if (text.includes('什么意思') || text.includes('是指什么') || text.includes('是什么')) {
      return 'clarification';
    }

    return 'skill_task';
  }

  private normalizeContent(text: string): string {
    let normalized = text.trim();

    for (const indicator of CONTEXT_INDICATORS) {
      if (normalized.startsWith(indicator)) {
        normalized = normalized.slice(indicator.length).trim();
        break;
      }
    }

    normalized = normalized.replace(/^(帮我|请|麻烦|能不能|可以|想要|需要)\S*/g, '').trim();

    return normalized || text;
  }

  private async llmDecompose(
    requirement: string,
    startTime: number,
    signal?: AbortSignal
  ): Promise<DecompositionResult> {
    try {
      const prompt = buildDecompositionPrompt(requirement);
      const response = await this.llmClient.generateStructured<DecompositionResponse>(
        prompt,
        DecompositionResponseSchema,
        REQUIREMENT_DECOMPOSER_SYSTEM_PROMPT,
        signal
      );

    const subRequirements: SubRequirement[] = response.subRequirements
      .filter(sub => sub.confidence >= CONFIDENCE_THRESHOLD)
      .map(sub => ({
        id: sub.id,
        content: sub.content,
        normalizedContent: sub.normalizedContent,
        position: {
          start: sub.position.start ?? 0,
          end: sub.position.end ?? sub.content.length,
        },
        type: sub.type as SubRequirementType,
        confidence: sub.confidence,
      }));

      return {
        isComposite: response.isComposite,
        subRequirements,
        overallIntent: response.overallIntent as OverallIntent,
        metadata: {
          processingTime: Date.now() - startTime,
          decompositionConfidence: response.metadata.decompositionConfidence,
        },
      };
    } catch (error) {
      console.error('[RequirementAnalyzer] LLM decomposition failed:', error);
      return this.fallbackDecomposition(requirement, startTime);
    }
  }

  private fallbackDecomposition(requirement: string, startTime: number): DecompositionResult {
    const subRequirements: SubRequirement[] = [];
    let currentPosition = 0;
    let idCounter = 1;

    const segments = this.splitByConnectors(requirement);

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (trimmed.length === 0) continue;

      const startIndex = requirement.indexOf(trimmed, currentPosition);
      const endIndex = startIndex + trimmed.length;

      subRequirements.push({
        id: `req-${idCounter++}`,
        content: trimmed,
        normalizedContent: this.normalizeContent(trimmed),
        position: { start: startIndex, end: endIndex },
        type: this.detectType(trimmed),
        confidence: 0.7,
      });

      currentPosition = endIndex;
    }

    if (subRequirements.length === 0) {
      subRequirements.push({
        id: 'req-1',
        content: requirement,
        normalizedContent: this.normalizeContent(requirement),
        position: { start: 0, end: requirement.length },
        type: this.detectType(requirement),
        confidence: 0.7,
      });
    }

    return {
      isComposite: subRequirements.length > 1,
      subRequirements,
      overallIntent: 'skill_task',
      metadata: {
        processingTime: Date.now() - startTime,
        decompositionConfidence: 0.7,
      },
    };
  }

  private splitByConnectors(text: string): string[] {
    let result = [text];

    for (const connector of CONNECTORS) {
      const newResult: string[] = [];
      for (const segment of result) {
        const parts = segment.split(connector);
        newResult.push(...parts);
      }
      result = newResult;
    }

    for (const delimiter of SENTENCE_DELIMITERS) {
      const newResult: string[] = [];
      for (const segment of result) {
        const parts = segment.split(delimiter);
        newResult.push(...parts);
      }
      result = newResult;
    }

    return result.filter(s => s.trim().length > 0);
  }
}

export function createRequirementAnalyzer(llmClient?: LLMClient): RequirementAnalyzer {
  return new RequirementAnalyzer(llmClient);
}
