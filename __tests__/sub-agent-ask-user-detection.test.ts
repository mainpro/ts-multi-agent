// __tests__/sub-agent-ask-user-detection.test.ts
/**
 * Bug fix 回归测试:
 *
 * 之前 SubAgent 用 `trackedToolCalls.find(name === 'ask_user')` 判断等待用户输入。
 * trackedToolCalls 是整个对话累积的工具调用历史,所以一旦 LLM 在前面调用过 ask_user,
 * 后续 LLM 返回纯文本(无 tool calls)时,SubAgent 也会被误判为 waiting_user_input,
 * 导致任务错误进入 waiting 状态。
 *
 * 修复:改为检查最后一个工具调用是否是 ask_user(只有 ask_user 是最后动作时才等待)。
 */
import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { SubAgent } from '../src/agents/sub-agent';
import { SkillRegistry } from '../src/skill-registry';
import { ILLMClient } from '../src/llm';
import { Task, Skill, ToolResult, ToolContext } from '../src/types';

/** 模拟 LLM:模拟真实 LLMClient.generateWithTools 的循环行为。 */
class SequencedLLM implements ILLMClient {
  readonly responses: Array<{ content: string; toolCalls: any[] }>;
  callCount = 0;

  constructor(responses: Array<{ content: string; toolCalls: any[] }>) {
    this.responses = responses;
  }

  async generateText(): Promise<string> {
    throw new Error('not used');
  }
  async generateStructured<T>(): Promise<T> {
    throw new Error('not used');
  }

  async generateWithTools(
    messages: any[],
    tools: any[],
    toolExecutor: any,
    signal?: AbortSignal,
    concurrencyChecker?: any,
    onIterationStart?: any,
    requestId?: string,
  ): Promise<{ content: string; toolCalls: any[]; messages: any[] }> {
    if (this.callCount >= this.responses.length) {
      return { content: '(done)', toolCalls: [], messages };
    }
    const resp = this.responses[this.callCount++];
    const trackedMessages = [...messages];

    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      trackedMessages.push({ role: 'assistant', content: resp.content });
      return { content: resp.content, toolCalls: [], messages: trackedMessages };
    }

