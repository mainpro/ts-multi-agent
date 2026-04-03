/**
 * BaseTool Abstract Class
 *
 * This module provides an abstract base class for Tool implementations.
 * It offers default implementations for common methods while requiring
 * subclasses to implement the core execute() method.
 *
 * Based on Claude Code's tool system design
 */

import type { Tool, ToolContext, ToolResult } from './interfaces';

/**
 * Abstract base class for Tool implementations
 *
 * Provides default implementations:
 * - isConcurrencySafe(): returns false (conservative default)
 * - isReadOnly(): returns false (conservative default)
 *
 * Subclasses must implement:
 * - execute(): core tool functionality
 * - name: unique tool identifier
 * - description: human-readable tool description
 */
export abstract class BaseTool implements Tool {
  /**
   * Unique name of the tool
   * Must be implemented by subclasses
   */
  abstract name: string;

  /**
   * Human-readable description of what the tool does
   * Must be implemented by subclasses
   */
  abstract description: string;

  /**
   * Execute the tool with given input and context
   * Must be implemented by subclasses
   *
   * @param input - Tool-specific input parameters
   * @param context - Execution context with user/session info
   * @returns Promise resolving to ToolResult
   */
  abstract execute(input: unknown, context: ToolContext): Promise<ToolResult>;

  /**
   * Determine if this tool execution is safe to run concurrently
   * with other instances of the same tool
   *
   * Default: false (conservative - assumes not safe)
   * Subclasses can override for read-only or stateless operations
   *
   * @param _input - Tool-specific input parameters (unused in default)
   * @returns false by default
   */
  isConcurrencySafe(_input: unknown): boolean {
    return false;
  }

  /**
   * Identify if this tool only performs read operations
   *
   * Default: false (conservative - assumes writes occur)
   * Subclasses can override for read-only tools
   *
   * @returns false by default
   */
  isReadOnly(): boolean {
    return false;
  }
}
