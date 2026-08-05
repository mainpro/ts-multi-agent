// src/agents/virtual-employee/employees/it-operations-consultant.ts

import type { EmployeeConfig, ResultRewriter } from '../types';
import { VirtualEmployee } from '../base';

/**
 * 示例虚拟员工:IT 运维顾问·小海。
 *
 * 业务属性:
 *   - 服务集团员工 IT 类问题(系统报错 / 桌面运维 / 网络 / 设备 / 工单 / 门禁权限)
 *   - 边界:不做人事 / 财务 / 销售 / 产品类问题(主动转接)
 *   - 风格:耐心、专业、礼貌;结尾追加"转人工 / 评价"提示
 *   - 技能:IT 类全 7 个 skill(本系统当前全部 skill 都是 IT 类)
 */
export class ITOperationsConsultantEmployee extends VirtualEmployee {
  readonly config: EmployeeConfig = {
    id: 'it-ops-consultant',
    displayName: 'IT 运维顾问·小海',
    intentKeywords: [
      'OA', 'VPN', '密码', '重装', '网络', '打印机', '工单', '门禁', '电脑',
      '系统报错', '登录不上', '白屏', '报销', '考勤', '请假', '出差', '加班',
      'EES', 'GEAM', '法务', '合同', '时间管理', '硫酸',
    ],
  };

  protected systemPromptPrefix(): string {
    return `你是「${this.config.displayName}」,集团 IT 服务台的虚拟员工。

【职责】接听集团员工 IT 类问题:系统报错(EES / GEAM / 法务 / 时间管理 / 差旅 / 兜底) / 桌面运维 / 网络连接 / 设备报修 / 工单查询 / 门禁权限申请。

【风格】耐心、专业、礼貌。先安抚用户情绪,再引导排查。每一步都说清楚"我接下来要做什么"和"请您提供什么信息"。

【边界】以下情况请礼貌告知并建议转接:
- 销售 / 产品 / 报价类需求 → "这块建议联系销售 / 产品同事"
- 业务决策 / 战略规划 → "这块建议联系业务负责人"
- 任何超出 IT 范围的请求都不要假装能解决`;
  }

  protected allowedSkillNames(): Set<string> | null {
    // 本次系统全部 7 个 skill 都是 IT 类,白名单 = 全开
    return new Set([
      'ees-qa',
      'fallback-service-desk',
      'fawu',
      'geam-qa',
      'sulfuric-acid-price-prediction',
      'time-management-qa',
      'travel-expense-apply',
    ]);
  }

  protected resultRewriter(): ResultRewriter | null {
    return (rawResult: string) => {
      const trailing = '\n\n---\n如果您尝试后仍未解决,请回复「转人工」,我会把您转给值班工程师;也可以回复「评价」给我本次服务打个分。';
      return rawResult + trailing;
    };
  }
}
