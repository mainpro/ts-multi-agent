// src/agents/virtual-employee/base.ts

import type { EmployeeConfig, ResultRewriter } from './types';
import { SubAgent } from '../sub-agent';

/**
 * 虚拟员工抽象基类。
 * 复用 SubAgent 全部 LLM 循环 / 断点续 / steer / metrics / compaction。
 * 通过 override 以下 3 个 hook 表达"业务属性":
 *   - systemPromptPrefix(): 拼到 skill body 前面的 persona
 *   - allowedSkillNames(): 该员工允许调用的 skill 集合(null = 不限制)
 *   - resultRewriter(): result 改写器(null = passthrough)
 */
export abstract class VirtualEmployee extends SubAgent {
  abstract readonly config: EmployeeConfig;

  /** 默认实现:无 prefix → 行为与 SubAgent 一致 */
  protected systemPromptPrefix(): string {
    return '';
  }

  /** 默认实现:null = 不限制(向后兼容) */
  protected allowedSkillNames(): Set<string> | null {
    return null;
  }

  /** 默认实现:null = passthrough */
  protected resultRewriter(): ResultRewriter | null {
    return null;
  }
}