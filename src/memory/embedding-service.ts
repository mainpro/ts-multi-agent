export interface EmbeddingConfig {
  dimension: number;
  apiUrl?: string;
  apiKey?: string;
}

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  dimension: 1024,
};

export class EmbeddingService {
  private config: EmbeddingConfig;

  constructor(_llmClient?: unknown, config: Partial<EmbeddingConfig> = {}) {
    this.config = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
  }

  async generateEmbedding(_text: string): Promise<number[] | null> {
    return null;
  }

  async generateEmbeddings(texts: string[]): Promise<(number[] | null)[]> {
    return Promise.all(texts.map(t => this.generateEmbedding(t)));
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }

  keywordMatchScore(query: string, content: string): number {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const contentLower = content.toLowerCase();
    if (queryTerms.length === 0) return 0;
    const matches = queryTerms.filter(term => contentLower.includes(term)).length;
    return matches / queryTerms.length;
  }

  isAvailable(): boolean {
    return !!this.config.apiUrl;
  }

  clearCache(): void {}
}
