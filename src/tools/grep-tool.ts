import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from './interfaces';

export interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export class GrepTool implements Tool {
  name = 'grep';
  description = 'Search for text patterns in files. Returns matching lines with context.';
  parameters = {
    pattern: { type: 'string', description: '搜索的正则表达式' },
    path: { type: 'string', description: '搜索路径，默认当前目录' },
    include: { type: 'string', description: '文件过滤模式，如 *.ts' },
  };
  required = ['pattern'];

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { pattern, path: searchPath, include } = input as GrepInput;
    
    if (!pattern) {
      return { success: false, error: 'pattern is required' };
    }

    const baseDir = searchPath || context.workDir;
    const matches: GrepMatch[] = [];
    const regex = new RegExp(pattern, 'gi');

    async function searchDir(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            await searchDir(fullPath);
          } else if (entry.isFile()) {
            if (include && !matchPattern(entry.name, include)) {
              continue;
            }
            
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const lines = content.split('\n');
              
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  matches.push({
                    file: path.relative(baseDir, fullPath),
                    line: i + 1,
                    content: lines[i].substring(0, 200),
                  });
                }
              }
              
              regex.lastIndex = 0;
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    try {
      await searchDir(baseDir);
      return { success: true, data: matches.slice(0, 100) };
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
    .replace(/\*/g, '[^/]*');
  
  return new RegExp(`^${regexPattern}$`).test(filePath);
}

export default GrepTool;
