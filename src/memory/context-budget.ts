import { MemoryEntry, MemoryLayer, ContextBudgetConfig } from './types';

export const DEFAULT_CONTEXT_BUDGET_CONFIG: ContextBudgetConfig = {
  totalTokenBudget: 4000,
  layerWeights: {
    [MemoryLayer.WORKING]: 0.1,
    [MemoryLayer.EPISODIC]: 0.4,
    [MemoryLayer.SEMANTIC]: 0.3,
    [MemoryLayer.PROCEDURAL]: 0.1,
  },
  systemPromptReserve: 0.1,
  minImportanceThreshold: 0.3,
};

export class ContextBudgetManager {
  private config: ContextBudgetConfig;

  constructor(config?: Partial<ContextBudgetConfig>) {
    this.config = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, ...config };
    if (config?.layerWeights) {
      this.config.layerWeights = { ...DEFAULT_CONTEXT_BUDGET_CONFIG.layerWeights, ...config.layerWeights };
    }
  }

  async allocate(
    entries: Map<MemoryLayer, MemoryEntry[]>,
    requestType?: 'chitchat' | 'task' | 'complex',
  ): Promise<{
    allocated: Map<MemoryLayer, MemoryEntry[]>;
    totalBudget: number;
    usedTokens: number;
  }> {
    const weights = this.adjustWeightsForRequestType(requestType);
    const systemReserve = Math.floor(this.config.totalTokenBudget * this.config.systemPromptReserve);
    const available = this.config.totalTokenBudget - systemReserve;

    const allocated = new Map<MemoryLayer, MemoryEntry[]>();
    let usedTokens = systemReserve;

    for (const layer of Object.values(MemoryLayer)) {
      const layerEntries = entries.get(layer) || [];
      const layerBudget = Math.floor(available * (weights[layer] || 0));
      const selected = await this.selectWithinBudget(layerEntries, layerBudget);
      allocated.set(layer, selected);

      for (const entry of selected) {
        usedTokens += await this.estimateEntryTokens(entry);
      }
    }

    return { allocated, totalBudget: this.config.totalTokenBudget, usedTokens };
  }

  private async selectWithinBudget(
    entries: MemoryEntry[],
    budget: number,
  ): Promise<MemoryEntry[]> {
    const sorted = [...entries].sort(
      (a, b) => (b.importance + (b.hitCount ?? 0) * 0.01) - (a.importance + (a.hitCount ?? 0) * 0.01),
    );

    const selected: MemoryEntry[] = [];
    let used = 0;

    for (const entry of sorted) {
      const tokens = await this.estimateEntryTokens(entry);
      if (used + tokens > budget) break;
      selected.push(entry);
      used += tokens;
    }

    return selected;
  }

  private adjustWeightsForRequestType(
    type?: 'chitchat' | 'task' | 'complex',
  ): Record<MemoryLayer, number> {
    const base = { ...this.config.layerWeights };
    if (type === 'chitchat') {
      base[MemoryLayer.PROCEDURAL] = 0.05;
      base[MemoryLayer.EPISODIC] = 0.3;
      base[MemoryLayer.SEMANTIC] = 0.2;
      base[MemoryLayer.WORKING] = 0.35;
    } else if (type === 'complex') {
      base[MemoryLayer.PROCEDURAL] = 0.15;
      base[MemoryLayer.EPISODIC] = 0.35;
      base[MemoryLayer.SEMANTIC] = 0.25;
      base[MemoryLayer.WORKING] = 0.05;
    }
    return base;
  }

  private async estimateEntryTokens(entry: MemoryEntry): Promise<number> {
    const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
    return Math.ceil(content.length / 4);
  }

  getConfig(): ContextBudgetConfig {
    return { ...this.config };
  }
}
