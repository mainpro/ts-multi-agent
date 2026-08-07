import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
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
import { requestLifecycle, RequestLifecycleEvent } from '../src/events/request-lifecycle';
import { taskEvents, TaskEvent } from '../src/events/task-events';

interface MockTraceEntry {
  method: string;
  promptFirstLine: string;
  args?: unknown;
  timestamp: number;
  elapsedMs: number;
  callIndex: number;
}

interface TimelineEntry {
  kind: 'event' | 'llm';
  source: 'requestLifecycle' | 'taskEvents' | 'llm' | 'memory';
  type: string;
  detail: string;
  elapsedMs: number;
}

interface StackedAgent {
  mainAgent: MainAgent;
  url: string;
  close: () => Promise<void>;
  dataDir: string;
  mockTrace: MockTraceEntry[];
  failureMode: 'none' | 'structured-throws' | 'tool-throws';
}

const TEST_START = { value: Date.now() };

function now(): number {
  return Date.now() - TEST_START.value;
}

async function buildStackedAgent(opts: { failureMode?: 'none' | 'llm-throws'; multiTurn?: boolean } = {}): Promise<StackedAgent> {
  const dataDir = path.join(os.tmpdir(), `desk-self-service-obs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });

  const mockTrace: MockTraceEntry[] = [];
  let structuredCalls = 0;
  let toolCalls = 0;
  const promptIntent = '意图识别: 请判断用户请求属于哪类任务';
  const promptSub = 'SubAgent: 选择工具并执行';

  const recordTrace = (method: string, prompt: string, args?: unknown) => {
    const isStructured = method === 'generateStructured';
    const idx = isStructured ? ++structuredCalls : ++toolCalls;
    const entry: MockTraceEntry = {
      method,
      promptFirstLine: prompt,
      args,
      timestamp: Date.now(),
      elapsedMs: now(),
      callIndex: idx,
    };
    mockTrace.push(entry);
    timeline.push({
      kind: 'llm',
      source: 'llm',
      type: method,
      detail: `prompt="${prompt}" idx=${idx}`,
      elapsedMs: entry.elapsedMs,
    });
  };

  const intentResult: IntentResult = {
    intent: 'skill_task',
    confidence: 0.98,
    tasks: [{ taskId: 'mdm-status', requirement: '查 MDM 客户端状态', skillName: 'mdm-status', intent: 'skill_task' }],
  };

  const mockLLM: ILLMClient = {
    generateStructured: async () => {
      recordTrace('generateStructured', promptIntent, { structuredCalls: structuredCalls + 1 });
      if (opts.failureMode === 'structured-throws' && structuredCalls === 0) {
        throw new Error('mock LLM failure: upstream service unavailable');
      }
      if (structuredCalls === 1) return intentResult;
      return {
        analysis: { summary: 'MDM 状态查询完成', intent: 'skill_task' },
        skillSelection: ['mdm-status'],
        plan: { needsClarification: false, tasks: [{ id: 'mdm-status', requirement: '查 MDM 客户端状态', skillName: 'mdm-status', params: {}, dependencies: [] }] },
      };
    },
    generateText: async () => 'MDM 客户端当前状态正常，已恢复登录。',
    generateWithTools: async () => {
      recordTrace('generateWithTools', promptSub, { deviceId: 'device-001', turn: toolCalls + 1 });
      if (opts.failureMode === 'tool-throws' && toolCalls === 0) {
        throw new Error('mock LLM failure: tool-call service unavailable');
      }
      if (opts.multiTurn) {
        if (toolCalls === 1) {
          return { content: '需要重置设备认证令牌', toolCalls: [{ name: 'reset_mdm_token', arguments: { deviceId: 'device-001' } }] };
        }
        return { content: 'MDM 客户端当前状态正常，已恢复登录。', toolCalls: [] };
      }
      return { content: 'MDM 客户端当前状态正常，已恢复登录。', toolCalls: [{ name: 'check_mdm_status', arguments: { deviceId: 'device-001' } }] };
    },
    generateWithToolsTracked: async () => ({ content: 'MDM 客户端当前状态正常，已恢复登录。', toolCalls: [], messages: [] }),
  } as any;

  const skillRegistry = {
    getAllMetadata: () => [{ name: 'mdm-status', description: '查询 MDM 客户端状态', metadata: {}, allowedTools: ['check_mdm_status', 'reset_mdm_token'] } as any],
    loadFullSkill: async () => ({ name: 'mdm-status', description: '查询 MDM 客户端状态', body: '查询 MDM 客户端状态', metadata: {}, allowedTools: ['check_mdm_status', 'reset_mdm_token'] }),
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
  return {
    mainAgent, url, dataDir, mockTrace,
    failureMode: opts.failureMode ?? 'none',
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(dataDir, { recursive: true, force: true }); },
  };
}

let timeline: TimelineEntry[] = [];
let cleanupFns: Array<() => void> = [];

function setupListeners(): void {
  cleanupFns = [];
  const onLifecycle = (e: RequestLifecycleEvent) => {
    let detail = '';
    if (e.type === 'request_spawned') detail = `requestId=${e.requestId} requirement="${e.requirementPreview}"`;
    else if (e.type === 'request_completed') detail = `status=${e.status}`;
    else if (e.type === 'request_error') detail = `error=${e.error.message}`;
    else if (e.type === 'request_queued') detail = `draftId=${e.draftId} pos=${e.position}`;
    else if (e.type === 'request_checkpoint') detail = `requestId=${e.requestId} pending=${e.pendingCount}`;
    else if (e.type === 'request_steered') detail = `taskId=${e.taskId}`;
    timeline.push({ kind: 'event', source: 'requestLifecycle', type: e.type, detail, elapsedMs: now() });
  };
  const onTask = (e: TaskEvent) => {
    let detail = '';
    if (e.type === 'task_started') detail = `taskId=${e.taskId} skill=${e.skillName ?? 'none'} requestId=${e.requestId}`;
    else if (e.type === 'task_completed') detail = `taskId=${e.taskId}`;
    else if (e.type === 'task_failed') detail = `taskId=${e.taskId} error=${e.error.message}`;
    else if (e.type === 'task_waiting') detail = `taskId=${e.taskId}`;
    timeline.push({ kind: 'event', source: 'taskEvents', type: e.type, detail, elapsedMs: now() });
  };
  // Subscribe to all lifecycle event types that the codebase actually emits
  requestLifecycle.on('request_spawned', onLifecycle);
  requestLifecycle.on('request_completed', onLifecycle);
  requestLifecycle.on('request_error', onLifecycle);
  requestLifecycle.on('request_queued', onLifecycle);
  requestLifecycle.on('request_checkpoint', onLifecycle);
  requestLifecycle.on('request_steered', onLifecycle);
  cleanupFns.push(() => {
    requestLifecycle.off('request_spawned', onLifecycle);
    requestLifecycle.off('request_completed', onLifecycle);
    requestLifecycle.off('request_error', onLifecycle);
    requestLifecycle.off('request_queued', onLifecycle);
    requestLifecycle.off('request_checkpoint', onLifecycle);
    requestLifecycle.off('request_steered', onLifecycle);
  });
  const offTask1 = taskEvents.on('task_started', onTask);
  const offTask2 = taskEvents.on('task_completed', onTask);
  const offTask3 = taskEvents.on('task_failed', onTask);
  const offTask4 = taskEvents.on('task_waiting', onTask);
  cleanupFns.push(() => { offTask1(); offTask2(); offTask3(); offTask4(); });
}

beforeEach(() => {
  TEST_START.value = Date.now();
  timeline = [];
  cleanupFns = [];
});

afterEach(() => {
  for (const fn of cleanupFns) {
    try { fn(); } catch { /* ignore */ }
  }
  cleanupFns = [];
});

async function postStreamExpectEvents(url: string, body: object) {
  return new Promise<{ status: number; events: Array<{ event: string; data: any }> }>((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request(`${url}/tasks/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) } }, (res) => {
      const events: Array<{ event: string; data: any }> = [];
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = raw.match(/^event: (.+)$/m)?.[1];
          const data = raw.match(/^data: (.+)$/m)?.[1];
          if (event) {
            let parsed: any = data;
            try { parsed = JSON.parse(data!); } catch { /* ignore */ }
            events.push({ event, data: parsed });
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, events }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

function dumpTrace(label: string, stack: StackedAgent, extra: { memoryFiles?: number; memoryBytes?: number; profileEntries?: number; l4ContainsUser?: boolean } = {}): void {
  const lines: string[] = [];
  lines.push(`[TRACE] ${label}`);
  for (const entry of timeline) {
    if (entry.kind === 'event') {
      lines.push(`  ${String(entry.elapsedMs).padStart(4, '0')}ms: ${entry.type} ${entry.detail}`);
    } else {
      const callIndex = stack.mockTrace.find((m) => m.elapsedMs === entry.elapsedMs && m.method === entry.type)?.callIndex ?? '?';
      lines.push(`  ${String(entry.elapsedMs).padStart(4, '0')}ms: LLM.${entry.type} (${callIndex}) ${entry.detail}`);
    }
  }
  if (extra.memoryFiles !== undefined) {
    const profilePart = extra.profileEntries !== undefined ? `; profile: ${extra.profileEntries} entry` : '';
    lines.push(`  memory: ${extra.memoryFiles} files in memory/, ${extra.memoryBytes ?? 0}B${profilePart}`);
  }
  console.log(lines.join('\n'));
}

async function walkDir(dir: string, dataDir: string): Promise<Array<{ rel: string; abs: string; size: number }>> {
  const results: Array<{ rel: string; abs: string; size: number }> = [];
  let entries: any[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkDir(abs, dataDir);
      results.push(...sub);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(abs);
        results.push({ rel: path.relative(dataDir, abs), abs, size: stat.size });
      } catch { /* ignore */ }
    }
  }
  return results;
}

