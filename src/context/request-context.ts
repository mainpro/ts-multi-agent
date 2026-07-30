/**
 * 请求级别的上下文存储
 *
 * 使用 Node.js AsyncLocalStorage 实现请求级别的数据传递，
 * 避免在 MainAgent/SubAgent 整条链路中逐层传递参数。
 *
 * 用法：
 *   // API 层：存入
 *   RequestContext.run({ accessToken, traceId }, async () => {
 *     await mainAgent.processRequirement(...);
 *   });
 *
 *   // 任意层：读取
 *   const ctx = RequestContext.get();
 *   const token = ctx?.accessToken;
 *   const traceId = ctx?.traceId;
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextData {
  /** 用户请求携带的 accessToken，透传给技能脚本 */
  accessToken?: string;
  /**
   * 请求级 trace ID,在 API 层入口生成,贯穿整条调用链。
   * Logger 自动从 AsyncLocalStorage 注入此字段到每条日志,
   * 运维可通过 `grep traceId=xxx` 一键串联单次请求的所有模块日志。
   */
  traceId?: string;
}

export const RequestContext = new AsyncLocalStorage<RequestContextData>();

/**
 * 获取当前请求的 accessToken
 */
export function getAccessToken(): string | undefined {
  return RequestContext.getStore()?.accessToken;
}

/**
 * 获取当前请求的 traceId
 */
export function getTraceId(): string | undefined {
  return RequestContext.getStore()?.traceId;
}
