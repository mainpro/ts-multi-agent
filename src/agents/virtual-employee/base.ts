// src/agents/virtual-employee/base.ts

import type { EmployeeConfig, ResultRewriter } from './types';
import { SubAgent } from '../sub-agent';

/**
 * 虚拟员工抽象基类。
 *
 * @deprecated Task 7 起 SubAgent 已移除 4 个 persona hook,本层的 hook 不再被
 * SubAgent 调用(persona/工具/白名单/改写全部上移到 MainAgent)。整个
 * `src/agents/virtual-employee/` 目录将在 Task 11 删除。
 */
export abstract class VirtualEmployee extends SubAgent {
  abstract readonly config: EmployeeConfig;

  /** @deprecated 不再被 SubAgent 调用 */
  protected systemPromptPrefix(): string {
    return '';
  }

  /** @deprecated 不再被 SubAgent 调用 */
  protected allowedSkillNames(): Set<string> | null {
    return null;
  }

  /** @deprecated 不再被 SubAgent 调用 */
  protected resultRewriter(): ResultRewriter | null {
    return null;
  }

  /** @deprecated 不再被 SubAgent 调用 */
  protected configId(): string {
    return this.config.id;
  }
}