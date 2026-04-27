/**
 * Tool System Interfaces
 * 
 * This module defines the core interfaces for the Tool abstraction layer.
 * Each tool must implement these interfaces to ensure consistent behavior
 * and enable intelligent concurrency control.
 */

/**
 * JSON Schema for tool parameters
 */
export interface ToolParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

export interface ToolParameters {
  [key: string]: ToolParameterSchema;
}

/**
 * Context provided to tool execution
 * Contains session and user information for tool operations
 */
export interface ToolContext {
  /** Working directory for file operations */
  workDir: string;
  /** User ID executing the tool */
  userId: string;
  /** Session ID for this execution */
  sessionId: string;
  /** Access token for downstream API calls (optional, passed from user request) */
  accessToken?: string;
}

/**
 * Result returned by tool execution
 */
export interface ToolResult {
  /** Whether the tool execution succeeded */
  success: boolean;
  /** Tool execution data (if successful) */
  data?: unknown;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Tool interface that all tools must implement
 * 
 * This interface provides:
 * - Standardized execution pattern
 * - Concurrency safety checks
 * - Read-only identification
 * 
 * Based on Claude Code's tool system design
 */
export interface Tool {
  /** Unique name of the tool */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema for tool parameters */
  parameters?: ToolParameters;
  /** Required parameter names */
  required?: string[];
  
  /**
   * Execute the tool with given input and context
   * @param input - Tool-specific input parameters
   * @param context - Execution context with user/session info
   * @returns Promise resolving to ToolResult
   */
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
  
  /**
   * Determine if this tool execution is safe to run concurrently
   * with other instances of the same tool
   * 
   * @param input - Tool-specific input parameters
   * @returns true if safe to run concurrently, false if must be serialized
   * 
   * Example: Read operations are typically concurrency-safe,
   * while write operations may need serialization
   */
  isConcurrencySafe(input: unknown): boolean;
  
  /**
   * Identify if this tool only performs read operations
   * 
   * @returns true if tool is read-only, false if it modifies state
   * 
   * Read-only tools can be safely run in parallel with other read-only tools.
   * Write tools need careful coordination.
   */
  isReadOnly(): boolean;
}