    const cumulativeToolCalls: any[] = [...resp.toolCalls];
    trackedMessages.push({
      role: 'assistant',
      content: resp.content,
      tool_calls: resp.toolCalls.map((tc, i) => ({
        id: `tc-${this.callCount}-${i}`,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    for (const tc of resp.toolCalls) {
      const resultStr = await toolExecutor({
        name: tc.name,
        arguments: tc.arguments,
      });
      trackedMessages.push({
        role: 'tool',
        name: tc.name,
        content: typeof resultStr === 'string' ? resultStr : JSON.stringify(resultStr),
      });
    }

    const next = await this.generateWithTools(
      trackedMessages, tools, toolExecutor, signal, concurrencyChecker, onIterationStart, requestId,
    );
    return {
      content: next.content,
      toolCalls: [...cumulativeToolCalls, ...next.toolCalls],
      messages: next.messages,
    };
  }
}

class StubSkillRegistry extends SkillRegistry {
  constructor(private readonly skill: Skill) { super(); }
  async loadFullSkill(name: string): Promise<Skill | null> {
    return name === this.skill.name ? this.skill : null;
  }
}

const baseTask: Task = {
  id: 'task-1',
  requirement: '我要申请GEAM凭证查询权限',
  status: 'pending',
  skillName: 'geam-qa',
  params: {},
  dependencies: [],
  dependents: [],
  createdAt: new Date(),
  retryCount: 0,
};

/**
 * Helper:每个 test 用独立 task 实例(避免 SubAgent.execute 把 _completedToolCalls
 * 等状态写到 task 上,污染后续测试)。
 */
function freshTask(): Task {
  return {
    ...baseTask,
    id: `${baseTask.id}-${Math.random().toString(36).slice(2, 7)}`,
  };
}

const baseSkill: Skill = {
  name: 'geam-qa',
  description: 'Test skill',
  body: 'TEST_BODY',
  allowedTools: ['ask_user', 'mock_echo'],
};

/**
 * Helper:用 monkey-patch 把 ToolRegistry 里所有工具换成 mock 版本,
 * 避免 PathGuard / sandbox 等副作用,让工具总是成功。
 */
function mockAllToolsAsSuccess(subAgent: SubAgent, capturedResults: Array<{ toolName: string; args: any }>): void {
  const registry = (subAgent as any).toolRegistry;
  // 注册 mock_echo 工具(总是成功)
  registry.register({
    name: 'mock_echo',
    description: 'mock echo tool for tests',
    parameters: { message: { type: 'string' } },
    required: [],
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      capturedResults.push({ toolName: 'mock_echo', args: input });
      return { success: true, data: `echo: ${(input as any)?.message || ''}` };
    },
  });
}

describe('SubAgent ask_user detection (regression: bug fix)', () => {
  let logSpy: any;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  test('Bug fix: ask_user 后又调用 mock_echo + 返回文本,不应误判为 waiting_user_input', async () => {
    // 真实 bug 场景:LLM 序列 ask_user → mock_echo → 文本
    // 旧代码:trackedToolCalls.find('ask_user') 找到 → 错误返回 waiting
    // 修复后:last tool call 是 mock_echo(不是 ask_user)→ 不 wait
    const capturedTools: any[] = [];
    const llm = new SequencedLLM([
      { content: '', toolCalls: [{ name: 'ask_user', arguments: { question: '请问您的工号?' } }] },
      { content: '', toolCalls: [{ name: 'mock_echo', arguments: { message: 'check' } }] },
      { content: '已完成凭证申请', toolCalls: [] },
    ]);

    const subAgent = new SubAgent(
      new StubSkillRegistry(baseSkill),
      llm as any,
    );
    mockAllToolsAsSuccess(subAgent, capturedTools);

    const result = await subAgent.execute(freshTask());

    // 关键断言:不应误判为 waiting_user_input
    expect(result.data?.status).not.toBe('waiting_user_input');
    expect(result.success).toBe(true);
    expect(result.data?.response).toBe('已完成凭证申请');
    // 两个工具都被实际执行了(ask_user + mock_echo)
    expect(capturedTools.length).toBe(1); // mock_echo(ask_user 是 SubAgent 内部拦截,不走 toolRegistry.execute)
  });

  test('Positive case: ask_user 是最后一个工具调用 → 正常返回 waiting_user_input', async () => {
    // 反向验证:不是把所有 ask_user 检测都关了
    // ask_user 是最后一个工具调用(LLM 调用 ask_user 后终止)→ 应该 wait
    const llm = new SequencedLLM([
      { content: '', toolCalls: [{ name: 'ask_user', arguments: { question: '请问您的工号?' } }] },
      { content: '(waiting)', toolCalls: [] },
    ]);

    const subAgent = new SubAgent(
      new StubSkillRegistry(baseSkill),
      llm as any,
    );
    mockAllToolsAsSuccess(subAgent, []);

    const result = await subAgent.execute(freshTask());

    // ask_user 是最后一个 → 应该返回 waiting
    expect(result.data?.status).toBe('waiting_user_input');
    expect(result.data?.question?.content).toBe('请问您的工号?');
  });

  test('Sanity: LLM 直接返回纯文本(无工具调用)→ completed', async () => {
    // 没有任何工具调用,LLM 直接返回文本 → 不应 waiting
    const llm = new SequencedLLM([
      { content: '直接回复:已查询完毕', toolCalls: [] },
    ]);

    const subAgent = new SubAgent(
      new StubSkillRegistry(baseSkill),
      llm as any,
    );
    mockAllToolsAsSuccess(subAgent, []);

    const result = await subAgent.execute(freshTask());

    expect(result.data?.status).not.toBe('waiting_user_input');
    expect(result.success).toBe(true);
    expect(result.data?.response).toBe('直接回复:已查询完毕');
  });
});