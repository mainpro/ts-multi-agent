/**
 * 系统技能类型定义
 * 系统技能与常规技能的区别：
 * - 存放在 system-skills/ 目录（不被 SkillRegistry 扫描）
 * - 通过 / 命令触发（被 MainAgent 拦截）
 * - 有 executor 字段指定执行器类型
 * - 有 adminOnly 字段控制权限
 */

export interface SystemSkill {
  /** SKILL.md 中的 name */
  name: string;
  /** 命令名（目录名，如 "improve" → /improve） */
  command: string;
  /** 技能描述 */
  description: string;
  /** 执行器类型（"improvement-agent" | "sub-agent" 等） */
  executor: string;
  /** 是否需要 admin 权限 */
  adminOnly: boolean;
  /** 技能目录路径 */
  skillDir: string;
  /** SKILL.md 完整内容 */
  skillContent: string;
}

/**
 * 系统技能执行器接口
 * 所有系统技能的执行器都需要实现此接口
 */
export interface SystemSkillExecutor {
  execute(skill: SystemSkill, params?: Record<string, unknown>): Promise<SystemSkillResult>;
}

export interface SystemSkillResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}
