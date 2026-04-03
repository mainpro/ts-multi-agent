import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import { FileReadTool } from './file-read-tool';
import type { ToolContext } from './interfaces';

describe('FileReadTool', () => {
  let tool: FileReadTool;
  let context: ToolContext;
  let testDir: string;
  let testFile: string;

  beforeEach(async () => {
    tool = new FileReadTool();
    context = {
      workDir: '/tmp/test-workdir',
      userId: 'test-user',
      sessionId: 'test-session',
    };

    testDir = path.join('/tmp', `file-read-tool-test-${Date.now()}`);
    testFile = path.join(testDir, 'test.md');
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(testFile, 'Test content for file read tool');
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('properties', () => {
    test('should have correct name', () => {
      expect(tool.name).toBe('file_read');
    });

    test('should have description', () => {
      expect(tool.description).toContain('reference files');
    });
  });

  describe('isConcurrencySafe', () => {
    test('should return true', () => {
      expect(tool.isConcurrencySafe({ fileName: 'test.md' })).toBe(true);
    });

    test('should return true for any input', () => {
      expect(tool.isConcurrencySafe(null)).toBe(true);
      expect(tool.isConcurrencySafe(undefined)).toBe(true);
      expect(tool.isConcurrencySafe({})).toBe(true);
    });
  });

  describe('isReadOnly', () => {
    test('should return true', () => {
      expect(tool.isReadOnly()).toBe(true);
    });
  });

  describe('execute', () => {
    test('should read file successfully', async () => {
      const input = {
        fileName: 'test.md',
        searchPaths: [testDir],
      };

      const result = await tool.execute(input, context);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect((result.data as any).fileName).toBe('test.md');
      expect((result.data as any).content).toBe('Test content for file read tool');
      expect((result.data as any).truncated).toBe(false);
    });

    test('should truncate large files', async () => {
      const largeContent = 'x'.repeat(5000);
      await fs.writeFile(testFile, largeContent);

      const input = {
        fileName: 'test.md',
        searchPaths: [testDir],
        maxChars: 100,
      };

      const result = await tool.execute(input, context);

      expect(result.success).toBe(true);
      expect((result.data as any).content.length).toBe(100);
      expect((result.data as any).truncated).toBe(true);
    });

    test('should return error for missing file', async () => {
      const input = {
        fileName: 'nonexistent.md',
        searchPaths: [testDir],
      };

      const result = await tool.execute(input, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
      expect(result.error).toContain('nonexistent.md');
    });

    test('should search multiple paths', async () => {
      const input = {
        fileName: 'test.md',
        searchPaths: ['/tmp/nonexistent', testDir],
      };

      const result = await tool.execute(input, context);

      expect(result.success).toBe(true);
      expect((result.data as any).content).toBe('Test content for file read tool');
    });

    test('should use default search paths when not provided', async () => {
      const workDir = path.join(testDir, 'workdir');
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(path.join(workDir, 'default.md'), 'Default path content');

      const input = { fileName: 'default.md' };
      const customContext = { ...context, workDir };

      const result = await tool.execute(input, customContext);

      expect(result.success).toBe(true);
      expect((result.data as any).content).toBe('Default path content');
    });

    test('should validate fileName is required', async () => {
      const result = await tool.execute({}, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('fileName is required');
    });

    test('should validate fileName is string', async () => {
      const result = await tool.execute({ fileName: 123 }, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('fileName is required');
    });

    test('should validate input is object', async () => {
      const result = await tool.execute('invalid', context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Input must be an object');
    });

    test('should handle permission denied errors', async () => {
      if (process.platform === 'win32') {
        // Skip on Windows
        return;
      }

      const restrictedFile = path.join(testDir, 'restricted.md');
      await fs.writeFile(restrictedFile, 'Restricted content');
      await fs.chmod(restrictedFile, 0o000);

      const input = {
        fileName: 'restricted.md',
        searchPaths: [testDir],
      };

      const result = await tool.execute(input, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');

      // Cleanup
      await fs.chmod(restrictedFile, 0o644);
    });

    test('should use default maxChars when not provided', async () => {
      const content = 'x'.repeat(100);
      await fs.writeFile(testFile, content);

      const input = {
        fileName: 'test.md',
        searchPaths: [testDir],
      };

      const result = await tool.execute(input, context);

      expect(result.success).toBe(true);
      expect((result.data as any).content).toBe(content);
    });

    test('should filter non-string searchPaths', async () => {
      const input = {
        fileName: 'test.md',
        searchPaths: [testDir, 123, null, 'invalid'],
      };

      const result = await tool.execute(input, context);

      expect(result.success).toBe(true);
    });
  });

  describe('integration', () => {
    test('should work with real file system', async () => {
      const realFile = path.join(testDir, 'integration-test.md');
      const realContent = '# Integration Test\n\nThis is a real file.';
      await fs.writeFile(realFile, realContent);

      const input = {
        fileName: 'integration-test.md',
        searchPaths: [testDir],
      };

      const result = await tool.execute(input, context);

      expect(result.success).toBe(true);
      expect((result.data as any).content).toBe(realContent);
      expect((result.data as any).path).toBe(realFile);
    });
  });
});
