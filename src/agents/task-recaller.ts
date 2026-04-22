import { LLMClient } from '../llm';
import { Task } from '../types';

/**
 * 挂起任务召回器
 *
 * 设计目标：判断用户的新消息是否与某个挂起的任务相关
 * 职责：主动匹配挂起任务，替代原来的排除法
 */
const TASK_RECALL_SYSTEM_PROMPT = `你是一个任务召回判断助手。判断用户的新消息是否与某个挂起的任务相关。

## 判断规则
1. 用户消息提到与任务相关的关键词/系统/操作 → 应该召回 (shouldRecall: true)
2. 用户消息明显是全新话题 → 不召回 (shouldRecall: false)
3. 用户消息模糊但可能相关 → 倾向于召回 (shouldRecall: true)
4. 用户消息是闲聊（你好、谢谢等）→ 不召回 (shouldRecall: false)

## 输出格式
只输出 JSON，不要输出其他内容：
{"shouldRecall": boolean, "confidence": 0.0到1.0, "reason": "简要理由"}`;

export interface RecallResult {
  shouldRecall: boolean;
  confidence: number;
  reason: string;
}

export class TaskRecaller {
  constructor(private llm: LLMClient) {}

  /**
   * 判断用户消息是否应该触发挂起任务的召回
   *
   * @param task - 挂起的任务
   * @param userMessage - 用户最新消息
   * @returns 召回判断结果
   */
  async shouldRecall(task: Task, userMessage: string): Promise<RecallResult> {
    const prompt = `## 挂起的任务
任务描述: ${task.requirement}
技能: ${task.skillName || '未知'}
挂起时间: ${task.startedAt?.toISOString() || '未知'}

## 用户最新消息
${userMessage}

请判断用户消息是否与挂起的任务相关。只输出 JSON。`;

    try {
      const response = await this.llm.generateText(prompt, TASK_RECALL_SYSTEM_PROMPT);

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const result: RecallResult = {
          shouldRecall: !!parsed.shouldRecall,
          confidence: parsed.confidence || 0.5,
          reason: parsed.reason || '未提供理由',
        };

        console.log(
          `[TaskRecaller] 任务 ${task.id}: shouldRecall=${result.shouldRecall}, ` +
          `confidence=${result.confidence}, reason=${result.reason}`
        );

        return result;
      }

      console.warn('[TaskRecaller] 无法解析 JSON 响应，默认不召回');
    } catch (error) {
      console.warn('[TaskRecaller] 召回判断失败:', error);
    }

    return { shouldRecall: false, confidence: 0.3, reason: '判断失败' };
  }
}
