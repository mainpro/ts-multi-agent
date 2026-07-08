/**
 * Embedding Service - 向量嵌入服务
 *
 * 支持接入硅基流动（SiliconFlow）Embedding API，提供向量生成和相似度计算能力。
 * API 不可用时自动降级到关键词匹配。
 */

export interface EmbeddingConfig {
  /** 向量维度 */
  dimension: number;
  /** API 地址（如 https://api.siliconflow.cn/v1） */
  apiUrl?: string;
  /** API 密钥 */
  apiKey?: string;
  /** Embedding 模型名称 */
  model?: string;
  /** 缓存最大条数 */
  cacheSize?: number;
  /** API 请求超时（毫秒） */
  timeoutMs?: number;
}

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  dimension: 1024,
  model: 'BAAI/bge-large-zh-v1.5',
  cacheSize: 1000,
  timeoutMs: 30000,
};

/**
 * 简易 LRU 缓存（不引入外部依赖）
 */
class LRUCache<T> {
  private cache = new Map<string, T>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

export class EmbeddingService {
  private config: EmbeddingConfig;
  private cache: LRUCache<number[]>;

  constructor(_llmClient?: unknown, config: Partial<EmbeddingConfig> = {}) {
    this.config = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
    this.cache = new LRUCache(this.config.cacheSize ?? DEFAULT_EMBEDDING_CONFIG.cacheSize!);

    // 从环境变量读取配置（如果未显式传入）
    if (!this.config.apiUrl && process.env.EMBEDDING_BASE_URL) {
      this.config.apiUrl = process.env.EMBEDDING_BASE_URL;
    }
    if (!this.config.apiKey && process.env.EMBEDDING_API_KEY) {
      this.config.apiKey = process.env.EMBEDDING_API_KEY;
    }
    if (!this.config.model && process.env.EMBEDDING_MODEL) {
      this.config.model = process.env.EMBEDDING_MODEL;
    }

    if (this.isAvailable()) {
      console.log(`[EmbeddingService] ✅ 已配置: model=${this.config.model}, dimension=${this.config.dimension}`);
    } else {
      console.log(`[EmbeddingService] ⚠️ 未配置 API，将使用关键词匹配回退方案`);
    }
  }

  /**
   * 生成单条文本的向量嵌入
   */
  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.config.apiUrl || !this.config.apiKey) return null;

    const cacheKey = this.getCacheKey(text);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await fetch(`${this.config.apiUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          input: text,
          encoding_format: 'float',
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_EMBEDDING_CONFIG.timeoutMs!),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        console.error(`[EmbeddingService] API 错误 ${response.status}: ${errorBody.substring(0, 200)}`);
        return null;
      }

      const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
      const embedding: number[] | undefined = data.data?.[0]?.embedding;

      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        console.error('[EmbeddingService] API 返回了空的 embedding');
        return null;
      }

      this.cache.set(cacheKey, embedding);
      return embedding;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[EmbeddingService] 请求失败: ${message}`);
      return null;
    }
  }

  /**
   * 批量生成向量嵌入（串行请求，避免限流）
   */
  async generateEmbeddings(texts: string[]): Promise<(number[] | null)[]> {
    return Promise.all(texts.map(t => this.generateEmbedding(t)));
  }

  /**
   * 计算两个向量的余弦相似度
   */
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

  /**
   * 关键词匹配评分（回退方案）
   */
  keywordMatchScore(query: string, content: string): number {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const contentLower = content.toLowerCase();
    if (queryTerms.length === 0) return 0;
    const matches = queryTerms.filter(term => contentLower.includes(term)).length;
    return matches / queryTerms.length;
  }

  /**
   * 检查 Embedding API 是否可用
   */
  isAvailable(): boolean {
    return !!(this.config.apiUrl && this.config.apiKey);
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 生成缓存 key（基于文本内容的简单哈希）
   */
  private getCacheKey(text: string): string {
    let hash = 0;
    const str = text;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return `${this.config.model}:${hash}`;
  }
}
