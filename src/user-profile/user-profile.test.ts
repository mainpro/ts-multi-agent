import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { UserProfileService } from './index';
import type { UserProfile } from '../types';

describe('UserProfileService', () => {
  let tempDir: string;
  let service: UserProfileService;
  let warnMessages: string[];
  let errorMessages: string[];

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `user-profile-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    warnMessages = [];
    errorMessages = [];
    const mockLogger = {
      warn: (msg: string) => { warnMessages.push(msg); },
      error: (msg: string) => { errorMessages.push(msg); },
    };

    service = new UserProfileService(tempDir, mockLogger);
  });

  afterEach(async () => {
    // Best effort cleanup - ignore errors
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors - temp dirs are cleaned by OS
    }
  });

  describe('loadProfile', () => {
    it('should return default profile when file does not exist', async () => {
      const profile = await service.loadProfile('test-user');
      
      expect(profile.userId).toBe('test-user');
      expect(profile.department).toBe('市场部');
      expect(profile.commonSystems).toEqual(['报销系统', '差旅系统']);
      expect(profile.tags).toEqual([]);
      expect(profile.conversationCount).toBe(0);
      expect(profile.createdAt).toBeDefined();
      expect(profile.updatedAt).toBeDefined();
      expect(profile.lastActiveAt).toBeDefined();
      
      expect(warnMessages.length).toBeGreaterThan(0);
      expect(warnMessages[0]).toContain('Profile file not found');
    });

    it('should return stored profile when file exists', async () => {
      const existingProfile: UserProfile = {
        userId: 'existing-user',
        department: '财务部',
        commonSystems: ['GEAM', '预算系统'],
        tags: ['vip', 'admin'],
        conversationCount: 10,
        lastActiveAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      
      const profiles: Record<string, UserProfile> = {
        'existing-user': existingProfile,
      };
      
      await fs.writeFile(
        path.join(tempDir, 'user-profile.json'),
        JSON.stringify(profiles, null, 2),
        'utf-8'
      );
      
      const profile = await service.loadProfile('existing-user');
      
      expect(profile.userId).toBe('existing-user');
      expect(profile.department).toBe('财务部');
      expect(profile.commonSystems).toEqual(['GEAM', '预算系统']);
      expect(profile.tags).toEqual(['vip', 'admin']);
      expect(profile.conversationCount).toBe(10);
    });

    it('should return default profile when userId not found in file', async () => {
      const profiles: Record<string, UserProfile> = {
        'other-user': {
          userId: 'other-user',
          department: '技术部',
          commonSystems: [],
          tags: [],
          conversationCount: 5,
          lastActiveAt: '2024-01-01T00:00:00.000Z',
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      
      await fs.writeFile(
        path.join(tempDir, 'user-profile.json'),
        JSON.stringify(profiles, null, 2),
        'utf-8'
      );
      
      const profile = await service.loadProfile('unknown-user');
      
      expect(profile.userId).toBe('unknown-user');
      expect(profile.department).toBe('市场部');
      expect(warnMessages.some(m => m.includes('Profile not found for userId'))).toBe(true);
    });
  });

  describe('saveProfile', () => {
    it('should create file if it does not exist', async () => {
      const profile: UserProfile = {
        userId: 'new-user',
        department: '人事部',
        commonSystems: ['差旅系统'],
        tags: ['new'],
        conversationCount: 0,
        lastActiveAt: '2024-06-01T00:00:00.000Z',
        createdAt: '2024-06-01T00:00:00.000Z',
        updatedAt: '2024-06-01T00:00:00.000Z',
      };
      
      await service.saveProfile(profile);
      
      const filePath = path.join(tempDir, 'user-profile.json');
      const fileStat = await fs.stat(filePath);
      expect(fileStat.isFile()).toBe(true);
      
      const content = await fs.readFile(filePath, 'utf-8');
      const profiles = JSON.parse(content) as Record<string, UserProfile>;
      expect(profiles['new-user']).toBeDefined();
      expect(profiles['new-user'].department).toBe('人事部');
    });

    it('should update existing file', async () => {
      const initialProfiles: Record<string, UserProfile> = {
        'user-1': {
          userId: 'user-1',
          department: '技术部',
          commonSystems: [],
          tags: [],
          conversationCount: 1,
          lastActiveAt: '2024-01-01T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      
      await fs.writeFile(
        path.join(tempDir, 'user-profile.json'),
        JSON.stringify(initialProfiles, null, 2),
        'utf-8'
      );
      
      const newProfile: UserProfile = {
        userId: 'user-2',
        department: '市场部',
        commonSystems: ['报销系统'],
        tags: [],
        conversationCount: 0,
        lastActiveAt: '2024-06-01T00:00:00.000Z',
        createdAt: '2024-06-01T00:00:00.000Z',
        updatedAt: '2024-06-01T00:00:00.000Z',
      };
      
      await service.saveProfile(newProfile);
      
      const content = await fs.readFile(path.join(tempDir, 'user-profile.json'), 'utf-8');
      const profiles = JSON.parse(content) as Record<string, UserProfile>;
      
      expect(Object.keys(profiles).length).toBe(2);
      expect(profiles['user-1']).toBeDefined();
      expect(profiles['user-2']).toBeDefined();
    });

    it('should pretty print JSON with indent 2', async () => {
      const profile: UserProfile = {
        userId: 'test-user',
        department: '技术部',
        commonSystems: ['GEAM', '报销系统'],
        tags: ['test'],
        conversationCount: 0,
        lastActiveAt: '2024-06-01T00:00:00.000Z',
        createdAt: '2024-06-01T00:00:00.000Z',
        updatedAt: '2024-06-01T00:00:00.000Z',
      };
      
      await service.saveProfile(profile);
      
      const content = await fs.readFile(path.join(tempDir, 'user-profile.json'), 'utf-8');
      
      expect(content).toContain('  "test-user"');
      expect(content).toContain('    "userId"');
      expect(content).toContain('    "commonSystems"');
    });
  });

  describe('updateProfile', () => {
    it('should merge updates correctly', async () => {
      const initialProfile: UserProfile = {
        userId: 'test-user',
        department: '技术部',
        commonSystems: ['GEAM'],
        tags: [],
        conversationCount: 5,
        lastActiveAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      
      await service.saveProfile(initialProfile);
      
      const updated = await service.updateProfile('test-user', {
        department: '财务部',
        tags: ['vip'],
      });
      
      expect(updated.userId).toBe('test-user');
      expect(updated.department).toBe('财务部');
      expect(updated.commonSystems).toEqual(['GEAM']);
      expect(updated.tags).toEqual(['vip']);
      expect(updated.conversationCount).toBe(5);
    });

    it('should update updatedAt timestamp', async () => {
      const initialProfile: UserProfile = {
        userId: 'test-user',
        department: '技术部',
        commonSystems: [],
        tags: [],
        conversationCount: 0,
        lastActiveAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      
      await service.saveProfile(initialProfile);
      
      const beforeUpdate = new Date();
      const updated = await service.updateProfile('test-user', { department: '财务部' });
      const afterUpdate = new Date();
      
      const updatedAt = new Date(updated.updatedAt);
      expect(updatedAt.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime() - 1000);
      expect(updatedAt.getTime()).toBeLessThanOrEqual(afterUpdate.getTime() + 1000);
    });

    it('should increment conversationCount', async () => {
      const initialProfile: UserProfile = {
        userId: 'test-user',
        department: '技术部',
        commonSystems: [],
        tags: [],
        conversationCount: 5,
        lastActiveAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      
      await service.saveProfile(initialProfile);
      
      const updated = await service.updateProfile('test-user', {
        conversationCount: 6,
      });
      
      expect(updated.conversationCount).toBe(6);
    });

    it('should update lastActiveAt when not explicitly provided', async () => {
      const initialProfile: UserProfile = {
        userId: 'test-user',
        department: '技术部',
        commonSystems: [],
        tags: [],
        conversationCount: 0,
        lastActiveAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      
      await service.saveProfile(initialProfile);
      
      const beforeUpdate = new Date();
      const updated = await service.updateProfile('test-user', { department: '财务部' });
      
      const lastActiveAt = new Date(updated.lastActiveAt);
      expect(lastActiveAt.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime() - 1000);
    });

    it('should preserve userId and not allow changing it', async () => {
      const initialProfile: UserProfile = {
        userId: 'original-user',
        department: '技术部',
        commonSystems: [],
        tags: [],
        conversationCount: 0,
        lastActiveAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      
      await service.saveProfile(initialProfile);
      
      const updated = await service.updateProfile('original-user', {
        userId: 'different-user',
        department: '财务部',
      } as Partial<UserProfile>);
      
      expect(updated.userId).toBe('original-user');
    });
  });

  describe('inferSystemFromText', () => {
    it('should return null for text without system names', () => {
      expect(service.inferSystemFromText('今天天气不错')).toBeNull();
      expect(service.inferSystemFromText('请帮我查一下数据')).toBeNull();
      expect(service.inferSystemFromText('')).toBeNull();
    });

    it('should return correct system name for GEAM', () => {
      expect(service.inferSystemFromText('请帮我登录GEAM系统')).toBe('GEAM');
      expect(service.inferSystemFromText('GEAM')).toBe('GEAM');
      expect(service.inferSystemFromText('geam')).toBe('geam');
    });

    it('should return correct system name for 报销系统', () => {
      expect(service.inferSystemFromText('我要使用报销系统')).toBe('报销系统');
      expect(service.inferSystemFromText('报销系统怎么用')).toBe('报销系统');
    });

    it('should return correct system name for 差旅系统', () => {
      expect(service.inferSystemFromText('差旅系统预订机票')).toBe('差旅系统');
    });

    it('should return correct system name for 预算系统', () => {
      expect(service.inferSystemFromText('查看预算系统数据')).toBe('预算系统');
    });

    it('should return correct system name for 凭证影像', () => {
      expect(service.inferSystemFromText('凭证影像上传')).toBe('凭证影像');
    });

    it('should return first match when multiple systems mentioned', () => {
      const result = service.inferSystemFromText('报销系统和差旅系统都需要使用');
      expect(result).not.toBeNull();
      expect(['报销系统', '差旅系统', 'GEAM', '预算系统', '凭证影像']).toContain(result);
    });
  });

  describe('getKnownSystems', () => {
    it('should return list of known system names', () => {
      const systems = service.getKnownSystems();
      
      expect(systems).toContain('GEAM');
      expect(systems).toContain('报销系统');
      expect(systems).toContain('差旅系统');
      expect(systems).toContain('预算系统');
      expect(systems).toContain('凭证影像');
      expect(systems.length).toBe(5);
    });

    it('should return a copy (not modify original)', () => {
      const systems = service.getKnownSystems();
      systems.push('新系统');
      
      const systemsAgain = service.getKnownSystems();
      expect(systemsAgain).not.toContain('新系统');
    });
  });
});
