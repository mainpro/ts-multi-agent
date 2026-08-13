// src/agents/employee/types.ts
// 类型定义全部 re-export 自 json-types.ts,这里保留文件以便后续扩展非 schema 类型
export type {
  EmployeeConfig,
  EmployeeIdentityConfig,
  PersonaConfig,
  CapabilitiesConfig,
  PlanningConfig,
  OutputBehaviorConfig,
  SkillWhitelist,
  ToolPolicy,
  LLMProvider,
  LLMConfig,
  ResultRewriter,
} from './json-types';

/**
 * Master 注入到 task 的 persona 上下文(worker 不再有 persona hooks,
 * 通过读取这个上下文拼到 system prompt)。
 */
export interface PersonaContext {
  prefix: string;
  style?: string;
  boundaries?: string;
}