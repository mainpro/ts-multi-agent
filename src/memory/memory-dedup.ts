import type { MemoryEntry } from './types';

export const DEFAULT_DEDUP_THRESHOLD = 0.98;
export const DEFAULT_CONSOLIDATION_THRESHOLD = 0.85;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function similarity(a: MemoryEntry, b: MemoryEntry): number {
  if (a.embedding && b.embedding) {
    return cosineSimilarity(a.embedding, b.embedding);
  }
  return a.content === b.content ? 1 : 0;
}

export class MemoryDedupService {
  dedup(entries: MemoryEntry[], threshold = DEFAULT_DEDUP_THRESHOLD): MemoryEntry[] {
    const kept: MemoryEntry[] = [];
    const removed = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      if (removed.has(entries[i].id)) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (removed.has(entries[j].id)) continue;
        if (similarity(entries[i], entries[j]) > threshold) {
          const loser = entries[i].importance >= entries[j].importance ? entries[j] : entries[i];
          removed.add(loser.id);
        }
      }
      if (!removed.has(entries[i].id)) {
        kept.push(entries[i]);
      }
    }
    return kept;
  }

  consolidate(entries: MemoryEntry[], threshold = DEFAULT_CONSOLIDATION_THRESHOLD): MemoryEntry[] {
    const groups: MemoryEntry[][] = [];
    const assigned = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      if (assigned.has(entries[i].id)) continue;
      const group = [entries[i]];
      assigned.add(entries[i].id);
      for (let j = i + 1; j < entries.length; j++) {
        if (assigned.has(entries[j].id)) continue;
        if (similarity(entries[i], entries[j]) > threshold) {
          group.push(entries[j]);
          assigned.add(entries[j].id);
        }
      }
      groups.push(group);
    }

    return groups.map(group => {
      if (group.length === 1) return group[0];
      const content = group.map(e => e.content).join(' | ');
      const importance = Math.max(...group.map(e => e.importance));
      const updatedAt = group.reduce((latest, e) => (e.updatedAt > latest ? e.updatedAt : latest), group[0].updatedAt);
      const metadata = group.reduce((acc, e) => ({ ...acc, ...e.metadata }), {} as Record<string, unknown>);
      const base = group.reduce((best, e) => (e.importance >= best.importance ? e : best), group[0]);
      return { ...base, content, importance, updatedAt, metadata };
    });
  }

  shouldDedup(newEntry: MemoryEntry, existing: MemoryEntry[], threshold = DEFAULT_DEDUP_THRESHOLD): boolean {
    return existing.some(e => similarity(newEntry, e) > threshold);
  }
}
