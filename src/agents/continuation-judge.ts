import { LLMClient } from '../llm';
import { QAEntry, ContinuationResult } from '../types';

/**
 * 轻量延续判断器
 *
 * 设计目标：快速（~1s）、低成本（短 prompt），替代完整的 LLM 意图分类
 * 职责：判断用户最新回复是否是对上一个问题的延续回答
 */
const CONTINUATION_JUDGE_SYSTEM_PROMPT = `你是一个意图判断助手。你的唯一任务是判断用户最新的回复是否是对上一个问题的回答。

## 判断规则
1. 如果用户回复是在回答/回应上面的问题 → isContinuation: true
2. 如果用户回复是在提出新的问题/请求/话题 → isContinuation: false
3. 如果无法确定 → isContinuation: true（倾向于继续当前任务，保守策略）

## 输出格式
只输出 JSON，不要输出其他内容：
{"isContinuation": boolean, "confidence": 0.0到1.0, "reason": "简要理由"}`;

export class ContinuationJudge {
  constructor(private llm: LLMClient) {}

  /**
   * 轻量判断用户回复是否是对上一个问题的延续回答
   *
   * @param question - 上一个等待回答的问题
   * @param userAnswer - 用户最新的回复
   * @returns 延续判断结果
   */
  async judge(question: QAEntry, userAnswer: string): Promise<ContinuationResult> {
    const prompt = `## 上一个问题（来源: ${question.source})
${question.content}

## 用户最新回复
${userAnswer}

请判断用户回复是否是对上面问题的回答。只输出 JSON。`;

    try {
      const response = await this.llm.generateText(prompt, CONTINUATION_JUDGE_SYSTEM_PROMPT);

      // 解析 JSON 响应
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const result: ContinuationResult = parsed.isContinuation
          ? { isContinuation: true, confidence: parsed.confidence || 0.7 }
          : { isContinuation: false, confidence: parsed.confidence || 0.7, reason: parsed.reason || '未提供理由' };

        console.log(
          `[ContinuationJudge] 判断结果: isContinuation=${result.isContinuation}, ` +
          `confidence=${result.confidence}${result.isContinuation ? '' : `, reason=${(result as any).reason}`}`
        );

        return result;
      }

      console.warn('[ContinuationJudge] 无法解析 JSON 响应，默认为延续');
    } catch (error) {
      console.warn('[ContinuationJudge] 判断失败，默认为延续:', error);
    }

    // 容错：判断失败时默认为延续（保守策略）
    return { isContinuation: true, confidence: 0.5 };
  }
}