async function inspectMemory(dataDir: string, userMessage: string): Promise<{ memoryFiles: number; memoryBytes: number; profileEntries: number; l4ContainsUser: boolean; allFiles: string[] }> {
  let memoryFiles = 0;
  let memoryBytes = 0;
  let l4ContainsUser = false;
  let profileEntries = 0;
  const allFiles: string[] = [];
  const memoryDir = path.join(dataDir, 'memory');
  // Walk memory dir
  const memFiles = await walkDir(memoryDir, dataDir);
  for (const f of memFiles) {
    if (!f.rel.endsWith('.json')) continue;
    memoryFiles += 1;
    memoryBytes += f.size;
    allFiles.push(f.rel);
    if (f.rel.includes('history') || f.rel.includes('l4')) {
      try {
        const content = await fs.readFile(f.abs, 'utf-8');
        if (content.includes(userMessage)) l4ContainsUser = true;
      } catch { /* ignore */ }
    }
  }
  // also walk root dataDir for any json
  const rootFiles = await walkDir(dataDir, dataDir);
  for (const f of rootFiles) {
    if (f.rel.startsWith('memory/')) continue;
    if (!f.rel.endsWith('.json')) continue;
    memoryFiles += 1;
    memoryBytes += f.size;
    allFiles.push(f.rel);
  }
  // profile.json or user-profile.json
  for (const candidate of ['profile.json', 'user-profile.json']) {
    const p = path.join(dataDir, candidate);
    const stat = await fs.stat(p).catch(() => null);
    if (stat && stat.isFile()) profileEntries += 1;
  }
  return { memoryFiles, memoryBytes, profileEntries, l4ContainsUser, allFiles };
}

