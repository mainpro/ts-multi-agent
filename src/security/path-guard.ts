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
   * 允许的命令前缀白名单
   *
   * 白名单策略：只允许已知安全的命令前缀通过，而非试图用正则黑名单拦截所有危险命令。
   * 黑名单天然不完整（可通过变量替换、别名、\r\n 绕过），白名单更安全。
   */
  private static readonly ALLOWED_COMMAND_PREFIXES: readonly string[] = [
    'node scripts/',
    'node script/',
    'npm ',
    'npx ',
    'pnpm ',
    'yarn ',
    'bun ',
    'ls ',
    'cat ',
    'echo ',
    'pwd',
    'mkdir ',
    'cp ',
    'mv ',
    'touch ',
    'head ',
    'tail ',
    'wc ',
    'grep ',
    'rg ',
    'find ',
    'git ',
    'tsc ',
    'tsx ',
  ];

  /**
   * 检查 bash 命令是否安全（白名单策略）
   *
   * 采用白名单优先 + 黑名单兜底的双重防御：
   * 1. 命令必须匹配白名单前缀（只允许已知安全命令）
   * 2. 即使匹配白名单，仍检查是否包含危险模式（如命令替换、提权等）
   */
  static checkBashCommand(command: string): PathCheckResult {
    const normalized = command.replace(/\s+/g, ' ').trim();

    if (!normalized) {
      return { safe: false, reason: '空命令' };
    }

    // 白名单检查：命令必须以允许的前缀开头
    const isAllowed = this.ALLOWED_COMMAND_PREFIXES.some(prefix =>
      normalized.startsWith(prefix) || normalized === prefix.trim()
    );

    if (!isAllowed) {
      this.logger.warn('命令不在白名单中', { command: normalized });
      return { safe: false, reason: `命令不在允许的白名单中: ${normalized.substring(0, 100)}` };
    }

    // 黑名单兜底：即使命令前缀合法，仍拦截危险模式
    const dangerousPatterns: RegExp[] = [
      /(?:^|[^a-zA-Z])sudo\s/,
      /(?:^|[^a-zA-Z])su\s/,
      /`[^`]+`/,
      /\$\([^)]+\)/,
      /\beval\s*\(/,
      /\bpython[23]?\s+-c\b/,
      /\bnode\s+-e\b/,
      /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?!\S)/,
      /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+)?~(?!\S)/,
      /\bmkfs\./,
      /\bdd\s+if=/,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(normalized)) {
        this.logger.warn('命令包含危险模式', { command: normalized, matchedPattern: pattern.source });
        return { safe: false, reason: `命令包含危险模式: ${normalized.substring(0, 100)}` };
      }
    }

    return { safe: true };
  }
}
