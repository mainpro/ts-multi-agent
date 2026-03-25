import { z } from 'zod';
import { LLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';

/**
 * 意图类型
 */
export type IntentType =
  | 'small_talk'    // 闲聊：你好、你是谁、谢谢
  | 'skill_task'    // 技能任务：需要执行技能
  | 'out_of_scope'  // 超出范围：天气、新闻等
  | 'unclear';      // 不明确

/**
 * 意图分类结果
 */
export interface IntentResult {
  intent: IntentType;
  confidence?: number;
  suggestedResponse?: string;
  matchedSkill?: string;
}

/**
 * 闲聊模式定义
 */
interface SmallTalkPattern {
  patterns: RegExp[];
  responseType: 'greeting' | 'identity' | 'thanks' | 'goodbye' | 'help' | 'capability';
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
  /图片/,
  /照片/,
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
 * 2. LLM 意图分类（不确定时）
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
   * 1. 先用关键词快速匹配
   * 2. 如果不明确，再用 LLM 分类
   */
  async classify(userInput: string): Promise<IntentResult> {
    const trimmedInput = userInput.trim();

    // Step 1: 关键词快速匹配（零延迟）
    const fastResult = this.fastClassify(trimmedInput);
    if (fastResult && (fastResult.confidence ?? 0) >= 0.95) {
      console.log(`[IntentRouter] ⚡ 快速匹配: ${fastResult.intent}`);
      return fastResult;
    }

    // Step 2: LLM 分类（用于边界情况）
    console.log(`[IntentRouter] 🤖 使用 LLM 分类意图...`);
    return this.llmClassify(trimmedInput);
  }

  /**
   * 快速关键词匹配
   */
  private fastClassify(userInput: string): IntentResult | null {
    // 检查闲聊模式
    for (const config of SMALL_TALK_CONFIGS) {
      for (const pattern of config.patterns) {
        if (pattern.test(userInput)) {
          return {
            intent: 'small_talk',
            confidence: 0.98,
            suggestedResponse: this.generateSmallTalkResponse(config.responseType),
          };
        }
      }
    }

    // 检查超出范围
    for (const pattern of OUT_OF_SCOPE_PATTERNS) {
      if (pattern.test(userInput)) {
        return {
          intent: 'out_of_scope',
          confidence: 0.95,
          suggestedResponse: this.generateOutOfScopeResponse(),
        };
      }
    }

    return null;
  }

  /**
   * LLM 意图分类
   */
  private async llmClassify(userInput: string): Promise<IntentResult> {
    const skills = this.skillRegistry.getAllMetadata();
    const skillList = skills.length > 0
      ? skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
      : '暂无可用技能';

const IntentSchema = z.object({
  intent: z.enum(['small_talk', 'skill_task', 'out_of_scope', 'unclear']),
  confidence: z.number().min(0).max(1).optional().default(0.8),
  matchedSkill: z.string().optional(),
  reasoning: z.string().optional(),
});

    const systemPrompt = `你是一个高效的意图分类器。分析用户输入，判断用户意图。

## 意图类型：

1. **small_talk**: 闲聊、寒暄、问候
   - 你好、您好、hi、hello
   - 你是谁、自我介绍
   - 谢谢、感谢
   - 再见、拜拜
   - 你能做什么

2. **skill_task**: 需要执行具体技能任务
   - 计算、数学运算
   - 查询班级信息
   - 其他需要具体处理的任务

3. **out_of_scope**: 超出系统能力范围
   - 天气查询
   - 新闻资讯
   - 翻译
   - 写文章、画画
   - 购物、订票
   - 游戏、笑话

4. **unclear**: 意图不明确
   - 无法判断用户想要什么
   - 需要更多信息

## 系统可用技能：
${skillList}

## 分类规则：
- 简单的问候、寒暄 → small_talk
- 需求匹配某个技能的能力 → skill_task（指出匹配的技能名）
- 需求超出所有技能范围 → out_of_scope
- 无法判断 → unclear

返回 JSON 格式，不要有多余说明。`;

    const result = await this.llm.generateStructured(
      `用户输入: "${userInput}"\n\n请分类用户意图。`,
      IntentSchema,
      systemPrompt
    );

    // 如果是闲聊或超出范围，生成回复
    if (result.intent === 'small_talk') {
      result.matchedSkill = undefined;
      return {
        ...result,
        suggestedResponse: this.generateSmallTalkResponse('greeting'),
      };
    }

    if (result.intent === 'out_of_scope') {
      return {
        ...result,
        suggestedResponse: this.generateOutOfScopeResponse(),
      };
    }

    return result;
  }

  /**
   * 生成闲聊回复
   */
  private generateSmallTalkResponse(type: string): string {
    const skills = this.skillRegistry.getAllMetadata();
    const skillNames = skills.map(s => s.name).join('、');
    const skillList = skills.length > 0
      ? `我可以帮您解决${skillNames}等问题。`
      : '目前暂无可用功能。';

    const responses: Record<string, string> = {
      greeting: `您好！我是运维智能体，${skillList}有什么可以帮您的吗？`,
      identity: `我是运维智能体，一个智能助手。${skillList}请告诉我您需要什么帮助？`,
      thanks: `不客气！如果还有其他问题，随时可以问我。我是运维智能体，${skillList}`,
      goodbye: `再见！有需要随时找我，我是运维智能体，${skillList}`,
      help: `您好！我是运维智能体。${skillList}\n\n请直接告诉我您需要什么帮助，我会尽力为您解决。`,
      capability: `我是运维智能体，目前我可以帮您解决以下问题：\n\n${skills.map(s => `• ${s.name}：${s.description}`).join('\n')}\n\n请告诉我您需要什么帮助？`,
    };

    return responses[type] || responses.greeting;
  }

  /**
   * 生成超出范围回复
   */
  private generateOutOfScopeResponse(): string {
    const skills = this.skillRegistry.getAllMetadata();
    const skillList = skills.length > 0
      ? skills.map(s => `• ${s.name}：${s.description}`).join('\n')
      : '暂无可用功能';

    return `抱歉，这个问题超出了我的能力范围。\n\n我是运维智能体，目前我可以帮您解决以下问题：\n\n${skillList}\n\n请告诉我您需要什么帮助？`;
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
}

export default IntentRouter;