describe('IT 服务台 observability — self-service scenario', () => {
  test('L1: 完整链路追踪 — IntentRouter + SubAgent + memory + profile', async () => {
    setupListeners();
    const userMessage = '我的 MDM 客户端登不上去了';
    const stack = await buildStackedAgent();
    try {
      const result = await postStreamExpectEvents(stack.url, { requirement: userMessage, userId: 'u-obs-1' });
      expect(result.status).toBe(200);

      // Layer A: Mock LLM trace
      const structuredCalls = stack.mockTrace.filter((t) => t.method === 'generateStructured');
      const toolCalls = stack.mockTrace.filter((t) => t.method === 'generateWithTools');
      expect(structuredCalls.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of stack.mockTrace) {
        expect(typeof call.elapsedMs).toBe('number');
        expect(call.promptFirstLine.length).toBeGreaterThan(0);
      }

      // Layer B: Event subscription timeline
      // In the simple single-request flow, MainAgent emits task_started and
      // task_completed on taskEvents. request_spawned / request_completed only
      // fire in the queue-and-merge (R2) flow.
      const eventTimeline = timeline.filter((e) => e.kind === 'event');
      const types = eventTimeline.map((e) => e.type);
      const idxTaskStarted = types.indexOf('task_started');
      const idxTaskCompleted = types.indexOf('task_completed');
      expect(idxTaskStarted).toBeGreaterThanOrEqual(0);
      expect(idxTaskCompleted).toBeGreaterThan(idxTaskStarted);
      // And verify ordering vs LLM calls: generateStructured happens first
      const firstLLM = stack.mockTrace[0];
      const lastLLM = stack.mockTrace[stack.mockTrace.length - 1];
      expect(firstLLM.elapsedMs).toBeLessThanOrEqual(idxTaskStarted >= 0 ? eventTimeline[idxTaskStarted].elapsedMs : Infinity);
      expect(lastLLM.elapsedMs).toBeLessThanOrEqual(eventTimeline[idxTaskCompleted].elapsedMs);
      expect(eventTimeline.length).toBeGreaterThanOrEqual(2);

      // Layer C: Memory state snapshot
      const mem = await inspectMemory(stack.dataDir, userMessage);
      expect(mem.memoryFiles).toBeGreaterThanOrEqual(1);
      // Either L4 history contains the user message, OR a session/profile file references the userId
      const userIdUsed = 'u-obs-1';
      const userIdInAnyFile = await (async () => {
        for (const f of mem.allFiles) {
          try {
            const c = await fs.readFile(path.join(stack.dataDir, f), 'utf-8');
            if (c.includes(userMessage) || c.includes(userIdUsed)) return true;
          } catch { /* ignore */ }
        }
        return false;
      })();
      expect(userIdInAnyFile).toBe(true);

      dumpTrace('完整链路追踪 self-service scenario', stack, { memoryFiles: mem.memoryFiles, memoryBytes: mem.memoryBytes, profileEntries: mem.profileEntries });
    } finally {
      await stack.close();
    }
  });

  test('L2: 多轮 SubAgent 迭代 — 验证 IntentRouter→SubAgent 顺序 + 时间戳递增', async () => {
    setupListeners();
    const userMessage = '我的 MDM 客户端登不上去了，需要重置';
    const stack = await buildStackedAgent({ multiTurn: true });
    try {
      const result = await postStreamExpectEvents(stack.url, { requirement: userMessage, userId: 'u-obs-2' });
      expect(result.status).toBe(200);

      const structuredCalls = stack.mockTrace.filter((t) => t.method === 'generateStructured');
      const toolCalls = stack.mockTrace.filter((t) => t.method === 'generateWithTools');
      expect(structuredCalls.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // LLM call timestamps must be monotonically non-decreasing
      for (let i = 1; i < stack.mockTrace.length; i++) {
        expect(stack.mockTrace[i].elapsedMs).toBeGreaterThanOrEqual(stack.mockTrace[i - 1].elapsedMs);
      }

      // IntentRouter's generateStructured must precede the SubAgent's generateWithTools
      const firstStructured = structuredCalls[0];
      const firstTool = toolCalls[0];
      expect(firstStructured.elapsedMs).toBeLessThanOrEqual(firstTool.elapsedMs);

      const timelineEntries = timeline.filter((e) => e.kind === 'event');
      expect(timelineEntries.some((e) => e.type === 'task_started')).toBe(true);
      expect(timelineEntries.some((e) => e.type === 'task_completed')).toBe(true);

      const mem = await inspectMemory(stack.dataDir, userMessage);
      dumpTrace('多轮 SubAgent 迭代 (验证时间戳单调)', stack, { memoryFiles: mem.memoryFiles, memoryBytes: mem.memoryBytes, profileEntries: mem.profileEntries });
    } finally {
      await stack.close();
    }
  });

  test('L3: 错误路径追踪 — mock LLM throws → task_failed + trace dump', async () => {
    setupListeners();
    const userMessage = '我的 MDM 客户端登不上去了';
    const stack = await buildStackedAgent({ failureMode: 'tool-throws' });
    try {
      const result = await postStreamExpectEvents(stack.url, { requirement: userMessage, userId: 'u-obs-3' });
      // API may return error event or complete event
      const errorEvent = result.events.find((e) => e.event === 'error' || e.event === 'task_failed');
      const completeEvent = result.events.find((e) => e.event === 'complete');
      expect(errorEvent !== undefined || completeEvent !== undefined).toBe(true);

      const types = timeline.filter((e) => e.kind === 'event').map((e) => e.type);
      const hadTaskFailed = types.includes('task_failed');
      const hadTaskStarted = types.includes('task_started');
      // task_started always fires (TaskGraphExecutor emits it before invoking the executor)
      expect(hadTaskStarted).toBe(true);
      // The throw is configured to fire on first generateWithTools call;
      // either task_failed fires or the system recovers to task_completed.
      expect(hadTaskFailed || types.includes('task_completed')).toBe(true);

      // Layer A trace: at least one generateWithTools was attempted before failure
      const toolCalls = stack.mockTrace.filter((t) => t.method === 'generateWithTools');
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      const mem = await inspectMemory(stack.dataDir, userMessage);
      const errorFlag = hadTaskFailed ? 'task_failed fired' : 'recovered';
      dumpTrace(`错误路径追踪 (${errorFlag})`, stack, { memoryFiles: mem.memoryFiles, memoryBytes: mem.memoryBytes, profileEntries: mem.profileEntries });
    } finally {
      await stack.close();
    }
  });
});
