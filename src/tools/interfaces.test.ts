import { describe, it } from 'bun:test';
import { expect } from 'bun:test';
import type { Tool, ToolContext, ToolResult } from './interfaces';

describe('Tool Interfaces', () => {
  it('should define ToolContext with required fields', () => {
    const context: ToolContext = {
      workDir: '/tmp/test',
      userId: 'user-123',
      sessionId: 'session-456',
    };

    expect(context.workDir).toBe('/tmp/test');
    expect(context.userId).toBe('user-123');
    expect(context.sessionId).toBe('session-456');
  });

  it('should define ToolResult with success state', () => {
    const successResult: ToolResult = {
      success: true,
      data: { message: 'test' },
    };

    const errorResult: ToolResult = {
      success: false,
      error: 'Something went wrong',
    };

    expect(successResult.success).toBe(true);
    expect(successResult.data).toBeDefined();
    expect(errorResult.success).toBe(false);
    expect(errorResult.error).toBeDefined();
  });

  it('should implement Tool interface correctly', () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool for validation',
      
      async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
        return {
          success: true,
          data: { input, context },
        };
      },

      isConcurrencySafe(input: unknown): boolean {
        return true;
      },

      isReadOnly(): boolean {
        return true;
      },
    };

    expect(mockTool.name).toBe('test-tool');
    expect(mockTool.description).toBe('A test tool for validation');
    expect(mockTool.isConcurrencySafe({})).toBe(true);
    expect(mockTool.isReadOnly()).toBe(true);
  });

  it('should allow different concurrency safety behaviors', () => {
    const readOnlyTool: Tool = {
      name: 'read-tool',
      description: 'Read-only tool',
      async execute() {
        return { success: true };
      },
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
    };

    const writeTool: Tool = {
      name: 'write-tool',
      description: 'Write tool',
      async execute() {
        return { success: true };
      },
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
    };

    expect(readOnlyTool.isConcurrencySafe({})).toBe(true);
    expect(readOnlyTool.isReadOnly()).toBe(true);
    
    expect(writeTool.isConcurrencySafe({})).toBe(false);
    expect(writeTool.isReadOnly()).toBe(false);
  });
});
