import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DynamicContextBuilder } from './dynamic-context';
import { MemoryService } from '../memory/memory-service';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('DynamicContextBuilder', () => {
  let tempDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dynamic-context-test-'));
    memoryDir = path.join(tempDir, 'data');
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('build()', () => {
    test('should return user context section even for new users', async () => {
      const svc = new MemoryService(memoryDir, { storagePath: path.join(memoryDir, 'memory') });
      const builder = new DynamicContextBuilder(svc);
      const result = await builder.build('test input', 'new-user');

      expect(result).toContain('## 用户上下文');
      expect(result).toContain('用户画像');
      expect(result).toContain('new-user');
    });

    test('should include custom user profile when available', async () => {
      const userId = 'test-user';
      const svc = new MemoryService(memoryDir, { storagePath: path.join(memoryDir, 'memory') });

      const profile = {
        userId,
        department: 'Engineering',
        commonSystems: ['SystemA', 'SystemB'],
        tags: ['developer', 'admin'],
        conversationCount: 5,
        lastActiveAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(
        path.join(memoryDir, 'user-profile.json'),
        JSON.stringify({ [userId]: profile })
      );

      const builder = new DynamicContextBuilder(svc);
      const result = await builder.build('test input', userId);
      expect(result).toContain('## 用户上下文');
      expect(result).toContain('用户画像');
      expect(result).toContain(userId);
      expect(result).toContain('Engineering');
      expect(result).toContain('SystemA, SystemB');
    });

    test('should include conversation history from episodic layer', async () => {
      const userId = 'test-user';
      const svc = new MemoryService(memoryDir, { storagePath: path.join(memoryDir, 'memory') });

      const profile = {
        userId,
        department: 'Test',
        commonSystems: [],
        tags: [],
        conversationCount: 1,
        lastActiveAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(
        path.join(memoryDir, 'user-profile.json'),
        JSON.stringify({ [userId]: profile })
      );

      await svc.saveUserMessage(userId, 'Hello');
      await svc.saveAssistantMessage(userId, 'Hi there!');

      const builder = new DynamicContextBuilder(svc);
      const result = await builder.build('test', userId);
      expect(result).toContain('对话历史');
      expect(result).toContain('Hello');
      expect(result).toContain('Hi there!');
    });

    test('should assemble profile and conversation history together', async () => {
      const userId = 'test-user';
      const svc = new MemoryService(memoryDir, { storagePath: path.join(memoryDir, 'memory') });

      const profile = {
        userId,
        department: 'Test',
        commonSystems: [],
        tags: [],
        conversationCount: 1,
        lastActiveAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(
        path.join(memoryDir, 'user-profile.json'),
        JSON.stringify({ [userId]: profile })
      );

      await svc.saveUserMessage(userId, 'Hello');
      await svc.saveAssistantMessage(userId, 'Hi there!');

      const builder = new DynamicContextBuilder(svc);
      const result = await builder.build('test input', userId);

      expect(result).toContain('## 用户上下文');
      expect(result).toContain('用户画像');
      expect(result).toContain('对话历史');
    });
  });

  describe('Memory recall', () => {
    test('should return default profile for missing user', async () => {
      const svc = new MemoryService(memoryDir, { storagePath: path.join(memoryDir, 'memory') });
      const builder = new DynamicContextBuilder(svc);
      const result = await builder.build('test', 'nonexistent-user');
      expect(result).toContain('## 用户上下文');
      expect(result).toContain('nonexistent-user');
    });
  });

  describe('Error handling', () => {
    test('should handle memory load errors gracefully', async () => {
      const memoryDirBad = path.join(tempDir, 'bad-data');
      await fs.mkdir(memoryDirBad, { recursive: true });

      const userId = 'test-user';
      await fs.writeFile(
        path.join(memoryDirBad, 'user-profile.json'),
        'invalid json'
      );

      const svc = new MemoryService(memoryDirBad, { storagePath: path.join(memoryDirBad, 'memory') });
      const builder = new DynamicContextBuilder(svc);

      const result = await builder.build('test', userId);
      expect(typeof result).toBe('string');
    });
  });

  describe('Configuration', () => {
    test('should use custom memory data directory', async () => {
      const customMemoryDir = path.join(tempDir, 'custom-memory');
      await fs.mkdir(customMemoryDir, { recursive: true });

      const userId = 'test-user';
      const profile = {
        userId,
        department: 'Custom',
        commonSystems: [],
        tags: [],
        conversationCount: 1,
        lastActiveAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(
        path.join(customMemoryDir, 'user-profile.json'),
        JSON.stringify({ [userId]: profile })
      );

      const svc = new MemoryService(customMemoryDir, { storagePath: path.join(customMemoryDir, 'memory') });
      const builder = new DynamicContextBuilder(svc);

      const result = await builder.build('test', userId);
      expect(result).toContain('Custom');
    });
  });
});
