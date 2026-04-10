import { z } from 'zod';
import { LLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { UserProfile } from '../types';
import { buildSkillMatcherPrompt } from '../prompts';
import { sessionContextService } from '../memory';
import * as fs from 'fs';
import * as path from 'path';

const KEYWORD_CACHE_FILE = 'data/keyword-cache.json';

/**
 * 意图类型
 */
export type IntentType =
  | 'small_talk' // 闲聊：你好、你是谁、谢谢
  | 'skill_task' // 技能任务：需要执行技能
  | 'out_of_scope' // 超出范围：天气、新闻等
  | 'guess_confirm' // 猜测确认：根据常用系统猜测意图
  | 'unclear'; // 不明确

/**
 * 意图分类结果
 */
export interface IntentResult {
  intent: IntentType;
  confidence?: number;
  suggestedResponse?: string;
  matchedSkill?: string;
  matchedSkills?: string[];
  guessedSystem?: string;
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
  matchedSkill?: string;
  matchedSkills?: string[];
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

    const cacheKey = JSON.stringify(skills.map(s => ({ name: s.name, description: s.description })));
    const cachedKeywords = this.loadKeywordCache(cacheKey);

    if (cachedKeywords) {
      for (const [kw, skillNames] of Object.entries(cachedKeywords)) {
        keywordMap.set(kw, skillNames);
      }
      console.log(`[IntentRouter] 📚 关键词映射已加载缓存: ${keywordMap.size} 个关键词`);
    } else {
      for (const skill of skills) {
        const keywords = this.extractKeywordsFromDescription(skill.description);

        for (const kw of keywords) {
          if (!keywordMap.has(kw)) {
            keywordMap.set(kw, []);
          }
          keywordMap.get(kw)!.push(skill.name);
        }
      }
      this.saveKeywordCache(cacheKey, Object.fromEntries(keywordMap));
      console.log(`[IntentRouter] 📚 关键词映射已构建: ${keywordMap.size} 个关键词`);
    }

    console.log(`[IntentRouter] 🎯 技能: ${skills.map(s => s.name).join(', ')}`);
    this.skillKeywordMap = keywordMap;
  }

  private loadKeywordCache(skillKey: string): Record<string, string[]> | null {
    try {
      if (!fs.existsSync(KEYWORD_CACHE_FILE)) return null;
      const cache = JSON.parse(fs.readFileSync(KEYWORD_CACHE_FILE, 'utf-8'));
      if (cache.key !== skillKey) return null;
      return cache.keywords;
    } catch {
      return null;
    }
  }

  private saveKeywordCache(skillKey: string, keywords: Record<string, string[]>): void {
    try {
      const dir = path.dirname(KEYWORD_CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(KEYWORD_CACHE_FILE, JSON.stringify({ key: skillKey, keywords }, null, 2));
    } catch (e) {
      console.warn('[IntentRouter] 关键词缓存保存失败:', e);
    }
  }

  private extractKeywordsFromDescription(description: string): string[] {
    const keywords: string[] = [];
    const fullText = `${description}`.toLowerCase();

    const stopWords = new Set([
      '的', '了', '是', '在', '和', '与', '或', '及', '等', '及', '可以', '能够', '需要', '可能', '如果', '那么',
      '用户', '系统', '问题', '情况', '相关', '功能', '操作', '使用', '帮助', '查询', '申请', '处理', '解决',
      'the', 'and', 'or', 'is', 'are', 'be', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from',
      '海尔', '集团', '助手', '触发', '场景', '排除', '包含', '涉及', '提到', '询问', '发送', '截图', '地址栏',
    ]);

    const chinesePattern = /[\u4e00-\u9fff]{2,6}/g;
    const chineseMatches = fullText.match(chinesePattern) || [];
    for (const word of chineseMatches) {
      if (!stopWords.has(word) && word.length >= 2 && !keywords.includes(word)) {
        keywords.push(word);
      }
    }

    const englishPattern = /[a-zA-Z]{2,}/g;
    const englishMatches = fullText.match(englishPattern) || [];
    for (const word of englishMatches) {
      const upper = word.toUpperCase();
      if (!stopWords.has(upper) && upper.length >= 2 && !keywords.includes(upper)) {
        keywords.push(upper);
      }
    }

    return keywords;
  }

  private keywordMatchSkill(userInput: string): { matchedSkill?: string; matchedSkills?: string[]; confidence: number; isAmbiguous?: boolean } {
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
      return { matchedSkill: skill, matchedSkills: [skill], confidence: 0.9 };
    } else if (matchedSkills.size > 1) {
      const skillList = Array.from(matchedSkills);
      console.log(`[IntentRouter] ⚠️ 关键词命中多个技能: ${skillList.join(', ')} (需要LLM决策)`);
      return { matchedSkill: skillList[0], matchedSkills: skillList, confidence: 0.7, isAmbiguous: true };
    }

    return { matchedSkill: undefined, matchedSkills: [], confidence: 0 };
  }

  /**
   * 从对话历史中提取最近使用的技能
   * 用于快速定位，跳过 LLM 匹配
   */
  extractRecentSkill(conversationHistory: Array<{ skill?: string }>): string | undefined {
    // 倒序查找，找到最近一个有 skill 的记录
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const msg = conversationHistory[i];
      if (msg.skill && msg.skill !== 'fallback') {
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
    if (keywordResult.matchedSkill && keywordResult.confidence > 0) {
      keywordMatch = {
        skill: keywordResult.matchedSkill,
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
        matchedSkill: undefined,
        method: 'fast_small_talk',
        needLLM: false,
      };
    }

    if (signals.sessionContext && signals.sessionContext.confidence >= 0.88 && trimmedInput.length < 20) {
      return {
        intent: 'skill_task',
        confidence: signals.sessionContext.confidence,
        matchedSkill: signals.sessionContext.skill,
        matchedSkills: [signals.sessionContext.skill],
        method: 'fast_session',
        needLLM: false,
      };
    }

    if (signals.keywordMatch && signals.keywordMatch.confidence >= 0.9 && trimmedInput.length < 15) {
      return {
        intent: 'skill_task',
        confidence: signals.keywordMatch.confidence,
        matchedSkill: signals.keywordMatch.skill,
        matchedSkills: [signals.keywordMatch.skill],
        method: 'fast_keyword',
        needLLM: false,
      };
    }

    if (signals.sessionContext && signals.keywordMatch && signals.sessionContext.skill === signals.keywordMatch.skill) {
      return {
        intent: 'skill_task',
        confidence: Math.min(0.92, signals.sessionContext.confidence + 0.05),
        matchedSkill: signals.sessionContext.skill,
        matchedSkills: [signals.sessionContext.skill],
        method: 'multi_signal_agree',
        needLLM: false,
      };
    }

    return {
      intent: 'skill_task',
      confidence: 0.70,
      matchedSkill: signals.keywordMatch?.skill || signals.sessionContext?.skill,
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
            suggestedResponse: fastResult.suggestedResponse,
          };
        }
        if (userInput.length < 25) {
          const llmResult = await this.llmClassifyChat(userInput);
          if (llmResult && llmResult.type !== 'other') {
            return {
              intent: 'small_talk',
              confidence: 0.85,
              suggestedResponse: this.generateSmallTalkResponse(llmResult.type, userProfile),
            };
          }
        }
      }
      return {
        intent: decision.intent,
        confidence: decision.confidence,
        matchedSkill: decision.matchedSkill,
        matchedSkills: decision.matchedSkills,
      };
    }

    // Step 4: LLM 综合判断（传入所有辅助信息）
    const guessResponse = this.generateGuessQuestions(userInput, userProfile);

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

      if (llmResult.matchedSkill && llmResult.matchedSkill !== 'fallback') {
        console.log(`[IntentRouter] ✅ LLM 匹配到技能: ${llmResult.matchedSkill}`);
        return {
          ...llmResult,
          suggestedResponse: undefined,
        };
      }

      console.log(`[IntentRouter] 💡 返回猜你想问`);
      return {
        intent: 'guess_confirm',
        confidence: 0.8,
        guessedSystem: guessResponse.systems[0] || undefined,
        suggestedResponse: guessResponse.fullResponse,
        matchedSkill: 'fallback',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorType = error instanceof Error ? error.constructor.name : 'Unknown';
      console.log(`[IntentRouter] ⚠️ LLM 匹配失败: ${errorType} - ${errorMsg}`);
      return {
        intent: 'guess_confirm',
        confidence: 0.7,
        guessedSystem: guessResponse.systems[0] || undefined,
        suggestedResponse: guessResponse.fullResponse,
        matchedSkill: 'fallback',
      };
    }
  }

  /**
   * 生成猜你想问（毫秒级，不调用 LLM）
   */
  generateGuessQuestions(userInput: string, userProfile?: UserProfile): { systems: string[]; fullResponse: string } {
    const department = userProfile?.department || '';
    const systems = userProfile?.commonSystems || [];

    // 截断过长输入，防止对话历史泄露到回复中
    const displayInput = userInput.length > 50 ? userInput.substring(0, 50) + '...' : userInput;

    let fullResponse: string;

    if (systems.length > 0) {
      const systemNames = systems.join('和');
      fullResponse = `您好～我看您是${department ? department + '的' : ''}平时使用${systemNames}较多，看您说"${displayInput}"，请问具体是哪个系统呀？另外大概多久前开始出现这个情况的呢？`;
    } else {
      fullResponse = this.generateClarificationResponse();
    }

    return { systems, fullResponse };
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
            suggestedResponse: this.generateSmallTalkResponse(config.responseType, userProfile),
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
            intent: 'guess_confirm',
            confidence: 0.85,
            guessedSystem,
            suggestedResponse: `您是想查询${guessedSystem}相关的问题吗？请确认或告诉我具体需求。`,
          };
        }
      }
      return {
        intent: 'out_of_scope',
        confidence: 0.95,
        matchedSkill: 'fallback',
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

    const IntentSchema = z.object({
      intent: z.enum(['skill_task', 'small_talk', 'unclear'])
        .describe('意图类型'),
      confidence: z.number().min(0).max(1).optional().default(0.8)
        .describe('置信度 0-1'),
      matchedSkill: z.string().optional().nullable()
        .describe('主匹配技能名称'),
      matchedSkills: z.array(z.string()).optional().nullable()
        .describe('所有匹配的技能列表'),
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
        suggestedResponse: this.generateSmallTalkResponse('', userProfile),
      };
    }

    if (result.intent === 'unclear' || !result.matchedSkill) {
      return {
        intent: 'unclear',
        confidence: 0.8,
        matchedSkill: 'fallback',
        matchedSkills: [],
      };
    }

    return {
      intent: 'skill_task',
      confidence: result.confidence || 0.8,
      matchedSkill: result.matchedSkill,
      matchedSkills: result.matchedSkills || [result.matchedSkill],
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
