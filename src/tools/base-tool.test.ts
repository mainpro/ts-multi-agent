import { describe, it } from 'bun:test';
import { expect } from 'bun:test';
import { BaseTool } from './base-tool';
import type { ToolContext, ToolResult } from './interfaces';

describe('BaseTool', () => {
  class TestTool extends BaseTool {
    name = 'test-tool';
    description = 'A test tool for unit testing BaseTool';

    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      return {
        success: true,
        data: { input, context },
      };
    }
  }

  it('should create a concrete tool extending BaseTool', () => {
    const tool = new TestTool();

    expect(tool.name).toBe('test-tool');
    expect(tool.description).toBe('A test tool for unit testing BaseTool');
  });

  it('should implement execute method from subclass', async () => {
    const tool = new TestTool();
    const context: ToolContext = {
      workDir: '/tmp/test',
      userId: 'user-123',
      sessionId: 'session-456',
    };

    const result = await tool.execute({ action: 'test' }, context);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('should return false for isConcurrencySafe by default', () => {
    const tool = new TestTool();

    const result = tool.isConcurrencySafe({});

    expect(result).toBe(false);
  });

  it('should return false for isReadOnly by default', () => {
    const tool = new TestTool();

    const result = tool.isReadOnly();

    expect(result).toBe(false);
  });

  it('should allow overriding isConcurrencySafe in subclass', () => {
    class ReadOnlyTool extends BaseTool {
      name = 'read-only-tool';
      description = 'A read-only tool';

      async execute(): Promise<ToolResult> {
        return { success: true };
      }

      override isConcurrencySafe(_input: unknown): boolean {
        return true;
      }
    }

    const tool = new ReadOnlyTool();

    expect(tool.isConcurrencySafe({})).toBe(true);
    expect(tool.isReadOnly()).toBe(false);
  });

  it('should allow overriding isReadOnly in subclass', () => {
    class ReadOnlyTool extends BaseTool {
      name = 'read-only-tool';
      description = 'A read-only tool';

      async execute(): Promise<ToolResult> {
        return { success: true };
      }

      override isReadOnly(): boolean {
        return true;
      }
    }

    const tool = new ReadOnlyTool();

    expect(tool.isReadOnly()).toBe(true);
    expect(tool.isConcurrencySafe({})).toBe(false);
  });

  it('should allow overriding both isConcurrencySafe and isReadOnly', () => {
    class SafeReadOnlyTool extends BaseTool {
      name = 'safe-read-only-tool';
      description = 'A safe read-only tool';

      async execute(): Promise<ToolResult> {
        return { success: true };
      }

      override isConcurrencySafe(_input: unknown): boolean {
        return true;
      }

      override isReadOnly(): boolean {
        return true;
      }
    }

    const tool = new SafeReadOnlyTool();

    expect(tool.isConcurrencySafe({})).toBe(true);
    expect(tool.isReadOnly()).toBe(true);
  });

  it('should handle different input types in isConcurrencySafe', () => {
    const tool = new TestTool();

    expect(tool.isConcurrencySafe(null)).toBe(false);
    expect(tool.isConcurrencySafe(undefined)).toBe(false);
    expect(tool.isConcurrencySafe({ complex: 'object' })).toBe(false);
    expect(tool.isConcurrencySafe('string')).toBe(false);
    expect(tool.isConcurrencySafe(42)).toBe(false);
  });

  it('should implement Tool interface correctly', () => {
    const tool: BaseTool = new TestTool();

    expect(tool.name).toBeDefined();
    expect(tool.description).toBeDefined();
    expect(typeof tool.execute).toBe('function');
    expect(typeof tool.isConcurrencySafe).toBe('function');
    expect(typeof tool.isReadOnly).toBe('function');
  });
});
