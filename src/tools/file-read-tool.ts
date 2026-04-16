/**
 * FileReadTool - Tool for reading reference files
 *
 * This tool provides file reading functionality for skill references,
 * supporting multiple search paths and graceful error handling.
 *
 * Based on Claude Code's tool system design
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { BaseTool } from './base-tool';
import type { ToolContext, ToolResult } from './interfaces';
import { PathGuard } from '../security/path-guard';

/**
 * Input parameters for FileReadTool
 */
export interface FileReadInput {
  /** Name of the file to read */
  fileName: string;
  /** Optional: Maximum characters to read (default: 10000) */
  maxChars?: number;
  /** Optional: Search paths to look for the file (default: [workDir]) */
  searchPaths?: string[];
}

/**
 * FileReadTool - Reads reference files from skill directories
 *
 * Features:
 * - Searches multiple paths (skill references, project root, working directory)
 * - Truncates large files to prevent memory issues
 * - Graceful error handling for missing files or permission issues
 * - Concurrency-safe (read-only operations)
 */
export class FileReadTool extends BaseTool {
  name = 'read';
  description = 'Read the contents of a file. Returns file content with line numbers.';
  parameters = {
    fileName: { type: 'string', description: '要读取的文件名' },
    maxChars: { type: 'number', description: '最大读取字符数，默认 10000' },
  };
  required = ['fileName'];

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.validateInput(input);
      const searchPaths = this.buildSearchPaths(params, context);
      const maxChars = params.maxChars ?? 10000;

      // 检查fileName是否为绝对路径
      if (path.isAbsolute(params.fileName)) {
        const fullPath = params.fileName;
        
        // P0-2: 路径安全检查
        const pathCheck = PathGuard.checkPath(fullPath);
        if (!pathCheck.safe) {
          return { success: false, error: pathCheck.reason };
        }

        try {
          const content = await this.readFile(fullPath, maxChars);
          return {
            success: true,
            data: {
              fileName: params.fileName,
              content,
              path: fullPath,
              truncated: content.length >= maxChars,
            },
          };
        } catch (error) {
          if (this.isNotFoundError(error)) {
            return {
              success: false,
              error: `File not found: ${params.fileName}`,
            };
          }
          throw error;
        }
      }

      // 处理相对路径
      for (const searchPath of searchPaths) {
        const fullPath = path.join(searchPath, params.fileName);

        // P0-2: 路径安全检查
        const pathCheck = PathGuard.checkPath(fullPath);
        if (!pathCheck.safe) {
          return { success: false, error: pathCheck.reason };
        }

        try {
          const content = await this.readFile(fullPath, maxChars);
          return {
            success: true,
            data: {
              fileName: params.fileName,
              content,
              path: fullPath,
              truncated: content.length >= maxChars,
            },
          };
        } catch (error) {
          if (this.isNotFoundError(error)) {
            continue;
          }
          throw error;
        }
      }

      return {
        success: false,
        error: `File not found: ${params.fileName}. Searched paths: ${searchPaths.join(', ')}`,
      };
    } catch (error) {
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return true;
  }

  isReadOnly(): boolean {
    return true;
  }

  private validateInput(input: unknown): FileReadInput {
    if (!input || typeof input !== 'object') {
      throw new Error('Input must be an object');
    }

    const params = input as Record<string, unknown>;

    if (!params.fileName || typeof params.fileName !== 'string') {
      throw new Error('fileName is required and must be a string');
    }

    return {
      fileName: params.fileName,
      maxChars: typeof params.maxChars === 'number' ? params.maxChars : undefined,
      searchPaths: Array.isArray(params.searchPaths)
        ? params.searchPaths.filter((p): p is string => typeof p === 'string')
        : undefined,
    };
  }

  private buildSearchPaths(params: FileReadInput, context: ToolContext): string[] {
    if (params.searchPaths && params.searchPaths.length > 0) {
      return params.searchPaths;
    }

    const defaultPaths = [context.workDir, process.cwd()];
    return [...new Set(defaultPaths)];
  }

  private async readFile(fullPath: string, maxChars: number): Promise<string> {
    const content = await fs.readFile(fullPath, 'utf-8');
    return content.length > maxChars ? content.substring(0, maxChars) : content;
  }

  private isNotFoundError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('enoent') ||
        message.includes('not found') ||
        message.includes('no such file')
      );
    }
    return false;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      const message = error.message;
      if (message.includes('EACCES') || message.includes('permission')) {
        return `Permission denied: Cannot read file. Please check file permissions.`;
      }
      return `Failed to read file: ${message}`;
    }
    return `Failed to read file: ${String(error)}`;
  }
}
