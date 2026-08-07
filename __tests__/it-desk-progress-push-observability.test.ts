/**
 * Deep internal-ops observability test for IT 服务台 scenario 2:
 * "问题进度主动推送 & 新问题提报" (PDF line 715).
 *
 * Goal: surface what the system actually does during this scenario —
 *   Layer A: LLM call trace (which methods get hit, in what order)
 *   Layer B: Event timeline (requestLifecycle + taskEvents)
 *   Layer C: Memory + Profile state (L4 history JSON, profile.history, files on disk)
 *   Layer D: Trace dump (printed at end of every test for visibility)
 *
 * Mirrors the DI stack from __tests__/it-desk-progress-push.test.ts but
 * defines its own helpers locally — does NOT import from that file.
 *
 * Test framework: bun:test
 * Run: bun test __tests__/it-desk-progress-push-observability.test.ts
 */
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
import type { ProfileHistoryItem } from '../src/types';

import { requestLifecycle } from '../src/events/request-lifecycle';
import { taskEvents } from '../src/events/task-events';

// ── Layer A: LLM call trace recorder ────────────────────────────────────────

type LLMCall = {
  method: string;
  promptFirstLine: string;
  tsMs: number;
};

// ── Layer B: Event timeline ─────────────────────────────────────────────────

type TimelineEntry = {
  source: 'requestLifecycle' | 'taskEvents';
  type: string;
  tsMs: number;
  payload: any;
};

function subscribeTimeline(timeline: TimelineEntry[]): {
  unsubscribers: Array<() => void>;
} {
  const unsubscribers: Array<() => void> = [];

  const onRequest = (event: { type: string } & Record<string, any>) => {
    timeline.push({
      source: 'requestLifecycle',
      type: event.type,
      tsMs: Date.now(),
      payload: event,
    });
  };
  const onTask = (event: { type: string } & Record<string, any>) => {
    timeline.push({
      source: 'taskEvents',
      type: event.type,
      tsMs: Date.now(),
      payload: event,
    });
  };

  const rlTypes = [
    'request_spawned',
    'request_completed',
    'request_error',
  ] as const;
  const teTypes = ['task_started', 'task_completed', 'task_waiting'] as const;

  for (const t of rlTypes) {
    requestLifecycle.on(t, onRequest as any);
    unsubscribers.push(() => requestLifecycle.off(t, onRequest as any));
  }
  for (const t of teTypes) {
    const unsub = taskEvents.on(t, onTask as any);
    unsubscribers.push(unsub);
  }

  return { unsubscribers };
}

// ── Layer D: Trace dump helpers ─────────────────────────────────────────────

async function listMemoryFilesWithSizes(
  dataDir: string,
): Promise<Array<{ relPath: string; bytes: number }>> {
  const memDir = path.join(dataDir, 'memory');
  const out: Array<{ relPath: string; bytes: number }> = [];
  async function walk(dir: string, prefix: string) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = await fs.stat(full);
      if (st.isDirectory()) {
        await walk(full, rel);
      } else if (st.isFile()) {
        out.push({ relPath: rel, bytes: st.size });
      }
    }
  }
  await walk(memDir, '');
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

