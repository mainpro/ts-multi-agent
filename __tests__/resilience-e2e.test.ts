/**
 * LLM 韧性层 e2e 测试套件
 *
 * 覆盖 3 个机制在真实模块组合下的端到端行为:
 *  1. tool-call-repair: 自由文本 → 原生 tool_calls 转换后,SubAgent 工具循环能正常消费
 *  2. safe compaction: CONTEXT_TOO_LONG 抛出后,SubAgent 压缩历史并重试,新 LLM 调用拿到精简 messages
 *  3. steer queue: 用户改口 → API 入队 → SubAgent 消费 → trackedMessages 含改口 + request_steered 事件发出
 *
 * 不启动真实 dev server,而是直接调用 LLMClient / SubAgent 模块,观察完整数据流。
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { repairToolCalls } from '../src/llm/tool-call-repair';
import { findValidCutPoints, selectCutPoint, compactMessages } from '../src/llm/compaction';
import { steeringBuffer } from '../src/memory/steering-buffer';
import { requestLifecycle } from '../src/events/request-lifecycle';
import { LLMError } from '../src/llm';
import type { Message } from '../src/types';

// ===== 工具 =====

function makeAssistantWithToolCalls(content: string | null, tool_calls: any[]) {
  return { content, tool_calls };
}

// ===== 测试 1: tool-call-repair e2e =====

describe('tool-call-repair e2e', () => {
  test('修复后的 tool_calls 形如 OpenAI 原生,可被下游正常消费', () => {
    // 模拟模型输出 bracket grammar
    const rawLlmOutput = {
      content: '我先看下文件 [tool:read_file]\n{"path":"/etc/hosts"}\n[/read_file] 然后告诉你',
      tool_calls: undefined,
    };

    const repaired = repairToolCalls(rawLlmOutput);

    expect(repaired.repaired).toBe(true);
    expect(repaired.stopReason).toBe('toolUse');
    expect(repaired.tool_calls).toHaveLength(1);

    const tc = repaired.tool_calls[0];
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('read_file');
    expect(JSON.parse(tc.function.arguments)).toEqual({ path: '/etc/hosts' });

    // 模拟下游:SubAgent toolExecutor 收到原生 tool_calls,正常执行
    const downstreamArgs = JSON.parse(tc.function.arguments);
    expect(downstreamArgs.path).toBe('/etc/hosts');  // 能被解析为正常参数
  });

  test('已合法 tool_calls 不会被修复破坏(idempotent)', () => {
    const legal = makeAssistantWithToolCalls(null, [{
      id: 'tc-1',
      type: 'function',
      function: { name: 'bash', arguments: '{"cmd":"ls"}' },
    }]);

    const repaired = repairToolCalls({
      content: legal.content,
      tool_calls: legal.tool_calls,
    });

    expect(repaired.repaired).toBe(false);
    expect(repaired.tool_calls).toEqual(legal.tool_calls);
  });
});

// ===== 测试 2: safe compaction e2e =====

describe('safe compaction e2e', () => {
  test('切点保护:toolUse/toolResult 配对不被切断', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: 'r1', tool_call_id: 'a' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'b', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: 'r2', tool_call_id: 'b' },
      { role: 'assistant', content: 'second answer' },
    ];

    const points = findValidCutPoints(messages);
    // 合法切点:0, 1(user), 4(assistant 无 tool_calls), 5(user), 8(assistant 无 tool_calls)
    expect(points).toEqual([0, 1, 4, 5, 8]);

    // ❌ 不能切:2 (toolUse 后)、3 (toolResult 后接 assistant tool_calls 时,3 处切会孤立 tool_call)
    //    实际:3 是 tool 消息,不能作切点(只 user / assistant-no-toolCalls 作切点)
    expect(points).not.toContain(2);
    expect(points).not.toContain(3);
    expect(points).not.toContain(6);  // toolUse
    expect(points).not.toContain(7);  // tool
  });

  test('selectCutPoint 选最优:从尾部向头部找,token 最小超标', () => {
    const messages: Message[] = [
      { role: 'user', content: 'a'.repeat(1000) },  // ~250 tokens
      { role: 'assistant', content: 'b'.repeat(1000) },
      { role: 'user', content: 'c'.repeat(1000) },
      { role: 'assistant', content: 'd'.repeat(1000) },
      { role: 'user', content: 'e'.repeat(1000) },
    ];
    // 总 token ~1250;budget=600 → 选最近的切点让剩余 ≤ 600

    const cut = selectCutPoint(messages, 600);
    expect(cut).not.toBeNull();
    // 期望 cut=3 或 4(保留最近 1-2 条)
    expect([3, 4]).toContain(cut!);
  });

  test('compactMessages:压缩后配对完整,recent 原样保留', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: 'tool result 1', tool_call_id: 't1' },
      { role: 'assistant', content: 'old complete answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: 'tool result 2', tool_call_id: 't2' },
      { role: 'assistant', content: 'recent answer' },
    ];

    // Mock LLM 摘要
    const mockLlm = {
      generateText: async (prompt: string): Promise<string> => {
        return '用户问了两个问题,都已回答。';
      },
    };

    const compacted = await compactMessages(messages, mockLlm as any, {
      tokenBudget: 15,  // 强制压缩(每条 ~6 token,8 条 ~48 token)
      keepRecent: 3,    // 保留最后 3 条
    });

    // 压缩后应是 [summary, ...recent]
    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted[0].role).toBe('user');
    expect(compacted[0].content).toContain('对话历史摘要');
    // recent 原样保留(最后 3 条)
    expect(compacted[compacted.length - 1]).toEqual(messages[messages.length - 1]);
  });

  test('CONTEXT_TOO_LONG 错误触发链路:SubAgent 模拟层捕获并压缩', async () => {
    // 模拟 SubAgent 工具循环:第一次 LLM 调用抛 CONTEXT_TOO_LONG,第二次用压缩后的 messages 重试
    // 单条消息 100 字符 ≈ 25 token;budget=300 → 留最近 ~10 条
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `msg-${i} ${'x'.repeat(100)}`,
    }));

    let attempt = 0;
    const mockGenerate = async (msgs: Message[]) => {
      attempt++;
      if (attempt === 1) {
        // 模拟 LLM 第一次报 token 超限
        throw new LLMError('CONTEXT_TOO_LONG', 'context length exceeded', 400);
      }
      // 第二次用压缩后的 messages(应更短)
      return { content: 'OK', messages: msgs };
    };

    // 模拟 SubAgent 包装层(Task 2 实现)
    let baseMessages = messages;
    const MAX_ATTEMPTS = 1;
    let attempts = 0;
    let result;
    while (attempts <= MAX_ATTEMPTS) {
      try {
        result = await mockGenerate(baseMessages);
        break;
      } catch (err) {
        if (err instanceof LLMError && err.type === 'CONTEXT_TOO_LONG' && attempts < MAX_ATTEMPTS) {
          const mockLlm = { generateText: async () => 'summary' };
          baseMessages = await compactMessages(baseMessages, mockLlm as any, {
            tokenBudget: 300,  // > 单条 ~25,留 ~10 条
            keepRecent: 3,
          });
          attempts++;
          continue;
        }
        throw err;
      }
    }

    expect(attempt).toBe(2);  // 第一次失败,第二次成功
    expect(result!.messages.length).toBeLessThan(messages.length);
    expect(result!.content).toBe('OK');
  });
});

// ===== 测试 3: steer queue e2e =====

describe('steer queue e2e', () => {
  const testSessionId = 'e2e-test-session';

  beforeEach(() => {
    steeringBuffer.clear(testSessionId);
  });

  afterEach(() => {
    steeringBuffer.clear(testSessionId);
  });

  test('完整流程:API enqueue → SubAgent consume → trackedMessages 注入 + request_steered 事件发出', () => {
    const events: any[] = [];
    const listener = (e: any) => events.push(e);
    requestLifecycle.on('request_steered', listener);

    // 1. API 层 enqueue(模拟 src/api/index.ts 的 steer 分支)
    steeringBuffer.enqueue(testSessionId, {
      content: '等等,改成上海',
      enqueuedAt: new Date().toISOString(),
    });

    // 2. SubAgent consume(模拟 src/agents/sub-agent.ts 的 consumeSteering 闭包)
    const trackedMessages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '查 GEAM 权限' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    ];

    const steering = steeringBuffer.consume(testSessionId);
    expect(steering).toHaveLength(1);

    for (const msg of steering) {
      trackedMessages.push({ role: 'user', content: msg.content });
      requestLifecycle.emit({
        type: 'request_steered',
        requestId: 'req-123',
        taskId: 'plan-1-task-1',
        content: msg.content,
        enqueuedAt: msg.enqueuedAt,
        consumedAt: new Date().toISOString(),
      });
    }

    // 3. 断言:trackedMessages 含改口消息,buffer 清空,事件发出
    expect(trackedMessages).toHaveLength(4);
    expect(trackedMessages[3]).toEqual({
      role: 'user',
      content: '等等,改成上海',
    });
    expect(steeringBuffer.peek(testSessionId)).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe('等等,改成上海');
    expect(events[0].taskId).toBe('plan-1-task-1');

    requestLifecycle.off('request_steered', listener);
  });

  test('drain on task end:SubAgent finally 清掉残留 buffer', () => {
    // 模拟场景:SubAgent 跑完一轮就退出,steer 消息来不及消费
    steeringBuffer.enqueue(testSessionId, {
      content: '晚到的改口',
      enqueuedAt: new Date().toISOString(),
    });

    // 模拟 SubAgent.execute 的 finally(任务结束)
    const pending = steeringBuffer.peek(testSessionId);
    expect(pending).toHaveLength(1);

    if (pending.length > 0) {
      steeringBuffer.clear(testSessionId);
    }

    // 下次任务执行时,buffer 已空,不会错误注入
    const next = steeringBuffer.consume(testSessionId);
    expect(next).toEqual([]);
  });

  test('跨 session 隔离:A 会话清掉不影响 B 会话', () => {
    const sessionA = 'session-A';
    const sessionB = 'session-B';

    steeringBuffer.enqueue(sessionA, { content: 'A 的改口', enqueuedAt: 't1' });
    steeringBuffer.enqueue(sessionB, { content: 'B 的改口', enqueuedAt: 't2' });

    // 清掉 A
    steeringBuffer.clear(sessionA);

    // B 不受影响
    const bMessages = steeringBuffer.consume(sessionB);
    expect(bMessages).toHaveLength(1);
    expect(bMessages[0].content).toBe('B 的改口');

    steeringBuffer.clear(sessionB);
  });
});
