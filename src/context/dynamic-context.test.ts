import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DynamicContextBuilder } from './dynamic-context';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('DynamicContextBuilder', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dynamic-context-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('build()', () => {
    test('should return user memory section even for new users', async () => {
      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test input', 'new-user');
      
      expect(result).toContain('## 用户记忆');
      expect(result).toContain('用户画像');
      expect(result).toContain('new-user');
    });

    test('should include CLAUDE.md content when available', async () => {
      const claudeMdContent = '# Test Project\n\nThis is a test configuration.';
      await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), claudeMdContent);

      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test input', 'user');
      
      expect(result).toContain('## 项目配置 (CLAUDE.md)');
      expect(result).toContain(claudeMdContent);
    });

    test('should include Git status when in a Git repository', async () => {
      const builder = new DynamicContextBuilder();
      const result = await builder.build('test input', 'user');
      
      if (result.includes('## Git 状态')) {
        expect(result).toContain('当前分支');
        expect(result).toContain('最近提交');
      }
    });

    test('should handle non-Git directory gracefully', async () => {
      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test input', 'user');
      
      expect(result).not.toContain('## Git 状态');
    });

    test('should include custom user profile when available', async () => {
      const memoryDir = path.join(tempDir, 'data');
      await fs.mkdir(memoryDir, { recursive: true });
      
      const userId = 'test-user';
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

      const builder = new DynamicContextBuilder({ 
        projectRoot: tempDir,
        memoryDataDir: memoryDir 
      });
      
      const result = await builder.build('test input', userId);
      expect(result).toContain('## 用户记忆');
      expect(result).toContain('用户画像');
      expect(result).toContain(userId);
      expect(result).toContain('Engineering');
      expect(result).toContain('SystemA, SystemB');
    });

    test('should assemble all three sources together', async () => {
      const claudeMdContent = '# Test Project';
      await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), claudeMdContent);

      const memoryDir = path.join(tempDir, 'data');
      await fs.mkdir(memoryDir, { recursive: true });
      
      const userId = 'test-user';
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

      const builder = new DynamicContextBuilder({ 
        projectRoot: tempDir,
        memoryDataDir: memoryDir 
      });
      
      const result = await builder.build('test input', userId);
      
      expect(result).toContain('## 项目配置 (CLAUDE.md)');
      expect(result).toContain('## 用户记忆');
    });
  });

  describe('CLAUDE.md integration', () => {
    test('should load CLAUDE.md from project root', async () => {
      const content = '# Project Config\n\nProject-specific settings.';
      await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), content);

      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test', 'user');
      expect(result).toContain(content);
    });

    test('should load CLAUDE.md from .claude directory', async () => {
      const claudeDir = path.join(tempDir, '.claude');
      await fs.mkdir(claudeDir, { recursive: true });
      
      const content = '# Claude Config\n\nClaude-specific settings.';
      await fs.writeFile(path.join(claudeDir, 'CLAUDE.md'), content);

      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test', 'user');
      expect(result).toContain(content);
    });

    test('should load CLAUDE.local.md', async () => {
      const content = '# Local Config\n\nLocal override settings.';
      await fs.writeFile(path.join(tempDir, 'CLAUDE.local.md'), content);

      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test', 'user');
      expect(result).toContain(content);
    });

    test('should merge multiple CLAUDE.md files', async () => {
      await fs.writeFile(path.join(tempDir, 'CLAUDE.md'), '# Project');
      
      const claudeDir = path.join(tempDir, '.claude');
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.writeFile(path.join(claudeDir, 'CLAUDE.md'), '# Claude');
      
      await fs.writeFile(path.join(tempDir, 'CLAUDE.local.md'), '# Local');

      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test', 'user');
      expect(result).toContain('# Project');
      expect(result).toContain('# Claude');
      expect(result).toContain('# Local');
    });
  });

  describe('Git status retrieval', () => {
    test('should handle Git command timeout', async () => {
      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test', 'user');
      expect(typeof result).toBe('string');
    });

    test('should not throw on non-Git directory', async () => {
      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test', 'user');
      expect(typeof result).toBe('string');
    });
  });

  describe('Memory recall', () => {
    test('should return default profile for missing user', async () => {
      const builder = new DynamicContextBuilder({ projectRoot: tempDir });
      const result = await builder.build('test', 'nonexistent-user');
      expect(result).toContain('## 用户记忆');
      expect(result).toContain('nonexistent-user');
    });

    test('should include conversation history when available', async () => {
      const memoryDir = path.join(tempDir, 'data');
      await fs.mkdir(memoryDir, { recursive: true });
      
      const userId = 'test-user';
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

      const historyDir = path.join(memoryDir, 'memory', userId);
      await fs.mkdir(historyDir, { recursive: true });
      
      const history = [
        {
          role: 'user',
          content: 'Hello',
          timestamp: new Date().toISOString(),
        },
        {
          role: 'assistant',
          content: 'Hi there!',
          timestamp: new Date().toISOString(),
        },
      ];
      
      await fs.writeFile(
        path.join(historyDir, 'conversations.json'),
        JSON.stringify(history)
      );

      const builder = new DynamicContextBuilder({ 
        projectRoot: tempDir,
        memoryDataDir: memoryDir 
      });
      
      const result = await builder.build('test', userId);
      expect(result).toContain('对话历史');
      expect(result).toContain('Hello');
      expect(result).toContain('Hi there!');
    });
  });

  describe('Error handling', () => {
    test('should handle CLAUDE.md read errors gracefully', async () => {
      const claudePath = path.join(tempDir, 'CLAUDE.md');
      await fs.writeFile(claudePath, 'test');
      await fs.chmod(claudePath, 0o000);

      try {
        const builder = new DynamicContextBuilder({ projectRoot: tempDir });
        const result = await builder.build('test', 'user');
        expect(typeof result).toBe('string');
      } finally {
        await fs.chmod(claudePath, 0o644);
      }
    });

    test('should handle memory load errors gracefully', async () => {
      const memoryDir = path.join(tempDir, 'data');
      await fs.mkdir(memoryDir, { recursive: true });
      
      const userId = 'test-user';
      await fs.writeFile(
        path.join(memoryDir, 'user-profile.json'),
        'invalid json'
      );

      const builder = new DynamicContextBuilder({ 
        projectRoot: tempDir,
        memoryDataDir: memoryDir 
      });
      
      const result = await builder.build('test', userId);
      expect(typeof result).toBe('string');
    });
  });

  describe('Configuration', () => {
    test('should use custom project root', async () => {
      const customDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-'));
      
      try {
        const content = '# Custom Project';
        await fs.writeFile(path.join(customDir, 'CLAUDE.md'), content);

        const builder = new DynamicContextBuilder({ projectRoot: customDir });
        const result = await builder.build('test', 'user');
        
        expect(result).toContain(content);
      } finally {
        await fs.rm(customDir, { recursive: true, force: true });
      }
    });

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

      const builder = new DynamicContextBuilder({ 
        projectRoot: tempDir,
        memoryDataDir: customMemoryDir 
      });
      
      const result = await builder.build('test', userId);
      expect(result).toContain('Custom');
    });
  });
});
