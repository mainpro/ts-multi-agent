/**
 * Conversation Context Helper - 对话上下文辅助工具
 *
 * 核心职责：
 * 1. 确保 questionHistory 与 conversationContext 的同步
 * 2. 校验询问状态一致性
 * 3. 优化断点续执行时的上下文构建
 *
 * 这是解决"重复提问"问题的关键模块。
 */

import { Message, QuestionHistoryEntry } from '../types';

export interface ConsistencyCheckResult {
  isConsistent: boolean;
  missingInContext: QuestionHistoryEntry[];
  extraInContext: Message[];
  details: string;
}

export interface ContextBuildOptions {
  /** 是否包含完整的对话历史（true）或仅摘要（false） */
  maxToolMessages?: number;
  /** 是否添加继续提示 */
  addContinuationPrompt?: boolean;
}

/**
 * 检查 questionHistory 与 conversationContext 的一致性
 */
export function checkQuestionHistoryConsistency(
  messages: Message[],
  questionHistory: QuestionHistoryEntry[]
): ConsistencyCheckResult {
  const missingInContext: QuestionHistoryEntry[] = [];
  const extraInContext: Message[] = [];
  const details: string[] = [];

  // 1. 检查每个 questionHistory 条目是否在 messages 中有对应
  for (let i = 0; i < questionHistory.length; i++) {
    const qh = questionHistory[i];
    const questionPrefix = qh.question.content.substring(0, 80);
    const answerPrefix = qh.answer.substring(0, 80);

    // 查找对应的 assistant 消息（提问）
    const questionIndex = messages.findIndex(m =>
      m.role === 'assistant' &&
      m.content.includes(questionPrefix)
    );

    // 查找对应的 user 消息（回答）
    const answerIndex = messages.findIndex(m =>
      m.role === 'user' &&
      m.content.includes(answerPrefix)
    );

    if (questionIndex === -1 || answerIndex === -1) {
      missingInContext.push(qh);
      details.push(`[缺失] 问答对 #${i + 1}: 问="${questionPrefix}..." 答="${answerPrefix}..."`);
    } else if (answerIndex <= questionIndex) {
      // 回答应该在提问之后
      missingInContext.push(qh);
      details.push(`[顺序错误] 问答对 #${i + 1}: 回答(${answerIndex})在提问(${questionIndex})之前`);
    }
  }

  // 2. 检查 messages 中是否有孤立的 assistant 消息（没有对应的 questionHistory）
  const assistantMessages = messages.filter(m => m.role === 'assistant');
  for (const msg of assistantMessages) {
    const msgPrefix = msg.content.substring(0, 80);
    const hasMatchingQuestion = questionHistory.some(qh =>
      qh.question.content.includes(msgPrefix) ||
      msg.content.includes(qh.question.content.substring(0, 80))
    );

    if (!hasMatchingQuestion && !msg.content.includes('【已完成的对话步骤】')) {
      extraInContext.push(msg);
      details.push(`[多余] 未匹配的 assistant 消息: "${msgPrefix}..."`);
    }
  }

  return {
    isConsistent: missingInContext.length === 0 && extraInContext.length === 0,
    missingInContext,
    extraInContext,
    details: details.join('\n'),
  };
}

/**
 * 构建问答对消息列表
 */
export function buildQuestionAnswerPairs(
  questionHistory: QuestionHistoryEntry[]
): Message[] {
  const pairs: Message[] = [];
  for (const qh of questionHistory) {
    pairs.push({ role: 'assistant', content: qh.question.content });
    pairs.push({ role: 'user', content: qh.answer });
  }
  return pairs;
}

/**
 * 同步 questionHistory 到 conversationContext
 *
 * 确保每个 questionHistory 条目都有对应的 message 对
 * 策略：将缺失的问答对追加到消息列表末尾
 */
