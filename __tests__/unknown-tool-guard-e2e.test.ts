/**
 * Unknown-Tool Guard 端到端测试
 *
 * 单元测试(__tests__/unknown-tool-guard.test.ts)覆盖 UnknownToolLoopGuard 类本身。
 * 本文件覆盖 guard 在真实 SubAgent toolExecutor 路径中的集成:
 *  - 连续调用同一未知工具时,toolResult 被改写为"必须放弃"的人话
 *  - 切换到合法工具时,counter 被 reset
 *  - 改写文本含 toolName,便于 LLM 知道是哪个工具
 *
 * 不直接调 SubAgent.executeSkill(private),而是模拟 SubAgent 内部 toolExecutor
 * 的完整流程:guard 实例化 → toolCall 决策 → toolResult 收集 → messages 累计。
 */
import { describe, test, expect } from 'bun:test';
import { UnknownToolLoopGuard } from '../src/agents/unknown-tool-guard';

interface SimulatedToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface SimulatedToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

/**
 * 模拟 SubAgent 的 toolExecutor 行为:
 *  1. LLM 决定 toolCall
 *  2. 工具调用前:guard.check(name) — 若返回改写文本,跳过真实调用
 *  3. 否则查 allowedToolNames,有则执行,无则返回 "工具不存在"
 *  4. push toolResult 到 trackedMessages
 *
 * 本函数提取自 src/agents/sub-agent.ts:executeSkill 的 toolExecutor 闭包。
 */
function simulateToolExecutor(
  toolCall: SimulatedToolCall,
  allowedToolNames: Set<string>,
  guard: UnknownToolLoopGuard,
  trackedMessages: SimulatedToolMessage[],
): void {
  if (!allowedToolNames.has(toolCall.name)) {
    // 走 guard 检查
    const rewrite = guard.check(toolCall.name);
    if (rewrite) {
      trackedMessages.push({
        role: 'tool',
        tool_call_id: `tc-${trackedMessages.length}`,
        content: rewrite,
      });
      return;
    }
    // 未到阈值,常规"工具不存在"返回
    trackedMessages.push({
      role: 'tool',
      tool_call_id: `tc-${trackedMessages.length}`,
      content: `工具执行失败: 工具 '${toolCall.name}' 不在允许列表中`,
    });
    return;
  }
  // 合法工具调用,reset guard
  guard.reset();
  trackedMessages.push({
    role: 'tool',
    tool_call_id: `tc-${trackedMessages.length}`,
    content: `OK:${toolCall.name}`,
  });
}

describe('Unknown-Tool Guard e2e 集成', () => {
  test('连续 4 次调同一未知工具,第 4 次触发改写', () => {
    const allowed = new Set(['read', 'write']);
    const guard = new UnknownToolLoopGuard(3);
    const messages: SimulatedToolMessage[] = [];

    for (let i = 0; i < 4; i++) {
      simulateToolExecutor({ name: 'fake_tool', args: {} }, allowed, guard, messages);
    }

    // 前 3 次是常规"不在允许列表"消息,第 4 次是改写消息
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toContain('不在允许列表中');
    expect(messages[1].content).toContain('不在允许列表中');
    expect(messages[2].content).toContain('不在允许列表中');
    expect(messages[3].content).toContain("can't use the tool 'fake_tool'");
    expect(messages[3].content).toContain('stop retrying');
  });

  test('切换到合法工具后,counter reset,新循环重新计数', () => {
    const allowed = new Set(['read']);
    const guard = new UnknownToolLoopGuard(3);
    const messages: SimulatedToolMessage[] = [];

    // 第 1-4 次:未知工具 (第 4 次触发改写)
    for (let i = 0; i < 4; i++) {
      simulateToolExecutor({ name: 'fake_tool', args: {} }, allowed, guard, messages);
    }
    expect(messages[3].content).toContain("can't use the tool");

    // 第 5 次:切换到合法 read → reset
    simulateToolExecutor({ name: 'read', args: { path: '/a' } }, allowed, guard, messages);
    expect(messages[4].content).toBe('OK:read');

    // 第 6-8 次:又回到 fake_tool,从 1 开始计数(不应触发改写)
    for (let i = 0; i < 3; i++) {
      simulateToolExecutor({ name: 'fake_tool', args: {} }, allowed, guard, messages);
    }
    expect(messages[5].content).toContain('不在允许列表中');
    expect(messages[6].content).toContain('不在允许列表中');
    expect(messages[7].content).toContain('不在允许列表中');
  });

  test('改写文本含工具名,让 LLM 知道是哪个工具出问题', () => {
    const allowed = new Set<string>();
    const guard = new UnknownToolLoopGuard(2);
    const messages: SimulatedToolMessage[] = [];

    // 阈值=2:第 1、2 次常规,第 3 次改写
    for (let i = 0; i < 3; i++) {
      simulateToolExecutor({ name: 'specific_evil_tool', args: {} }, allowed, guard, messages);
    }

    const rewrite = messages[2].content;
    expect(rewrite).toContain('specific_evil_tool');
    expect(rewrite).toContain("doesn't exist");
  });

  test('不同未知工具不会互相串台', () => {
    const allowed = new Set<string>();
    const guard = new UnknownToolLoopGuard(2);
    const messages: SimulatedToolMessage[] = [];

    // fake_a × 2,fake_b × 2,fake_a × 1 → fake_a 总共 3 次,会触发改写
    simulateToolExecutor({ name: 'fake_a', args: {} }, allowed, guard, messages);
    simulateToolExecutor({ name: 'fake_a', args: {} }, allowed, guard, messages);
    simulateToolExecutor({ name: 'fake_b', args: {} }, allowed, guard, messages); // 切换 → reset
    simulateToolExecutor({ name: 'fake_b', args: {} }, allowed, guard, messages);
    simulateToolExecutor({ name: 'fake_a', args: {} }, allowed, guard, messages); // 切换回 a,count=1

    // 5 次都是常规"不在允许列表"消息,因为每次切换都 reset
    expect(messages).toHaveLength(5);
    for (const m of messages) {
      expect(m.content).toContain('不在允许列表中');
    }
  });
});
