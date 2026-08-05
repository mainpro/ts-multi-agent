// src/agents/virtual-employee/registry.ts

import type { EmployeeId, EmployeeConfig } from './types';
import type { VirtualEmployee } from './base';
import type { SkillRegistry } from '../../skill-registry';
import type { ILLMClient } from '../../llm';
import type { MemoryService } from '../../memory/memory-service';

export type VirtualEmployeeCtor = new (
  skillRegistry: SkillRegistry,
  llm: ILLMClient,
  memoryService?: MemoryService,
) => VirtualEmployee;

interface Registration {
  ctor: VirtualEmployeeCtor;
  config: EmployeeConfig;
  isDefault: boolean;
}

/**
 * 虚拟员工注册表(进程内单例,静态)。
 *
 * 持有构造函数 + 静态 config,不会临时实例化(避免传 null 依赖崩溃)。
 * resolver / list() 直接读静态 config,SubAgent 构造函数副作用隔离。
 */
export class VirtualEmployeeRegistry {
  private static entries = new Map<EmployeeId, Registration>();

  /**
   * 注册一个虚拟员工。
   * 重复注册同一 id 抛错(避免覆盖)。
   *
   * @param config 静态 config(应在子类声明 `static readonly config` 并在此传入)。
   *               之所以要求显式传入,而不是从 ctor 实例临时 new 出来读,
   *               是为了避免 `(ctor as any)(null, null)` 这种侵入 SubAgent
   *               构造函数依赖的脆弱写法。
   */
  static register(
    id: EmployeeId,
    ctor: VirtualEmployeeCtor,
    config: EmployeeConfig,
    opts?: { isDefault?: boolean },
  ): void {
    if (this.entries.has(id)) {
      throw new Error(`VirtualEmployee id '${id}' already registered`);
    }
    this.entries.set(id, { ctor, config, isDefault: opts?.isDefault ?? false });
  }

  /** 拿构造函数(caller 注入依赖后 new 实例)。 */
  static getCtor(id: EmployeeId): VirtualEmployeeCtor | undefined {
    return this.entries.get(id)?.ctor;
  }

  /** 拿默认员工的构造函数(注册时标记 isDefault=true)。 */
  static getDefaultCtor(): VirtualEmployeeCtor | undefined {
    for (const reg of this.entries.values()) {
      if (reg.isDefault) return reg.ctor;
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
