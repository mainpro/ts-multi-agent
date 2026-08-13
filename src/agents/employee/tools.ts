import type { ToolPolicy } from './json-types';

/**
 * 工具白名单(默认安全集合 = 只读工具 + 自我审查工具)。
 *
 * 这是全局唯一定义:`src/agents/sub-agent.ts` 直接 import 本常量,
 * 避免两处副本漂移。tools.ts 不依赖 SubAgent,故无循环依赖。
 */
export const DEFAULT_SAFE_TOOLS: readonly string[] = [
  'conversation-get',
  'read',
  'glob',
  'grep',
  'ask_user',           // 只读:向用户提问
  'append_improvement', // SubAgent 自我审查:记录技能执行中发现的质量问题
];

/**
 * 计算 task 实际可用的工具集合。
 *
 * 规则（按顺序）：
 *   1. 基础集：skill.allowedTools（若定义且非空）OR DEFAULT_SAFE_TOOLS
 *   2. 员工白名单（若定义）：与基础集求交集（更严格）
 *   3. 员工黑名单（若定义）：从结果中差集（更严格）
 *
 * 注意：黑名单优先级最高 —— 即使 enabled 放行，denied 也拒绝。
 *
 * @param skillAllowedTools skill 声明的允许工具（undefined/[] 时用 DEFAULT_SAFE_TOOLS）
 * @param employeeTools 员工级 tool 策略（可选）
 * @returns 最终可用工具的 Set
 */
export function computeAllowedTools(
  skillAllowedTools: string[] | undefined,
  employeeTools: ToolPolicy | undefined,
): Set<string> {
  // 1. 基础集
  let base: Set<string>;
  if (skillAllowedTools && skillAllowedTools.length > 0) {
    base = new Set(skillAllowedTools);
  } else {
    base = new Set(DEFAULT_SAFE_TOOLS);
  }

  // 2. 员工白名单：交集
  if (employeeTools?.enabled && employeeTools.enabled.length > 0) {
    const enabledSet = new Set(employeeTools.enabled);
    base = new Set([...base].filter((t) => enabledSet.has(t)));
  }

  // 3. 员工黑名单：差集
  if (employeeTools?.denied && employeeTools.denied.length > 0) {
    const deniedSet = new Set(employeeTools.denied);
    base = new Set([...base].filter((t) => !deniedSet.has(t)));
  }

  return base;
}
