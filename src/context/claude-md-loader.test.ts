import { test, describe, beforeAll, afterAll, expect } from 'bun:test';
import { ClaudeMdLoader } from './claude-md-loader';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('ClaudeMdLoader', () => {
  let loader: ClaudeMdLoader;
  const testDir = path.join(__dirname, 'test-fixtures');

  beforeAll(async () => {
    loader = new ClaudeMdLoader(testDir);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('findClaudeMdFiles', () => {
    test('should find project-level CLAUDE.md file', async () => {
      const projectFile = path.join(testDir, 'CLAUDE.md');
      await fs.writeFile(projectFile, '# Project Config');

      const files = await loader.findClaudeMdFiles();
      expect(files).toContain(projectFile);

      await fs.unlink(projectFile);
    });

    test('should find .claude/CLAUDE.md file', async () => {
      const claudeDir = path.join(testDir, '.claude');
      await fs.mkdir(claudeDir, { recursive: true });
      const configFile = path.join(claudeDir, 'CLAUDE.md');
      await fs.writeFile(configFile, '# Project Config Dir');

      const files = await loader.findClaudeMdFiles();
      expect(files).toContain(configFile);

      await fs.rm(claudeDir, { recursive: true, force: true });
    });

    test('should find CLAUDE.local.md file', async () => {
      const localFile = path.join(testDir, 'CLAUDE.local.md');
      await fs.writeFile(localFile, '# Local Config');

      const files = await loader.findClaudeMdFiles();
      expect(files).toContain(localFile);

      await fs.unlink(localFile);
    });

    test('should return empty array when no files exist', async () => {
      const emptyLoader = new ClaudeMdLoader('/nonexistent/path');
      const files = await emptyLoader.findClaudeMdFiles();
      expect(files).toEqual([]);
    });
  });

  describe('loadFile', () => {
    test('should load file content successfully', async () => {
      const testFile = path.join(testDir, 'test.md');
      const content = '# Test Content\n\nThis is a test.';
      await fs.writeFile(testFile, content);

      const loaded = await loader.loadFile(testFile);
      expect(loaded).toBe(content);

      await fs.unlink(testFile);
    });

    test('should throw error for non-existent file', async () => {
      expect(loader.loadFile('/nonexistent/file.md')).rejects.toThrow();
    });
  });

  describe('loadAll', () => {
    test('should merge multiple CLAUDE.md files', async () => {
      const projectFile = path.join(testDir, 'CLAUDE.md');
      const localFile = path.join(testDir, 'CLAUDE.local.md');

      await fs.writeFile(projectFile, '# Project');
      await fs.writeFile(localFile, '# Local');

      const content = await loader.loadAll();
      expect(content).toContain('# Project');
      expect(content).toContain('# Local');
      expect(content).toContain('From:');

      await fs.unlink(projectFile);
      await fs.unlink(localFile);
    });

    test('should return empty string when no files exist', async () => {
      const emptyLoader = new ClaudeMdLoader('/nonexistent/path');
      const content = await emptyLoader.loadAll();
      expect(content).toBe('');
    });
  });
});
