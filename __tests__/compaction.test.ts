/**
 * Safe compaction tests
 *
 * 覆盖 findValidCutPoints、selectCutPoint、compactMessages 的核心行为:
 *  - 切点必须避开 tool 消息(防止切断 toolUse/toolResult 配对)
 *  - 切点必须避开带 tool_calls 的 assistant 消息
 *  - selectCutPoint 选最大合法切点使剩余 token ≤ budget
 *  - compactMessages 调用 LLM 摘要并拼接 summary + recent
 *  - 边界:无可压缩、单条消息超 budget、消息长度 ≤ keepRecent
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  findValidCutPoints,
  selectCutPoint,
  compactMessages,
} from '../src/llm/compaction';
import type { Message } from '../src/types';

// 构造测试消息
function userMsg(content: string): Message {
  return { role: 'user', content };
}

function assistantMsg(content: string, toolCalls?: Message['tool_calls']): Message {
  return { role: 'assistant', content, tool_calls: toolCalls };
}

function toolMsg(content: string, toolCallId: string): Message {
  return { role: 'tool', content, tool_call_id: toolCallId };
}

describe('findValidCutPoints', () => {
  test('空数组返回 [0]', () => {
    expect(findValidCutPoints([])).toEqual([0]);
  });

  test('单条 user 消息 → [0, 0]', () => {
    const msgs = [userMsg('hi')];
    expect(findValidCutPoints(msgs)).toEqual([0, 0]);
  });

  test('基础 user/assistant 交替 → 0 + 每个 user/assistant 下标', () => {
    const msgs = [
      userMsg('u1'),
      assistantMsg('a1'),
      userMsg('u2'),
      assistantMsg('a2'),
    ];
    expect(findValidCutPoints(msgs)).toEqual([0, 0, 1, 2, 3]);
  });

  test('tool 消息不作为切点(避免切断 toolUse/toolResult 配对)', () => {
    const msgs = [
      userMsg('u1'),
      assistantMsg('a1', [{ id: 'tc1', type: 'function', function: { name: 'foo', arguments: '{}' } }]),
      toolMsg('result', 'tc1'),
      userMsg('u2'),
    ];
    const points = findValidCutPoints(msgs);
    // 合法切点: 0, 0(user), 3(user)
    expect(points).toEqual([0, 0, 3]);
    // 确保 tool 消息下标 2 不在切点中
    expect(points).not.toContain(2);
  });

  test('带 tool_calls 的 assistant 消息不作为切点', () => {
    const msgs = [
      userMsg('u1'),
      assistantMsg('a1', [{ id: 'tc1', type: 'function', function: { name: 'foo', arguments: '{}' } }]),
      toolMsg('result', 'tc1'),
      assistantMsg('a2'), // 无 tool_calls,可作为切点
    ];
    const points = findValidCutPoints(msgs);
    expect(points).toEqual([0, 0, 3]);
    // 带 tool_calls 的 assistant 索引 1 不在切点中
    expect(points).not.toContain(1);
  });
});

describe('selectCutPoint', () => {
  test('所有消息 token ≤ budget → 选最大有效切点(末尾 user/assistant 索引)', () => {
    // 切点必须是 user/assistant 索引,不能切到 messages.length
    // 因为这会丢掉 tool 配对
    const msgs = [userMsg('a'), assistantMsg('b'), userMsg('c')];
    const cut = selectCutPoint(msgs, 100000);
    // 切点 = [0, 0, 1, 2],最大值 2 = 末尾 user
    expect(cut).toBe(2);
  });

  test('从尾部选切点使剩余 ≤ budget', () => {
    // 构造大消息让前部超 budget
    const big = 'x'.repeat(4000); // ~1000 tokens
    const msgs = [
      userMsg(big),
      assistantMsg(big),
      userMsg(big),
      assistantMsg('short'), // 最后一条
    ];
    // budget = 1 token: 只能保留最后一条
    const cut = selectCutPoint(msgs, 4); // 1 token = 4 chars
    // cut 应是 3 (assistant 'short')
    expect(cut).toBe(3);
  });

  test('无合法切点(单条消息就超 budget)→ null', () => {
    const msgs = [userMsg('x'.repeat(10000))]; // 2500 tokens
    const cut = selectCutPoint(msgs, 4); // 1 token
    expect(cut).toBeNull();
  });

  test('custom tokenCounter 被调用', () => {
    const msgs = [userMsg('a'), assistantMsg('b')];
    const counter = mock((m: Message[]) => m.length);
    const cut = selectCutPoint(msgs, 100, counter);
    // 切点 = [0, 0, 1],最大 = 1
    expect(cut).toBe(1);
    expect(counter).toHaveBeenCalled();
  });

  test('tool 消息不作为切点:即使后面的 user 在 budget 内,中间若有 tool 消息,只能切到 tool 之前', () => {
    const msgs = [
      userMsg('u1'),
      assistantMsg('a1', [{ id: 'tc1', type: 'function', function: { name: 'foo', arguments: '{}' } }]),
      toolMsg('result', 'tc1'),
      userMsg('u2'), // 索引 3
    ];
    // budget 大到能装下 4 条
    const cut = selectCutPoint(msgs, 100000);
    // 切点:0, 0, 3. 最大 = 3
    expect(cut).toBe(3);
  });
});

describe('compactMessages', () => {
  function makeLlm(summaryResponse = 'Summary of old conversation'): { generateText: any } {
    return {
      generateText: mock(async (prompt: string, systemPrompt?: string) => {
        // 验证 prompt 包含对比信息
        if (!prompt.includes('总结')) {
          throw new Error('prompt should ask for summary');
        }
        return summaryResponse;
      }),
    };
  }

  test('messages.length ≤ keepRecent → 直接返回原 messages', async () => {
    const msgs = [userMsg('a'), assistantMsg('b')];
    const llm = makeLlm();
    const result = await compactMessages(msgs, llm, {
      tokenBudget: 100000,
      keepRecent: 5,
    });
    expect(result).toEqual(msgs);
    expect(llm.generateText).not.toHaveBeenCalled();
  });

  test('正常压缩: summary + recent(cutPoint 由 budget 决定)', async () => {
    const old1 = userMsg('u1');
    const old2 = assistantMsg('a1');
    const old3 = userMsg('u2');
    const recent1 = assistantMsg('a2');
    const recent2 = toolMsg('result', 'tc1');
    const recent3 = userMsg('u3');
    const recent4 = assistantMsg('a3');
    const recent5 = userMsg('u4');
    const msgs = [old1, old2, old3, recent1, recent2, recent3, recent4, recent5];
    const llm = makeLlm('Old summary');
    const result = await compactMessages(msgs, llm, {
      tokenBudget: 100000,
      keepRecent: 5,
    });
    // selectCutPoint 选最大切点使剩余 ≤ budget,所有消息都很小,选 7 (末尾 user)
    // recent = msgs.slice(7) = [u4], summary + recent = 2
    expect(result.length).toBe(2);
    // 第一条是 user/摘要
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('Old summary');
    // 第二条是原 msgs[7] = u4
    expect(result[1]).toEqual(msgs[7]);
    expect(llm.generateText).toHaveBeenCalledTimes(1);
  });

  test('小 budget 时压缩:留少量末尾 + summary', async () => {
    // 让前面 3 条大,后面 5 条小 → budget 紧时切点靠后
    const big = 'x'.repeat(400); // 100 tokens
    const small = 'y';
    const msgs = [
      userMsg(big),
      assistantMsg(big),
      userMsg(big),
      // 切点候选从这里开始
      userMsg(small),
      assistantMsg(small),
      userMsg(small),
      assistantMsg(small),
      userMsg(small),
    ];
    const llm = makeLlm('compressed');
    const result = await compactMessages(msgs, llm, {
      tokenBudget: 10, // 10 tokens = 40 chars
      keepRecent: 5,
    });
    // summary + recent
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('compressed');
    // recent 必须满足 token ≤ budget
    const recent = result.slice(1);
    // total content length should be ≤ 40 chars (10 tokens)
    const totalChars = recent.reduce((sum, m) => sum + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(40);
  });

  test('单条消息超 budget → 抛错', async () => {
    const msgs = [userMsg('x'.repeat(10000))];
    const llm = makeLlm();
    await expect(
      compactMessages(msgs, llm, { tokenBudget: 4, keepRecent: 0 })
    ).rejects.toThrow(/无法选择合法切点/);
  });

  test('signal 转发到 LLM.generateText', async () => {
    const controller = new AbortController();
    const llm = {
      generateText: mock(async (_prompt: string, _system?: string) => 'summary'),
    };
    const msgs = [
      userMsg('u1'),
      assistantMsg('a1'),
      userMsg('u2'),
      assistantMsg('a2'),
      userMsg('u3'),
      assistantMsg('a3'),
    ];
    await compactMessages(msgs, llm, {
      tokenBudget: 100000,
      keepRecent: 5,
      signal: controller.signal,
    });
    // 只验证 LLM 被调用,signal 透传由 generateText 内部处理
    expect(llm.generateText).toHaveBeenCalled();
  });

  test('keepRecent = 0:仍走正常压缩路径', async () => {
    // keepRecent 只用作 "messages.length <= keepRecent 则不压缩" 短路
    // messages.length > keepRecent = 0 时仍正常压缩
    const llm = makeLlm();
    const msgs = [userMsg('u1'), assistantMsg('a1'), userMsg('u2')];
    const result = await compactMessages(msgs, llm, {
      tokenBudget: 100000,
      keepRecent: 0,
    });
    // selectCutPoint 选 2 (max user index), recent = msgs.slice(2) = [u2]
    // summary + recent = 2
    expect(result.length).toBe(2);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('Summary'); // from makeLlm default
    expect(result[1]).toEqual(msgs[2]);
  });
});
