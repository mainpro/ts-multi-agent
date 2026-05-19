import { describe, test, expect, afterAll } from 'bun:test';
import { MemoryService } from './memory-service';
import { MemoryLayer } from './types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmpBase = mkdtempSync(join(tmpdir(), 'incr-write-'));

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

function uniqueDir(): string {
  return join(tmpBase, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('Incremental Memory Writes', () => {
  test('saveUserMessage writes to episodic layer', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'user-episodic-test';

    await svc.saveUserMessage(userId, 'Hello, I need help');

    const episodic = await svc.getStore().getEntries(userId, MemoryLayer.EPISODIC);
    expect(episodic.length).toBe(1);
    expect(episodic[0].content).toBe('Hello, I need help');
    expect(episodic[0].layer).toBe('episodic');
    expect(episodic[0].metadata.role).toBe('user');
  });

  test('saveAssistantMessage writes to episodic layer', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'user-assistant-episodic';

    await svc.saveAssistantMessage(userId, 'Sure, I can help with that', { skill: 'test-skill' });

    const episodic = await svc.getStore().getEntries(userId, MemoryLayer.EPISODIC);
    expect(episodic.length).toBe(1);
    expect(episodic[0].content).toBe('Sure, I can help with that');
    expect(episodic[0].metadata.role).toBe('assistant');
    expect(episodic[0].metadata.skill).toBe('test-skill');
  });

  test('waiting state scenario — memory written incrementally before request completes', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'user-waiting-state';

    await svc.saveUserMessage(userId, 'I want to apply for permission');
    await svc.saveAssistantMessage(userId, 'Are you a finance staff?', { skill: 'geam-qa' });

    // No saveInteraction called — simulates waiting_user_input state
    const episodic = await svc.getStore().getEntries(userId, MemoryLayer.EPISODIC);
    expect(episodic.length).toBe(2);
  });

  test('incremental writes are sufficient without saveInteraction', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'user-incremental-only';

    await svc.saveUserMessage(userId, 'What is EES?');
    await svc.saveAssistantMessage(userId, 'EES is the Employee Experience Survey', { skill: 'ees-qa' });

    // No saveInteraction needed — incremental writes cover the full interaction
    const episodic = await svc.getStore().getEntries(userId, MemoryLayer.EPISODIC);
    expect(episodic.length).toBe(2);
    expect(episodic.find(e => e.metadata.role === 'user')).toBeDefined();
    expect(episodic.find(e => e.metadata.role === 'assistant')).toBeDefined();
  });
});
