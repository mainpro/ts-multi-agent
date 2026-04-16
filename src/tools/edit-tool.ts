import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from './interfaces';
import { PathGuard } from '../security/path-guard';

export interface EditInput {
  filePath: string;
  oldString: string;
  newString: string;
}

export class EditTool implements Tool {
  name = 'edit';
  description = 'Edit an existing file by replacing a specific string with new content.';
  parameters = {
    filePath: { type: 'string', description: '要编辑的文件路径' },
    oldString: { type: 'string', description: '要替换的旧内容' },
    newString: { type: 'string', description: '要替换成的新内容' },
  };
  required = ['filePath', 'oldString', 'newString'];

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { filePath, oldString, newString } = input as EditInput;
    
    if (!filePath || !oldString) {
      return { success: false, error: 'filePath and oldString are required' };
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
      const content = await fs.readFile(fullPath, 'utf-8');
      
      if (!content.includes(oldString)) {
        return { success: false, error: 'oldString not found in file' };
      }

      const newContent = content.replace(oldString, newString ?? '');
      await fs.writeFile(fullPath, newContent, 'utf-8');
      
      return {
        success: true,
        data: { path: fullPath, replaced: true },
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

export default EditTool;
