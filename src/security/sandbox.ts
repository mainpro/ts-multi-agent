/**
 * 沙箱执行器
 * P3-1: 沙箱隔离
 * 使用 bubblewrap (bwrap) 提供文件系统和网络隔离
 */
import { execSync } from 'child_process';
import * as path from 'path';

export interface SandboxOptions {
  allowedDirs?: string[];
  network?: boolean;
  timeout?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class Sandbox {
  private static isAvailable: boolean | null = null;

  /**
   * 检查 bubblewrap 是否可用
   */
  static isBwrapAvailable(): boolean {
    if (this.isAvailable !== null) return this.isAvailable;
    try {
      execSync('which bwrap', { encoding: 'utf-8', stdio: 'pipe' });
      this.isAvailable = true;
    } catch {
      this.isAvailable = false;
    }
    return this.isAvailable;
  }

  /**
   * 在沙箱中执行命令
   */
  static execute(command: string, workDir: string, options?: SandboxOptions): SandboxResult {
    // 如果 bwrap 不可用，回退到直接执行并发出警告
    if (!this.isBwrapAvailable()) {
      console.warn('[Sandbox] ⚠️ bubblewrap 不可用，回退到直接执行（无隔离）');
      try {
        const result = execSync(command, {
          cwd: workDir,
          timeout: options?.timeout || 30000,
          encoding: 'utf-8',
        });
        return { stdout: result, stderr: '', exitCode: 0 };
      } catch (error: any) {
        return {
          stdout: error.stdout || '',
          stderr: error.stderr || error.message,
          exitCode: error.status || 1,
        };
      }
    }

    const allowedDirs = options?.allowedDirs || [workDir];
    const network = options?.network !== false ? '--share-net' : '--unshare-net';

    const bwrapArgs = [
      'bwrap',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--proc', '/proc',
      '--dev', '/dev',
      network,
    ];

    // 添加允许读写的目录
    for (const dir of allowedDirs) {
      const resolvedDir = path.resolve(dir);
      bwrapArgs.push('--bind', resolvedDir, resolvedDir);
    }

    bwrapArgs.push('--', '/bin/bash', '-c', command);

    try {
      const result = execSync(bwrapArgs.join(' '), {
        cwd: workDir,
        timeout: options?.timeout || 30000,
        encoding: 'utf-8',
      });
      return { stdout: result, stderr: '', exitCode: 0 };
    } catch (error: any) {
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        exitCode: error.status || 1,
      };
    }
  }
}
