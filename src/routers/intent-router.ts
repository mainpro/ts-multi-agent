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
  // 当前会话上下文（最新鲜）
  sessionContext: {
    skill: string;
    confidence: number;
    turnCount: number;
  } | null;

  // 追问检测
  followup: {
    detected: boolean;
    confidence: number;
    pattern?: string;
  };

  // 关键词匹配
  keywordMatch: {
    skill: string;
    confidence: number;
    matchedKeywords: string[];
  } | null;

  // 历史技能（较旧）
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

  private isFollowUpQuestion(
    userInput: string,
    recentHistory?: Array<{ role?: string; content?: string; skill?: string; system?: string }>
  ): { isFollowUp: boolean; matchedSkill?: string; confidence: number } {
    if (!recentHistory || recentHistory.length === 0) {
      return { isFollowUp: false, confidence: 0 };
    }

    const lastAssistantMsg = recentHistory
      .slice()
      .reverse()
      .find(m => m.role === 'assistant' && m.content);

    if (!lastAssistantMsg) {
      return { isFollowUp: false, confidence: 0 };
    }

    const trimmedInput = userInput.trim().toLowerCase();
    const assistantContent = lastAssistantMsg.content?.toLowerCase() || '';

    const followUpPatterns = [
      /^(那|但是|可是|不过|那如果|那请问|那能否|那能不能|那可以|那麻烦|那能否)/,
      /^(我|我们)?(不|没|没有)?.*?(的话|的话呢)?[，,]?(那|但是|可是|不过)?.*?[能|可以|麻烦|请|帮].*?([吗|呢|吧])?$/,
      /^(为什么|怎么|能否|可以|麻烦|请帮|能不能|那能|那可以|那不|如果|要是|假设)/,
      /^(好的|行|可以|没问题|不行|不对|不是|但是|可是).*?(那|那能|那可以|那请问|那如果|那麻烦)/,
      /那.*?(能|可以|麻烦|请|帮|怎么|为什么).*?([吗呢吧])$/,
    ];

    const isFollowUpPattern = followUpPatterns.some(pattern => pattern.test(trimmedInput));

    const keywords = ['权限', '开通', '申请', '添加', '配置', '财务', 'GEAM', 'EES', '报销', '凭证'];
    const hasContextKeyword = keywords.some(kw =>
      trimmedInput.includes(kw) && assistantContent.includes(kw)
    );

    const pronounPatterns = [/这个/, /那个/, /它/, /这样/, /那样/, /上述/, /前面/, /刚才/, /之前/];
    const hasPronoun = pronounPatterns.some(p => p.test(trimmedInput));

    const isShortInput = trimmedInput.length < 10;

    const recentSkill = this.extractRecentSkill(recentHistory);

    if (recentSkill) {
      if (isFollowUpPattern && (hasContextKeyword || hasPronoun)) {
        console.log(`[IntentRouter] 🔄 检测到高置信度追问: "${userInput}" -> ${recentSkill}`);
        return { isFollowUp: true, matchedSkill: recentSkill, confidence: 0.95 };
      }

      if (isFollowUpPattern) {
        console.log(`[IntentRouter] 🔄 检测到追问模式: "${userInput}" -> ${recentSkill}`);
        return { isFollowUp: true, matchedSkill: recentSkill, confidence: 0.85 };
      }

      if (isShortInput && hasContextKeyword) {
        console.log(`[IntentRouter] 🔄 检测到短追问: "${userInput}" -> ${recentSkill}`);
        return { isFollowUp: true, matchedSkill: recentSkill, confidence: 0.8 };
      }
    }

    return { isFollowUp: false, confidence: 0 };
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

    // 1. Session Context（最高优先级之一）
    let sessionContext: AuxiliarySignals['sessionContext'] = null;
    if (sessionId && sessionContextService.hasActiveContext(sessionId)) {
      const ctx = sessionContextService.getContext(sessionId);
      if (ctx.currentSkill) {
        // 轮次越少，置信度越高
        const turnPenalty = Math.min(0.15, ctx.turnCount * 0.03);
        const confidence = Math.max(0.70, 0.90 - turnPenalty);
        sessionContext = {
          skill: ctx.currentSkill,
          confidence,
          turnCount: ctx.turnCount,
        };
        console.log(`[IntentRouter] 💡 Session Context: ${ctx.currentSkill} (置信度: ${confidence.toFixed(2)}, 轮次: ${ctx.turnCount})`);
      }
    }

    // 2. 追问检测
    const followUpResult = this.isFollowUpQuestion(trimmedInput, recentHistory);
    const followup: AuxiliarySignals['followup'] = {
      detected: followUpResult.isFollowUp,
      confidence: followUpResult.confidence,
      pattern: followUpResult.isFollowUp ? 'followup_pattern' : undefined,
    };

    // 3. 关键词匹配
    const keywordResult = this.keywordMatchSkill(trimmedInput);
    let keywordMatch: AuxiliarySignals['keywordMatch'] = null;
    if (keywordResult.matchedSkill && keywordResult.confidence > 0) {
      keywordMatch = {
        skill: keywordResult.matchedSkill,
        confidence: keywordResult.confidence,
        matchedKeywords: [],
      };
      console.log(`[IntentRouter] 🔑 关键词匹配: ${keywordResult.matchedSkill} (置信度: ${keywordResult.confidence})`);
    }

    // 4. 历史技能
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
      console.log(`[IntentRouter] 📜 历史技能: ${recentSkill} (置信度: ${confidence.toFixed(2)})`);
    }

    // 5. 用户画像
    const userProfileSignal: AuxiliarySignals['userProfile'] = {
      department: userProfile?.department,
      commonSystems: userProfile?.commonSystems || [],
      confidence: 0.60,
    };

    return {
      sessionContext,
      followup,
      keywordMatch,
      historicalSkill,
      userProfile: userProfileSignal,
    };
  }

  /**
   * 决策引擎：根据信号计算置信度，决定是否需要 LLM
   */
  private decide(signals: AuxiliarySignals, userInput: string): DecisionResult {
    const trimmedInput = userInput.trim();

    // 1. 快速闲聊检测（零延迟）
    const fastResult = this.fastClassify(trimmedInput, undefined);
    if (fastResult && fastResult.intent === 'small_talk') {
      console.log(`[IntentRouter] ⚡ 快速闲聊匹配`);
      return {
        intent: 'small_talk',
        confidence: 0.98,
        matchedSkill: undefined,
        method: 'fast_small_talk',
        needLLM: false,
      };
    }

    // 2. 追问检测（高优先级）
    if (signals.followup.detected && signals.followup.confidence >= 0.85) {
      let matchedSkill: string | undefined;
      
      if (signals.followup.confidence >= 0.95) {
        matchedSkill = signals.sessionContext?.skill || signals.historicalSkill?.skill;
      } else {
        matchedSkill = signals.historicalSkill?.skill;
      }

      if (matchedSkill) {
        console.log(`[IntentRouter] ⚡ 追问检测 → 沿用技能: ${matchedSkill}`);
        return {
          intent: 'skill_task',
          confidence: signals.followup.confidence,
          matchedSkill,
          matchedSkills: [matchedSkill],
          method: 'fast_followup',
          needLLM: false,
        };
      }
    }

    // 3. Session Context 单独命中
    if (signals.sessionContext && signals.sessionContext.confidence >= 0.88) {
      const skill = signals.sessionContext.skill;
      console.log(`[IntentRouter] ⚡ Session Context 直接匹配: ${skill}`);
      return {
        intent: 'skill_task',
        confidence: signals.sessionContext.confidence,
        matchedSkill: skill,
        matchedSkills: [skill],
        method: 'fast_session',
        needLLM: false,
      };
    }

    // 4. 关键词单命中 + 输入简单
    if (signals.keywordMatch && 
        signals.keywordMatch.confidence >= 0.85 && 
        trimmedInput.length < 20) {
      console.log(`[IntentRouter] ⚡ 关键词快速匹配: ${signals.keywordMatch.skill}`);
      return {
        intent: 'skill_task',
        confidence: signals.keywordMatch.confidence,
        matchedSkill: signals.keywordMatch.skill,
        matchedSkills: [signals.keywordMatch.skill],
        method: 'fast_keyword',
        needLLM: false,
      };
    }

    // 5. 多信号一致（Session + Keyword）
    if (signals.sessionContext && signals.keywordMatch) {
      if (signals.sessionContext.skill === signals.keywordMatch.skill) {
        const confidence = Math.min(0.92, signals.sessionContext.confidence + 0.05);
        console.log(`[IntentRouter] ⚡ 多信号一致 → 提高置信度: ${confidence}`);
        return {
          intent: 'skill_task',
          confidence,
          matchedSkill: signals.sessionContext.skill,
          matchedSkills: [signals.sessionContext.skill],
          method: 'multi_signal_agree',
          needLLM: false,
        };
      }
    }

    // 6. 需要 LLM 综合判断
    console.log(`[IntentRouter] 🤖 需要 LLM 综合判断`);
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
        return {
          intent: 'small_talk',
          confidence: decision.confidence,
          suggestedResponse: fastResult?.suggestedResponse,
        };
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
        userProfile
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
    // 检查闲聊模式
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

  // 检查超出范围
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
    userProfile?: UserProfile
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

    let prompt = `【用户当前输入】
${userInput}

【辅助信息（置信度评分）】`;

    if (signals.sessionContext) {
      prompt += `\n- Session Context: ${signals.sessionContext.skill} (置信度: ${signals.sessionContext.confidence.toFixed(2)}, 轮次: ${signals.sessionContext.turnCount})`;
    }

    if (signals.followup.detected) {
      prompt += `\n- 追问检测: 是 (置信度: ${signals.followup.confidence.toFixed(2)})`;
    }

    if (signals.keywordMatch) {
      prompt += `\n- 关键词命中: ${signals.keywordMatch.skill} (置信度: ${signals.keywordMatch.confidence.toFixed(2)})`;
    }

    if (signals.historicalSkill) {
      prompt += `\n- 历史技能: ${signals.historicalSkill.skill} (置信度: ${signals.historicalSkill.confidence.toFixed(2)})`;
    }

    if (signals.userProfile.commonSystems.length > 0) {
      prompt += `\n- 常用系统: ${signals.userProfile.commonSystems.join(', ')}`;
    }

    prompt += `

【决策指引】
1. 如果是闲聊/结束语（你好、好的、谢谢等）→ intent=small_talk
2. 如果追问检测命中，且有历史/Session技能 → 沿用该技能
3. 如果多个信号指向同一技能 → 提高置信度
4. 如果用户输入包含多个问题（逗号/问号分隔）→ 返回多个技能

请综合以上信息判断用户意图。`;

    const result = await this.llm.generateStructured(
      prompt,
      IntentSchema,
      systemPrompt
    );

    if (result.intent === 'small_talk') {
      return {
        intent: 'small_talk',
        confidence: result.confidence || 0.9,
        suggestedResponse: this.generateSmallTalkResponse('thanks', userProfile),
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
   * 生成闲聊回复
   */
  private generateSmallTalkResponse(type: string, userProfile?: UserProfile): string {
    const skills = this.skillRegistry.getAllMetadata();
    const skillNames = skills.map(s => s.name).join('、');
    const skillList = skills.length > 0
      ? `我可以帮您解决${skillNames}等问题。`
      : '目前暂无可用功能。';

    const systems = userProfile?.commonSystems || [];
    const department = userProfile?.department || '';

    const responses: Record<string, string> = {
      greeting: `您好！${department ? department + '的同事，' : ''}我可以帮您处理${systems.length > 0 ? systems.join('、') : '相关业务'}问题。${skillList}\n\n请问您需要什么帮助？`,
      empathy: `听起来您今天状态不太好呀～工作生活中难免有低潮的时候。如果有什么我能帮您处理的，比如报销、差旅这些问题，可以随时告诉我。`,
      identity: `我是运维智能体，一个智能助手。${department ? department + '的同事，' : ''}我可以帮您处理${systems.length > 0 ? systems.join('、') : '相关业务'}问题。${skillList}\n\n请告诉我您需要什么帮助？`,
      thanks: `不客气！如果还有其他问题，随时可以问我。${skillList}`,
      goodbye: `再见！有需要随时找我。${skillList}`,
      help: `您好！我是运维智能体。${skillList}\n\n请直接告诉我您需要什么帮助，我会尽力为您解决。`,
      capability: `我是运维智能体，目前我可以帮您解决以下问题：\n\n${skills.map(s => `• ${s.name}：${s.description}`).join('\n')}\n\n请告诉我您需要什么帮助？`,
    };

    return responses[type] || responses.greeting;
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
