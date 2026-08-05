// src/agents/virtual-employee/types.ts

/**
 * 虚拟员工类型定义。
 * 虚拟员工 = 系统提供出去的、带着业务属性的智能体。
 * 每个员工有 persona / skill 白名单 / result 改写器 三件套。
 */

export type EmployeeId = string;

export interface EmployeeConfig {
  /** 唯一标识(用于注册表查找 + body 字段) */
  id: EmployeeId;
  /** 展示名称(用于 @mention 识别 + 前端展示) */
  displayName: string;
  /**
   * 意图路由关键词。
   * resolver 在无 @ 时扫描 userMessage,命中任一关键词即路由到此员工。
   * 大小写不敏感,substring 匹配(中文 / 英文都支持)。
   */
  intentKeywords: string[];
}

export type ResultRewriter = (rawResult: string) => string;