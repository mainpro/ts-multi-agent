/**
 * P2-1 修复测试:IntentRouter 返回混合 tasks(部分 skill + 部分 unclear),
 * MainAgent 应整条请求转人工,不执行 skill 任务(避免"既返回结果又说转人工"的混乱)。
 *
 * 覆盖:
 *  1. hasTransferRequest=true → 返回 "转人工" 消息,type='unclear'
 *  2. 旧行为 prefix "转人工" 已移除(响应里不含 skill 结果拼接)
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MainAgent } from '../src/agents/main-agent';
import { MemoryService } from '../src/memory/memory-service';
import { SessionStore } from '../src/memory/session-store';
import { IntentRouter } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { UserProfileService } from '../src/user-profile';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';
import { TaskQueue } from '../src/task-queue';

describe('hasTransferRequest 短路转人工 (P2-1)', () => {
  let dataDir: string;
  let sessionStore: SessionStore;
  let taskQueue: TaskQueue;
  let skillCallCount: number;
  let intentCallCount: number;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `p21-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
    sessionStore = new SessionStore(100, dataDir);
    taskQueue = new TaskQueue(async () => ({ ok: true, response: 'skill-result' }));
    skillCallCount = 0;
    intentCallCount = 0;
  });

  async function createAgent(intentRouterMock: any) {
    const mockLLM: any = {
      generateText: async () => '',
      generateWithTools: async () => ({ content: '', toolCalls: [] }),
      generateStructured: async () => ({}),
    };
    const skillRegistry: any = {
      getAllMetadata: () => [],
      loadFullSkill: async () => null,
      hasSkill: () => false,
    };
    const memoryService = new MemoryService(dataDir, mockLLM);
    const userProfileService = new UserProfileService(dataDir);
    const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
    const askAgent = new AskAgent(sessionStore, mockLLM, taskQueue);
    const systemSkillLoader = new SystemSkillLoader();
    const executorRegistry = new ExecutorRegistry();

    return new MainAgent({
      llm: mockLLM, skillRegistry, taskQueue, intentRouter: intentRouterMock,
      userProfileService, memoryService, dynamicContextBuilder,
      sessionStore, askAgent, systemSkillLoader, executorRegistry,
    });
  }

  test('hasTransferRequest=true → 整条请求转人工,无 skill 任务执行', async () => {
    // IntentRouter 返回 2 个 task:1 个 skill,1 个 unclear
    const intentRouter: any = {
      classify: async () => {
        intentCallCount++;
        return {
          intent: 'skill_task',
          confidence: 0.8,
          tasks: [
            { taskId: 't1', requirement: 'clear skill task', skillName: 'echo', params: {}, intent: 'skill' },
            { taskId: 't2', requirement: 'unclear thing', skillName: null, params: {}, intent: 'unclear' },
          ],
        };
      },
    };
    const agent = await createAgent(intentRouter);

    // TaskQueue 调用计数(简易监控)
    const addTaskSpy = (taskQueue as any).addTask = () => {
      skillCallCount++;
      return { success: true, taskId: 't1' };
    };

    const result = await agent.processRequirement(
      '混合意图请求', undefined, 'u1', 's1',
    );

    // 整条请求应被识别为转人工
    expect((result.data as any)?.type).toBe('unclear');
    expect((result.data as any)?.message).toContain('转给人工客服');

    // 关键断言:不应执行 skill 任务
    expect(skillCallCount).toBe(0);
    expect(intentCallCount).toBe(1);
  });

  test('无 unclear 任务 → 正常走 skill 任务路径(回归)', async () => {
    // IntentRouter 返回纯 skill 任务,无 unclear
    const intentRouter: any = {
      classify: async () => {
        intentCallCount++;
        return {
          intent: 'skill_task',
          confidence: 0.9,
          tasks: [
            { taskId: 't1', requirement: 'normal skill task', skillName: 'echo', params: {}, intent: 'skill' },
          ],
        };
      },
    };
    const agent = await createAgent(intentRouter);

    // 不 mock addTask — 走真实 TaskQueue(由于没有真实 SubAgent,任务会卡在 pending)
    // 这里我们只验证 hasTransferRequest 不触发短路返回
    // 用 try/catch 接受任务卡住的失败,但 result 应不是 'unclear'
    let result;
    try {
      result = await agent.processRequirement('纯 skill 请求', undefined, 'u2', 's2');
    } catch (e) {
      // 任务执行卡住会抛错,不影响 P2-1 验证
      result = null;
    }

    // 不应触发"转人工"短路(由 hasTransferRequest=false 保证)
    if (result && (result.data as any)?.type) {
      expect((result.data as any).type).not.toBe('unclear');
    }
    // 即使任务卡住,也不会短路到转人工
    expect(intentCallCount).toBe(1);
  });

  test('hasTransferRequest=true 时,旧 prefix 拼接行为已移除', async () => {
    // 验证:即便 skill 任务执行了(旧行为),也不会再把结果拼到 "转人工" 后面
    // 因为现在 hasTransferRequest 直接短路,不进 skill 路径
    const intentRouter: any = {
      classify: async () => ({
        intent: 'skill_task',
        confidence: 0.8,
        tasks: [
          { taskId: 't1', requirement: 'clear', skillName: 'echo', params: {}, intent: 'skill' },
          { taskId: 't2', requirement: 'unclear', skillName: null, params: {}, intent: 'unclear' },
        ],
      }),
    };
    const agent = await createAgent(intentRouter);

    const result = await agent.processRequirement('混合', undefined, 'u3', 's3');

    // message 应只包含 "转给人工客服",不应包含 "根据执行结果" / skill 结果拼接
    const message = (result.data as any)?.message ?? '';
    expect(message).toContain('转给人工客服');
    // 不应有 skill 结果特征(例如 "skill-result" 或 "根据执行结果")
    expect(message).not.toContain('skill-result');
    expect(message).not.toContain('根据执行结果');
  });
});