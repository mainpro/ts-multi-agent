import { describe, it, expect, beforeEach } from 'bun:test';
import { DynamicContextBuilder } from '../../src/context/dynamic-context';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

describe('DynamicContextBuilder', () => {
  let tempDir: string;
  let builder: DynamicContextBuilder;

  beforeEach(async () => {
    tempDir = path.join('/tmp', `dynamic-context-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    builder = new DynamicContextBuilder({
      memoryDataDir: tempDir,
    });
  });

  it('should build context with user memory', async () => {
    const result = await builder.build('test input', 'test-user');
    expect(typeof result).toBe('string');
  });

  it('should handle new user gracefully', async () => {
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

  it('should handle missing memory directory', async () => {
    const builder = new DynamicContextBuilder({
      memoryDataDir: '/nonexistent/path',
    });
    const result = await builder.build('test', 'nonexistent-user');
    expect(typeof result).toBe('string');
  });
});
