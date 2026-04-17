import { z } from 'zod';
import { LLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { UserProfile } from '../types';
import { buildSkillMatcherPrompt } from '../prompts';
import { sessionContextService } from '../memory';

export type IntentType =
  | 'small_talk' // 闲聊：你好、你是谁、谢谢
  | 'skill_task' // 技能任务：需要执行技能
  | 'out_of_scope' // 超出范围：天气、新闻等
  | 'confirm_system' // 系统确认：需要用户确认具体系统
  | 'unclear'; // 无法匹配

export interface TaskItem {
  requirement: string;
  skillName?: string;
  intent: 'skill_task' | 'unclear';
  params?: Record<string, unknown>;
}

export interface IntentResult {
  intent: IntentType;
  confidence?: number;
  tasks: TaskItem[];
  guessedSystem?: string;
  confirmOptions?: string[];
  
  question?: {
    type: 'system_confirm' | 'skill_confirm';
    content: string;
    metadata?: Record<string, unknown>;
  } | null;
}

/**
 * 辅助信息结构（传递给 LLM 的信号）
 */
export interface AuxiliarySignals {
  // 当前会话上下文
  sessionContext: {
    skill: string;
    confidence: number;
    turnCount: number;
  } | null;

  // 关键词匹配
  keywordMatch: {
    skill: string;
    confidence: number;
    matchedKeywords: string[];
  } | null;

  // 历史技能
  historicalSkill: {
    skill: string;
    confidence: number;
    turnsAgo: number;
  } | null;

  // 用户画像
  userProfile: {
    department?: string;
    commonSystems: string[];
    confidence: number;
  };
}

/**
 * 决策结果
 */
interface DecisionResult {
  intent: IntentType;
  confidence: number;
  method: 'fast_small_talk' | 'fast_followup' | 'fast_session' | 'fast_keyword' | 'multi_signal_agree' | 'llm_decision';
  needLLM: boolean;
  auxiliarySignals?: AuxiliarySignals;
}

/**
 * 闲聊模式定义
 */
interface SmallTalkPattern {
  patterns: RegExp[];
  responseType: 'greeting' | 'empathy' | 'identity' | 'thanks' | 'goodbye' | 'help' | 'capability';
}

/**
 * 快速应答模式配置
 */
const SMALL_TALK_CONFIGS: SmallTalkPattern[] = [
  {
    patterns: [
      /^(你好|您好|hi|hello|hey|早上好|下午好|晚上好)[!.?]?$/i,
    ],
    responseType: 'greeting',
  },
  {
    patterns: [
      /(心情不好|心情差|不爽|郁闷|难过|伤心|沮丧|烦恼|压力大|焦虑|累|疲惫|烦)/i,
      /(我今天|最近|今天)(心情|情绪|状态)(不好|差|糟|低落|烦)/i,
    ],
    responseType: 'empathy',
  },
  {
    patterns: [
      /^(你是谁|你叫什么|自我介绍|介绍一下你自己|你是那个|是什么)/i,
      /你(是)?什么(智能体|助手|系统|机器人)/i,
    ],
    responseType: 'identity',
  },
  {
    patterns: [
      /^(谢谢|感谢|thanks|thank you|多谢)[!.?]?$/i,
      /(好的|好的呢|好的呀|好的哦|没问题|ok|okay)[，,。\s]*(谢谢|感谢|thanks|thank you|多谢)/i,
      /(谢谢|感谢|thanks|thank you|多谢)[，,。\s]*(好的|没问题|ok|okay)/i,
    ],
    responseType: 'thanks',
  },
  {
    patterns: [
      /^(再见|拜拜|bye|goodbye|下次见)[!.?]?$/i,
      /(好的|好的呢|没问题|ok|okay)[，,。\s]*(再见|拜拜|bye|goodbye)/i,
    ],
    responseType: 'goodbye',
  },
  {
    patterns: [
      /^(怎么样|如何|怎么用|帮助|help|\?|？)$/i,
      /^(你能做什么|你会什么|你有什么功能|你能帮我什么)/i,
    ],
    responseType: 'help',
  },
  {
    patterns: [
      /^(有什么功能|有哪些功能|功能列表|能力)/i,
    ],
    responseType: 'capability',
  },
];

/**
 * 超出范围的模式
 */
const OUT_OF_SCOPE_PATTERNS = [
  /天气/,
  /气温/,
  /预报/,
  /新闻/,
  /头条/,
  /股票/,
  /股价/,
  /翻译/,
  /translate/i,
  /写(文章|作文|故事|诗|小说)/,
  /画画/,
  /绘画/,
  /生成图片/,
  /视频/,
  /音乐/,
  /歌曲/,
  /播放/,
  /订(票|餐|酒店|机票)/,
  /买/,
  /购物/,
  /订餐/,
  /外卖/,
  /地图/,
  /导航/,
  /路线/,
  /怎么走/,
  /打车/,
  /叫车/,
  /笑话/,
  /讲个笑话/,
  /游戏/,
  /玩游戏/,
  /今天.*几号/,
  /现在.*时间/,
  /几点/,
  /汇率/,
  /汇率/,
  /换算/,
  /表情/,
  /emoji/i,
];

/**
 * 意图路由器
 * 
 * 实现快速应答和意图分类：
 * 1. 关键词快速匹配（无 LLM 调用）
 * 2. 猜你想问（立即生成）
 * 3. LLM 匹配技能（并行）
 */
export class IntentRouter {
  private skillKeywordMap: Map<string, string[]> = new Map();

  constructor(
    private llm: LLMClient,
    private skillRegistry: SkillRegistry
  ) {
    this.buildKeywordMap();
  }

  private buildKeywordMap(): void {
    const skills = this.skillRegistry.getAllMetadata();
    const keywordMap = new Map<string, string[]>();

    for (const skill of skills) {
      const keywords = (skill.metadata?.keywords as string[]) || [];
      for (const kw of keywords) {
        if (!keywordMap.has(kw)) {
          keywordMap.set(kw, []);
        }
        keywordMap.get(kw)!.push(skill.name);
      }
    }

    console.log(`[IntentRouter] 📚 关键词映射已构建: ${keywordMap.size} 个关键词`);
    console.log(`[IntentRouter] 🎯 技能: ${skills.map(s => s.name).join(', ')}`);
    this.skillKeywordMap = keywordMap;
  }

  private keywordMatchSkill(userInput: string): { matchedSkills: string[]; confidence: number; isAmbiguous?: boolean } {
    const lowerInput = userInput.toLowerCase();
    const matchedSkills = new Set<string>();

    for (const [keyword, skills] of this.skillKeywordMap) {
      if (lowerInput.includes(keyword)) {
        for (const skill of skills) {
          matchedSkills.add(skill);
        }
      }
    }

    if (matchedSkills.size === 1) {
      const skill = Array.from(matchedSkills)[0];
      console.log(`[IntentRouter] ⚡ 关键词命中技能: ${skill} (唯一匹配)`);
      return { matchedSkills: [skill], confidence: 0.9 };
    } else if (matchedSkills.size > 1) {
      const skillList = Array.from(matchedSkills);
      console.log(`[IntentRouter] ⚠️ 关键词命中多个技能: ${skillList.join(', ')} (需要LLM决策)`);
      return { matchedSkills: skillList, confidence: 0.7, isAmbiguous: true };
    }

    return { matchedSkills: [], confidence: 0 };
  }

  /**
   * 从对话历史中提取最近使用的技能
   * 用于快速定位，跳过 LLM 匹配
   */
  extractRecentSkill(conversationHistory: Array<{ skill?: string }>): string | undefined {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const msg = conversationHistory[i];
      if (msg.skill) {
        return msg.skill;
      }
    }
    return undefined;
  }

  /**
   * 收集所有信号
   */
  private collectSignals(
    userInput: string,
    userProfile?: UserProfile,
    recentHistory?: Array<{ role?: string; content?: string; skill?: string; system?: string }>,
    sessionId?: string
  ): AuxiliarySignals {
    const trimmedInput = userInput.trim();

    let sessionContext: AuxiliarySignals['sessionContext'] = null;
    if (sessionId && sessionContextService.hasActiveContext(sessionId)) {
      const ctx = sessionContextService.getContext(sessionId);
      if (ctx.currentSkill) {
        const turnPenalty = Math.min(0.15, ctx.turnCount * 0.03);
        const confidence = Math.max(0.70, 0.90 - turnPenalty);
        sessionContext = {
          skill: ctx.currentSkill,
          confidence,
          turnCount: ctx.turnCount,
        };
      }
    }

    const keywordResult = this.keywordMatchSkill(trimmedInput);
    let keywordMatch: AuxiliarySignals['keywordMatch'] = null;
    if (keywordResult.matchedSkills.length > 0 && keywordResult.confidence > 0) {
      keywordMatch = {
        skill: keywordResult.matchedSkills[0],
        confidence: keywordResult.confidence,
        matchedKeywords: [],
      };
    }

    let historicalSkill: AuxiliarySignals['historicalSkill'] = null;
    const recentSkill = this.extractRecentSkill(recentHistory || []);
    if (recentSkill && recentSkill !== sessionContext?.skill) {
      const historyCount = recentHistory?.length || 0;
      const confidence = Math.max(0.60, 0.75 - historyCount * 0.02);
      historicalSkill = {
        skill: recentSkill,
        confidence,
        turnsAgo: historyCount,
      };
    }

    return {
      sessionContext,
      keywordMatch,
      historicalSkill,
      userProfile: {
        department: userProfile?.department,
        commonSystems: userProfile?.commonSystems || [],
        confidence: 0.60,
      },
    };
  }

  /**
   * 决策引擎：根据信号计算置信度，决定是否需要 LLM
   */
  private decide(signals: AuxiliarySignals, userInput: string): DecisionResult {
    const trimmedInput = userInput.trim();

    const fastResult = this.fastClassify(trimmedInput, undefined);
    if (fastResult && fastResult.intent === 'small_talk') {
      return {
        intent: 'small_talk',
        confidence: 0.98,
        method: 'fast_small_talk',
        needLLM: false,
      };
    }

    return {
      intent: 'skill_task',
      confidence: 0.70,
      method: 'llm_decision',
      needLLM: true,
      auxiliarySignals: signals,
    };
  }

  /**
   * 分类用户意图
   *
   * 策略：
   * 1. 收集所有信号（Session Context, 追问, 关键词, 历史, 用户画像）
   * 2. 决策引擎计算置信度
   * 3. 高置信度 → 快速返回
   * 4. 低置信度 → LLM 综合判断
   */
  async classify(userInput: string, userProfile?: UserProfile, recentHistory?: Array<{ role?: string; content?: string; skill?: string; system?: string }>, sessionId?: string): Promise<IntentResult> {
    // Step 1: 收集所有信号
    const signals = this.collectSignals(userInput, userProfile, recentHistory, sessionId);

    // Step 2: 决策引擎判断
    const decision = this.decide(signals, userInput);

    // Step 3: 快速路径 - 不需要 LLM
    if (!decision.needLLM) {
      if (decision.intent === 'small_talk') {
        const fastResult = this.fastClassify(userInput, userProfile);
        if (fastResult) {
          return {
            intent: 'small_talk',
            confidence: decision.confidence,
            tasks: [],
            question: {
              type: 'skill_confirm',
              content: fastResult.question?.content || '',
            },
          };
        }
        if (userInput.length < 25) {
          const llmResult = await this.llmClassifyChat(userInput);
          if (llmResult && llmResult.type !== 'other') {
            return {
              intent: 'small_talk',
              confidence: 0.85,
              tasks: [],
              question: {
                type: 'skill_confirm',
                content: this.generateSmallTalkResponse(llmResult.type, userProfile),
              },
            };
          }
        }
      }
      return {
        intent: decision.intent,
        confidence: decision.confidence,
        tasks: [],
      };
    }

    // Step 4: LLM 综合判断（传入所有辅助信息）
    const guessResponse = this.generateGuessQuestions();

    console.log(`[IntentRouter] 🤖 使用 LLM 匹配技能...`);
    try {
      const llmResult = await this.llmMatchSkillWithSignals(
        userInput,
        decision.auxiliarySignals!,
        userProfile,
        sessionId,
        recentHistory
      );

      if (llmResult.intent === 'small_talk') {
        console.log(`[IntentRouter] 💬 LLM 识别为闲聊/对话结束语`);
        return llmResult;
      }

      if (llmResult.intent === 'confirm_system') {
        console.log(`[IntentRouter] ❓ LLM 需要确认系统`);
        return {
          intent: 'confirm_system',
          confidence: llmResult.confidence || 0.9,
          tasks: [],
          question: llmResult.question,
        };
      }

      if (llmResult.tasks && llmResult.tasks.length > 0) {
        console.log(`[IntentRouter] ✅ LLM 返回任务: ${llmResult.tasks.length}个`);
        return {
          ...llmResult,
        };
      }

      console.log(`[IntentRouter] 💡 返回转人工`);
      return {
        intent: 'unclear',
        confidence: 0.8,
        tasks: [],
        question: {
          type: 'skill_confirm',
          content: guessResponse.fullResponse,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorType = error instanceof Error ? error.constructor.name : 'Unknown';
      console.log(`[IntentRouter] ⚠️ LLM 匹配失败: ${errorType} - ${errorMsg}`);
      return {
          intent: 'unclear',
          confidence: 0.7,
          tasks: [],
          question: {
            type: 'skill_confirm',
            content: guessResponse.fullResponse,
          },
        };
    }
  }

  /**
   * 匹配不到技能时返回转人工消息
   */
  generateGuessQuestions(): { systems: string[]; fullResponse: string } {
    return {
      systems: [],
      fullResponse: '您好，我帮您转到人工这边，让工程师进一步帮您排查一下。',
    };
  }

  /**
   * 快速关键词匹配
   */
  private fastClassify(userInput: string, userProfile?: UserProfile): IntentResult | null {
    for (const config of SMALL_TALK_CONFIGS) {
      for (const pattern of config.patterns) {
        if (pattern.test(userInput)) {
          return {
            intent: 'small_talk',
            confidence: 0.98,
            tasks: [],
            question: {
              type: 'skill_confirm',
              content: this.generateSmallTalkResponse(config.responseType, userProfile),
            },
          };
        }
      }
    }

    for (const pattern of OUT_OF_SCOPE_PATTERNS) {
    if (pattern.test(userInput)) {
      if (userProfile?.commonSystems?.length) {
        const guessedSystem = this.findBestMatch(userInput, userProfile.commonSystems);
        if (guessedSystem) {
          return {
            intent: 'confirm_system',
            confidence: 0.85,
            guessedSystem,
            tasks: [],
            question: {
              type: 'system_confirm',
              content: `请问您说的是"${guessedSystem}"吗？`,
            },
          };
        }
      }
      return {
        intent: 'out_of_scope',
        confidence: 0.95,
        tasks: [],
      };
    }
  }

    return null;
  }

  /**
   * LLM 技能匹配（使用辅助信号）
   */
  private async llmMatchSkillWithSignals(
    userInput: string,
    signals: AuxiliarySignals,
    userProfile?: UserProfile,
    sessionId?: string,
    recentHistory?: Array<{ role?: string; content?: string; skill?: string; system?: string }>
  ): Promise<IntentResult> {
    const skills = this.skillRegistry.getAllMetadata();
    const systemNames = skills
      .map(s => s.metadata?.systemName as string)
      .filter(Boolean);

    const IntentSchema = z.object({
      intent: z.enum(['skill_task', 'small_talk', 'confirm_system', 'unclear'])
        .describe('意图类型'),
      confidence: z.number().min(0).max(1).optional().default(0.8)
        .describe('置信度 0-1'),
      tasks: z.array(z.object({
        requirement: z.string().describe('任务描述'),
        skillName: z.string().optional().describe('匹配的技能名，无技能时省略'),
        intent: z.enum(['skill_task', 'unclear']).describe('任务意图'),
        params: z.record(z.unknown()).optional()
          .describe('从对话上下文中提取的参数，如 userId、department 等'),
      })).optional().default([])
        .describe('任务列表，每个任务包含requirement、skillName、intent、params'),
      question: z.union([
        z.object({
          type: z.enum(['system_confirm', 'skill_confirm']),
          content: z.string(),
        }),
        z.object({}).transform(() => null)
      ]).nullable().optional()
        .describe('询问内容，不需要反问时为null'),
      reasoning: z.string().optional()
        .describe('决策理由（简短）'),
    });

    const systemPrompt = buildSkillMatcherPrompt(skills);

    let prompt = '';

    if (sessionId) {
      const priorityPrompt = sessionContextService.buildPriorityPrompt(sessionId);
      if (priorityPrompt) {
        prompt += priorityPrompt + '\n\n';
      }
    }

    if (recentHistory && recentHistory.length > 0) {
      prompt += '【对话历史】\n';
      for (const msg of recentHistory.slice(-10)) {
        const role = msg.role === 'user' ? '用户' : '助手';
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        prompt += `${role}: ${content}\n`;
      }
      prompt += '\n';
    }

    prompt += `【用户当前输入】
${userInput}

【辅助信息】`;

    if (signals.keywordMatch) {
      prompt += `\n- 关键词匹配: ${signals.keywordMatch.skill}`;
    }

    if (signals.historicalSkill) {
      prompt += `\n- 历史使用技能: ${signals.historicalSkill.skill}`;
    }

    if (signals.userProfile.commonSystems.length > 0) {
      prompt += `\n- 常用系统: ${signals.userProfile.commonSystems.join(', ')}`;
    }

    prompt += '\n\n请根据会话上下文和辅助信息判断用户意图。';

    const result = await this.llm.generateStructured(
      prompt,
      IntentSchema,
      systemPrompt
    );

    if (result.intent === 'small_talk') {
      return {
        intent: 'small_talk',
        confidence: result.confidence || 0.9,
        tasks: [],
        question: {
          type: 'skill_confirm',
          content: this.generateSmallTalkResponse('', userProfile),
        },
      };
    }

    if (result.intent === 'confirm_system') {
      const confirmOptions = systemNames.join('"、"');
      return {
        intent: 'confirm_system',
        confidence: result.confidence || 0.9,
        tasks: [],
        question: result.question || {
          type: 'system_confirm',
          content: `请问您说的是"${confirmOptions}"中的哪一个？`,
        },
      };
    }

    let tasks = result.tasks || [];
    if (result.intent === 'unclear' || tasks.length === 0) {
      return {
        intent: 'unclear',
        confidence: 0.8,
        tasks: [],
      };
    }

    // 验证并映射技能名称
    const allSkills = this.skillRegistry.getAllMetadata();
    tasks = tasks.map(task => {
      if (task.skillName) {
        // 检查技能是否存在
        if (this.skillRegistry.hasSkill(task.skillName)) {
          return task;
        }
        
        // 尝试根据系统名或关键词匹配技能
        let matchedSkill = null;
        for (const skill of allSkills) {
          // 系统名匹配
          if (skill.metadata?.systemName === task.skillName) {
            matchedSkill = skill;
            break;
          }
          // 关键词匹配
          const keywords = skill.metadata?.keywords as string[] | undefined;
          if (keywords?.some(keyword =>
            task.skillName?.includes(keyword) || (task.skillName && keyword.includes(task.skillName))
          )) {
            matchedSkill = skill;
            break;
          }
        }
        
        if (matchedSkill) {
          console.log(`[IntentRouter] 技能名称映射: ${task.skillName} → ${matchedSkill.name}`);
          return {
            ...task,
            skillName: matchedSkill.name
          };
        }
      }
      return task;
    });

    return {
      intent: 'skill_task',
      confidence: result.confidence || 0.8,
      tasks,
      question: result.question,
    };
  }

  /**
   * 生成闲聊回复 - Claude 风格
   * 规则：
   * - 默认不主动闲聊，聚焦任务
   * - 用户闲聊时：1-3 句自然回复，不超过 4 行
   * - 禁止主动扩展话题、使用 emoji
   * - 不确定时直接问"需要我帮什么？"
   */
  private generateSmallTalkResponse(type: string, userProfile?: UserProfile): string {
    const department = userProfile?.department || '';
    const deptStr = department ? `${department}的同事，` : '';

    const templates: Record<string, () => string> = {
      greeting: () => `您好！${deptStr}请问需要什么帮助？`,
      empathy: () => `听起来状态不太好，有我能帮的随时说。`,
      identity: () => `我是运维智能体，${deptStr}可以帮您处理报销、考勤、权限等问题。`,
      thanks: () => '不客气，有其他问题随时问我。',
      goodbye: () => '再见，有需要随时找我。',
      help: () => `我是运维智能体，可以帮您处理报销、考勤、权限等问题。请告诉我需要什么？`,
      capability: () => {
        const skills = this.skillRegistry.getAllMetadata();
        return `我能帮您处理：${skills.map(s => s.name).join('、')}等问题。请问需要什么？`;
      },
    };

    const response = templates[type]?.() || templates.greeting();
    return response;
  }

  /**
   * LLM 闲聊分类 - 当快速匹配失败时使用
   * 只分类，不生成内容，确保不乱回复
   */
  async llmClassifyChat(userInput: string): Promise<{ type: string } | null> {
    try {
      const schema = z.object({
        type: z.enum(['greeting', 'thanks', 'goodbye', 'empathy', 'identity', 'help', 'other']),
      });

      const prompt = `判断用户意图类型：
- greeting: 打招呼（你好、早上好等）
- thanks: 感谢（谢谢、多谢等）
- goodbye: 告别（再见、拜拜等）
- empathy: 同理���（心情不好、累等）
- identity: 询问身份（你是谁、你是什么等）
- help: 请求帮助（怎么用、怎么操作等）
- other: 其他闲聊

用户输入: ${userInput}
只输出 JSON：{"type": "类型"}`;

      const result = await this.llm.generateStructured(prompt, schema);
      return { type: result.type };
    } catch {
      return null;
    }
  }

  /**
   * 生成澄清回复
   */
  generateClarificationResponse(): string {
    const skills = this.skillRegistry.getAllMetadata();
    const skillList = skills.length > 0
      ? skills.map(s => `• ${s.name}`).join('\n')
      : '暂无可用功能';

    return `抱歉，我不太理解您的需求。\n\n我是运维智能体，目前我可以帮您解决以下问题：\n\n${skillList}\n\n请告诉我您需要什么帮助？`;
  }

  private findBestMatch(input: string, systems: string[]): string | null {
    const lowerInput = input.toLowerCase();
    for (const system of systems) {
      const lowerSystem = system.toLowerCase();
      if (lowerSystem.includes(lowerInput) || lowerInput.includes(lowerSystem)) {
        return system;
      }
    }
    return null;
  }
}

export default IntentRouter;
