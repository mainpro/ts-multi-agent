// src/agents/virtual-employee/registry.ts

import type { EmployeeId, EmployeeConfig } from './types';
import type { VirtualEmployee } from './base';
import type { JsonEmployeeConfig } from './json-types';
import { JsonVirtualEmployee } from './json-employee';
import type { SkillRegistry } from '../../skill-registry';
import type { ILLMClient } from '../../llm';
import type { MemoryService } from '../../memory/memory-service';

export type VirtualEmployeeCtor = new (
  skillRegistry: SkillRegistry,
  llm: ILLMClient,
  memoryService?: MemoryService,
) => VirtualEmployee;

/**
 * 工厂函数:接收外部依赖,构造一个虚拟员工实例。
 * 两种来源共用同一签名:
 *  - TS 类的员工:`(sr, llm, ms) => new Ctor(sr, llm, ms)`
 *  - JSON 配置的员工:`(sr, llm, ms) => new JsonVirtualEmployee(json, sr, llm, ms)`
 */
export type VirtualEmployeeFactory = (
  skillRegistry: SkillRegistry,
  llm: ILLMClient,
  memoryService?: MemoryService,
) => VirtualEmployee;

interface Registration {
  /** 工厂函数:由 registry 调用生成实例(双轨共用) */
  factory: VirtualEmployeeFactory;
  /** TS 类 ctor(back-compat,JSON 路径为 undefined) */
  ctor?: VirtualEmployeeCtor;
  config: EmployeeConfig;
  isDefault: boolean;
}

/**
 * 虚拟员工注册表(进程内单例,静态)。
 *
 * 持有 factory + 静态 config,不会临时实例化(避免传 null 依赖崩溃)。
 * resolver / list() 直接读静态 config,SubAgent 构造函数副作用隔离。
 */
export class VirtualEmployeeRegistry {
  private static entries = new Map<EmployeeId, Registration>();

  /**
   * 注册一个 TS 类员工(back-compat 路径,复杂业务用)。
   * 重复注册同一 id 抛错(避免覆盖)。
   *
   * @param config 静态 config(应在子类声明 `static readonly config` 并在此传入)。
   */
  static register(
    id: EmployeeId,
    ctor: VirtualEmployeeCtor,
    config: EmployeeConfig,
    opts?: { isDefault?: boolean },
  ): void {
    this.registerInternal(
      id,
      (sr, llm, ms) => new ctor(sr, llm, ms),
      config,
      opts?.isDefault ?? false,
      { ctor },
    );
  }

  /**
   * 注册一个 JSON 配置员工(新增路径,简单业务用)。
   * json 必须已经过 zod 校验(parseJsonEmployeeConfig)。
   */
  static registerFromJson(json: JsonEmployeeConfig): void {
    const config: EmployeeConfig = {
      id: json.id,
      displayName: json.displayName,
      intentKeywords: json.intentKeywords,
    };
    this.registerInternal(
      json.id,
      (sr, llm, ms) => new JsonVirtualEmployee(json, sr, llm, ms),
      config,
      json.isDefault ?? false,
    );
  }

  /** 内部统一注册入口 */
  private static registerInternal(
    id: EmployeeId,
    factory: VirtualEmployeeFactory,
    config: EmployeeConfig,
    isDefault: boolean,
    extra: { ctor?: VirtualEmployeeCtor } = {},
  ): void {
    if (this.entries.has(id)) {
      throw new Error(`VirtualEmployee id '${id}' already registered`);
    }
    this.entries.set(id, { factory, config, isDefault, ctor: extra.ctor });
  }

  /**
   * 拿员工实例(caller 注入依赖,工厂产出实例)。
   * 这是 resolver 唯一应该用的入口,与来源(TS 类 / JSON)解耦。
   */
  static getInstance(
    id: EmployeeId,
    skillRegistry: SkillRegistry,
    llm: ILLMClient,
    memoryService?: MemoryService,
  ): VirtualEmployee | undefined {
    const reg = this.entries.get(id);
    if (!reg) return undefined;
    return reg.factory(skillRegistry, llm, memoryService);
  }

  /**
   * 拿构造函数(back-compat: TS 类返回 ctor,JSON 路径返回 undefined)。
   * 现有 caller 仅 extractMention 用 list() 查存在性,getCtor 当前不被 resolver 依赖。
   */
  static getCtor(id: EmployeeId): VirtualEmployeeCtor | undefined {
    return this.entries.get(id)?.ctor;
  }

  /** 拿默认员工的 ctor(TS 类路径)。JSON 路径(无 ctor)返回 undefined。 */
  static getDefaultCtor(): VirtualEmployeeCtor | undefined {
    for (const reg of this.entries.values()) {
      if (reg.isDefault) return reg.ctor;
    }
    return undefined;
  }

  /** 拿默认员工的实例(工厂包装,统一依赖注入,新代码主用此接口)。 */
  static getDefaultInstance(
    skillRegistry: SkillRegistry,
    llm: ILLMClient,
    memoryService?: MemoryService,
  ): VirtualEmployee | undefined {
    for (const reg of this.entries.values()) {
      if (reg.isDefault) return reg.factory(skillRegistry, llm, memoryService);
    }
    return undefined;
  }

  /**
   * 列出所有员工的配置(给前端 / Resolver 用)。
   * 直接读静态 config,不实例化。
   */
  static list(): EmployeeConfig[] {
    return Array.from(this.entries.values()).map(r => r.config);
  }

  /** 测试用:清空 registry。生产代码不要调。 */
  static _reset(): void {
    this.entries.clear();
  }
}
