/**
 * UserProfileService JSON 解析容错测试
 *
 * 覆盖:
 *  - 文件存在但为空 → 静默回退默认 profile,不打印 error
 *  - 文件存在但内容损坏 → 静默回退默认 profile
 *  - 文件存在且内容有效 → 正常解析
 *  - 文件不存在 → 走原有 'file not found' 路径,创建默认 profile
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UserProfileService } from '../src/user-profile';

describe('UserProfileService JSON 解析容错', () => {
  let dataDir: string;
  let service: UserProfileService;
  let logs: { level: string; msg: string }[];

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `up-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(dataDir, { recursive: true });
    logs = [];
    service = new UserProfileService(dataDir, {
      warn: (msg) => logs.push({ level: 'warn', msg }),
      error: (msg) => logs.push({ level: 'error', msg }),
    });
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test('文件存在但为空 → 静默回退默认 profile,不打印 error', async () => {
    // 写入空文件
    await fs.writeFile(path.join(dataDir, 'user-profile.json'), '', 'utf-8');

    const profile = await service.loadProfile('user-1');

    expect(profile.userId).toBe('user-1');
    expect(profile.department).toBe('财务部');

    // 不应有 error 日志
    const errors = logs.filter(l => l.level === 'error');
    expect(errors.length).toBe(0);
  });

  test('文件存在但内容损坏 → 静默回退默认 profile', async () => {
    await fs.writeFile(path.join(dataDir, 'user-profile.json'), '{ invalid json', 'utf-8');

    const profile = await service.loadProfile('user-1');

    expect(profile.userId).toBe('user-1');
    expect(profile.department).toBe('财务部');

    const errors = logs.filter(l => l.level === 'error');
    expect(errors.length).toBe(0);
  });

  test('文件存在且内容有效 → 正常解析', async () => {
    const data = {
      'user-1': {
        userId: 'user-1',
        department: '技术部',
        commonSystems: ['GEAM'],
        tags: [],
        conversationCount: 5,
        lastActiveAt: '2026-01-01T00:00:00Z',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    };
    await fs.writeFile(path.join(dataDir, 'user-profile.json'), JSON.stringify(data), 'utf-8');

    const profile = await service.loadProfile('user-1');

    expect(profile.userId).toBe('user-1');
    expect(profile.department).toBe('技术部');
    expect(profile.commonSystems).toEqual(['GEAM']);
    expect(profile.conversationCount).toBe(5);
  });

  test('文件不存在 → 走原有路径,创建默认 profile', async () => {
    const profile = await service.loadProfile('user-1');

    expect(profile.userId).toBe('user-1');
    expect(profile.department).toBe('财务部');

    // 应有 'file not found' warn 日志(走原逻辑)
    const warnings = logs.filter(l => l.level === 'warn' && l.msg.includes('not found'));
    expect(warnings.length).toBeGreaterThan(0);

    // 文件已创建
    const exists = await fs.access(path.join(dataDir, 'user-profile.json')).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  test('文件有效但 userId 不存在 → 走原有路径,创建新 profile', async () => {
    const data = {
      'other-user': {
        userId: 'other-user',
        department: '技术部',
        commonSystems: [],
        tags: [],
        conversationCount: 0,
        lastActiveAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    };
    await fs.writeFile(path.join(dataDir, 'user-profile.json'), JSON.stringify(data), 'utf-8');

    const profile = await service.loadProfile('new-user');

    expect(profile.userId).toBe('new-user');
    expect(profile.department).toBe('财务部');

    // 不应有 error 日志
    const errors = logs.filter(l => l.level === 'error');
    expect(errors.length).toBe(0);
  });
});