import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from './interfaces';
import { PathGuard } from '../security/path-guard';

export interface WriteInput {
  filePath: string;
  content: string;
}

export class WriteTool implements Tool {
  name = 'write';
  description = 'Write or create a file with specified content.';
  parameters = {
    filePath: { type: 'string', description: '要写入的文件路径' },
    content: { type: 'string', description: '要写入的内容' },
  };
  required = ['filePath', 'content'];

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { filePath, content } = input as WriteInput;
    
    if (!filePath || content === undefined) {
      return { success: false, error: 'filePath and content are required' };
    }

    const fullPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.join(context.workDir, filePath);

    // P0-2: 路径安全检查
    const pathCheck = PathGuard.checkPath(fullPath);
    if (!pathCheck.safe) {
      return { success: false, error: pathCheck.reason };
    }

    try {
      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      
      return {
        success: true,
        data: { path: fullPath, bytes: content.length },
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return false;
  }

  isReadOnly(): boolean {
    return false;
  }
}

export default WriteTool;
