import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createAPIServer } from '../src/api';
import { MainAgent } from '../src/agents/main-agent';
import { SubAgent } from '../src/agents/sub-agent';
import { SessionStore } from '../src/memory/session-store';
import { steeringBuffer } from '../src/memory/steering-buffer';
import { TaskQueue } from '../src/task-queue';
import { MemoryService } from '../src/memory/memory-service';
import { UserProfileService } from '../src/user-profile';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { IntentRouter } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';
import { SkillRegistry } from '../src/skill-registry';
import { Message, Task, Skill } from '../src/types';

function postJson(url: string, body: unknown): Promise<{ status: number; rawBody: string; headers: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c.toString());
      res.on('end', () => resolve({ status: res.statusCode ?? 0, rawBody: buf, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('POST /tasks/stream steer path', () => {
  let dataDir: string;
  let server: http.Server;
  let url: string;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    steeringBuffer.clear('s1');
    dataDir = path.join(os.tmpdir(), `apisteer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });

    const mockLLM = {
      generateStructured: async () => null,
      generateText: async () => '',
      generateWithTools: async () => ({ content: '', toolCalls: [] }),
    } as any;
    const mockRegistry = {
      getAllMetadata: () => [], loadFullSkill: async () => null, hasSkill: () => false,
      scanSkills: async () => [], startWatch: () => {}, stopWatch: () => {},
      getSkillCount: () => 0, getSkillNames: () => [], getSkillMetadata: () => null,
    } as any;

    sessionStore = new SessionStore(100, dataDir);
    const memoryService = new MemoryService(dataDir, mockLLM);
    const userProfileService = new UserProfileService(dataDir);
    const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
    const intentRouter = new IntentRouter(mockLLM, mockRegistry);
    const askAgent = new AskAgent(sessionStore, mockLLM);
    const systemSkillLoader = new SystemSkillLoader();
    systemSkillLoader.loadAll();
    const executorRegistry = new ExecutorRegistry();
    const taskQueue = new TaskQueue(async () => null);

    const mainAgent = new MainAgent({
      llm: mockLLM, skillRegistry: mockRegistry, taskQueue, intentRouter,
      userProfileService, memoryService, dynamicContextBuilder, sessionStore,
      askAgent, systemSkillLoader, executorRegistry,
    });

    const app = createAPIServer(mainAgent, mockRegistry, taskQueue);
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  async function seedActive(taskStatus: 'running' | 'pending' | null) {
    const session = await sessionStore.loadSession('u1', 's1');
    session.activeRequestId = 'r-existing';
    session.requests = [{
      requestId: 'r-existing', content: 'first', status: 'processing',
      createdAt: 'x', updatedAt: 'x',
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null,
      tasks: taskStatus ? [{
        taskId: 't1', content: 'sub task', status: taskStatus, skillName: 'demo',
        createdAt: 'x', updatedAt: 'x', result: null, questions: [], currentQuestion: null,
      }] : [],
      result: null,
    }];
    session.pendingRequests = [];
    await sessionStore.saveSession('u1', 's1', session);
    await new Promise(r => setTimeout(r, 150));
  }

  test('active processing request with a running task → 202 steered + 消息进 steeringBuffer', async () => {
    await seedActive('running');

    const { status, headers, rawBody } = await postJson(`${url}/tasks/stream`, {
      requirement: '改成上海',
      userId: 'u1',
      sessionId: 's1',
    });

    expect(status).toBe(202);
    expect(headers['content-type']).toMatch(/application\/json/);
    const parsed = JSON.parse(rawBody);
    expect(parsed.steered).toBe(true);
    expect(parsed.success).toBe(true);

    const consumed = steeringBuffer.consume('s1');
    expect(consumed).toHaveLength(1);
    expect(consumed[0].content).toBe('改成上海');
    expect(consumed[0].enqueuedAt).toBeTruthy();
  });

  test('active processing 但没有 running 任务 → 回退到原有 queued 路径,不进 steer', async () => {
    await seedActive(null);

    const { status, rawBody } = await postJson(`${url}/tasks/stream`, {
      requirement: '第二条',
      userId: 'u1',
      sessionId: 's1',
    });

    expect(status).toBe(202);
    const parsed = JSON.parse(rawBody);
    expect(parsed.steered).toBeUndefined();
    expect(parsed.status).toBe('queued');
    expect(steeringBuffer.peek('s1')).toEqual([]);
  });
});

describe('SubAgent 消费 steer 队列', () => {
  class SteerCapturingLLM {
    lastMessages: Message[] = [];
    async generateText(): Promise<string> { return ''; }
    async generateStructured<T>(): Promise<T> { return {} as T; }
    async generateWithTools(
      messages: Message[],
      _tools: any[],
      _toolExecutor: any,
      _signal?: AbortSignal,
      _concurrencyChecker?: any,
      onIterationStart?: (messages: Message[]) => void,
    ): Promise<{ content: string; toolCalls: any[]; messages: Message[] }> {
      // 模拟真实 LLMClient 的循环:复制 messages 后在每轮开头调用 hook
      const tracked = [...messages];
      onIterationStart?.(tracked);
      this.lastMessages = tracked;
      return { content: '完成', toolCalls: [], messages: tracked };
    }
  }

  class StubSkillRegistry extends SkillRegistry {
    async loadFullSkill(): Promise<Skill> {
      return { name: 'demo-skill', description: 'demo', body: 'demo body', allowedTools: ['read'] } as Skill;
    }
  }

  const makeTask = (sessionId?: string): Task => ({
    id: 'task-1',
    requirement: '订北京的酒店',
    status: 'pending',
    skillName: 'demo-skill',
    params: {},
    dependencies: [],
    dependents: [],
    createdAt: new Date(),
    retryCount: 0,
    sessionId,
    userId: 'u1',
  });

  beforeEach(() => {
    steeringBuffer.clear('steer-sess');
  });

  test('队列里的改口消息作为 user message 注入到本轮 messages,并被清空', async () => {
    const llm = new SteerCapturingLLM();
    const subAgent = new SubAgent(new StubSkillRegistry(), llm as any);

    steeringBuffer.enqueue('steer-sess', { content: '改成上海', enqueuedAt: new Date().toISOString() });
    steeringBuffer.enqueue('steer-sess', { content: '预算 800', enqueuedAt: new Date().toISOString() });

    await subAgent.execute(makeTask('steer-sess'));

    const injected = llm.lastMessages.filter(m => m.role === 'user').map(m => m.content);
    expect(injected).toContain('改成上海');
    expect(injected).toContain('预算 800');
    // 消费后队列清空,避免重复注入
    expect(steeringBuffer.peek('steer-sess')).toEqual([]);
  });

  test('没有 steer 消息时不改动 messages', async () => {
    const llm = new SteerCapturingLLM();
    const subAgent = new SubAgent(new StubSkillRegistry(), llm as any);

    await subAgent.execute(makeTask('steer-sess'));

    const userMessages = llm.lastMessages.filter(m => m.role === 'user');
    // 只有原始 requirement 那条 user message
    expect(userMessages.length).toBe(1);
    expect(userMessages[0].content).toContain('订北京的酒店');
  });

  test('task 没有 sessionId 时不消费队列(避免串会话)', async () => {
    const llm = new SteerCapturingLLM();
    const subAgent = new SubAgent(new StubSkillRegistry(), llm as any);

    steeringBuffer.enqueue('steer-sess', { content: '改成上海', enqueuedAt: new Date().toISOString() });

    await subAgent.execute(makeTask(undefined));

    expect(llm.lastMessages.some(m => m.content === '改成上海')).toBe(false);
    expect(steeringBuffer.peek('steer-sess').map(m => m.content)).toEqual(['改成上海']);
  });
});
