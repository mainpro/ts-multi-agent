import { EmbeddingService } from './embedding-service';
import { MemoryBackend, MemoryEntry, RetrievalResult, SearchOptions } from './types';

export interface RetrievalWeights {
  recency: number;
  keyword: number;
  importance: number;
  semantic: number;
}

const DEFAULT_WEIGHTS: RetrievalWeights = {
  recency: 0.15,
  keyword: 0.15,
  importance: 0.1,
  semantic: 0.6,
};

export class SemanticRetrievalEngine {
  private embeddingService: EmbeddingService;
  private backend?: MemoryBackend;
  private weights: RetrievalWeights;
  private recencyHalfLifeHours: number;

  constructor(
    embeddingService: EmbeddingService,
    weights?: Partial<RetrievalWeights>,
    recencyHalfLifeHours: number = 24,
    backend?: MemoryBackend,
  ) {
    this.embeddingService = embeddingService;
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.recencyHalfLifeHours = recencyHalfLifeHours;
    this.backend = backend;
  }

  /**
   * 语义检索（单次检索，基于向量相似度 + 关键词 + 时效性 + 重要性）
   */
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

    // 尝试生成查询的 embedding
    queryEmbedding = await this.embeddingService.generateEmbedding(query);

    // 如果有向量后端且所有候选属于同一 namespace，尝试向量检索
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

    // 手动评分模式
    const scored: RetrievalResult[] = [];
    for (const entry of filtered) {
      const recency = this.computeRecencyScore(entry.createdAt);
      const keyword = this.computeKeywordScore(query, entry);
      const importance = entry.importance;
      const semantic = this.computeSemanticScore(entry, queryEmbedding);

      const score =
        this.weights.recency * recency +
        this.weights.keyword * keyword +
        this.weights.importance * importance +
        this.weights.semantic * semantic;

      if (options?.minScore !== undefined && score < options.minScore) continue;

      scored.push({
        entry,
        score,
        scoreBreakdown: { recency, keyword, importance, semantic },
      });
    }

    // 更新命中统计
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

  /**
   * 关键词匹配评分
   */
  computeKeywordScore(query: string, entry: MemoryEntry): number {
    return this.embeddingService.keywordMatchScore(query, entry.content);
  }

  /**
   * 语义相似度评分（基于向量余弦相似度）
   * 如果 entry 或 query 没有 embedding，返回 0
   */
  computeSemanticScore(entry: MemoryEntry, queryEmbedding?: number[] | null): number {
    if (!entry.embedding || entry.embedding.length === 0) return 0;
    if (!queryEmbedding) return 0;
    return this.embeddingService.cosineSimilarity(queryEmbedding, entry.embedding);
  }

  computeImportanceScore(entry: MemoryEntry): number {
    return entry.importance;
  }

  getWeights(): RetrievalWeights {
    return { ...this.weights };
  }
}
