import { describe, test, expect, afterAll } from 'bun:test';
import { EpisodicStore } from './episodic-store';
import { UserMemoryStore } from './user-memory-store';
import { MemoryLayer, DEFAULT_TTL } from './types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmpBase = mkdtempSync(join(tmpdir(), 'episodic-store-'));

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

function uniqueDir(): string {
  return join(tmpBase, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('EpisodicStore', () => {
  test('saveUserMessage creates MemoryEntry with correct fields', async () => {
    const dir = uniqueDir();
    const store = new UserMemoryStore(dir);
    const episodic = new EpisodicStore(store);

    await episodic.saveUserMessage('user1', 'Hello, I need help');

    const entries = await store.getEntries('user1', MemoryLayer.EPISODIC);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('Hello, I need help');
    expect(entries[0].layer).toBe('episodic');
    expect(entries[0].metadata.role).toBe('user');
    expect(entries[0].namespace).toBe('user1');
  });

  test('saveAssistantMessage creates MemoryEntry with correct fields', async () => {
    const dir = uniqueDir();
    const store = new UserMemoryStore(dir);
    const episodic = new EpisodicStore(store);

    await episodic.saveAssistantMessage('user1', 'Sure, I can help', { skill: 'ees-qa', system: 'EES' });

    const entries = await store.getEntries('user1', MemoryLayer.EPISODIC);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('Sure, I can help');
    expect(entries[0].metadata.role).toBe('assistant');
    expect(entries[0].metadata.skill).toBe('ees-qa');
    expect(entries[0].metadata.system).toBe('EES');
  });

  test('episodic entries have TTL set to 30 days', async () => {
    const dir = uniqueDir();
    const store = new UserMemoryStore(dir);
    const episodic = new EpisodicStore(store);

    await episodic.saveUserMessage('user1', 'Hello');

    const entries = await store.getEntries('user1', MemoryLayer.EPISODIC);
    expect(entries[0].ttl).toBe(DEFAULT_TTL[MemoryLayer.EPISODIC]); // 2592000000 = 30 days
  });

  test('loadEpisodicEntries returns sorted entries with optional limit', async () => {
    const dir = uniqueDir();
    const store = new UserMemoryStore(dir);
    const episodic = new EpisodicStore(store);

    // Save 5 messages
    for (let i = 0; i < 5; i++) {
      await episodic.saveUserMessage('user1', `Message ${i}`);
    }

    // Without limit
    const all = await episodic.loadEpisodicEntries('user1');
    expect(all.length).toBe(5);
    // Verify sorted by createdAt (oldest first)
    expect(all[0].content).toBe('Message 0');
    expect(all[4].content).toBe('Message 4');

    // With limit
    const limited = await episodic.loadEpisodicEntries('user1', { maxEntries: 3 });
    expect(limited.length).toBe(3);
    // Should be the 3 most recent
    expect(limited[0].content).toBe('Message 2');
    expect(limited[2].content).toBe('Message 4');
  });

  test('buildContextPrompt limits entries and formats correctly', async () => {
    const dir = uniqueDir();
    const store = new UserMemoryStore(dir);
    const episodic = new EpisodicStore(store);

    // Save 10 messages
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        await episodic.saveUserMessage('user1', `User ${i}`);
      } else {
        await episodic.saveAssistantMessage('user1', `Assistant ${i}`);
      }
    }

    const entries = await episodic.loadEpisodicEntries('user1');

    // Without limit
    const prompt1 = episodic.buildContextPrompt(entries);
    expect(prompt1).toContain('[对话历史]');
    expect(prompt1).toContain('用户: User 0');
    expect(prompt1).toContain('助手: Assistant 1');

    // With maxEntries = 4
    const limited = await episodic.loadEpisodicEntries('user1', { maxEntries: 4 });
    const prompt2 = episodic.buildContextPrompt(limited);
    expect(prompt2).toContain('User 6');  // Should contain recent messages
    expect(prompt2).not.toContain('User 0');  // Should not contain old messages
  });

  test('buildContextPrompt handles empty entries', () => {
    const dir = uniqueDir();
    const store = new UserMemoryStore(dir);
    const episodic = new EpisodicStore(store);

    const prompt = episodic.buildContextPrompt([]);
    expect(prompt).toBe('');
  });

  test('buildContextPrompt handles unknown roles explicitly', async () => {
    const dir = uniqueDir();
    const store = new UserMemoryStore(dir);
    const episodic = new EpisodicStore(store);

    // Manually create an entry with an unknown role
    await store.appendEntry('user1', MemoryLayer.EPISODIC, {
      id: 'test-id',
      layer: MemoryLayer.EPISODIC,
      content: 'System message',
      metadata: { role: 'system' },
      importance: 0.5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      namespace: 'user1',
      ttl: DEFAULT_TTL[MemoryLayer.EPISODIC],
    });

    const entries = await episodic.loadEpisodicEntries('user1');
    const prompt = episodic.buildContextPrompt(entries);
    // Unknown role should be shown as-is, not silently labeled as '助手'
    expect(prompt).toContain('system:');
    expect(prompt).not.toContain('助手: System message');
  });

  test('clearEpisodicEntries removes all episodic entries', async () => {
    const dir = uniqueDir();
    const store = new UserMemoryStore(dir);
    const episodic = new EpisodicStore(store);

    await episodic.saveUserMessage('user1', 'Hello');
    await episodic.saveAssistantMessage('user1', 'Hi');

    await episodic.clearEpisodicEntries('user1');

    const entries = await store.getEntries('user1', MemoryLayer.EPISODIC);
    expect(entries.length).toBe(0);
  });

  test('entry IDs are collision-resistant', async () => {
    const dir = uniqueDir();
    const store = new UserMemoryStore(dir);
    const episodic = new EpisodicStore(store);

    // Save 100 messages rapidly
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      await episodic.saveUserMessage('user1', `Message ${i}`);
    }

    const entries = await store.getEntries('user1', MemoryLayer.EPISODIC);
    for (const entry of entries) {
      ids.add(entry.id);
    }
    // All IDs should be unique
    expect(ids.size).toBe(100);
  });
});
