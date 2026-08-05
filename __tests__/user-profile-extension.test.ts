import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UserProfileService } from '../src/user-profile';

describe('UserProfile extension', () => {
  let tmpDir: string;
  let service: UserProfileService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-'));
    service = new UserProfileService(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  test('loadProfile fills missing fields with defaults', async () => {
    // 写老格式 JSON
    const oldJson = {
      'u-1': {
        userId: 'u-1',
        department: '财务部',
        commonSystems: ['OA'],
        tags: [],
        conversationCount: 5,
        lastActiveAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        // 缺 role / permissions / history / preferences
      },
    };
    await fs.writeFile(
      path.join(tmpDir, 'user-profile.json'),
      JSON.stringify(oldJson),
      'utf-8'
    );

    const profile = await service.loadProfile('u-1');
    expect(profile.role).toBe('employee');
    expect(profile.permissions).toEqual([]);
    expect(profile.history).toEqual([]);
    expect(profile.preferences).toEqual([]);
  });

  test('updateProfile preserves new fields', async () => {
    await service.updateProfile('u-1', {
      role: 'admin',
      permissions: ['oa:read', 'finance:read'],
      history: [{ topic: '报销', summary: '跨部门报销', lastOccurredAt: '2026-08-01', occurrences: 2 }],
      preferences: [{ key: 'response_style', value: 'concise', confidence: 0.8 }],
    });

    const profile = await service.loadProfile('u-1');
    expect(profile.role).toBe('admin');
    expect(profile.permissions).toEqual(['oa:read', 'finance:read']);
    expect(profile.history).toHaveLength(1);
    expect(profile.preferences).toHaveLength(1);
  });

  test('createUserProfile includes new fields', async () => {
    const profile = await service.createUserProfile('u-new');
    expect(profile.role).toBe('employee');
    expect(profile.permissions).toEqual([]);
    expect(profile.history).toEqual([]);
    expect(profile.preferences).toEqual([]);
  });
});
