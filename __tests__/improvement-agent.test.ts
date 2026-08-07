import { describe, test, expect, beforeEach } from 'bun:test';
import { ImprovementAgent } from '../src/agents/improvement-agent';
import { ImprovementStore } from '../src/improvements';
import type { ImprovementEntry } from '../src/improvements';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockLlm = (response: string): any => ({
  generateText: async () => response,
});

const makeEntry = (overrides: Partial<ImprovementEntry> = {}): ImprovementEntry => ({
  id: 'imp-1',
  type: 'improvement',
  category: 'logic',
  skill: 'general',
  priority: 'P1',
  status: 'pending',
  created_at: '2026-08-07T00:00:00Z',
  description: 'Improve error handling',
  rootCause: 'Missing catch block',
  suggestion: 'Wrap async call in try/catch',
  involvedFiles: ['src/foo.ts'],
  ...overrides,
});

describe('ImprovementAgent', () => {
  let tmpDir: string;
  let store: ImprovementStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'imp-agent-'));
    store = new ImprovementStore(tmpDir);
  });

  test('constructor uses provided store and defaults otherwise', () => {
    const agent = new ImprovementAgent(mockLlm('{}') as any, store);
    expect(agent).toBeInstanceOf(ImprovementAgent);
    const defaultAgent = new ImprovementAgent(mockLlm('{}') as any);
    expect(defaultAgent).toBeInstanceOf(ImprovementAgent);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('getNextPending returns null when store is empty', async () => {
    const agent = new ImprovementAgent(mockLlm('{}') as any, store);
    const next = await agent.getNextPending();
    expect(next).toBeNull();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('processNextPending returns empty result when no pending entries', async () => {
    const agent = new ImprovementAgent(mockLlm('{}') as any, store);
    const result = await agent.processNextPending();
    expect(result.entry).toBeNull();
    expect(result.plan).toBeNull();
    expect(result.rejected).toBeUndefined();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('processNextPending generates plan from LLM JSON response', async () => {
    await store.create(makeEntry({ id: 'imp-A' }));
    const llmJson = JSON.stringify({
      entryId: 'imp-A',
      analysis: 'Missing try/catch',
      changes: [{ file: 'src/foo.ts', type: 'edit', target: 'fn()', content: 'try { fn() } catch {}' }],
      risk: 'low',
      testStrategy: 'Run unit tests',
    });
    const agent = new ImprovementAgent(mockLlm(llmJson) as any, store);
    const result = await agent.processNextPending();
    expect(result.entry?.id).toBe('imp-A');
    expect(result.plan?.analysis).toBe('Missing try/catch');
    expect(result.plan?.changes.length).toBe(1);
    expect(result.plan?.risk).toBe('low');
    expect(result.approvalQuestion).toContain('是否应用此修改');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('processNextPending parses LLM response wrapped in code fence', async () => {
    await store.create(makeEntry({ id: 'imp-B' }));
    const fenced = '```json\n' + JSON.stringify({
      entryId: 'imp-B',
      analysis: 'analysis text',
      changes: [{ file: 'a.ts', type: 'append', target: 'end', content: 'x' }],
      risk: 'medium',
      testStrategy: 'manual',
    }) + '\n```';
    const agent = new ImprovementAgent(mockLlm(fenced) as any, store);
    const result = await agent.processNextPending();
    expect(result.plan).not.toBeNull();
    expect(result.plan?.risk).toBe('medium');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('processNextPending rejects when LLM returns empty changes', async () => {
    await store.create(makeEntry({ id: 'imp-C' }));
    const llmJson = JSON.stringify({
      entryId: 'imp-C',
      analysis: 'Not actionable',
      changes: [],
      risk: 'low',
      testStrategy: 'none',
    });
    const agent = new ImprovementAgent(mockLlm(llmJson) as any, store);
    const result = await agent.processNextPending();
    expect(result.entry?.id).toBe('imp-C');
    expect(result.plan).toBeNull();
    expect(result.rejected).toBe(true);
    expect(result.reason).toBe('Not actionable');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('processNextPending rejects when LLM returns garbage', async () => {
    await store.create(makeEntry({ id: 'imp-D' }));
    const agent = new ImprovementAgent(mockLlm('not json at all') as any, store);
    const result = await agent.processNextPending();
    expect(result.entry?.id).toBe('imp-D');
    expect(result.plan).toBeNull();
    expect(result.rejected).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('executePlan "yes" reports success and message count', async () => {
    const entry = makeEntry({ id: 'imp-E' });
    const plan = {
      entryId: 'imp-E',
      analysis: 'a',
      changes: [
        { file: '/nonexistent-path-xyz/file1.ts', type: 'edit' as const, target: 'x', content: 'y' },
        { file: '/nonexistent-path-xyz/file2.ts', type: 'edit' as const, target: 'x', content: 'y' },
      ],
      risk: 'low' as const,
      testStrategy: 'tests',
    };
    const agent = new ImprovementAgent(mockLlm('{}') as any, store);
    const result = await agent.executePlan(entry, plan, 'yes');
    expect(result.success).toBe(true);
    expect(result.message).toContain('imp-E');
    expect(result.message).toContain('2');
  });

  test('executePlan "no" includes optional reason in message', async () => {
    const entry = makeEntry({ id: 'imp-F' });
    const plan = { entryId: 'imp-F', analysis: 'a', changes: [], risk: 'low' as const, testStrategy: '' };
    const agent = new ImprovementAgent(mockLlm('{}') as any, store);
    const r1 = await agent.executePlan(entry, plan, 'no', 'too risky');
    expect(r1.message).toContain('已拒绝');
    expect(r1.message).toContain('too risky');
    const r2 = await agent.executePlan(entry, plan, 'no');
    expect(r2.message).toContain('已拒绝');
  });

  test('executePlan "skip" keeps entry pending', async () => {
    const entry = makeEntry({ id: 'imp-G' });
    const plan = { entryId: 'imp-G', analysis: 'a', changes: [], risk: 'low' as const, testStrategy: '' };
    const agent = new ImprovementAgent(mockLlm('{}') as any, store);
    const result = await agent.executePlan(entry, plan, 'skip');
    expect(result.success).toBe(true);
    expect(result.message).toContain('跳过');
  });

  test('updateEntryStatus delegates to store', async () => {
    await store.create(makeEntry({ id: 'imp-H' }));
    const agent = new ImprovementAgent(mockLlm('{}') as any, store);
    const ok = await agent.updateEntryStatus('imp-H', 'completed');
    expect(ok).toBe(true);
    const updated = store.getById('imp-H');
    expect(updated?.status).toBe('completed');
    const missing = await agent.updateEntryStatus('nope', 'rejected');
    expect(missing).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('execute returns idle message when no pending entries', async () => {
    const agent = new ImprovementAgent(mockLlm('{}') as any, store);
    const result = await agent.execute({} as any);
    expect(result.success).toBe(true);
    expect(result.message).toContain('没有待处理');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('execute surfaces approval question when a plan exists', async () => {
    await store.create(makeEntry({ id: 'imp-I' }));
    const llmJson = JSON.stringify({
      entryId: 'imp-I',
      analysis: 'fix it',
      changes: [{ file: 'x.ts', type: 'edit', target: 'a', content: 'b' }],
      risk: 'low',
      testStrategy: 't',
    });
    const agent = new ImprovementAgent(mockLlm(llmJson) as any, store);
    const result = await agent.execute({} as any);
    expect(result.success).toBe(true);
    expect(result.message).toContain('是否应用');
    rmSync(tmpDir, { recursive: true, force: true });
  });
});