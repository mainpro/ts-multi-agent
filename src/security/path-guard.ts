/**
 * 路径安全检查工具类
 * P0-2: 敏感文件保护
 */
import * as path from 'path';

export interface PathCheckResult {
  safe: boolean;
  reason?: string;
}

export class PathGuard {
  // 系统级敏感路径（绝对禁止访问）
  private static readonly SYSTEM_SENSITIVE_PATTERNS: RegExp[] = [
    /\/\.ssh\//,
    /\/\.aws\//,
    /\/\.gnupg\//,
    /\/etc\/(shadow|passwd|sudoers)/,
    /\/proc\//,
    /\/sys\//,
  ];

  // 项目级敏感路径（需要额外确认）
  private static readonly PROJECT_SENSITIVE_PATTERNS: RegExp[] = [
    /\.env$/,
    /\.env\./,
    /credentials/i,
    /secret/i,
    /private[_-]?key/i,
  ];

  /**
   * 检查路径是否安全
   */
  static checkPath(filePath: string): PathCheckResult {
    const normalizedPath = path.resolve(filePath);

    for (const pattern of this.SYSTEM_SENSITIVE_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        return { safe: false, reason: `系统敏感路径，禁止访问: ${normalizedPath}` };
      }
    }

    for (const pattern of this.PROJECT_SENSITIVE_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        return { safe: false, reason: `敏感文件，禁止访问: ${normalizedPath}` };
      }
    }

    return { safe: true };
  }

  /**
   * 检查 bash 命令是否安全（基础检查）
   */
  static checkBashCommand(command: string): PathCheckResult {
    const dangerousPatterns: RegExp[] = [
      /rm\s+(-[rf]+\s+)?\//,
      /mkfs\./,
      /dd\s+if=/,
      />\s*\/dev\//,
      /chmod\s+777/,
      /curl.*\|\s*(ba)?sh/,
      /wget.*\|\s*(ba)?sh/,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return { safe: false, reason: `危险命令模式被拦截: ${command}` };
      }
    }

    return { safe: true };
  }
}
