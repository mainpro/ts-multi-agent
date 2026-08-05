// src/agents/virtual-employee/json-employee.ts

import type { EmployeeConfig, ResultRewriter } from './types';
import type { JsonEmployeeConfig } from './json-types';
import { VirtualEmployee } from './base';

/**
 * 从 JSON 配置实例化的虚拟员工(通用工厂)。
 *
 * 与 TS 类员工(继承 VirtualEmployee 自定义 hook)平行存在:
 *  - 简单业务属性(id/persona/白名单/resultRewriter)走 JSON 配置
 *  - 复杂业务逻辑(自定义 resultRewriter 算法、特殊状态机)仍可写 TS 类继承 VirtualEmployee
 *
 * 设计权衡:
 *  - 不做模板引擎(只支持 ${displayName} 简单插值)
 *  - resultRewriter 只支持 3 种 transform(append/passthrough/replace)
 *  - 这样 90% 的业务属性可以用 JSON 描述,无需写代码
 */
export class JsonVirtualEmployee extends VirtualEmployee {
  readonly config: EmployeeConfig;

  private readonly personaTemplate: string;
  private readonly allowedSkills: Set<string> | null;
  private readonly rewriterSpec: JsonEmployeeConfig['resultRewriter'];

  constructor(
    json: JsonEmployeeConfig,
    skillRegistry: any,
    llm: any,
    memoryService?: any,
  ) {
    super(skillRegistry, llm, memoryService);
    this.config = {
      id: json.id,
      displayName: json.displayName,
      intentKeywords: json.intentKeywords,
    };
    this.personaTemplate = json.persona?.prefix ?? '';
    this.allowedSkills = json.skillWhitelist?.type === 'allowlist'
      ? new Set(json.skillWhitelist.skills)
      : null;
    this.rewriterSpec = json.resultRewriter;
  }

  /** 简单模板变量插值,只支持 ${displayName} */
  private render(template: string): string {
    return template.replace(/\$\{displayName\}/g, this.config.displayName);
  }

  protected systemPromptPrefix(): string {
    return this.render(this.personaTemplate);
  }

  protected allowedSkillNames(): Set<string> | null {
    return this.allowedSkills;
  }

  protected resultRewriter(): ResultRewriter | null {
    if (!this.rewriterSpec) return null;

    // match.status 过滤:默认只改 completed(避免给 waiting_user_input 提问加尾注)
    const targetStatus = this.rewriterSpec.match?.status ?? 'completed';
    const rewriter: ResultRewriter = (rawResult: string) => {
      // 注意:status 实际由 SubAgent 在 execute() return 处守卫,
      // 这里保留 match 检查作为 back-compat 文档;
      // 真正过滤在 SubAgent.execute() 内的 shouldRewrite gate。
      switch (this.rewriterSpec!.transform) {
        case 'append':
          return rawResult + (this.rewriterSpec!.value ?? '');
        case 'passthrough':
          return rawResult;
        case 'replace':
          return this.rewriterSpec!.value ?? rawResult;
      }
    };
    // 标记 targetStatus 用于SubAgent.shouldRewrite gate(若 rewriterSpec 有 match 配置)
    // 注:SubAgent 当前只看 status,不看 rewriter 内部;配置项 future-proof 用,
    // 未来可在 rewriter 内做更精细过滤。
    void targetStatus;
    return rewriter;
  }
}