function dumpTrace(args: {
  testName: string;
  llmCalls: LLMCall[];
  timeline: TimelineEntry[];
  memoryFiles: Array<{ relPath: string; bytes: number }>;
  memorySnapshots: Array<{ label: string; payload: any }>;
  profileSnapshot: { length: number; topics: string[] } | null;
}) {
  const t0 = args.timeline[0]?.tsMs ?? args.llmCalls[0]?.tsMs ?? Date.now();
  const fmtMs = (ts: number) => `+${ts - t0}ms`;

  console.log('\n────────────── TRACE DUMP ──────────────');
  console.log(`TEST: ${args.testName}`);
  console.log('PROLOGUE: pre-seeded 2 historical tasks (任务1=completed, 任务2=running)');
  console.log('');

  // LLM trace
  console.log('[Layer A] LLM CALL TRACE:');
  const byMethod = new Map<string, number>();
  for (const c of args.llmCalls) {
    byMethod.set(c.method, (byMethod.get(c.method) ?? 0) + 1);
  }
  for (const c of args.llmCalls) {
    console.log(`  ${fmtMs(c.tsMs)}  ${c.method}  | ${c.promptFirstLine}`);
  }
  console.log(`  >> call count by method: ${JSON.stringify(Object.fromEntries(byMethod))}`);
  console.log('');

  // Timeline
  console.log('[Layer B] EVENT TIMELINE:');
  for (const e of args.timeline) {
    console.log(`  ${fmtMs(e.tsMs)}  [${e.source}] ${e.type}`);
  }
  console.log('');

  // Memory + profile
  console.log('[Layer C] MEMORY + PROFILE STATE:');
  console.log(`  profile.history.length=${args.profileSnapshot?.length ?? '?'}`);
  console.log(`  profile.history.topics=${JSON.stringify(args.profileSnapshot?.topics ?? [])}`);
  console.log('  dataDir/memory/ files:');
  for (const f of args.memoryFiles) {
    console.log(`    ${f.relPath}  (${f.bytes} bytes)`);
  }
  for (const snap of args.memorySnapshots) {
    const summary =
      snap.payload && typeof snap.payload === 'object'
        ? JSON.stringify(snap.payload).slice(0, 200)
        : String(snap.payload);
    console.log(`  ${snap.label}: ${summary}`);
  }
  console.log('────────────────────────────────────────\n');
}

// ── DI stack builder (mirrors existing test, with tracing injected) ────────

interface StackedAgent {
  mainAgent: MainAgent;
  url: string;
  close: () => Promise<void>;
  dataDir: string;
  profileService: UserProfileService;
  memoryService: MemoryService;
  llmTrace: LLMCall[];
}

