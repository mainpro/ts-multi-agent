import { z } from 'zod';
import { ILLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { UserProfile } from '../types';
import { buildSkillMatcherPrompt } from '../prompts';
import { sessionContextService } from '../memory';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'IntentRouter' });

/**
 * 意图类型
 */
export type IntentType =
  | 'small_talk'   // 闲聊：你好、谢谢、再见
  | 'skill_task'   // 技能任务：需要执行技能
  | 'confirm_system' // 系统确认：需要用户确认具体系统
  | 'unclear';     // 无法匹配

/**
 * 任务项
 */
export interface TaskItem {
  requirement: string;
  skillName?: string;
  intent: 'skill_task' | 'unclear';
  params?: Record<string, unknown>;
}

/**
 * 意图识别结果
 */
export interface IntentResult {
  intent: IntentType;
  confidence?: number;
  tasks: TaskItem[];
  question?: {
    type: 'system_confirm' | 'skill_confirm';
    content: string;
    candidateSkills?: string[];
    metadata?: Record<string, unknown>;
  } | null;
}

/**
 * 极简意图路由器
 * 
 * 架构：
 * 所有输入统一走 LLM 判断（通过 Prompt 工程 + 置信度优化速度）
 * 
 * 设计原则：
 * - 不做本地规则拦截，让 LLM 自主判断
 * - 不做信号收集，信任 LLM 的语义理解
 * - 不做关键词匹配，信任 LLM 的语义理解
 * - 缓存层后续再加
 */
export class IntentRouter {
  constructor(
    private llm: ILLMClient,
    private skillRegistry: SkillRegistry,
  ) {
    const skills = this.skillRegistry.getAllMetadata();
    console.log(`[IntentRouter] 🚀 初始化完成`);
    console.log(`[IntentRouter] 🎯 技能: ${skills.map(s => s.name).join(', ')}`);
  }

  /**
   * 分类用户意图
   * 
   * 流程：
   * 1. LLM 判断（所有输入）
   */
  async classify(
    userInput: string,
    userProfile?: UserProfile,
    recentHistory?: Array<{ role?: string; content?: string; skill?: string; system?: string }>,
    sessionId?: string,
    _proceduralExperience?: Array<{ skillName: string; usageCount: number; lastSuccess: boolean }>,
    _userId?: string,
  ): Promise<IntentResult> {
    const startTime = Date.now();

    // LLM 判断（所有输入统一走 LLM）
    const result = await this.llmClassify(
      userInput,
      userProfile,
      recentHistory,
      sessionId
    );

    const elapsed = Date.now() - startTime;
    console.log(`[IntentRouter] 🤖 LLM 判断: ${result.intent} (${elapsed}ms, confidence=${result.confidence})`);

    return result;
  }

