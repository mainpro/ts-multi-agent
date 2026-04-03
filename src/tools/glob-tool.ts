import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from './interfaces';

export interface GlobInput {
  pattern: string;
  cwd?: string;
}

export class GlobTool implements Tool {
  name = 'glob';
  description = 'Find files matching a pattern. Supports wildcards like **/*.ts or *.js.';

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { pattern, cwd } = input as GlobInput;
    
    if (!pattern) {
      return { success: false, error: 'pattern is required' };
    }

    const baseDir = cwd || context.workDir;
    const results: string[] = [];

    async function walkDir(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.isFile()) {
            const relativePath = path.relative(baseDir, fullPath);
            if (matchPattern(relativePath, pattern) || matchPattern(entry.name, pattern)) {
              results.push(relativePath);
            }
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    try {
      await walkDir(baseDir);
      return { success: true, data: results };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return true;
  }

  isReadOnly(): boolean {
    return true;
  }
}

function matchPattern(filePath: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  
  return new RegExp(`^${regexPattern}$`).test(filePath);
}

export default GlobTool;
