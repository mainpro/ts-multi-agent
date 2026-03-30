import { z } from 'zod';
import { LLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { SkillMetadata, TaskPlan } from '../types';
import { buildTaskPlannerPrompt } from '../prompts';

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
    private llm: LLMClient,
    private skillRegistry: SkillRegistry
  ) {}

  /**
   * 执行统一规划
   * 一次 LLM 调用完成：需求分析 + 技能匹配 + 任务规划
   */
  async plan(requirement: string, matchedSkill?: string): Promise<PlanResult> {
    console.log(`[UnifiedPlanner] 🚀 开始统一规划...`);
    console.log(`[UnifiedPlanner] 📥 需求: "${requirement}"`);
    if (matchedSkill) {
      console.log(`[UnifiedPlanner] 🎯 已匹配技能: ${matchedSkill}`);
    }

    const allSkills = this.skillRegistry.getAllMetadata();
    console.log(`[UnifiedPlanner] 📋 可用技能: ${allSkills.map(s => s.name).join(', ')}`);

    if (allSkills.length === 0) {
      console.log(`[UnifiedPlanner] ⚠️ 没有可用技能`);
      return {
        success: false,
        needsClarification: true,
        clarificationPrompt: '抱歉，当前系统没有可用的技能。请联系管理员配置技能。',
      };
    }

  const systemPrompt = buildTaskPlannerPrompt(allSkills);

  const userPrompt = matchedSkill
    ? `需求: "${requirement}"\n匹配技能: ${matchedSkill}\n为该技能创建任务计划。`
    : `需求: "${requirement}"`;

  try {
    console.log(`[UnifiedPlanner] 🤖 发送统一规划请求...`);

    const result = await this.llm.generateStructured(
      userPrompt,
      UnifiedPlanSchema,
      systemPrompt
    );

      console.log(`[UnifiedPlanner] ✅ 规划完成`);

      // 提取选中的技能（处理两种格式）
      const selectedSkillNames: string[] = Array.isArray(result.skillSelection)
        ? result.skillSelection
        : (result.skillSelection as { selectedSkills?: string[] }).selectedSkills || [];

      console.log(`[UnifiedPlanner] 📊 分析意图: ${result.analysis?.intent || 'N/A'}`);
      console.log(`[UnifiedPlanner] 📊 选中技能: ${selectedSkillNames.join(', ')}`);
      console.log(`[UnifiedPlanner] 📊 任务数量: ${result.plan.tasks.length}`);

      // 检查是否需要澄清
      if (result.plan.needsClarification) {
        console.log(`[UnifiedPlanner] ❓ 需要澄清: ${result.plan.clarificationPrompt}`);
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
    console.log(`[UnifiedPlanner] ⚠️ 没有匹配到有效技能`);
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
          dependencies: task.dependencies || [],
        })),
      };

      return {
        success: true,
        plan: taskPlan,
        matchedSkills,
      };

    } catch (error) {
      console.error(`[UnifiedPlanner] ❌ 规划失败:`, error);
      return {
        success: false,
        needsClarification: true,
        clarificationPrompt: `抱歉，处理请求时发生错误。请稍后重试或换一种方式描述您的需求。`,
      };
    }
  }
}

export default UnifiedPlanner;
