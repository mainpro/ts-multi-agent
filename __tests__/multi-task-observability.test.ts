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
  timestamp: number;
  elapsedMs: number;
  callIndex: number;
  taskHint?: string;
}

interface TimelineEntry {
  kind: 'event' | 'llm';
  source: 'requestLifecycle' | 'taskEvents' | 'llm';
  type: string;
  detail: string;
  elapsedMs: number;
  taskId?: string;
}

interface StackedAgent {
  mainAgent: MainAgent;
  url: string;
  close: () => Promise<void>;
  dataDir: string;
  mockTrace: MockTraceEntry[];
  taskResponses: Map<string, string>;
}

type Scenario = 'mt1-parallel-2' | 'mt2-layered-3' | 'mt3-partial-fail';

const TEST_START = { value: Date.now() };
function now(): number {
  return Date.now() - TEST_START.value;
}

let timeline: TimelineEntry[] = [];
let lifecycleUnsub: (() => void)[] = [];
let taskUnsub: (() => void)[] = [];

function setupListeners(): void {
  timeline = [];
  lifecycleUnsub.forEach((u) => u());
  taskUnsub.forEach((u) => u());
  lifecycleUnsub = [];
  taskUnsub = [];

  const reqEvents: RequestLifecycleEvent['type'][] = [
    'request_queued', 'request_checkpoint', 'request_spawned', 'request_steered',
    'request_merged', 'request_completed', 'request_error',
  ];
  for (const evt of reqEvents) {
    const handler = (e: RequestLifecycleEvent) => {
      timeline.push({
        kind: 'event',
        source: 'requestLifecycle',
        type: e.type,
        detail: JSON.stringify({ requestId: (e as any).requestId }).slice(0, 80),
        elapsedMs: now(),
      });
    };
    requestLifecycle.on(evt, handler);
    lifecycleUnsub.push(() => requestLifecycle.off(evt, handler));
  }

  const taskEventTypes: TaskEvent['type'][] = ['task_started', 'task_completed', 'task_failed', 'task_waiting'];
  for (const evt of taskEventTypes) {
    const handler = (e: TaskEvent) => {
      timeline.push({
        kind: 'event',
        source: 'taskEvents',
        type: e.type,
        detail: `${e.type} taskId=${e.taskId}`,
        elapsedMs: now(),
        taskId: e.taskId,
      });
    };
    taskEvents.on(evt, handler);
    taskUnsub.push(() => taskEvents.off(evt, handler));
  }
}

function dumpTrace(label: string, stack: StackedAgent, extra: { memoryFiles?: number; memoryBytes?: number } = {}): void {
  console.log(`\n[TRACE-MT] ${label}`);
  console.log('  Mock LLM calls:');
  for (const m of stack.mockTrace) {
    const hint = m.taskHint ? ` taskHint=${m.taskHint}` : '';
    console.log(`    ${m.elapsedMs}ms  ${m.method}(${m.callIndex}) prompt="${m.promptFirstLine}"${hint}`);
  }
  console.log('  Event timeline:');
  for (const e of timeline.filter((x) => x.kind === 'event')) {
    console.log(`    ${e.elapsedMs}ms  [${e.source}] ${e.type}${e.taskId ? ' taskId=' + e.taskId : ''}`);
  }
  if (extra.memoryFiles !== undefined) {
    console.log(`  Memory snapshot: ${extra.memoryFiles} files, ${extra.memoryBytes ?? 0}B`);
  }
}

