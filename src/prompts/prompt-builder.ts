/**
 * Prompt 构建器
 * P1-5: Prompt Cache 优化
 * 将 System Prompt 分为静态段落和动态段落，支持缓存
 */
export class PromptBuilder {
  private static staticPromptCache: Map<string, string> = new Map();

  /**
   * 构建带缓存边界的 System Prompt
   * @param staticParts 静态段落（会话内不变，如技能说明、保底规则）
   * @param dynamicParts 动态段落（每轮变化，如用户画像、对话历史）
   */
  static build(
    staticParts: { key: string; content: string }[],
    dynamicParts: string[]
  ): string {
    const staticContent = staticParts.map(p => {
      if (!this.staticPromptCache.has(p.key)) {
        this.staticPromptCache.set(p.key, p.content);
      }
      return this.staticPromptCache.get(p.key)!;
    }).join('\n\n');

    const dynamicContent = dynamicParts.join('\n\n');

    return `${staticContent}\n\n<!-- DYNAMIC_CONTEXT_START -->\n${dynamicContent}\n<!-- DYNAMIC_CONTEXT_END -->`;
  }

  /**
   * 清除缓存（技能热重载时调用）
   */
  static clearCache(key?: string): void {
    if (key) {
      this.staticPromptCache.delete(key);
    } else {
      this.staticPromptCache.clear();
    }
  }

  /**
   * 获取缓存大小
   */
  static getCacheSize(): number {
    return this.staticPromptCache.size;
  }
}
