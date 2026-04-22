import { LLMClient } from '../llm';
import { SessionStore } from '../memory/session-store';
import { QAEntry, ContinuationResult, HandleResult, Request } from '../types';

/**
 * RequestManager — 请求生命周期管理器
 *
 * 核心职责：
 * 1. 判断用户输入是延续回答还是新请求
 * 2. 管理请求的创建、挂起、召回
 * 3. 确保请求状态和任务状态一致
 */

const CONTINUATION_JUDGE_PROMPT = `你是一个意图判断助手。你的唯一任务是判断用户最新的回复是否是对上一个问题的回答。

## 上一个问题
{questionContent}

## 用户最新回复
{userAnswer}

## 判断规则
1. 如果用户回复是在回答/回应上面的问题 → isContinuation: true
2. 如果用户回复是在提出新的问题/请求/话题 → isContinuation: false
3. 如果无法确定 → isContinuation: true（倾向于继续当前任务）

## 输出格式（只输出JSON）
{"isContinuation": boolean, "confidence": 0.0到1.0, "reason": "简要理由"}`;

const TASK_RECALL_PROMPT = `你是一个任务召回判断助手。判断用户的新消息是否与某个挂起的请求相关。

## 挂起的请求
请求内容: {requestContent}
挂起原因: {suspendedReason}
挂起时间: {suspendedAt}

## 用户最新消息
{userMessage}

## 判断规则
1. 用户消息提到与请求相关的关键词/系统/操作 → 应该召回 (shouldRecall: true)
2. 用户消息明显是全新话题 → 不召回 (shouldRecall: false)
3. 用户消息模糊但可能相关 → 倾向于召回 (shouldRecall: true)

## 输出格式（只输出JSON）
{"shouldRecall": boolean, "confidence": 0.0到1.0, "reason": "简要理由"}`;

export class RequestManager {
  constructor(
    private sessionStore: SessionStore,
    private llm: LLMClient
  ) {}

  /**
   * 处理用户输入的入口
   */
  async handleUserInput(
    userId: string,
    sessionId: string,
    userInput: string
  ): Promise<HandleResult> {
    console.log(`[RequestManager] 📥 处理用户输入: "${userInput.substring(0, 80)}..."`);

    // 1. 检查是否有等待的请求
    const waitingRequest = await this.sessionStore.getWaitingRequest(userId, sessionId);
    if (waitingRequest) {
      // 获取当前等待的问题（可能是主智能体或子智能体的）
      const currentQuestion = await this.sessionStore.getCurrentQuestion(userId, sessionId, waitingRequest.requestId);
      if (currentQuestion) {
        console.log(`[RequestManager] 🔔 检测到等待请求: ${waitingRequest.requestId} (来源: ${currentQuestion.source})`);

        const judgeResult = await this.judgeContinuation(currentQuestion, userInput);
        console.log(`[RequestManager] 🎯 延续判断: ${judgeResult.isContinuation} (置信度: ${judgeResult.confidence})`);

        if (judgeResult.isContinuation) {
          const updated = await this.sessionStore.answerQuestion(
            userId, sessionId, waitingRequest.requestId,
            currentQuestion.questionId, userInput
          );
          if (updated) {
            return { type: 'continue', request: updated, question: currentQuestion };
          }
        }
      }

      // 用户切换话题 → 挂起当前请求，创建新请求
      console.log(`[RequestManager] 📌 用户切换话题，挂起请求 ${waitingRequest.requestId}`);
      await this.sessionStore.suspendRequest(userId, sessionId, waitingRequest.requestId, '用户发起了新请求');

      const newRequest = await this.sessionStore.createRequest(userId, sessionId, userInput);
      return { type: 'new_request', request: newRequest };
    }

    // 2. 检查挂起的请求
    const suspendedRequests = await this.sessionStore.getSuspendedRequests(userId, sessionId);
    if (suspendedRequests.length > 0) {
      console.log(`[RequestManager] 🔄 检测到 ${suspendedRequests.length} 个挂起请求`);

      for (const sr of suspendedRequests) {
        const recallResult = await this.shouldRecall(sr, userInput);
        console.log(`[RequestManager] 📊 召回判断: ${sr.requestId} → ${recallResult.shouldRecall} (置信度: ${recallResult.confidence})`);

        if (recallResult.shouldRecall && recallResult.confidence >= 0.6) {
          // 创建新请求（用户可能想继续也可能想新建）
          const newRequest = await this.sessionStore.createRequest(userId, sessionId, userInput);
          return {
            type: 'recall_prompt',
            request: newRequest,
            suspendedRequest: sr,
          };
        }
      }
    }

    // 3. 创建新请求
    const newRequest = await this.sessionStore.createRequest(userId, sessionId, userInput);
    return { type: 'new_request', request: newRequest };
  }

  /**
   * 召回挂起的请求
   */
  async recallRequest(userId: string, sessionId: string, requestId: string): Promise<Request | null> {
    return this.sessionStore.recallRequest(userId, sessionId, requestId);
  }

  /**
   * 轻量延续判断
   */
  async judgeContinuation(question: QAEntry, userInput: string): Promise<ContinuationResult> {
    const prompt = CONTINUATION_JUDGE_PROMPT
      .replace('{questionContent}', question.content)
      .replace('{userAnswer}', userInput);

    // 内部判断逻辑（测试阶段保留完整 reasoning 日志）
    const response = await this.llm.generateText(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.isContinuation
          ? { isContinuation: true, confidence: parsed.confidence || 0.7 }
          : { isContinuation: false, confidence: parsed.confidence || 0.7, reason: parsed.reason || '未提供理由' };
      }
    } catch (error) {
      console.warn('[RequestManager] 延续判断失败，默认为延续:', error);
    }
    return { isContinuation: true, confidence: 0.5 };
  }

  /**
   * 判断是否应该召回挂起请求
   */
  private async shouldRecall(request: Request, userInput: string): Promise<{
    shouldRecall: boolean;
    confidence: number;
    reason: string;
  }> {
    const prompt = TASK_RECALL_PROMPT
      .replace('{requestContent}', request.content)
      .replace('{suspendedReason}', request.suspendedReason || '未知')
      .replace('{suspendedAt}', request.suspendedAt || '未知')
      .replace('{userMessage}', userInput);

    // 内部判断逻辑（测试阶段保留完整 reasoning 日志）
    const response = await this.llm.generateText(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          shouldRecall: !!parsed.shouldRecall,
          confidence: parsed.confidence || 0.5,
          reason: parsed.reason || '未提供理由',
        };
      }
    } catch (error) {
      console.warn('[RequestManager] 召回判断失败:', error);
    }
    return { shouldRecall: false, confidence: 0.3, reason: '判断失败' };
  }
}
