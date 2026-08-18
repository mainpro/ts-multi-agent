import { z } from 'zod';
import { ILLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { SkillMetadata, TaskPlan } from '../types';
import { buildTaskPlannerPrompt } from '../prompts';
import { createLogger } from '../observability/logger';
import type { EmployeeAgent } from '../agents/employee/agent';

const log = createLogger({ module: 'UnifiedPlanner' });

/**
 * 统一规划器 - 将需求分析、技能匹配、任务规划合并为一次 LLM 调用
 * 
 * 优化前流程（3-4次 LLM 调用）：
 * 1. IntentRouter.classify() - 意图分类
 * 2. analyzeRequirement() - 需求分析
 * 3. discoverSkills() - 技能匹配
 * 4. createPlan() - 任务规划
 * 
 * 优化后流程（2次 LLM 调用）：
 * 1. IntentRouter.classify() - 意图分类（保留，有快速路径）
 * 2. UnifiedPlanner.plan() - 统一规划（合并分析+匹配+规划）
 */

/**
 * 统一规划结果 Schema
 */
const UnifiedPlanSchema = z.object({
  analysis: z.object({
    summary: z.string().optional(),
    entities: z.any().optional(),
    intent: z.string().optional(),
  }).passthrough().optional().default({}),

  skillSelection: z.any().optional(),

  plan: z.object({
    needsClarification: z.boolean().optional(),
    clarificationPrompt: z.string().optional(),
    tasks: z.array(z.any()),
  }),
});

export type UnifiedPlanResult = z.infer<typeof UnifiedPlanSchema>;

/**
 * 规划结果（对外接口）
 */
export interface PlanResult {
  success: boolean;
  plan?: TaskPlan;
  needsClarification?: boolean;
  clarificationPrompt?: string;
  analysis?: {
    summary: string;
    entities?: string[];
    intent?: string;
  };
  matchedSkills?: SkillMetadata[];
}

/**
 * 统一规划器
 */
export class UnifiedPlanner {
  constructor(
    private llm: ILLMClient,
    private skillRegistry: SkillRegistry
  ) {}

  /**
   * 执行统一规划
   * 一次 LLM 调用完成：需求分析 + 技能匹配 + 任务规划
   *
   * Task 8: 签名从 (requirement, opts: { hint }) 改为 (requirement, employee: EmployeeAgent)。
   *   - employee.decompositionHint 注入到 userPrompt 末尾的【拆解偏好】段落
   *   - 生成的每个 task 自动携带 employeeId = employee.id
   */
  async plan(
    requirement: string,
    employee: EmployeeAgent,
  ): Promise<PlanResult> {
    log.info('开始统一规划', { requirement, employeeId: employee.id });

    const allSkills = this.skillRegistry.getAllMetadata();
    log.debug('可用技能', { skills: allSkills.map(s => s.name).join(', ') });

    if (allSkills.length === 0) {
      log.warn('没有可用技能');
      return {
        success: false,
        needsClarification: true,
        clarificationPrompt: '抱歉，当前系统没有可用的技能。请联系管理员配置技能。',
      };
    }

  const systemPrompt = buildTaskPlannerPrompt(allSkills);

  const userPrompt = this.buildPrompt(requirement, employee.decompositionHint);

  try {
    log.info('发送统一规划请求');

    const result = await this.llm.generateStructured(
      userPrompt,
      UnifiedPlanSchema,
      systemPrompt
    );

      log.info('规划完成');

      // 提取选中的技能（处理两种格式）
      const selectedSkillNames: string[] = Array.isArray(result.skillSelection)
        ? result.skillSelection
        : (result.skillSelection as { selectedSkills?: string[] }).selectedSkills || [];

      log.info('规划结果', { intent: result.analysis?.intent, selectedSkills: selectedSkillNames.join(', '), taskCount: result.plan.tasks.length });

      // 检查是否需要澄清
      if (result.plan.needsClarification) {
        log.info('需要澄清', { prompt: result.plan.clarificationPrompt });
        return {
          success: false,
          needsClarification: true,
          clarificationPrompt: result.plan.clarificationPrompt,
        };
      }

      // 验证选中的技能是否存在
      const matchedSkills = selectedSkillNames
        .map(name => allSkills.find(s => s.name === name))
        .filter((s): s is SkillMetadata => s !== undefined);

  if (matchedSkills.length === 0) {
    log.warn('没有匹配到有效技能');
    const skillDescriptions = allSkills.map(s => `- **${s.name}**: ${s.description}`).join('\n');
    return {
      success: false,
      needsClarification: true,
      clarificationPrompt: `抱歉，无法找到合适的技能来处理您的请求。\n\n可用技能：\n${skillDescriptions}`,
    };
  }

      // 构建返回的计划（处理多种字段名）
      const planId = `plan-${Date.now()}`;
      const taskPlan: TaskPlan = {
        id: planId,
        requirement,
        needsClarification: false,
        tasks: result.plan.tasks.map(task => ({
          id: task.id,
          requirement: task.requirement || task.description || requirement,
          skillName: task.skillName || task.skill || selectedSkillNames[0] || '',
          params: task.params || {},
          dependencies: task.dependencies || [],
          // Task 8: 由 MainAgent(IntentRouter 路由 + 派单)写入的目标员工 ID。
          // UnifiedPlanner 已持有 EmployeeAgent,直接注入。
          employeeId: employee.id,
        })),
      };

      return {
        success: true,
        plan: taskPlan,
        matchedSkills,
      };

    } catch (error) {
      log.error('规划失败', { error });
      return {
        success: false,
        needsClarification: true,
        clarificationPrompt: `抱歉，处理请求时发生错误。请稍后重试或换一种方式描述您的需求。`,
      };
    }
  }

  /**
   * 构造 user prompt,仅在末尾追加【拆解偏好】段落(若 hint 存在),
   * 不改动原有 base 部分(保持与未传 hint 时的兼容行为)。
   */
  private buildPrompt(requirement: string, hint?: string): string {
    const base = `需求: "${requirement}"`;
    const hintSection = hint ? `\n\n【拆解偏好】\n${hint}` : '';
    return base + hintSection;
  }
}

export default UnifiedPlanner;