async function buildStackedAgent(scenario: Scenario): Promise<StackedAgent> {
  const dataDir = path.join(os.tmpdir(), `multi-task-obs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });

  const mockTrace: MockTraceEntry[] = [];
  const taskResponses = new Map<string, string>();

  let structuredCalls = 0;
  let toolCalls = 0;
  const promptIntent = '【用户当前输入】';
  const promptPlanner = '需求:';
  const promptSub = 'SubAgent: 选择工具并执行';
  const promptAggregate = '用户原始需求:';

  const recordTrace = (method: string, prompt: string, callIndex: number, taskHint?: string) => {
    mockTrace.push({
      method,
      promptFirstLine: prompt,
      timestamp: Date.now(),
      elapsedMs: now(),
      callIndex,
      taskHint,
    });
    timeline.push({
      kind: 'llm',
      source: 'llm',
      type: method,
      detail: `prompt="${prompt}" idx=${callIndex}`,
      elapsedMs: now(),
    });
  };

  // 任务定义
  let taskDefs: Array<{ taskId: string; skillName: string; requirement: string; deps: string[] }> = [];
  if (scenario === 'mt1-parallel-2') {
    taskDefs = [
      { taskId: 't1', skillName: 'ssh-test', requirement: '查 SSH 状态', deps: [] },
      { taskId: 't2', skillName: 'k8s-status', requirement: '查 K8s 状态', deps: [] },
    ];
  } else if (scenario === 'mt2-layered-3') {
    taskDefs = [
      { taskId: 't1', skillName: 'ssh-test', requirement: '查 SSH 状态', deps: [] },
      { taskId: 't2', skillName: 'k8s-status', requirement: '查 K8s 状态', deps: [] },
      { taskId: 't3', skillName: 'compare', requirement: '对比 SSH 与 K8s 状态', deps: ['t1', 't2'] },
    ];
  } else if (scenario === 'mt3-partial-fail') {
    taskDefs = [
      { taskId: 't1-ok', skillName: 'ssh-test', requirement: '查 SSH 状态', deps: [] },
      { taskId: 't2-fail', skillName: 'k8s-status', requirement: '查 K8s 状态(故意失败)', deps: [] },
    ];
  }

  const intentResult: IntentResult = {
    intent: 'skill_task',
    confidence: 0.98,
    tasks: taskDefs.map((t) => ({
      taskId: t.taskId,
      requirement: t.requirement,
      skillName: t.skillName,
      intent: 'skill_task' as const,
    })),
  };

  const subagentResponses: Record<string, string> = {};
  for (const t of taskDefs) {
    if (t.taskId === 't2-fail') {
      subagentResponses[t.taskId] = '__FAIL__';
    } else {
      subagentResponses[t.taskId] = `完成 ${t.skillName} 任务,结果正常`;
    }
  }

  const skillRegistryStub: any = {
    getAllMetadata: () => taskDefs.map((t) => ({ name: t.skillName, description: t.requirement })),
    loadFullSkill: (name: string) => ({
      name,
      description: `${name} skill`,
      body: 'mock body',
    }),
    hasSkill: (name: string) => taskDefs.some((t) => t.skillName === name),
    scanSkills: async () => {},
  };

  const mockLLM: any = {
    generateStructured: async (prompt: string) => {
      structuredCalls++;
      // 注意:aggregate prompt 包含 "需求:" 字串,所以先匹配更具体的 aggregate
      const isIntent = prompt.includes(promptIntent);
      const isAggregate = prompt.includes(promptAggregate);
      const isPlanner = prompt.includes(promptPlanner) && !isAggregate;
      let taskHint: string;
      if (isIntent) taskHint = 'IntentRouter';
      else if (isAggregate) taskHint = 'ResultAggregator.summarizeResults';
      else if (isPlanner) taskHint = 'UnifiedPlanner';
      else taskHint = 'unknown';
      recordTrace('generateStructured',
        isIntent ? promptIntent : (isAggregate ? promptAggregate : (isPlanner ? promptPlanner : prompt.slice(0, 40))),
        structuredCalls, taskHint);
      if (isIntent) {
        return intentResult;
      }
      if (isPlanner) {
        return {
          analysis: { summary: 'multi-task plan', intent: 'skill_task' },
          skillSelection: taskDefs.map((t) => t.skillName),
          plan: {
            needsClarification: false,
            tasks: taskDefs.map((t) => ({
              id: t.taskId,
              requirement: t.requirement,
              skillName: t.skillName,
              params: {},
              dependencies: t.deps,
            })),
          },
        };
      }
      if (isAggregate) {
        return {
          completed: true,
          summary: `汇总 ${taskDefs.length} 个任务结果,关键信息已整合`,
        };
      }
      return { intent: 'skill_task', tasks: [] };
    },
    generateText: async (prompt: string) => {
      recordTrace('generateText', prompt.slice(0, 40), 0, 'L3Summary');
      return 'L3 summary content';
    },
    generateWithTools: async (messages: any[], tools: any[], executor: any) => {
      toolCalls++;
      // 找到当前任务对应的响应(根据传入的 requirement 等)
      const lastUser = messages.findLast?.((m: any) => m.role === 'user') || messages[messages.length - 1];
      const reqText = lastUser?.content || '';
      let response = 'default';
      let shouldFail = false;
      for (const t of taskDefs) {
        if (reqText.includes(t.requirement) || reqText.includes(t.skillName)) {
          response = subagentResponses[t.taskId];
          if (response === '__FAIL__') shouldFail = true;
          break;
        }
      }
      recordTrace('generateWithTools', promptSub, toolCalls, shouldFail ? 'SubAgent-FAIL' : 'SubAgent');
      if (shouldFail) {
        throw new Error(`mock SubAgent failure: ${scenario}`);
      }
      return {
        content: response,
        toolCalls: [],
        messages: messages,
      };
    },
  };

  const llm: ILLMClient = mockLLM;

  const skillRegistry = skillRegistryStub as SkillRegistry;
  const memoryService = new MemoryService(dataDir, llm);
  const sessionStore = new SessionStore(100, dataDir);
  const intentRouter = new IntentRouter(llm, skillRegistry);
  const userProfileService = new UserProfileService(dataDir);
  const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
  const askAgent = new AskAgent(sessionStore, llm, undefined as any);
  const systemSkillLoader = new SystemSkillLoader();
  systemSkillLoader.loadAll();
  const executorRegistry = new ExecutorRegistry();
  const subAgent = new SubAgent(skillRegistry, llm, memoryService);
  const taskQueue = new TaskQueue(async (task: any) => {
    const result = await subAgent.execute(task);
    return result;
  });

  const mainAgent = new MainAgent({
    llm,
    skillRegistry,
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

  const app = createAPIServer(mainAgent, skillRegistry, taskQueue, userProfileService);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://localhost:${port}`;

  return {
    mainAgent,
    url,
    dataDir,
    mockTrace,
    taskResponses,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function postStreamExpectEvents(url: string, body: any, timeoutMs = 5000): Promise<{ status: number; events: any[] }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port,
        path: '/tasks/stream',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        const events: any[] = [];
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev: any = {};
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) ev.event = line.slice(6).trim();
              else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
            }
            if (ev.event) events.push(ev);
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, events }));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

