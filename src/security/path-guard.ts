/**
 * 路径安全检查工具类
 * P0-2: 敏感文件保护
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { createLogger } from '../observability/logger';

export interface PathCheckResult {
  safe: boolean;
  reason?: string;
}

export class PathGuard {
  private static readonly logger = createLogger({ module: 'PathGuard' });

  // 系统级敏感路径（绝对禁止访问）
  private static readonly SYSTEM_SENSITIVE_PATTERNS: RegExp[] = [
    /\/\.ssh\//,
    /\/\.aws\//,
    /\/\.gnupg\//,
    /\/etc\/(shadow|passwd|sudoers)/,
    /\/proc\//,
    /\/sys\//,
    /\/\.docker\//,
    /\/\.kube\//,
    /\/\.npmrc$/,
    /\/\.pypirc$/,
    /\/\.config\/(gh|github)/,
  ];

  // 项目级敏感路径（需要额外确认）
  private static readonly PROJECT_SENSITIVE_PATTERNS: RegExp[] = [
    /\.env$/,
    /\.env\./,
    /credentials/i,
    /secret/i,
    /private[_-]?key/i,
    /\.pem$/,
    /\.key$/,
    /token/i,
    /password/i,
  ];

  /**
   * 检查路径是否安全（异步版本，支持符号链接解析）
   */
  static async checkPath(filePath: string, workDir?: string): Promise<PathCheckResult> {
    let normalizedPath: string;
    try {
      // 使用 realpath 解析符号链接，防止符号链接指向 workDir 外部
      normalizedPath = await fs.realpath(filePath);
    } catch {
      // 文件不存在时使用 path.resolve
      normalizedPath = path.resolve(filePath);
    }

    // 白名单优先：检查路径是否在允许的工作目录范围内
    if (workDir) {
      let normalizedWorkDir: string;
      try {
        normalizedWorkDir = await fs.realpath(workDir);
      } catch {
        normalizedWorkDir = path.resolve(workDir);
      }

      if (!normalizedPath.startsWith(normalizedWorkDir + path.sep) &&
          normalizedPath !== normalizedWorkDir) {
        this.logger.warn('路径超出工作目录', { filePath, workDir, resolvedPath: normalizedPath });
        return { safe: false, reason: `路径超出工作目录范围: ${normalizedPath}` };
      }
    }

    // 黑名单兜底：系统敏感路径
    for (const pattern of this.SYSTEM_SENSITIVE_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        this.logger.warn('访问系统敏感路径', { filePath, resolvedPath: normalizedPath });
        return { safe: false, reason: `系统敏感路径，禁止访问: ${normalizedPath}` };
      }
    }

    // 黑名单兜底：项目敏感路径
    for (const pattern of this.PROJECT_SENSITIVE_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        this.logger.warn('访问敏感文件', { filePath, resolvedPath: normalizedPath });
        return { safe: false, reason: `敏感文件，禁止访问: ${normalizedPath}` };
      }
    }

    return { safe: true };
  }

  /**
   * 检查 bash 命令是否安全（基础检查）
   */
  static checkBashCommand(command: string): PathCheckResult {
    // 预处理：去除多余空白字符（含制表符、换行符等），便于匹配
    const normalized = command.replace(/\s+/g, ' ').trim();

    const dangerousPatterns: RegExp[] = [
      // 危险删除操作
      /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?!\S)/,  // rm -rf /
      /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+)?~(?!\S)/,     // rm -rf ~
      /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+)?\$HOME(?!\S)/, // rm -rf $HOME
      // 危险系统操作
      /mkfs\./,
      /dd\s+if=/,
      />\s*\/dev\//,
      /chmod\s+777/,
      // 远程代码执行
      /curl.*\|\s*(ba)?sh/,
      /wget.*\|\s*(ba)?sh/,
      // 提权操作
      /\bsudo\b\s+/,          // 禁止 sudo（词边界，避免匹配文件名中的 sudo）
      /\bsu\b\s+/,            // 禁止 su
      // 动态代码执行
      /\beval\b/,             // 禁止 eval
      /`[^`]+`/,              // 禁止反引号命令替换
      /\$\([^)]+\)/,          // 禁止 $() 命令替换
      // 危险网络工具
      /\bnc\b\s+-/,           // 禁止 netcat（需跟参数才拦截，避免误报）
      // 内联代码执行
      /\bpython[23]?\s+-c\b/, // 禁止内联 Python
      /\bnode\s+-e\b/,        // 禁止内联 Node
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(normalized)) {
        this.logger.warn('命令被拦截', { command, matchedPattern: pattern.source });
        return { safe: false, reason: `危险命令模式被拦截: ${command}` };
      }
    }

    return { safe: true };
  }
}
