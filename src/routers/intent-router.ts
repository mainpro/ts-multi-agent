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
   * 分类用户意图
   *
   * 策略：
   * 1. 先用关键词快速匹配闲聊/超出范围
   * 2. 检查对话历史，如果有已知技能则快速定位
   * 3. 立即生成猜你想问（不等待 LLM）
   * 4. 并行调用 LLM 匹配技能
   * 5. 根据 LLM 结果决定返回猜你想问还是技能
   */
  async classify(userInput: string, userProfile?: UserProfile, recentHistory?: Array<{ role?: string; content?: string; skill?: string; system?: string }>, sessionId?: string): Promise<IntentResult> {
    const trimmedInput = userInput.trim();

    // Step 0: 关键词快速匹配技能（零延迟，单一命中直接返回）
    const keywordResult = this.keywordMatchSkill(trimmedInput);
    if (keywordResult.matchedSkill && keywordResult.confidence >= 0.9 && !keywordResult.isAmbiguous) {
      return {
        intent: 'skill_task',
        confidence: keywordResult.confidence,
        matchedSkill: keywordResult.matchedSkill,
      };
    }

    // Step 0.5: 如果关键词命中多个技能，降低置信度但继续使用 LLM 决策
    // (isAmbiguous = true 时，让 LLM 进一步判断)

    // Step 1: 获取 Session Context（作为 LLM 匹配的参考）
    let sessionContextHint = '';
    if (sessionId && sessionContextService.hasActiveContext(sessionId)) {
      const sessionContext = sessionContextService.getContext(sessionId);
      if (sessionContext.currentSkill) {
        sessionContextHint = sessionContext.currentSkill;
        console.log(`[IntentRouter] 💡 Session Context: 当前技能=${sessionContext.currentSkill}, 轮次=${sessionContext.turnCount}`);
      }
    }

    // Step 1: 快速闲聊匹配（零延迟）
    const fastResult = this.fastClassify(trimmedInput, userProfile);
    if (fastResult && (fastResult.confidence ?? 0) >= 0.95) {
      console.log(`[IntentRouter] ⚡ 快速匹配: ${fastResult.intent}`);
      return fastResult;
    }

    // Step 1.5: 检测是否是追问，如果是直接沿用技能
    const followUpResult = this.isFollowUpQuestion(trimmedInput, recentHistory);
    if (followUpResult.isFollowUp && followUpResult.matchedSkill) {
      console.log(`[IntentRouter] 🔄 检测到追问，沿用技能: ${followUpResult.matchedSkill}`);
      return {
        intent: 'skill_task',
        confidence: followUpResult.confidence,
        matchedSkill: followUpResult.matchedSkill,
      };
    }

    // Step 1.6: 从历史中获取最近技能作为 LLM 匹配的提示
    const recentSkill = this.extractRecentSkill(recentHistory || []);
    if (recentSkill) {
      console.log(`[IntentRouter] 💡 历史技能: ${recentSkill}，作为 LLM 匹配的提示`);
    }

    // Step 2: 立即生成猜你想问（用户无需等待）
    const guessResponse = this.generateGuessQuestions(trimmedInput, userProfile);

    // Step 3: 调用 LLM 匹配技能（传入 Session Context 和历史技能作为 hint）
    console.log(`[IntentRouter] 🤖 使用 LLM 匹配技能...`);
    try {
      const llmResult = await this.llmMatchSkill(trimmedInput, recentSkill, recentHistory, userProfile, sessionContextHint);

      // 如果 LLM 匹配到闲聊意图，直接返回
      if (llmResult.intent === 'small_talk') {
        console.log(`[IntentRouter] 💬 LLM 识别为闲聊/对话结束语`);
        return llmResult;
      }

      // 如果 LLM 匹配到了有效技能，直接返回
      if (llmResult.matchedSkill && llmResult.matchedSkill !== 'fallback') {
        console.log(`[IntentRouter] ✅ LLM 匹配到技能: ${llmResult.matchedSkill}`);
        return {
          ...llmResult,
          suggestedResponse: undefined,
        };
      }

      // LLM 没匹配到技能 → 返回猜你想问
      console.log(`[IntentRouter] 💡 返回猜你想问`);
      return {
        intent: 'guess_confirm',
        confidence: 0.8,
        guessedSystem: guessResponse.systems[0] || undefined,
        suggestedResponse: guessResponse.fullResponse,
        matchedSkill: 'fallback',
      };
    } catch (error) {
      // LLM 调用失败 → 返回猜你想问作为兜底
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
   * LLM 技能匹配
   * @param userInput 用户输入
   * @param recentSkillHint 历史技能提示（辅助判断，不强制）
   * @param recentHistory 对话历史（用于多轮对话理解）
   */
  private async llmMatchSkill(
    userInput: string,
    recentSkillHint?: string,
    recentHistory?: Array<{ role?: string; content?: string; skill?: string; system?: string }>,
    userProfile?: UserProfile,
    sessionContextHint?: string
  ): Promise<IntentResult> {
    const skills = this.skillRegistry.getAllMetadata();

    const IntentSchema = z.object({
      intent: z.enum(['skill_task', 'small_talk', 'unclear'])
        .describe('意图类型: skill_task=需要使用某个技能执行任务, small_talk=闲聊/对话结束语(如"好的谢谢"), unclear=无法判断'),
      confidence: z.number().min(0).max(1).optional().default(0.8)
        .describe('置信度 0-1'),
      matchedSkill: z.string().optional().nullable()
        .describe('主匹配技能名称，intent=skill_task 时填写'),
      matchedSkills: z.array(z.string()).optional().nullable()
        .describe('所有匹配的技能列表，多意图时填写多个'),
    });

    const systemPrompt = buildSkillMatcherPrompt(skills);

    const hintText = recentSkillHint ? `上次使用的技能: "${recentSkillHint}"` : '无';
    const sessionHintText = sessionContextHint ? `当前会话激活的技能: "${sessionContextHint}"（几率为大，但请根据当前输入确认）` : '';

    let contextHint = '';
    if (recentHistory && recentHistory.length > 0) {
      const lastFew = recentHistory.slice(-4);
      const contextLines = lastFew
        .filter(m => m.content && m.content.length > 0)
        .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content!.substring(0, 150)}`);
      if (contextLines.length > 0) {
        contextHint = contextLines.join('\n');
      }
    }

    let prompt = `【用户当前输入】\n${userInput}\n\n`;

    if (sessionHintText) {
      prompt += `【当前会话上下文 - 参考】\n${sessionHintText}\n\n`;
    }

    if (contextHint) {
      prompt += `【最近对话历史】\n${contextHint}\n\n`;
    }

    prompt += `【历史技能参考】\n${hintText}\n\n请综合以上信息判断。注意：当前技能只是参考，如果用户明显切换了新话题，请匹配新的技能。`;

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
      ? skills.map(s => `• ${s.name}：${s.description}`).join('\n')
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
