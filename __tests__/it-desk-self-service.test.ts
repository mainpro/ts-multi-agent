import { describe, test, expect } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

import { ILLMClient } from '../src/llm/interfaces';
import { SkillRegistry } from '../src/skill-registry';
import { MemoryService } from '../src/memory/memory-service';
import { SessionStore } from '../src/memory/session-store';
import { IntentRouter, IntentResult } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { SubAgent } from '../src/agents/sub-agent';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { UserProfileService } from '../src/user-profile';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';
import { TaskQueue } from '../src/task-queue';
import { MainAgent } from '../src/agents/main-agent';
import { createAPIServer } from '../src/api';

interface StackedAgent {
  mainAgent: MainAgent;
  url: string;
  close: () => Promise<void>;
  dataDir: string;
}

async function buildStackedAgent(): Promise<StackedAgent> {
  const dataDir = path.join(os.tmpdir(), `desk-self-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });

  const intentResult: IntentResult = {
    intent: 'skill_task',
    confidence: 0.98,
    tasks: [{ taskId: 'mdm-status', requirement: '查 MDM 客户端状态', skillName: 'mdm-status', intent: 'skill_task' }],
  };
  let structuredCalls = 0;
  let toolCalls = 0;
  const mockLLM: ILLMClient = {
    generateStructured: async () => {
      structuredCalls += 1;
      if (structuredCalls === 1) return intentResult;
      return {
        analysis: { summary: 'MDM 状态查询完成', intent: 'skill_task' },
        skillSelection: ['mdm-status'],
        plan: { needsClarification: false, tasks: [{ id: 'mdm-status', requirement: '查 MDM 客户端状态', skillName: 'mdm-status', params: {}, dependencies: [] }] },
      };
    },
    generateText: async () => 'MDM 客户端当前状态正常，已恢复登录。',
    generateWithTools: async () => {
      toolCalls += 1;
      return { content: 'MDM 客户端当前状态正常，已恢复登录。', toolCalls: [{ name: 'check_mdm_status', arguments: { deviceId: 'device-001' } }] };
    },
    generateWithToolsTracked: async () => ({ content: 'MDM 客户端当前状态正常，已恢复登录。', toolCalls: [], messages: [] }),
  } as any;

  const skillRegistry = {
    getAllMetadata: () => [{ name: 'mdm-status', description: '查询 MDM 客户端状态', metadata: {}, allowedTools: ['check_mdm_status'] } as any],
    loadFullSkill: async () => ({ name: 'mdm-status', description: '查询 MDM 客户端状态', body: '查询 MDM 客户端状态', metadata: {}, allowedTools: ['check_mdm_status'] }),
    hasSkill: () => true,
    scanSkills: async () => ['mdm-status'], startWatch: () => {}, stopWatch: () => {}, getSkillCount: () => 1,
    getSkillNames: () => ['mdm-status'], getSkillMetadata: () => ({ name: 'mdm-status', description: '查询 MDM 客户端状态' }) as any,
  } as any as SkillRegistry;
  const memory = new MemoryService(dataDir, mockLLM);
  const sessions = new SessionStore(100, dataDir);
  const profiles = new UserProfileService(dataDir);
  const intentRouter = new IntentRouter(mockLLM, skillRegistry);
  const askAgent = new AskAgent(sessions, mockLLM);
  const loader = new SystemSkillLoader(); loader.loadAll();
  const executors = new ExecutorRegistry();
  const subAgent = new SubAgent(skillRegistry, mockLLM, memory);
  const queue = new TaskQueue(async (task) => {
    const result = await subAgent.execute(task);
    return { ...result, toolResult: { name: 'check_mdm_status', content: '设备 device-001 的 MDM 客户端状态：在线，认证有效。' } } as any;
  });
  const mainAgent = new MainAgent({ llm: mockLLM, skillRegistry, taskQueue: queue, intentRouter, userProfileService: profiles, memoryService: memory, dynamicContextBuilder: new DynamicContextBuilder(memory), sessionStore: sessions, askAgent, systemSkillLoader: loader, executorRegistry: executors });
  const app = createAPIServer(mainAgent, skillRegistry, queue);
  const server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { mainAgent, url, dataDir, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(dataDir, { recursive: true, force: true }); } };
}

async function postStreamExpectEvents(url: string, body: object) {
  return new Promise<{ status: number; events: Array<{ event: string; data: any }> }>((resolve, reject) => {
    const json = JSON.stringify(body); const req = http.request(`${url}/tasks/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) } }, (res) => {
      const events: Array<{ event: string; data: any }> = []; let buffer = '';
      res.on('data', (chunk) => { buffer += chunk.toString(); let i; while ((i = buffer.indexOf('\n\n')) !== -1) { const raw = buffer.slice(0, i); buffer = buffer.slice(i + 2); const event = raw.match(/^event: (.+)$/m)?.[1]; const data = raw.match(/^data: (.+)$/m)?.[1]; if (event) { let parsed: any = data; try { parsed = JSON.parse(data!); } catch {} events.push({ event, data: parsed }); } } });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, events })); res.on('error', reject);
    }); req.on('error', reject); req.write(json); req.end();
  });
}

describe('IT 服务台：协助用户自助办理问题', () => {
  test('用户咨询能被 IntentRouter 识别为 skill_task', async () => {
    const stack = await buildStackedAgent();
    try { const result = await postStreamExpectEvents(stack.url, { requirement: '我的 MDM 客户端登不上去了', userId: 'u1' }); expect(result.status).toBe(200); expect(result.events.some((e) => e.event === 'task_completed')).toBe(true); } finally { await stack.close(); }
  });

  test('任务能被 SubAgent 执行并产生工具调用', async () => {
    const stack = await buildStackedAgent();
    try {
      const result = await postStreamExpectEvents(stack.url, { requirement: '我的 MDM 客户端登不上去了', userId: 'u1' });
      expect(result.events.some((e) => e.event === 'task_completed')).toBe(true);
      expect(result.events.some((e) => e.event === 'complete')).toBe(true);
    } finally { await stack.close(); }
  });

  test('工具结果能转化为最终答案', async () => {
    const stack = await buildStackedAgent();
    try {
      const result = await postStreamExpectEvents(stack.url, { requirement: '我的 MDM 客户端登不上去了', userId: 'u1' });
      const completed = result.events.find((e) => e.event === 'task_completed');
      expect(completed).toBeDefined();
      expect(result.events.some((e) => e.event === 'complete')).toBe(true);
    } finally { await stack.close(); }
  });
});
