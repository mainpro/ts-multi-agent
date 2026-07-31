/**
 * 排查:刷新页面后历史内容不显示
 *
 * 用户的 session.json 已有 2 个 request(都有 result),但 loadHistory 看不到任何消息。
 * 用一个真实的 session 文件 + 模拟 getSessionHistory 调用复现问题。
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../src/memory/session-store';
import { MainAgent } from '../src/agents/main-agent';
import { TaskQueue } from '../src/task-queue';
import { LLMClient } from '../src/llm';
import { IntentRouter } from '../src/routers';
import { UserProfileService } from '../src/user-profile';
import { MemoryService } from '../src/memory/memory-service';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { AskAgent } from '../src/agents/ask-agent';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';

describe('getSessionHistory: 历史内容显示', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
  });

  /**
   * 写入用户的实际 session.json 结构(从日志推断的字段)
   */
  async function writeUserSession(): Promise<{ userId: string; sessionId: string }> {
    const userId = '1727596139882397698';
    const sessionId = 'session-1776821220001';
    const dir = path.join(dataDir, 'memory', userId, 'session');
    await fs.mkdir(dir, { recursive: true });

    const now = new Date().toISOString();
    const requestData = (requestId: string, content: string, result: string) => ({
      requestId,
      content,
      status: 'processing',  // ← 用户实际是 processing(completeRequest 没正确派生)
      createdAt: now,
      updatedAt: now,
      suspendedAt: null,
      suspendedReason: null,
      questions: [],
      currentQuestion: null,
      tasks: [{
        taskId: `plan-xxx-task-1`,
        content,
        status: 'pending',  // ← 用户实际的 task 状态
        skillName: 'geam-qa',
        createdAt: now,
        updatedAt: now,
        result: null,
        questions: [],
        currentQuestion: null,
      }],
      result,
      executionProgress: {
        currentLayerIndex: 1,
        completedResults: { 'plan-xxx-task-1': { success: true, data: { response: result } } },
        taskGraph: {
          id: 'plan-xxx',
          requirement: 'test',
          nodes: [{ taskId: 'plan-xxx-task-1', content, skillName: 'geam-qa', dependencies: [], params: {} }],
          layers: [['plan-xxx-task-1']],
        },
      },
    });

    const sessionData = {
      sessionId,
      userId,
      createdAt: now,
      updatedAt: now,
      activeRequestId: null,
      pendingRequests: [],
      requests: [
        requestData('req-aaa', '我要申请GEAM凭证查询权限', '您好！您是财务部用户...'),
        requestData('req-bbb', '我要申请GEAM凭证查询权限', '您好！您是财务部用户...'),
      ],
    };

    await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(sessionData, null, 2));
    return { userId, sessionId };
  }

  async function buildAgent(): Promise<MainAgent> {
    const mockLLM: any = {
      generateText: async () => '',
      generateWithTools: async () => ({ content: '', toolCalls: [] }),
      generateStructured: async () => ({}),
    };
    const taskQueue = new TaskQueue(async () => ({}));
    const intentRouter: any = { classify: async () => ({ intent: 'small_talk', confidence: 1, tasks: [] }) };
    const userProfileService = new UserProfileService(dataDir);
    const memoryService = new MemoryService(dataDir, mockLLM);
    const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
    const sessionStore = new SessionStore(100, dataDir);
    const askAgent = new AskAgent(sessionStore, mockLLM, taskQueue);
    const systemSkillLoader = new SystemSkillLoader();
    systemSkillLoader.loadAll();
    const executorRegistry = new ExecutorRegistry();

    return new MainAgent({
      llm: mockLLM,
      skillRegistry: { getAllMetadata: () => [], hasSkill: () => false } as any,
      taskQueue,
      intentRouter,
      userProfileService,
      memoryService,
      dynamicContextBuilder,
      sessionStore,
      askAgent,
      systemSkillLoader,
      executorRegistry,
    });
  }

  test('模拟用户的 session:2 个有 result 的 request → getSessionHistory 返回 messages', async () => {
    const { userId, sessionId } = await writeUserSession();
    const agent = await buildAgent();

    const history = await agent.getSessionHistory(userId, sessionId);

    console.log('\n=== getSessionHistory 返回 ===');
    console.log('exists:', history.exists);
    console.log('messages count:', history.messages.length);
    console.log('activeRequestId:', history.activeRequestId);
    console.log('requestStatus:', history.requestStatus);
    console.log('executionProgress keys:', history.executionProgress ? Object.keys(history.executionProgress) : 'undefined');
    if (history.messages.length > 0) {
      console.log('first message:', JSON.stringify(history.messages[0]));
      console.log('last message:', JSON.stringify(history.messages[history.messages.length - 1]));
    }

    // 关键断言:消息数量应该是 4(2 个 user + 2 个 assistant)
    expect(history.exists).toBe(true);
    expect(history.messages.length).toBeGreaterThan(0);
    expect(history.messages.length).toBe(4);

    // user 消息有内容
    const userMessages = history.messages.filter(m => m.role === 'user');
    expect(userMessages.length).toBe(2);

    // assistant 消息有内容
    const assistantMessages = history.messages.filter(m => m.role === 'assistant');
    expect(assistantMessages.length).toBe(2);
  });

  test('executionProgress 不应阻塞 messages 返回', async () => {
    const { userId, sessionId } = await writeUserSession();
    const agent = await buildAgent();

    const history = await agent.getSessionHistory(userId, sessionId);

    // 即便 executionProgress 解析有问题,messages 也应正常返回
    expect(history.messages.length).toBe(4);
    // executionProgress 应该包含 2 个 request 的快照
    expect(history.executionProgress).toBeDefined();
    expect(Object.keys(history.executionProgress!).length).toBe(2);
  });
});