import { createLogger } from '../../observability/logger';
import type { IntentResult } from '../../routers/intent-router';
import type { EmployeeAgent } from './agent';
import type { EmployeeRegistry } from './registry';

const log = createLogger({ module: 'EmployeeRouter' });

/**
 * 根据 IntentRouter 结果 + EmployeeRegistry 选择 EmployeeAgent。
 *
 * 路由规则:
 *   1. LLM 返回有效 employeeId → registry.get()
 *   2. 否则(undefined / 不存在 / 'unclear') → fallback-service-desk
 *
 * 永不抛错(兜底保证):即使 LLM 给了不存在的 id,也静默兜底。
 */
export function routeIntentToEmployee(
  intentResult: IntentResult,
  registry: EmployeeRegistry,
): EmployeeAgent {
  const employeeId = intentResult.employeeId;

  if (employeeId && registry.has(employeeId)) {
    return registry.get(employeeId)!;
  }

  if (employeeId) {
    log.warn('LLM 返回不存在的 employeeId,兜底到 fallback-service-desk', { employeeId });
  }

  return registry.defaultFallback();
}