export function syncQuestionHistoryToContext(
  messages: Message[],
  questionHistory: QuestionHistoryEntry[]
): Message[] {
  if (!questionHistory || questionHistory.length === 0) {
    return messages;
  }

  // 1. 检查一致性
  const check = checkQuestionHistoryConsistency(messages, questionHistory);

  if (check.isConsistent) {
    console.log(`[ConversationHelper] ✅ questionHistory 与 conversationContext 已同步 (${questionHistory.length} 对)`);
    return messages;
  }

  console.log(`[ConversationHelper] 🔧 同步 questionHistory 到 conversationContext:`);
  console.log(check.details);

  // 2. 创建新的消息数组
  const newMessages: Message[] = [...messages];

  // 3. 构建缺失的问答对并追加到末尾
  const qaPairs = buildQuestionAnswerPairs(check.missingInContext);
  if (qaPairs.length > 0) {
    newMessages.push(...qaPairs);
    console.log(`[ConversationHelper] ✅ 已追加 ${qaPairs.length / 2} 条缺失的问答对到消息末尾`);
  }

  return newMessages;
}

/**
 * 构建精简的断点续执行上下文
 *
 * 减少 token 消耗，同时保留关键信息
 */
export function buildResumedContext(
  originalContext: Message[],
  questionHistory: QuestionHistoryEntry[],
  systemPrompt: string,
  options: ContextBuildOptions = {}
): Message[] {
  const {
    maxToolMessages = 10,
    addContinuationPrompt = true,
  } = options;

  const messages: Message[] = [];

  // 1. 添加 system prompt
  messages.push({ role: 'system', content: systemPrompt });

  // 2. 添加问答历史摘要
  if (questionHistory.length > 0) {
    const qaSummary = questionHistory.map((qh, i) =>
      `[步骤 ${i + 1}/${questionHistory.length}] 问: ${qh.question.content.substring(0, 100)}${qh.question.content.length > 100 ? '...' : ''}\n答: ${qh.answer.substring(0, 100)}${qh.answer.length > 100 ? '...' : ''}`
    ).join('\n\n');

    messages.push({
      role: 'system',
      content: `【已完成的对话步骤】\n${qaSummary}\n\n注意：以上步骤已完成，请勿重复询问。`
    });
  }

  // 3. 保留最近的 assistant+tool 消息对（避免重复调用，同时保持消息格式合法）
  //    LLM API 要求每个 tool 消息前必须有对应的 assistant 消息（包含 tool_calls）
  const recentToolPairs: Message[] = [];
  const toolMessages = originalContext.filter(m => m.role === 'tool');
  const targetToolMessages = toolMessages.slice(-maxToolMessages);
  const targetToolCallIds = new Set(targetToolMessages.map(m => m.tool_call_id).filter(Boolean));

  // 找到与这些 tool_call_id 对应的 assistant 消息
  for (const msg of originalContext) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      const hasMatchingTool = msg.tool_calls.some(
        (tc: any) => targetToolCallIds.has(tc.id)
      );
      if (hasMatchingTool) {
        recentToolPairs.push(msg);
        // 追加对应的 tool 消息
        for (const toolMsg of targetToolMessages) {
          if (msg.tool_calls!.some((tc: any) => tc.id === toolMsg.tool_call_id)) {
            recentToolPairs.push(toolMsg);
          }
        }
      }
    }
  }
  messages.push(...recentToolPairs);

  // 4. 添加继续提示
  if (addContinuationPrompt) {
    messages.push({
      role: 'user',
      content: '请根据以上上下文继续执行任务。如果所有必要信息已收集完成，请直接执行；如果还需要补充信息，请继续询问。'
    });
  }

  console.log(`[ConversationHelper] 📊 构建断点续执行上下文: ${messages.length} 条消息 (问答历史: ${questionHistory.length} 对)`);

  return messages;
}

/**
 * 验证断点续执行上下文是否完整
 */
export function validateResumedContext(
  messages: Message[],
  questionHistory: QuestionHistoryEntry[]
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // 1. 检查是否有 system 消息
  const hasSystem = messages.some(m => m.role === 'system');
  if (!hasSystem) {
    issues.push('缺少 system 消息');
  }

  // 2. 检查问答历史是否同步
  const check = checkQuestionHistoryConsistency(messages, questionHistory);
  if (!check.isConsistent) {
    issues.push('questionHistory 与 conversationContext 不同步');
    issues.push(...check.details.split('\n'));
  }

  // 3. 检查消息顺序
  let lastUserIndex = -1;
  let lastAssistantIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') lastUserIndex = i;
    if (messages[i].role === 'assistant') lastAssistantIndex = i;
  }

  if (lastAssistantIndex > lastUserIndex) {
    issues.push('上下文以 assistant 消息结尾，可能缺少用户回复');
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
