import { Tool, ToolContext, ToolResult } from './interfaces';
import { PathGuard } from '../security/path-guard';
import { Sandbox } from '../security/sandbox';
import { getAccessToken } from '../context/request-context';

export interface BashInput {
  command: string;
  timeout?: number;
}

export class BashTool implements Tool {
  name = 'bash';
  description = 'Execute shell commands. Use for running scripts, installing dependencies, or any system operations.';
  parameters = {
    command: { type: 'string', description: '要执行的 shell 命令' },
    timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
  };
  required = ['command'];

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { command, timeout = 30000 } = input as BashInput;

    if (!command) {
      return { success: false, error: 'command is required' };
    }

    // P0-2: 命令安全检查（前置防线）
    const cmdCheck = PathGuard.checkBashCommand(command);
    if (!cmdCheck.safe) {
      return { success: false, error: cmdCheck.reason };
    }

    try {
      // 构建环境变量
      const accessToken = getAccessToken();
      const env: Record<string, string> = accessToken
        ? { ...process.env as Record<string, string>, SKILL_ACCESS_TOKEN: accessToken }
        : process.env as Record<string, string>;

      // P3-1: 使用沙箱执行（隔离防线）
      const result = await Sandbox.execute(command, context.workDir, {
        allowedDirs: [context.workDir],
        network: false,   // 默认禁用网络
        timeout,
        env,              // 传递环境变量（含 SKILL_ACCESS_TOKEN）
      });

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: [
            `Command failed (exit ${result.exitCode}): ${command}`,
            result.stdout ? `\n[stdout]:\n${result.stdout}` : '',
            result.stderr ? `\n[stderr]:\n${result.stderr}` : '',
          ].join(''),
          data: {
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            exitCode: result.exitCode,
            sandboxed: result.sandboxed,
          },
        };
      }

      return {
        success: true,
        data: {
          stdout: result.stdout || '(empty)',
          stderr: result.stderr || '(empty)',
          exitCode: 0,
          sandboxed: result.sandboxed,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Sandbox execution error: ${error.message}`,
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
