import { describe, it, expect, beforeEach } from 'bun:test';
import { DynamicContextBuilder } from '../../src/context/dynamic-context';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

describe('DynamicContextBuilder Integration', () => {
  let tempDir: string;
  let builder: DynamicContextBuilder;

  beforeEach(async () => {
    tempDir = path.join('/tmp', `dynamic-context-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    builder = new DynamicContextBuilder({
      projectRoot: tempDir,
      memoryDataDir: tempDir,
    });
  });

  it('should build context with empty directories', async () => {
    const result = await builder.build('test input', 'test-user');
    expect(typeof result).toBe('string');
  });

  it('should handle missing CLAUDE.md gracefully', async () => {
    const result = await builder.build('test', 'user1');
    expect(result).toBeDefined();
  });

  it('should build context with user input', async () => {
    const result = await builder.build('Show me the files', 'user2');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle different user IDs', async () => {
    const result1 = await builder.build('test', 'user-a');
    const result2 = await builder.build('test', 'user-b');
    expect(typeof result1).toBe(typeof result2);
  });
});

describe('DynamicContextBuilder with CLAUDE.md', () => {
  let tempDir: string;
  let builder: DynamicContextBuilder;

  beforeEach(async () => {
    tempDir = path.join('/tmp', `claude-md-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    await fs.writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      '# Project Config\n\n- Project name: Test\n- Version: 1.0.0'
    );
    
    builder = new DynamicContextBuilder({
      projectRoot: tempDir,
      memoryDataDir: tempDir,
    });
  });

  it('should load CLAUDE.md when present', async () => {
    const result = await builder.build('test input', 'test-user');
    expect(result).toContain('Project Config');
  });
});
