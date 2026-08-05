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
  isDefault: boolean;
}

/**
 * 虚拟员工注册表(进程内单例,静态)。
 *
 * 持有构造函数引用(不是实例),每次 getCtor() 后由 caller 注入外部共享的
 * skillRegistry / llm / memoryService,避免重复创建外部资源。
 */
export class VirtualEmployeeRegistry {
  private static entries = new Map<EmployeeId, Registration>();

  /** 注册一个虚拟员工。重复注册同一 id 抛错(避免覆盖)。 */
  static register(
    id: EmployeeId,
    ctor: VirtualEmployeeCtor,
    opts?: { isDefault?: boolean },
  ): void {
    if (this.entries.has(id)) {
      throw new Error(`VirtualEmployee id '${id}' already registered`);
    }
    this.entries.set(id, { ctor, isDefault: opts?.isDefault ?? false });
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
   * 通过临时实例化(传入 null 依赖)读取 config,生产代码不会调这个。
   */
  static list(): EmployeeConfig[] {
    const configs: EmployeeConfig[] = [];
    for (const { ctor } of this.entries.values()) {
      const tmp = new (ctor as any)(null, null);
      configs.push(tmp.config);
    }
    return configs;
  }

  /** 测试用:清空 registry。生产代码不要调。 */
  static _reset(): void {
    this.entries.clear();
  }
}
