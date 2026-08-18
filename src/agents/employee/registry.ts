import { createLogger } from '../../observability/logger';
import { BootstrapError } from '../../errors';
import { EmployeeAgent } from './agent';

const log = createLogger({ module: 'EmployeeRegistry' });

const FALLBACK_EMPLOYEE_ID = 'fallback-service-desk';

/**
 * 进程级员工注册表,启动期一次性 register,运行期只读。
 *
 * 不可变:Map 外部不可访问,内部 register 后不再修改。
 * 兜底:defaultFallback() 校验 fallback-service-desk 存在且 enabled,否则 fail-fast。
 */
export class EmployeeRegistry {
  private map = new Map<string, EmployeeAgent>();

  register(agent: EmployeeAgent): void {
    if (this.map.has(agent.id)) {
      throw new BootstrapError(
        'DUPLICATE_EMPLOYEE',
        `[DUPLICATE_EMPLOYEE] 员工 '${agent.id}' 已注册,重复注册被拒绝`,
      );
    }
    this.map.set(agent.id, agent);
    log.info('register', { employeeId: agent.id, displayName: agent.displayName });
  }

  get(employeeId: string): EmployeeAgent | undefined {
    return this.map.get(employeeId);
  }

  has(employeeId: string): boolean {
    return this.map.has(employeeId);
  }

  /** 只列 enabled 员工(给 LLM 看到、给上层枚举时都是 enabled) */
  list(): EmployeeAgent[] {
    return Array.from(this.map.values()).filter(a => a.isEnabled);
  }

  /**
   * 返回 fallback-service-desk 员工。
   * 缺失或 disabled 时抛 BootstrapError,启动 fail-fast。
   */
  defaultFallback(): EmployeeAgent {
    const fb = this.map.get(FALLBACK_EMPLOYEE_ID);
    if (!fb) {
      throw new BootstrapError(
        'FALLBACK_EMPLOYEE_MISSING',
        `[FALLBACK_EMPLOYEE_MISSING] 必备员工 "${FALLBACK_EMPLOYEE_ID}" 不在 registry 中`,
      );
    }
    if (!fb.isEnabled) {
      throw new BootstrapError(
        'FALLBACK_EMPLOYEE_DISABLED',
        `[FALLBACK_EMPLOYEE_DISABLED] 必备兜底员工 "${FALLBACK_EMPLOYEE_ID}" 配置中 enabled=false`,
      );
    }
    return fb;
  }

  /** 给 LLM prompt 注入员工列表 */
  listForLLM(): Array<{ id: string; brief: string }> {
    return this.list().map(a => ({ id: a.id, brief: a.displayName }));
  }
}
