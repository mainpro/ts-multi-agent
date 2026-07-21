import { ILLMClient } from '../llm';
import { SessionStore } from '../memory/session-store';
import { QAEntry, ContinuationResult, HandleResult, Request } from '../types';
import { createLogger } from '../observability/logger';

/**
 * AskAgent — 询问系统智能体
 *
 * 核心职责：
 * 1. 判断用户输入是对问题的回答还是其他意图（新请求/话题切换）
 * 2. 管理询问的生命周期：创建、等待回答、判断意图
 * 3. 确保用户输入被正确路由到对应的处理流程
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

export class AskAgent {
  private static readonly log = createLogger({ module: 'AskAgent' });
  constructor(
    private sessionStore: SessionStore,
    private llm: ILLMClient
  ) {}

  /**
   * 处理用户输入的入口
   */
  async handleUserInput(
    userId: string,
    sessionId: string,
    userInput: string
  ): Promise<HandleResult> {
    console.log(`[AskAgent] 📥 处理用户输入: "${userInput.substring(0, 80)}..."`);

    // 1. 检查是否有等待的请求
    const waitingRequest = await this.sessionStore.getWaitingRequest(userId, sessionId);
    if (waitingRequest) {
      // 获取当前等待的问题（可能是主智能体或子智能体的）
      const currentQuestion = await this.sessionStore.getCurrentQuestion(userId, sessionId, waitingRequest.requestId);
      if (currentQuestion) {
        console.log(`[AskAgent] 🔔 检测到等待请求: ${waitingRequest.requestId} (来源: ${currentQuestion.source})`);

        const judgeResult = await this.judgeContinuation(currentQuestion, userInput);
        console.log(`[AskAgent] 🎯 延续判断: ${judgeResult.isContinuation} (置信度: ${judgeResult.confidence})`);

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
      console.log(`[AskAgent] 📌 用户切换话题，挂起请求 ${waitingRequest.requestId}`);
      await this.sessionStore.suspendRequest(userId, sessionId, waitingRequest.requestId, '用户发起了新请求');
    }

    // 2. 创建新请求
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
    try {
      const traceId = `ask-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      AskAgent.log.info('llm.request', {
        traceId,
        type: 'judgeContinuation',
        questionId: question.questionId,
        questionLength: question.content.length,
        answerLength: userInput.length,
      });

      const response = await this.llm.generateText(prompt);

      AskAgent.log.info('llm.response', {
        traceId,
        responseLength: response?.length || 0,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.isContinuation
          ? { isContinuation: true, confidence: parsed.confidence || 0.7 }
          : { isContinuation: false, confidence: parsed.confidence || 0.7, reason: parsed.reason || '未提供理由' };
      }
    } catch (error) {
      console.warn('[AskAgent] 延续判断失败，默认为延续:', error);
    }
    return { isContinuation: true, confidence: 0.5 };
  }
}
