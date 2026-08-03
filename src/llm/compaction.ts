import type { Message } from '../types';

/**
 * 默认 token 估算:每 4 字符约 1 token
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    total += Math.ceil(content.length / 4);
    if (m.tool_calls) {
      total += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
    }
  }
  return total;
}

/**
 * 找出所有合法的切点下标(可从此下标开始切,前面的消息可以被丢弃)
 *
 * 合法切点:
 *  - 0(开头)
 *  - 任意 user 消息下标
 *  - 任意 assistant 消息下标(且无 tool_calls)
 *  - tool 消息不加入切点(避免切断 toolUse/toolResult 配对)
 */
export function findValidCutPoints(messages: Message[]): number[] {
  const points: number[] = [0];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      points.push(i);
    } else if (m.role === 'assistant' && !m.tool_calls) {
      points.push(i);
    }
    // tool 消息不加入切点(避免切断 toolUse/toolResult 配对)
  }
  return points;
}

/**
 * 从尾部向头部扫描,选第一个让估算 token ≤ budget 的切点
 *
 * 返回 cutPoint: 让 messages.slice(cutPoint) 估算 token ≤ budget 的最大 cutPoint。
 * 若单条消息就超 budget,返回 null。
 */
export function selectCutPoint(
  messages: Message[],
  tokenBudget: number,
  tokenCounter: (msgs: Message[]) => number = estimateTokens,
): number | null {
  const points = findValidCutPoints(messages);
  // 从最大切点向最小切点扫描
  for (let i = points.length - 1; i >= 0; i--) {
    const cut = points[i];
    const remaining = messages.slice(cut);
    if (tokenCounter(remaining) <= tokenBudget) {
      return cut;
    }
  }
  return null; // 单条消息就超 budget,无法压缩
}

export interface CompactOptions {
  /** 压缩后总 token 上限 */
  tokenBudget: number;
  /** 保留最近 N 条原样 */
  keepRecent: number;
  /** 可选的中止信号 */
  signal?: AbortSignal;
}

/**
 * 摘要旧消息 + 保留 recent。失败时抛 Error。
 *
 * 流程:
 *  1. 若 messages.length ≤ keepRecent → 不需要压缩
 *  2. 选切点 selectCutPoint,失败则抛错
 *  3. cut 之后的 recent 原样保留
 *  4. cut 之前的 oldMessages 调 LLM 摘要为一条 user 消息
 *  5. 返回 [summary, ...recent]
 */
export async function compactMessages(
  messages: Message[],
  llm: { generateText(prompt: string, systemPrompt?: string): Promise<string> },
  options: CompactOptions,
): Promise<Message[]> {
  if (messages.length <= options.keepRecent) {
    return messages; // 不需要压缩
  }

  const cutPoint = selectCutPoint(messages, options.tokenBudget);
  if (cutPoint === null) {
    throw new Error('无法选择合法切点(单条消息已超 token 预算)');
  }

  // recent = 切点到末尾的所有消息
  const recent = messages.slice(cutPoint);
  if (recent.length >= messages.length - cutPoint && recent.length === messages.length) {
    return messages; // 选中的切点 = 0,等于没压缩
  }

  // 旧消息:0 ~ cutPoint(不含)
  const oldMessages = messages.slice(0, cutPoint);
  if (oldMessages.length === 0) {
    return messages;
  }

  // 摘要旧消息
  const summaryText = oldMessages
    .map((m, i) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${i}] ${m.role}: ${content.substring(0, 500)}`;
    })
    .join('\n');

  const summary = await llm.generateText(
    `请用 200 字以内总结以下对话历史的关键信息(用户意图、已完成工具调用、当前进度):\n\n${summaryText}`,
    '你是一个对话摘要助手,只输出摘要文本,不要输出其他内容。',
  );

  const summaryMessage: Message = {
    role: 'user',
    content: `[对话历史摘要]\n${summary}\n\n(以上是早期对话的摘要,后续对话是新内容)`,
  };

  // 保留 summary + recent
  return [summaryMessage, ...recent];
}