async function buildStackedAgent(opts: {
  userId?: string;
  injectError?: boolean;
  trace?: LLMCall[];
} = {}): Promise<StackedAgent> {
  const userId = opts.userId ?? 'u-desk-push-obs';
  const dataDir = path.join(
    os.tmpdir(),
    `desk-progress-obs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });

  const intentResult: IntentResult = {
    intent: 'skill_task',
    confidence: 0.95,
    tasks: [
      {
        taskId: 'vpn-reset',
        requirement: '我的 VPN 连不上去了,请帮我重置密码',
        skillName: 'vpn-reset',
        intent: 'skill_task',
      },
    ],
  };

  let structuredCalls = 0;
  let toolCalls = 0;
  const errorMode = opts.injectError === true;
  const trace = opts.trace ?? [];

  const record = (method: string, prompt: unknown) => {
    let firstLine = '';
    if (typeof prompt === 'string') {
      firstLine = prompt.split('\n')[0]!.slice(0, 120);
    } else if (Array.isArray(prompt)) {
      firstLine = `array(len=${prompt.length})`;
    } else if (prompt && typeof prompt === 'object') {
      firstLine = `object(keys=${Object.keys(prompt).length})`;
    } else {
      firstLine = String(prompt).slice(0, 120);
    }
    trace.push({ method, promptFirstLine: firstLine, tsMs: Date.now() });
  };

  const baseLLM: ILLMClient = {
    generateStructured: async (...args: any[]) => {
      record('generateStructured', args[0]);
      structuredCalls += 1;
      if (errorMode) {
        throw new Error('simulated LLM failure on new task');
      }
      if (structuredCalls === 1) return intentResult;
      return {
        analysis: { summary: 'VPN 重置请求已受理', intent: 'skill_task' },
        skillSelection: ['vpn-reset'],
        plan: {
          needsClarification: false,
          tasks: [
            {
              id: 'vpn-reset',
              requirement: '我的 VPN 连不上去了,请帮我重置密码',
              skillName: 'vpn-reset',
              params: {},
              dependencies: [],
            },
          ],
        },
      };
    },
    generateText: async (...args: any[]) => {
      record('generateText', args[0]);
      return 'VPN 密码已重置,新密码请到企业微信查看。';
    },
    generateWithTools: async (...args: any[]) => {
      record('generateWithTools', args[0]);
      toolCalls += 1;
      return {
        content: 'VPN 密码已重置,新密码请到企业微信查看。',
        toolCalls: [{ name: 'reset_vpn_password', arguments: { userId } }],
      };
    },
    generateWithToolsTracked: async (...args: any[]) => {
      record('generateWithToolsTracked', args[0]);
      return {
        content: 'VPN 密码已重置,新密码请到企业微信查看。',
        toolCalls: [],
        messages: [],
      };
    },
  } as any;

  const mockLLM = baseLLM;

  const skillRegistry = {
    getAllMetadata: () => [
      {
        name: 'vpn-reset',
        description: '重置 VPN 密码',
        metadata: {},
        allowedTools: ['reset_vpn_password'],
      } as any,
    ],
    loadFullSkill: async () => ({
      name: 'vpn-reset',
      description: '重置 VPN 密码',
      body: '重置 VPN 密码',
      metadata: {},
      allowedTools: ['reset_vpn_password'],
    }),
    hasSkill: () => true,
    scanSkills: async () => ['vpn-reset'],
    startWatch: () => {},
    stopWatch: () => {},
    getSkillCount: () => 1,
    getSkillNames: () => ['vpn-reset'],
    getSkillMetadata: () => ({ name: 'vpn-reset', description: '重置 VPN 密码' }) as any,
  } as any as SkillRegistry;

  const memory = new MemoryService(dataDir, mockLLM);
  const sessions = new SessionStore(100, dataDir);
  const profiles = new UserProfileService(dataDir);

  // Pre-seed historical tasks (任务1=completed, 任务2=running).
  const historicalTasks: ProfileHistoryItem[] = [
    {
      topic: '打印机驱动安装',
      summary: '任务1(已完成): 帮张三安装办公室打印机驱动,2026-07-20 提交,2026-07-22 完成',
      lastOccurredAt: '2026-07-22T10:30:00.000Z',
      occurrences: 1,
    },
    {
      topic: '企业邮箱迁移',
      summary: '任务2(进行中): 企业邮箱从 Exchange 迁移到飞书邮箱,运维李四跟进中',
      lastOccurredAt: '2026-08-05T14:00:00.000Z',
      occurrences: 1,
    },
  ];
  await profiles.createUserProfile(userId, {
    department: '研发部',
    commonSystems: ['VPN', 'GitLab'],
    tags: ['正式员工'],
    role: 'employee',
    permissions: [],
    history: historicalTasks,
    preferences: [],
  });

  const intentRouter = new IntentRouter(mockLLM, skillRegistry);
  const askAgent = new AskAgent(sessions, mockLLM);
  const loader = new SystemSkillLoader();
  loader.loadAll();
  const executors = new ExecutorRegistry();
  const subAgent = new SubAgent(skillRegistry, mockLLM, memory);
  const queue = new TaskQueue(async (task) => {
    const result = await subAgent.execute(task);
    return {
      ...result,
      toolResult: {
        name: 'reset_vpn_password',
        content: 'VPN 密码已重置完成,新密码已发送到企业微信。',
      },
    } as any;
  });

  const mainAgent = new MainAgent({
    llm: mockLLM,
    skillRegistry,
    taskQueue: queue,
    intentRouter,
    userProfileService: profiles,
    memoryService: memory,
    dynamicContextBuilder: new DynamicContextBuilder(memory),
    sessionStore: sessions,
    askAgent,
    systemSkillLoader: loader,
    executorRegistry: executors,
  });

  const app = createAPIServer(mainAgent, skillRegistry, queue);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;

  return {
    mainAgent,
    url,
    dataDir,
    profileService: profiles,
    memoryService: memory,
    llmTrace: opts.trace ?? [],
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Flush L4 history debounce before removing dataDir.
      try {
        await memory.flushAll();
      } catch {}
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function postStreamExpectEvents(
  url: string,
  body: object,
): Promise<{ status: number; events: Array<{ event: string; data: any }> }> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request(
      `${url}/tasks/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
        },
      },
      (res) => {
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
              try {
                parsed = JSON.parse(data!);
              } catch {}
              events.push({ event, data: parsed });
            }
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, events }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('IT 服务台进度推送 — 深度内部可观测性', () => {
  let timeline: TimelineEntry[] = [];
  let unsubscribers: Array<() => void> = [];
  let llmTrace: LLMCall[] = [];

  beforeEach(() => {
    timeline = [];
    llmTrace = [];
    unsubscribers = [];
    const sub = subscribeTimeline(timeline);
    unsubscribers = sub.unsubscribers;
  });

  afterEach(() => {
    for (const u of unsubscribers) {
      try {
        u();
      } catch {}
    }
    unsubscribers = [];
  });

  test('OBS-1: 历史进度读取 + 新任务并存(2 个历史条目保持不变)', async () => {
    const stack = await buildStackedAgent({ userId: 'u-obs1', trace: llmTrace });

    try {
      // Sanity: profile is pre-seeded with 2 historical entries
      const before = await stack.profileService.loadProfile('u-obs1');
      expect(before.history.length).toBe(2);

      // Fire new task
      const result = await postStreamExpectEvents(stack.url, {
        requirement: '我的 VPN 连不上去了',
        userId: 'u-obs1',
      });

      expect(result.status).toBe(200);
      expect(result.events.some((e) => e.event === 'task_completed')).toBe(true);
      expect(result.events.some((e) => e.event === 'complete')).toBe(true);

      // Profile.history remains the 2 historical entries — unchanged
      const after = await stack.profileService.loadProfile('u-obs1');
      expect(after.history.length).toBe(2);
      const task1 = after.history.find((h) => h.topic === '打印机驱动安装');
      const task2 = after.history.find((h) => h.topic === '企业邮箱迁移');
      expect(task1!.summary).toContain('已完成');
      expect(task2!.summary).toContain('进行中');

      // L4 history JSON: must contain BOTH historical markers AND the new task
      // L4 stores per-session JSON under dataDir/memory/{userId}/history/{sessionId}.json
      // We grep across all history files for "vpn" / "VPN" markers.
      await stack.memoryService.flushAll();
      const histDir = path.join(stack.dataDir, 'memory', 'u-obs1', 'history');
      const files = (await fs.readdir(histDir).catch(() => [])) as string[];
      expect(files.length).toBeGreaterThan(0);
      let combined = '';
      for (const f of files) {
        combined += await fs.readFile(path.join(histDir, f), 'utf-8');
      }
      // Historical markers from profile don't go into L4 — L4 is the conversation log.
      // We verify: L4 contains the NEW task's content; profile keeps history unchanged.
      expect(combined).toContain('VPN');

      // Memory snapshot for trace dump
      const memFiles = await listMemoryFilesWithSizes(stack.dataDir);
      const l4Entries: Array<{ role: string; content: string }> = [];
      for (const f of files) {
        try {
          const json = JSON.parse(
            await fs.readFile(path.join(histDir, f), 'utf-8'),
          );
          if (Array.isArray(json.entries)) l4Entries.push(...json.entries);
        } catch {}
      }

      dumpTrace({
        testName: 'OBS-1: 历史进度读取 + 新任务并存',
        llmCalls: stack.llmTrace,
        timeline,
        memoryFiles: memFiles,
        memorySnapshots: [
          { label: 'L4 entries count', payload: l4Entries.length },
          {
            label: 'L4 user msgs',
            payload: l4Entries
              .filter((e) => e.role === 'user')
              .map((e) => e.content.slice(0, 80)),
          },
        ],
        profileSnapshot: {
          length: after.history.length,
          topics: after.history.map((h) => h.topic),
        },
      });
    } finally {
      await stack.close();
    }
  });

  test('OBS-2: 新任务 → task_started + task_completed 配对出现在 timeline', async () => {
    const stack = await buildStackedAgent({ userId: 'u-obs2', trace: llmTrace });

    try {
      const result = await postStreamExpectEvents(stack.url, {
        requirement: '我的 VPN 连不上去了',
        userId: 'u-obs2',
      });
      expect(result.status).toBe(200);

      // Wait briefly to let event emitter drain
      await new Promise((r) => setTimeout(r, 50));

      const started = timeline.filter((e) => e.type === 'task_started');
      const completed = timeline.filter((e) => e.type === 'task_completed');

      // At least one of each. (The emitter may fire more for sub-tasks.)
      expect(started.length).toBeGreaterThanOrEqual(1);
      expect(completed.length).toBeGreaterThanOrEqual(1);

      // Ordering: every started must precede its corresponding completed
      // (by timestamp).
      for (const s of started) {
        const laterCompleted = completed.find(
          (c) => c.tsMs >= s.tsMs && (c.payload as any).taskId === (s.payload as any).taskId,
        );
        expect(laterCompleted).toBeDefined();
      }

      const memFiles = await listMemoryFilesWithSizes(stack.dataDir);
      const after = await stack.profileService.loadProfile('u-obs2');
      dumpTrace({
        testName: 'OBS-2: 单任务状态机时序',
        llmCalls: stack.llmTrace,
        timeline,
        memoryFiles: memFiles,
        memorySnapshots: [
          {
            label: 'timeline counts',
            payload: {
              task_started: started.length,
              task_completed: completed.length,
              request_spawned: timeline.filter((e) => e.type === 'request_spawned').length,
              request_completed: timeline.filter((e) => e.type === 'request_completed').length,
            },
          },
        ],
        profileSnapshot: {
          length: after.history.length,
          topics: after.history.map((h) => h.topic),
        },
      });
    } finally {
      await stack.close();
    }
  });

  test('OBS-3: 错误路径 — LLM 抛错时,历史任务不受影响', async () => {
    const stack = await buildStackedAgent({
      userId: 'u-obs3',
      injectError: true,
      trace: llmTrace,
    });

    try {
      // Sanity: pre-seed history preserved before the failure
      const before = await stack.profileService.loadProfile('u-obs3');
      expect(before.history.length).toBe(2);

      // Fire new task — the mock LLM will throw inside generateStructured
      const result = await postStreamExpectEvents(stack.url, {
        requirement: '我的 VPN 连不上去了',
        userId: 'u-obs3',
      });

      // We don't strictly require status 200 — the error may surface as
      // a 500/503 SSE error envelope. We only assert: historical profile is untouched.
      // The error event from SSE stream OR the timeline reflects the failure.
      const errorFromStream = result.events.some(
        (e) => e.event === 'error' || e.event === 'request_error',
      );

      // After the failure, profile.history must STILL be 2 entries unchanged.
      const after = await stack.profileService.loadProfile('u-obs3');
      expect(after.history.length).toBe(2);
      const task1 = after.history.find((h) => h.topic === '打印机驱动安装');
      const task2 = after.history.find((h) => h.topic === '企业邮箱迁移');
      expect(task1!.summary).toContain('已完成');
      expect(task2!.summary).toContain('进行中');

      // Timeline should show LLM trace was attempted and then error
      const hasGenerateStructuredCall = stack.llmTrace.some(
        (c) => c.method === 'generateStructured',
      );
      expect(hasGenerateStructuredCall).toBe(true);

      const memFiles = await listMemoryFilesWithSizes(stack.dataDir);
      dumpTrace({
        testName: 'OBS-3: 错误路径追踪',
        llmCalls: stack.llmTrace,
        timeline,
        memoryFiles: memFiles,
        memorySnapshots: [
          {
            label: 'SSE error observed',
            payload: errorFromStream,
          },
          {
            label: 'profile.history topics (unchanged)',
            payload: after.history.map((h) => h.topic),
          },
        ],
        profileSnapshot: {
          length: after.history.length,
          topics: after.history.map((h) => h.topic),
        },
      });
    } finally {
      await stack.close();
    }
  });
});
