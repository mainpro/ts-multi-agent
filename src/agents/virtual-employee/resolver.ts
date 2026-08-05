// src/agents/virtual-employee/resolver.ts

import { BusinessError } from '../../errors';
import type { EmployeeId } from './types';
import type { VirtualEmployee } from './base';
import { VirtualEmployeeRegistry } from './registry';

export interface ResolverOptions {
  hintedId?: EmployeeId;
  userMessage: string;
  skillRegistry: any;
  llm: any;
  memoryService?: any;
}

/**
 * 虚拟员工路由器。
 *
 * 二级 fallback 路由策略:
 *   1. 显式指定(hintedId / @提及)→ 直接拿
 *   2. 意图识别(扫描 config.intentKeywords)→ 第一个命中
 *   3. 默认员工(getDefaultCtor)→ fallback
 *
 * 错误码:
 *   - UNKNOWN_EMPLOYEE      hintedId 显式但不存在,或消息中有 @ 前缀但无法解析
 *   - NO_DEFAULT_EMPLOYEE   三级全部失败 + 消息中没有显式 @mention
 *
 * 注:消息中有 @mention 但未匹配时,不立即抛 UNKNOWN_EMPLOYEE,
 *     而是先让意图/默认路由尝试(因为 @X 后的内容仍可能命中意图)。
 *     仅当三级都失败且原始消息确实含 @ 前缀时,才抛 UNKNOWN_EMPLOYEE。
 */
export class VirtualEmployeeResolver {
  resolve(opts: ResolverOptions): VirtualEmployee {
    // ===== 1. hintedId 显式 =====
    if (opts.hintedId !== undefined) {
      const employee = VirtualEmployeeRegistry.getInstance(
        opts.hintedId, opts.skillRegistry, opts.llm, opts.memoryService,
      );
      if (!employee) {
        throw new BusinessError(
          'UNKNOWN_EMPLOYEE',
          `UNKNOWN_EMPLOYEE: 虚拟员工 '${opts.hintedId}' 不存在`,
        );
      }
      return employee;
    }

    // ===== 1b. @mention 解析 =====
    const hintedFromMessage = this.extractMention(opts.userMessage);
    if (hintedFromMessage) {
      const employee = VirtualEmployeeRegistry.getInstance(
        hintedFromMessage, opts.skillRegistry, opts.llm, opts.memoryService,
      )!;
      return employee;
    }

    // ===== 2. 意图识别关键词匹配(按注册顺序)=====
    const lowered = opts.userMessage.toLowerCase();
    for (const config of VirtualEmployeeRegistry.list()) {
      for (const kw of config.intentKeywords) {
        if (lowered.includes(kw.toLowerCase())) {
          const employee = VirtualEmployeeRegistry.getInstance(
            config.id, opts.skillRegistry, opts.llm, opts.memoryService,
          )!;
          return employee;
        }
      }
    }

    // ===== 3. 默认 fallback =====
    const defaultEmployee = VirtualEmployeeRegistry.getDefaultInstance(
      opts.skillRegistry, opts.llm, opts.memoryService,
    );
    if (defaultEmployee) {
      return defaultEmployee;
    }

    // ===== 三级全部失败 =====
    // 区分两种错误码:
    //   - 消息里有 @ 前缀(用户尝试 @ 某人)→ UNKNOWN_EMPLOYEE
    //   - 没有 @ 前缀(普通消息)→ NO_DEFAULT_EMPLOYEE
    if (this.containsAtMentionPrefix(opts.userMessage)) {
      throw new BusinessError(
        'UNKNOWN_EMPLOYEE',
        `UNKNOWN_EMPLOYEE: 消息中的 @mention 未能匹配到任何已注册员工(且无默认员工可兜底)`,
      );
    }
    throw new BusinessError(
      'NO_DEFAULT_EMPLOYEE',
      'NO_DEFAULT_EMPLOYEE: 没有可用的虚拟员工(意图未命中 + 没有注册默认员工)',
    );
  }

  /**
   * 从 userMessage 中提取 @mention。
   *
   * 例: "@IT小海 帮我..." → 优先按 id 查 'it-ops-consultant',
   * 否则按 displayName substring 匹配。
   *
   * **多 @ 行为(确定性)**:消息中存在多个 `@token` 时,只取第一个 —
   * `String.prototype.match` 不带 `g` 标志时仅返回首次匹配。
   * 这意味着相同输入永远派给同一个员工,不会出现"同一句话两次路由不同"。
   * 如果第一个 @ 未能解析(id 不存在 + displayName 不包含),则跳过
   * `extractMention` 路径,让兜底路由(意图/默认员工)接管。
   *
   * 解析不到时返回 undefined(由调用方在兜底全失败时再决定抛哪个错误码)。
   */
  extractMention(userMessage: string): EmployeeId | undefined {
    const mentionMatch = userMessage.match(/@([\p{L}\p{N}_-]+)/u);
    if (!mentionMatch) return undefined;
    const name = mentionMatch[1];

    // 直接当 id 查 — 通过 Registry.list() 里查找(避免触发 factory)
    if (VirtualEmployeeRegistry.list().some((c) => c.id === name)) return name;

    // 否则按 displayName 模糊匹配(取第一个命中)
    for (const config of VirtualEmployeeRegistry.list()) {
      if (config.displayName.includes(name)) {
        return config.id;
      }
    }
    return undefined;
  }

  /**
   * 消息中是否有 @ 前缀(用于决定兜底失败时的错误码)。
   *
   * 要求 `@` 前必须是字符串开头或空白字符,避免把 `hello@world.com`
   * 这类邮箱式文本误判为 mention。CJK 字符(无空格)也不应触发 —
   * 邮箱/CJK @ 紧贴前文一律视为非 mention。
   */
  containsAtMentionPrefix(userMessage: string): boolean {
    return /(?:^|\s)@[\p{L}\p{N}_-]/u.test(userMessage);
  }
}
