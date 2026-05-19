import { EmbeddingService } from './embedding-service';
import { MemoryBackend, MemoryEntry, RetrievalResult, SearchOptions } from './types';
import type { LLMClient } from '../llm';

export interface RetrievalWeights {
  recency: number;
  keyword: number;
  importance: number;
}

export interface AdaptiveRetrievalConfig {
  /** If top score exceeds this, return results directly (high confidence). Default: 0.8 */
  confidenceThresholdHigh?: number;
  /** If top score is below this, trigger LLM expansion if available. Default: 0.5 */
  confidenceThresholdLow?: number;
  /** Maximum number of expanded queries to generate via LLM. Default: 3 */
  explorationBudget?: number;
}

const DEFAULT_WEIGHTS: RetrievalWeights = {
  recency: 0.3,
  keyword: 0.5,
  importance: 0.2,
};

const DEFAULT_ADAPTIVE_CONFIG: Required<AdaptiveRetrievalConfig> = {
  confidenceThresholdHigh: 0.8,
  confidenceThresholdLow: 0.5,
  explorationBudget: 3,
};

export class SemanticRetrievalEngine {
  private embeddingService: EmbeddingService;
  private backend?: MemoryBackend;
  private weights: RetrievalWeights;
  private recencyHalfLifeHours: number;
  private llmClient?: LLMClient;
  private adaptiveConfig: Required<AdaptiveRetrievalConfig>;

  constructor(
    embeddingService: EmbeddingService,
    weights?: Partial<RetrievalWeights>,
    recencyHalfLifeHours: number = 24,
    backend?: MemoryBackend,
    llmClient?: LLMClient,
    adaptiveConfig?: AdaptiveRetrievalConfig,
  ) {
    this.embeddingService = embeddingService;
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.recencyHalfLifeHours = recencyHalfLifeHours;
    this.backend = backend;
    this.llmClient = llmClient;
    this.adaptiveConfig = { ...DEFAULT_ADAPTIVE_CONFIG, ...adaptiveConfig };
  }

  async retrieve(
    query: string,
    candidates: MemoryEntry[],
    options?: SearchOptions,
  ): Promise<RetrievalResult[]> {
    let queryEmbedding: number[] | null = null;
    let filtered = candidates;
    if (options?.layers && options.layers.length > 0) {
      filtered = filtered.filter(e => options.layers!.includes(e.layer));
    }

    queryEmbedding = await this.embeddingService.generateEmbedding(query);

    if (this.backend && filtered.length > 0 && queryEmbedding) {
      const namespace = filtered[0].namespace;
      const allSameNamespace = filtered.every(e => e.namespace === namespace);
      if (allSameNamespace) {
        try {
          const vectorResults = await this.backend.searchVector(
            namespace,
            queryEmbedding,
            options?.topK,
          );
          const ids = new Set(filtered.map(e => e.id));
          return vectorResults.filter(r => ids.has(r.entry.id));
        } catch {
          // searchVector unavailable — fall through to manual scoring
        }
      }
    }

    const scored: RetrievalResult[] = [];
    for (const entry of filtered) {
      const recency = this.computeRecencyScore(entry.createdAt);
      const keyword = this.computeKeywordScore(query, entry, queryEmbedding);
      const importance = entry.importance;

      const score =
        this.weights.recency * recency +
        this.weights.keyword * keyword +
        this.weights.importance * importance;

      if (options?.minScore !== undefined && score < options.minScore) continue;

      scored.push({
        entry,
        score,
        scoreBreakdown: { recency, keyword, importance },
      });
    }

    for (const result of scored) {
      result.entry.hitCount = (result.entry.hitCount ?? 0) + 1;
      result.entry.lastHitAt = new Date().toISOString();
    }

    scored.sort((a, b) => b.score - a.score);
    const topK = options?.topK ?? scored.length;
    return scored.slice(0, topK);
  }

  computeRecencyScore(createdAt: string): number {
    const now = Date.now();
    const then = new Date(createdAt).getTime();
    const ageHours = (now - then) / (1000 * 60 * 60);
    return Math.exp(-0.693 * ageHours / this.recencyHalfLifeHours);
  }

  computeKeywordScore(query: string, entry: MemoryEntry, queryEmbedding?: number[] | null): number {
    if (entry.embedding && entry.embedding.length > 0 && queryEmbedding) {
      return this.embeddingService.cosineSimilarity(queryEmbedding, entry.embedding);
    }
    return this.embeddingService.keywordMatchScore(query, entry.content);
  }

  computeImportanceScore(entry: MemoryEntry): number {
    return entry.importance;
  }

  getWeights(): RetrievalWeights {
    return { ...this.weights };
  }

  async adaptiveRetrieve(
    query: string,
    candidates: MemoryEntry[],
    options?: SearchOptions,
  ): Promise<RetrievalResult[]> {
    const firstPass = await this.retrieve(query, candidates, options);

    if (firstPass.length === 0) return firstPass;

    const topScore = firstPass[0].score;

    if (topScore >= this.adaptiveConfig.confidenceThresholdHigh) {
      return firstPass;
    }

    if (topScore >= this.adaptiveConfig.confidenceThresholdLow) {
      return firstPass;
    }

    if (!this.llmClient) {
      return firstPass;
    }

    const expandedQueries = await this.expandQuery(query);
    if (expandedQueries.length === 0) {
      return firstPass;
    }

    const allResults = new Map<string, RetrievalResult>();
    for (const result of firstPass) {
      allResults.set(result.entry.id, result);
    }

    for (const expandedQuery of expandedQueries) {
      const expandedResults = await this.retrieve(expandedQuery, candidates, options);
      for (const result of expandedResults) {
        if (!allResults.has(result.entry.id)) {
          allResults.set(result.entry.id, result);
        }
      }
    }

    const merged = Array.from(allResults.values());
    merged.sort((a, b) => b.score - a.score);
    const topK = options?.topK ?? merged.length;
    return merged.slice(0, topK);
  }

  private async expandQuery(originalQuery: string): Promise<string[]> {
    if (!this.llmClient) return [];

    try {
      const prompt = `Generate ${this.adaptiveConfig.explorationBudget} alternative search queries for the following question. Each query should approach the topic from a different angle or use different terminology. Return only the queries, one per line, without numbering or bullets.\n\nQuestion: ${originalQuery}`;

      const response = await this.llmClient.generateText(prompt);
      const queries = response
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .slice(0, this.adaptiveConfig.explorationBudget);

      return queries;
    } catch {
      return [];
    }
  }
}
