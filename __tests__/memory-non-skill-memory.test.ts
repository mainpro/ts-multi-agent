import { describe, test, expect, afterAll } from 'bun:test';
import { MemoryService } from './memory-service';
import { MemoryLayer } from './types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmpBase = mkdtempSync(join(tmpdir(), 'non-skill-mem-'));

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

function uniqueDir(): string {
  return join(tmpBase, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('Non-Skill Intent Memory Writes', () => {
  test('small_talk — greeting response saved to memory', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'user-small-talk';

    await svc.saveUserMessage(userId, '你好');
    await svc.saveAssistantMessage(userId, '您好！有什么可以帮助您的吗？');

    const episodic = await svc.getStore().getEntries(userId, MemoryLayer.EPISODIC);
    expect(episodic.length).toBe(2);
    expect(episodic[0].content).toBe('你好');
    expect(episodic[0].metadata.role).toBe('user');
    expect(episodic[1].content).toBe('您好！有什么可以帮助您的吗？');
    expect(episodic[1].metadata.role).toBe('assistant');
  });

  test('confirm_system — clarification question saved to memory', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'user-confirm-system';

    await svc.saveUserMessage(userId, '我要查GEAM');
    await svc.saveAssistantMessage(userId, '请问您说的是GEAM影像系统还是其他？');

    const episodic = await svc.getStore().getEntries(userId, MemoryLayer.EPISODIC);
    expect(episodic.length).toBe(2);
    expect(episodic[1].metadata.role).toBe('assistant');
    // confirm_system path doesn't set skill
    expect(episodic[1].metadata.skill).toBeUndefined();
  });

  test('unclear intent — fallback response saved to memory', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'user-unclear';

    await svc.saveUserMessage(userId, '随便聊聊');
    await svc.saveAssistantMessage(userId, '抱歉，这个问题暂时超出了我的处理范围');

    const episodic = await svc.getStore().getEntries(userId, MemoryLayer.EPISODIC);
    expect(episodic.length).toBe(2);
  });

  test('mixed session — skill task + non-skill in same session', async () => {
    const dir = uniqueDir();
    const svc = new MemoryService(dir, { storagePath: dir });
    const userId = 'user-mixed-session';

    // Skill task
    await svc.saveUserMessage(userId, '帮我查EES');
    await svc.saveAssistantMessage(userId, '正在为您查询EES...', { skill: 'ees-qa' });
    // Non-skill follow-up
    await svc.saveUserMessage(userId, '谢谢');
    await svc.saveAssistantMessage(userId, '不客气！');

    const episodic = await svc.getStore().getEntries(userId, MemoryLayer.EPISODIC);
    expect(episodic.length).toBe(4);
    // Entry index 1 (0-based) = first assistant message, has skill
    expect(episodic[1].metadata.skill).toBe('ees-qa');
    // Entry index 3 = second assistant message, no skill
    expect(episodic[3].metadata.skill).toBeUndefined();
  });
});
