/**
 * 沙箱执行器
 * P3-1: 沙箱隔离
 * 使用 bubblewrap (bwrap) 提供文件系统和网络隔离
 */
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { existsSync } from 'fs';
import { createLogger } from '../observability/logger';

const execFileAsync = promisify(execFile);

export interface SandboxOptions {
  allowedDirs?: string[];
  network?: boolean;
  timeout?: number;
  env?: Record<string, string>;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxed: boolean;  // 标识是否实际使用了沙箱隔离
}

export class Sandbox {
  private static readonly logger = createLogger({ module: 'Sandbox' });
  private static isAvailable: boolean | null = null;
  private static shellPath: string | null = null;

  /**
   * 检测可用的 shell 路径
   * 优先使用 /bin/bash，不存在时回退到 /bin/sh（兼容 Alpine 等精简镜像）
   */
  static detectShell(): string {
    if (this.shellPath !== null) return this.shellPath;

    const candidates = ['/bin/bash', '/bin/sh'];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        this.shellPath = candidate;
        if (candidate !== '/bin/bash') {
          this.logger.info('使用备用 shell', { shell: candidate, reason: '/bin/bash 不存在（可能为 Alpine 等精简镜像）' });
        }
        return this.shellPath;
      }
    }

    // 最终兜底：使用 /bin/sh（即使文件不存在，让 OS 报错）
    this.shellPath = '/bin/sh';
    this.logger.warn('未找到可用的 shell，使用 /bin/sh 作为兜底');
    return this.shellPath;
  }

  /**
   * 检查 bubblewrap 是否可用
   */
  static isBwrapAvailable(): boolean {
    if (this.isAvailable !== null) return this.isAvailable;
    try {
      execSync('command -v bwrap', { encoding: 'utf-8', stdio: 'pipe' });
      this.isAvailable = true;
      this.logger.info('bubblewrap 可用，沙箱隔离已启用');
    } catch {
      this.isAvailable = false;
      this.logger.warn('bubblewrap 不可用，命令将在无隔离环境下直接执行');
    }
    return this.isAvailable;
  }

  /**
   * 在沙箱中执行命令
   */
  static async execute(command: string, workDir: string, options?: SandboxOptions): Promise<SandboxResult> {
    const env = options?.env ? { ...process.env, ...options.env } : process.env;
    const shell = this.detectShell();
    // 截断命令用于日志展示（避免过长）
    const displayCmd = command.length > 200 ? command.substring(0, 200) + '...' : command;

    // 如果 bwrap 不可用，回退到直接执行
    if (!this.isBwrapAvailable()) {
      this.logger.warn('命令在无隔离环境下执行', {
        command: displayCmd,
        workDir,
        shell,
        reason: 'bubblewrap 不可用',
      });
      try {
        const { stdout, stderr } = await execFileAsync(shell, ['-c', command], {
          cwd: workDir,
          timeout: options?.timeout || 30000,
          maxBuffer: 10 * 1024 * 1024,
          env,
        });
        return { stdout, stderr, exitCode: 0, sandboxed: false };
      } catch (error: any) {
        return {
          stdout: error.stdout || '',
          stderr: error.stderr || error.message,
          exitCode: error.status || 1,
          sandboxed: false,
        };
      }
    }

    const allowedDirs = options?.allowedDirs || [workDir];
    // 默认禁用网络（更安全），仅当 network 显式为 true 时共享
    const network = options?.network === true ? '--share-net' : '--unshare-net';
    const networkMode = options?.network === true ? 'shared' : 'isolated';

    // 使用参数数组，避免 shell 注入
    const bwrapArgs: string[] = [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/etc', '/etc',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--die-with-parent',
      '--new-session',
      network,
    ];

    // 添加允许读写的目录
    for (const dir of allowedDirs) {
      const resolvedDir = path.resolve(dir);
      bwrapArgs.push('--bind', resolvedDir, resolvedDir);
    }

    bwrapArgs.push('--', shell, '-c', command);

    this.logger.info('沙箱执行命令', {
      command: displayCmd,
      workDir,
      shell,
      allowedDirs,
      network: networkMode,
      timeout: options?.timeout || 30000,
    });

    try {
      const { stdout, stderr } = await execFileAsync('bwrap', bwrapArgs, {
        cwd: workDir,
        timeout: options?.timeout || 30000,
        maxBuffer: 10 * 1024 * 1024,
        env,
      });
      this.logger.info('沙箱命令执行完成', {
        command: displayCmd,
        exitCode: 0,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
      return { stdout, stderr, exitCode: 0, sandboxed: true };
    } catch (error: any) {
      this.logger.warn('沙箱命令执行失败', {
        command: displayCmd,
        exitCode: error.status || 1,
        stderrSnippet: (error.stderr || '').substring(0, 500),
      });
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        exitCode: error.status || 1,
        sandboxed: true,
      };
    }
  }
}
