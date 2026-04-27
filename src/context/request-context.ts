/**
 * 请求级别的上下文存储
 *
 * 使用 Node.js AsyncLocalStorage 实现请求级别的数据传递，
 * 避免在 MainAgent/SubAgent 整条链路中逐层传递参数。
 *
 * 用法：
 *   // API 层：存入
 *   RequestContext.run({ accessToken }, async () => {
 *     await mainAgent.processRequirement(...);
 *   });
 *
 *   // BashTool 层：读取
 *   const ctx = RequestContext.get();
 *   const token = ctx?.accessToken;
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextData {
  /** 用户请求携带的 accessToken，透传给技能脚本 */
  accessToken?: string;
}

export const RequestContext = new AsyncLocalStorage<RequestContextData>();

/**
 * 获取当前请求上下文
 */
export function getRequestContext(): RequestContextData | undefined {
  return RequestContext.getStore();
}

/**
 * 获取当前请求的 accessToken
 */
export function getAccessToken(): string | undefined {
  return RequestContext.getStore()?.accessToken;
}
