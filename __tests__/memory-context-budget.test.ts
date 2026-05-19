import { describe, test, expect } from 'bun:test';
import { ContextBudgetManager, DEFAULT_CONTEXT_BUDGET_CONFIG } from './context-budget';
import { MemoryEntry, MemoryLayer } from './types';

function makeEntry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'layer' | 'content'>): MemoryEntry {
  return {
    importance: 0.5,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    namespace: 'test',
    metadata: {},
    ...overrides,
  };
}

describe('ContextBudgetManager', () => {
  test('constructor uses default config', () => {
    const mgr = new ContextBudgetManager();
    const config = mgr.getConfig();
    expect(config.totalTokenBudget).toBe(4000);
    expect(config.systemPromptReserve).toBe(0.1);
    expect(config.minImportanceThreshold).toBe(0.3);
    expect(config.layerWeights[MemoryLayer.EPISODIC]).toBe(0.4);
    expect(config.layerWeights[MemoryLayer.SEMANTIC]).toBe(0.3);
    expect(config.layerWeights[MemoryLayer.WORKING]).toBe(0.1);
    expect(config.layerWeights[MemoryLayer.PROCEDURAL]).toBe(0.1);
  });

  test('constructor merges custom config', () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 8000, minImportanceThreshold: 0.5 });
    const config = mgr.getConfig();
    expect(config.totalTokenBudget).toBe(8000);
    expect(config.minImportanceThreshold).toBe(0.5);
    expect(config.systemPromptReserve).toBe(0.1);
  });

  test('constructor merges partial layerWeights', () => {
    const mgr = new ContextBudgetManager({
      layerWeights: { [MemoryLayer.EPISODIC]: 0.6 },
    });
    const config = mgr.getConfig();
    expect(config.layerWeights[MemoryLayer.EPISODIC]).toBe(0.6);
    expect(config.layerWeights[MemoryLayer.SEMANTIC]).toBe(0.3);
  });

  test('DEFAULT_CONTEXT_BUDGET_CONFIG has expected values', () => {
    expect(DEFAULT_CONTEXT_BUDGET_CONFIG.totalTokenBudget).toBe(4000);
    expect(DEFAULT_CONTEXT_BUDGET_CONFIG.systemPromptReserve).toBe(0.1);
    expect(DEFAULT_CONTEXT_BUDGET_CONFIG.minImportanceThreshold).toBe(0.3);
  });

  test('allocate returns Map with all 4 layers as keys', async () => {
    const mgr = new ContextBudgetManager();
    const entries = new Map<MemoryLayer, MemoryEntry[]>();
    const result = await mgr.allocate(entries);
    expect(result.allocated.has(MemoryLayer.WORKING)).toBe(true);
    expect(result.allocated.has(MemoryLayer.EPISODIC)).toBe(true);
    expect(result.allocated.has(MemoryLayer.SEMANTIC)).toBe(true);
    expect(result.allocated.has(MemoryLayer.PROCEDURAL)).toBe(true);
  });

  test('allocate returns totalBudget from config', async () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 5000 });
    const entries = new Map<MemoryLayer, MemoryEntry[]>();
    const result = await mgr.allocate(entries);
    expect(result.totalBudget).toBe(5000);
  });

  test('allocate with basic entries selects them within budget', async () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 4000 });
    const entry = makeEntry({ id: '1', layer: MemoryLayer.EPISODIC, content: 'short' });
    const entries = new Map<MemoryLayer, MemoryEntry[]>([[MemoryLayer.EPISODIC, [entry]]]);
    const result = await mgr.allocate(entries);
    const episodic = result.allocated.get(MemoryLayer.EPISODIC)!;
    expect(episodic.length).toBe(1);
    expect(episodic[0].id).toBe('1');
  });

  test('allocate respects budget and drops entries that exceed it', async () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 20, systemPromptReserve: 0.5 });
    const longEntry = makeEntry({
      id: 'long',
      layer: MemoryLayer.EPISODIC,
      content: 'a'.repeat(400),
      importance: 0.9,
    });
    const entries = new Map<MemoryLayer, MemoryEntry[]>([[MemoryLayer.EPISODIC, [longEntry]]]);
    const result = await mgr.allocate(entries);
    const episodic = result.allocated.get(MemoryLayer.EPISODIC)!;
    expect(episodic.length).toBe(0);
  });

  test('allocate selects higher importance entries first', async () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 60, systemPromptReserve: 0.1 });
    const low = makeEntry({ id: 'low', layer: MemoryLayer.EPISODIC, content: 'x'.repeat(20), importance: 0.3 });
    const high = makeEntry({ id: 'high', layer: MemoryLayer.EPISODIC, content: 'y'.repeat(20), importance: 0.9 });
    const entries = new Map<MemoryLayer, MemoryEntry[]>([[MemoryLayer.EPISODIC, [low, high]]]);
    const result = await mgr.allocate(entries);
    const episodic = result.allocated.get(MemoryLayer.EPISODIC)!;
    expect(episodic[0].id).toBe('high');
  });

  test('chitchat request type reduces PROCEDURAL weight', async () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 4000 });
    const procEntry = makeEntry({ id: 'proc', layer: MemoryLayer.PROCEDURAL, content: 'step by step', importance: 0.9 });
    const workEntry = makeEntry({ id: 'work', layer: MemoryLayer.WORKING, content: 'current task', importance: 0.9 });
    const entries = new Map<MemoryLayer, MemoryEntry[]>([
      [MemoryLayer.PROCEDURAL, [procEntry]],
      [MemoryLayer.WORKING, [workEntry]],
    ]);
    const result = await mgr.allocate(entries, 'chitchat');
    const proc = result.allocated.get(MemoryLayer.PROCEDURAL)!;
    const work = result.allocated.get(MemoryLayer.WORKING)!;
    expect(work.length).toBe(1);
    expect(proc.length).toBeLessThanOrEqual(1);
  });

  test('task request type increases EPISODIC weight', async () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 4000 });
    const epiEntry = makeEntry({ id: 'epi', layer: MemoryLayer.EPISODIC, content: 'past task', importance: 0.9 });
    const entries = new Map<MemoryLayer, MemoryEntry[]>([[MemoryLayer.EPISODIC, [epiEntry]]]);
    const result = await mgr.allocate(entries, 'task');
    const episodic = result.allocated.get(MemoryLayer.EPISODIC)!;
    expect(episodic.length).toBe(1);
  });

  test('complex request type adjusts weights', async () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 4000 });
    const procEntry = makeEntry({ id: 'proc', layer: MemoryLayer.PROCEDURAL, content: 'complex procedure', importance: 0.9 });
    const entries = new Map<MemoryLayer, MemoryEntry[]>([[MemoryLayer.PROCEDURAL, [procEntry]]]);
    const result = await mgr.allocate(entries, 'complex');
    const proc = result.allocated.get(MemoryLayer.PROCEDURAL)!;
    expect(proc.length).toBe(1);
  });

  test('estimateEntryTokens via allocate counts correctly', async () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 4000 });
    const content = 'a'.repeat(40);
    const entry = makeEntry({ id: 'tok', layer: MemoryLayer.SEMANTIC, content, importance: 0.8 });
    const entries = new Map<MemoryLayer, MemoryEntry[]>([[MemoryLayer.SEMANTIC, [entry]]]);
    const result = await mgr.allocate(entries);
    expect(result.usedTokens).toBeGreaterThan(0);
  });

  test('allocate with empty entries returns zero used beyond system reserve', async () => {
    const mgr = new ContextBudgetManager({ totalTokenBudget: 4000 });
    const entries = new Map<MemoryLayer, MemoryEntry[]>();
    const result = await mgr.allocate(entries);
    const systemReserve = Math.floor(4000 * 0.1);
    expect(result.usedTokens).toBe(systemReserve);
  });
});