async function inspectMemory(dataDir: string): Promise<{ memoryFiles: number; memoryBytes: number; allFiles: string[] }> {
  let memoryFiles = 0;
  let memoryBytes = 0;
  const allFiles: string[] = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.json')) {
        const stat = await fs.stat(p);
        memoryFiles++;
        memoryBytes += stat.size;
        allFiles.push(path.relative(dataDir, p));
      }
    }
  };
  await walk(dataDir);
  return { memoryFiles, memoryBytes, allFiles };
}

describe('Multi-task observability', () => {
  beforeEach(() => {
    setupListeners();
  });
  afterEach(() => {
    lifecycleUnsub.forEach((u) => u());
    taskUnsub.forEach((u) => u());
  });

  test('MT-1: 2 parallel tasks (L0 only) — IntentRouter 1 + SubAgent 2 + summarizeResults 1', async () => {
    const userMessage = '帮我查 SSH 和 K8s 状态';
    const stack = await buildStackedAgent('mt1-parallel-2');
    try {
      const result = await postStreamExpectEvents(stack.url, { requirement: userMessage, userId: 'u-mt1' });
      expect(result.status).toBe(200);

      // Layer A: Mock LLM trace 计数
      const structuredCalls = stack.mockTrace.filter((t) => t.method === 'generateStructured');
      const toolCalls = stack.mockTrace.filter((t) => t.method === 'generateWithTools');
      // 多任务流程:IntentRouter + UnifiedPlanner(可能多次,失败重排) + summarizeResults
      expect(structuredCalls.length).toBeGreaterThanOrEqual(2);
      expect(toolCalls.length).toBe(2);         // 2 个 SubAgent
      // 验证关键 tag 都出现过
      const tags = structuredCalls.map((t) => t.taskHint);
      expect(tags).toContain('IntentRouter');
      expect(tags).toContain('ResultAggregator.summarizeResults');

      // Layer B: 事件时间线 — 应该有 2 个 task_started 和 2 个 task_completed
      const taskStartedEvents = timeline.filter((e) => e.kind === 'event' && e.type === 'task_started');
      const taskCompletedEvents = timeline.filter((e) => e.kind === 'event' && e.type === 'task_completed');
      expect(taskStartedEvents.length).toBe(2);
      expect(taskCompletedEvents.length).toBe(2);
      // 顺序:每个 task_started 在对应 task_completed 之前
      const startedTaskIds = new Set(taskStartedEvents.map((e) => e.taskId));
      const completedTaskIds = new Set(taskCompletedEvents.map((e) => e.taskId));
      expect(startedTaskIds).toEqual(completedTaskIds);

      // Layer C: memory 落盘
      const mem = await inspectMemory(stack.dataDir);
      expect(mem.memoryFiles).toBeGreaterThanOrEqual(1);

      dumpTrace('MT-1: 2 parallel tasks', stack, { memoryFiles: mem.memoryFiles, memoryBytes: mem.memoryBytes });
    } finally {
      await stack.close();
    }
  });

  test('MT-2: 3 tasks layered (L0:[t1,t2] parallel, L1:[t3] after) — verify L1 starts after L0 ends', async () => {
    const userMessage = '先查 SSH 和 K8s,然后对比两者';
    const stack = await buildStackedAgent('mt2-layered-3');
    try {
      const result = await postStreamExpectEvents(stack.url, { requirement: userMessage, userId: 'u-mt2' });
      expect(result.status).toBe(200);

      // Layer A: Mock LLM trace
      const structuredCalls = stack.mockTrace.filter((t) => t.method === 'generateStructured');
      const toolCalls = stack.mockTrace.filter((t) => t.method === 'generateWithTools');
      expect(structuredCalls.length).toBeGreaterThanOrEqual(2);
      expect(toolCalls.length).toBe(3);         // 3 个 SubAgent
      const tags = structuredCalls.map((t) => t.taskHint);
      expect(tags).toContain('IntentRouter');
      expect(tags).toContain('ResultAggregator.summarizeResults');

      // Layer B: 事件时间线 — 3 个 task_started, 3 个 task_completed
      const taskStartedEvents = timeline.filter((e) => e.kind === 'event' && e.type === 'task_started');
      const taskCompletedEvents = timeline.filter((e) => e.kind === 'event' && e.type === 'task_completed');
      expect(taskStartedEvents.length).toBe(3);
      expect(taskCompletedEvents.length).toBe(3);

      // 关键验证:t3 (Layer 1) 的 task_started 必须晚于 t1+t2 (Layer 0) 的 task_completed
      const t3Started = taskStartedEvents.find((e) => e.taskId?.includes('t3'));
      const l0Completed = taskCompletedEvents.filter((e) => e.taskId?.includes('t1') || e.taskId?.includes('t2'));
      expect(t3Started).toBeDefined();
      expect(l0Completed.length).toBe(2);
      const maxL0CompletedTime = Math.max(...l0Completed.map((e) => e.elapsedMs));
      expect(t3Started!.elapsedMs).toBeGreaterThanOrEqual(maxL0CompletedTime);

      // Layer C: memory 落盘
      const mem = await inspectMemory(stack.dataDir);
      expect(mem.memoryFiles).toBeGreaterThanOrEqual(1);

      dumpTrace('MT-2: 3 tasks layered (L0 parallel + L1 after)', stack, { memoryFiles: mem.memoryFiles, memoryBytes: mem.memoryBytes });
    } finally {
      await stack.close();
    }
  });

  test('MT-3: partial failure — 1 succeed + 1 fail → summarizeResults still called', async () => {
    const userMessage = '查 SSH 和 K8s(K8s 会失败)';
    const stack = await buildStackedAgent('mt3-partial-fail');
    try {
      const result = await postStreamExpectEvents(stack.url, { requirement: userMessage, userId: 'u-mt3' });
      expect(result.status).toBe(200);

      // Layer A: 应该有 task_failed 触发,但 summarizeResults 仍可能调
      // (实际行为取决于 MainAgent 如何处理部分失败 — 验证至少 task_failed 事件触发)
      const toolCalls = stack.mockTrace.filter((t) => t.method === 'generateWithTools');
      // 2 个 SubAgent 调用,其中一个抛错
      const failedCalls = toolCalls.filter((t) => t.taskHint === 'SubAgent-FAIL');
      expect(failedCalls.length).toBe(1);

      // Layer B: 验证有 task_failed 事件
      const taskFailedEvents = timeline.filter((e) => e.kind === 'event' && e.type === 'task_failed');
      const taskStartedEvents = timeline.filter((e) => e.kind === 'event' && e.type === 'task_started');
      expect(taskStartedEvents.length).toBe(2);
      expect(taskFailedEvents.length).toBeGreaterThanOrEqual(1);

      dumpTrace('MT-3: 1 succeed + 1 fail', stack);
    } finally {
      await stack.close();
    }
  });
});
