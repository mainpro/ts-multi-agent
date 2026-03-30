import { z } from 'zod';
import { LLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { UserProfile } from '../types';
import { buildSkillMatcherPrompt } from '../prompts';

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
      /^(你好|您好)[^\n]*$/i,
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
    ],
    responseType: 'thanks',
  },
  {
    patterns: [
      /^(再见|拜拜|bye|goodbye|下次见)[!.?]?$/i,
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
  constructor(
    private llm: LLMClient,
    private skillRegistry: SkillRegistry
  ) {}

  /**
   * 分类用户意图
   *
   * 策略：
   * 1. 先用关键词快速匹配闲聊/超出范围
   * 2. 立即生成猜你想问（不等待 LLM）
   * 3. 并行调用 LLM 匹配技能
   * 4. 根据 LLM 结果决定返回猜你想问还是技能
   */
  async classify(userInput: string, userProfile?: UserProfile): Promise<IntentResult> {
    const trimmedInput = userInput.trim();

    // Step 1: 快速闲聊匹配（零延迟）
    const fastResult = this.fastClassify(trimmedInput, userProfile);
    if (fastResult && (fastResult.confidence ?? 0) >= 0.95) {
      console.log(`[IntentRouter] ⚡ 快速匹配: ${fastResult.intent}`);
      return fastResult;
    }

    // Step 2: 立即生成猜你想问（用户无需等待）
    const guessResponse = this.generateGuessQuestions(trimmedInput, userProfile);

    // Step 3: 并行调用 LLM 匹配技能
    console.log(`[IntentRouter] 🤖 使用 LLM 匹配技能...`);
    try {
      const llmResult = await this.llmMatchSkill(trimmedInput);

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
      console.log(`[IntentRouter] ⚠️ LLM 匹配失败:`, error);
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
    
    let fullResponse: string;
    
    if (systems.length > 0) {
      // 根据常用系统生成自然对话式询问
      const systemNames = systems.join('和');
      fullResponse = `您好～我看您是${department ? department + '的' : ''}平时使用${systemNames}较多，看您说"${userInput}"，请问具体是哪个系统呀？另外大概多久前开始出现这个情况的呢？`;
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
   */
  private async llmMatchSkill(userInput: string): Promise<IntentResult> {
    const skills = this.skillRegistry.getAllMetadata();

    const IntentSchema = z.object({
      intent: z.enum(['skill_task', 'unclear'])
      .describe('意图类型: skill_task=需要使用某个技能执行任务, unclear=无法判断'),
      confidence: z.number().min(0).max(1).optional().default(0.8)
      .describe('置信度 0-1'),
      matchedSkill: z.string().optional()
      .describe('匹配的技能名称，intent=skill_task 时填写'),
    });

    const systemPrompt = buildSkillMatcherPrompt(skills);

    const result = await this.llm.generateStructured(
      `用户需求: "${userInput}"`,
      IntentSchema,
      systemPrompt
    );

    if (result.intent === 'unclear' || !result.matchedSkill) {
      return {
        intent: 'unclear',
        confidence: 0.8,
        matchedSkill: 'fallback',
      };
    }

    return {
      intent: 'skill_task',
      confidence: result.confidence || 0.8,
      matchedSkill: result.matchedSkill,
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

    const personalizedGreeting = userProfile?.department
      ? `您好！${userProfile.department}的同事，我可以帮您处理${userProfile.commonSystems.join('、')}相关问题。有什么可以帮您的吗？`
      : `您好！我是运维智能体，${skillList}有什么可以帮您的吗？`;

    const personalizedIdentity = userProfile?.department
      ? `我是运维智能体，一个智能助手。${userProfile.department}的同事，我可以帮您处理${userProfile.commonSystems.join('、')}相关问题。请告诉我您需要什么帮助？`
      : `我是运维智能体，一个智能助手。${skillList}请告诉我您需要什么帮助？`;

    const responses: Record<string, string> = {
      greeting: personalizedGreeting,
      empathy: `听起来您今天状态不太好呀～工作生活中难免有低潮的时候。如果有什么我能帮您处理的，比如报销、差旅这些问题，可以随时告诉我，转移一下注意力可能会好受些😊`,
      identity: personalizedIdentity,
      thanks: `不客气！如果还有其他问题，随时可以问我。我是运维智能体，${skillList}`,
      goodbye: `再见！有需要随时找我，我是运维智能体，${skillList}`,
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
