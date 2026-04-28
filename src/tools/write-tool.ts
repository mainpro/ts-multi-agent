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
    const params = input as Record<string, unknown>;
    // 向后兼容：支持 filePath、fileName 和 file_path 参数名
    const filePath = params.filePath || params.fileName || params.file_path;
    const content = params.content;
    
    if (!filePath || content === undefined) {
      return { success: false, error: 'filePath and content are required' };
    }

    const fullPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.join(context.workDir, filePath);

    // P0-2: 路径安全检查
    const pathCheck = await PathGuard.checkPath(fullPath, context.workDir);
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
