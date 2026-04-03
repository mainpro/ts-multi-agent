import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool, ToolContext, ToolResult } from './interfaces';

const execAsync = promisify(exec);

export interface BashInput {
  command: string;
  timeout?: number;
}

export class BashTool implements Tool {
  name = 'bash';
  description = 'Execute shell commands. Use for running scripts, installing dependencies, or any system operations.';

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { command, timeout = 30000 } = input as BashInput;
    
    if (!command) {
      return { success: false, error: 'command is required' };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: context.workDir,
        timeout,
        maxBuffer: 1024 * 1024 * 10, // 10MB
      });

      return {
        success: true,
        data: {
          stdout: stdout || '(empty)',
          stderr: stderr || '(empty)',
          exitCode: 0,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Command execution failed',
        data: {
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          exitCode: error.code || 1,
        },
      };
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return false;
  }

  isReadOnly(): boolean {
    return false;
  }
}

export default BashTool;