  /**
   * LLM 意图分类
   * 
   * 输入：用户输入 + 会话上下文 + 对话历史 + 技能列表
   * 输出：intent + confidence + tasks + friendlyResponse
   */
  private async llmClassify(
    userInput: string,
    userProfile?: UserProfile,
    recentHistory?: Array<{ role?: string; content?: string; skill?: string; system?: string }>,
    sessionId?: string
  ): Promise<IntentResult> {
    const skills = this.skillRegistry.getAllMetadata();
    const systemPrompt = buildSkillMatcherPrompt(skills);

    // LLM 返回的 Schema
    const IntentSchema = z.object({
      intent: z.enum(['skill_task', 'small_talk', 'confirm_system', 'unclear'])
        .describe('意图类型'),
      confidence: z.number().min(0).max(1).optional().default(0.8)
        .describe('置信度 0-1'),
      tasks: z.array(z.object({
        requirement: z.string().describe('任务描述'),
        skillName: z.string().optional().describe('匹配的技能名，无技能时省略'),
        intent: z.enum(['skill_task', 'unclear']).optional().default('skill_task').describe('任务意图'),
        params: z.record(z.unknown()).optional()
          .describe('从对话上下文中提取的参数'),
      })).optional().default([])
        .describe('任务列表'),
      question: z.union([
        z.object({
          type: z.enum(['system_confirm', 'skill_confirm']),
          content: z.string(),
          candidateSkills: z.array(z.string()).optional()
            .describe('候选技能名列表（1-3个）'),
        }),
        z.object({}).transform(() => null)
      ]).nullable().optional()
        .describe('询问内容'),
      friendlyResponse: z.string().optional()
        .describe('unclear 或 small_talk 时的友好回复'),
      reasoning: z.string().optional()
        .describe('决策理由（简短）'),
    });

    // 构建 Prompt
    let prompt = '';

    // 会话上下文
    if (sessionId) {
      const contextPrompt = sessionContextService.buildPriorityPrompt(sessionId);
      if (contextPrompt) {
        prompt += contextPrompt + '\n\n';
      }
    }

    // 对话历史（最近10轮）
    if (recentHistory && recentHistory.length > 0) {
      prompt += '【对话历史】\n';
      for (const msg of recentHistory.slice(-10)) {
        const role = msg.role === 'user' ? '用户' : '助手';
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        prompt += `${role}: ${content}\n`;
      }
      prompt += '\n';
    }

    // 用户画像（如果有用）
    if (userProfile?.department) {
      prompt += `【用户信息】\n部门: ${userProfile.department}\n\n`;
    }

    prompt += `【用户当前输入】\n${userInput}`;

    // 调用 LLM
    const traceId = `intent-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    log.info('llm.request', {
      traceId,
      type: 'intentClassify',
      sessionId,
      promptLength: prompt.length,
    });

    const result = await this.llm.generateStructured(
      prompt,
      IntentSchema,
      systemPrompt
    );

    log.info('llm.response', {
      traceId,
      intent: result.intent,
      confidence: result.confidence,
      tasks: result.tasks?.length || 0,
    });

    // 处理 LLM 返回结果
    return this.processLLMResult(result);
  }

  /**
   * 处理 LLM 返回结果
   */
  private processLLMResult(result: z.infer<ReturnType<typeof z.object>>): IntentResult {
    const allSkills = this.skillRegistry.getAllMetadata();

    // small_talk: 使用 LLM 生成的友好回复
    if (result.intent === 'small_talk') {
      const content = result.friendlyResponse || '您好！请问需要什么帮助？';
      return {
        intent: 'small_talk',
        confidence: result.confidence || 0.9,
        tasks: [],
        question: {
          type: 'skill_confirm',
          content,
        },
      };
    }

    // confirm_system: 反问确认系统
    if (result.intent === 'confirm_system') {
      const candidateSkills = (result.question as any)?.candidateSkills as string[] | undefined;
      let content: string;

      if (candidateSkills && candidateSkills.length > 0) {
        const candidateNames = candidateSkills.map(skillName => {
          const skill = allSkills.find(s => s.name === skillName);
          return skill?.metadata?.systemName || skillName;
        });
        content = `请问您指的是以下哪个？\n${candidateNames.map(n => `- ${n}`).join('\n')}`;
      } else {
        content = '抱歉，我目前没有该系统的相关技能，请问您指的是以下哪个？';
      }

      return {
        intent: 'confirm_system',
        confidence: result.confidence || 0.9,
        tasks: [],
        question: {
          type: 'system_confirm',
          content,
          candidateSkills,
        },
      };
    }

    // unclear: 无法匹配
    if (result.intent === 'unclear' || (result.tasks || []).length === 0) {
      const content = result.friendlyResponse || this.generateUnclearResponse();
      return {
        intent: 'unclear',
        confidence: result.confidence || 0.7,
        tasks: [],
        question: {
          type: 'skill_confirm',
          content,
        },
      };
    }

    // skill_task: 验证并映射技能名称
    let tasks = result.tasks || [];
    tasks = tasks.map((task: any) => {
      if (!task.skillName) return task;

      // 精确匹配
      if (this.skillRegistry.hasSkill(task.skillName)) {
        return task;
      }

      // 系统名匹配
      const bySystem = allSkills.find(s => s.metadata?.systemName === task.skillName);
      if (bySystem) {
        return { ...task, skillName: bySystem.name };
      }

      // 关键词匹配
      const byKeyword = allSkills.find(s => {
        const keywords = (s.metadata?.keywords as string[]) || [];
        return keywords.some(kw =>
          task.skillName?.includes(kw) || (task.skillName && kw.includes(task.skillName))
        );
      });
      if (byKeyword) {
        return { ...task, skillName: byKeyword.name };
      }

      // 无法匹配，返回原技能名（LLM 可能会猜错）
      return task;
    });

    return {
      intent: 'skill_task',
      confidence: result.confidence || 0.8,
      tasks,
    };
  }

  /**
   * 生成无法匹配的回复（兜底）
   */
  private generateUnclearResponse(): string {
    const skills = this.skillRegistry.getAllMetadata();
    const skillList = skills.length > 0
      ? skills.map(s => s.metadata?.systemName || s.name).join('、')
      : '暂无';
    return `抱歉，我暂时无法理解您的需求。\n\n我是运维智能体，主要可以帮您处理：${skillList}。\n\n请问您需要哪方面的帮助？`;
  }
}

// 引用 sessionContextService（需要确保在调用前已初始化）

export default IntentRouter;
