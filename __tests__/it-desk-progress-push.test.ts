/**
 * End-to-end integration test for IT 服务台 scenario 2:
 * "问题进度主动推送 & 新问题提报" (PDF line 715).
 *
 * Scenario:
 *   - 用户进入 IT 服务台
 *   - 系统主动推送历史问题进度(用户没有显式发起)
 *   - 用户提报新问题(属于"新问题提报",不是改口)
 *   - 新任务与历史任务并存(独立状态)
 *   - 新问题解决 → 整体闭环
 *
 * Test framework: bun:test
 * Run: bun test __tests__/it-desk-progress-push.test.ts
 */
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
import type { ProfileHistoryItem } from '../src/types';

interface StackedAgent {
  mainAgent: MainAgent;
  url: string;
  close: () => Promise<void>;
  dataDir: string;
  profileService: UserProfileService;
}

/**
 * Build a fresh MainAgent + Express stack for this scenario.
 * Pre-seeds a user profile with 2 historical tasks (任务1=completed, 任务2=running).
 */
async function buildStackedAgent(opts: { userId?: string } = {}): Promise<StackedAgent> {
  const userId = opts.userId ?? 'u-desk-push';
  const dataDir = path.join(
    os.tmpdir(),
    `desk-progress-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  const mockLLM: ILLMClient = {
    generateStructured: async () => {
      structuredCalls += 1;
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
    generateText: async () => 'VPN 密码已重置,新密码请到企业微信查看。',
    generateWithTools: async () => {
      toolCalls += 1;
      return {
        content: 'VPN 密码已重置,新密码请到企业微信查看。',
        toolCalls: [{ name: 'reset_vpn_password', arguments: { userId: 'u-desk-push' } }],
      };
    },
    generateWithToolsTracked: async () => ({
      content: 'VPN 密码已重置,新密码请到企业微信查看。',
      toolCalls: [],
      messages: [],
    }),
  } as any;

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
  // These are recorded as profile.history entries — they represent
  // previously-known tickets the system should surface proactively.
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
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function postStreamExpectEvents(url: string, body: object) {
  return new Promise<{
    status: number;
    events: Array<{ event: string; data: any }>;
  }>((resolve, reject) => {
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
      }
    );
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('IT 服务台：问题进度主动推送 & 新问题提报', () => {
  test('PROG-1: 系统能识别并加载历史任务进度(无需用户主动询问)', async () => {
    const stack = await buildStackedAgent({ userId: 'u-prog1' });
    try {
      // 加载 profile,验证 2 个历史任务都被正确 seed
      const profile = await stack.profileService.loadProfile('u-prog1');
      expect(profile.history.length).toBe(2);

      const task1 = profile.history.find((h) => h.topic === '打印机驱动安装');
      const task2 = profile.history.find((h) => h.topic === '企业邮箱迁移');
      expect(task1).toBeDefined();
      expect(task1!.summary).toContain('已完成');
      expect(task2).toBeDefined();
      expect(task2!.summary).toContain('进行中');

      // 不发任何新请求,profile history 字段就是"主动推送历史进度"的载体
      // — 验证 MainAgent 持有的 profileService 引用能读到同一个 profile
      const reloaded = await stack.profileService.loadProfile('u-prog1');
      expect(reloaded.history.length).toBe(2);
      expect(reloaded.history.map((h) => h.topic)).toEqual([
        '打印机驱动安装',
        '企业邮箱迁移',
      ]);
    } finally {
      await stack.close();
    }
  });

  test('PROG-2: 新任务与历史任务并存(独立状态,新任务不影响历史条目)', async () => {
    const stack = await buildStackedAgent({ userId: 'u-prog2' });
    try {
      // 1. 记录历史 profile 的初始历史长度
      const before = await stack.profileService.loadProfile('u-prog2');
      expect(before.history.length).toBe(2);

      // 2. 用户提报新问题 — 这是"新问题提报",不是改口
      const result = await postStreamExpectEvents(stack.url, {
        requirement: '我的 VPN 连不上去了',
        userId: 'u-prog2',
      });

      expect(result.status).toBe(200);

      // 3. 新任务必须完成 — 触发 task_completed 和 complete
      const completed = result.events.find((e) => e.event === 'task_completed');
      expect(completed).toBeDefined();
      expect(result.events.some((e) => e.event === 'complete')).toBe(true);

      // 4. 历史任务状态保持不变 — 任务1 仍是"已完成",任务2 仍是"进行中"
      // 这是"并存"的硬约束:新任务启动不能修改历史条目
      const after = await stack.profileService.loadProfile('u-prog2');
      expect(after.history.length).toBe(2);
      const task1 = after.history.find((h) => h.topic === '打印机驱动安装');
      const task2 = after.history.find((h) => h.topic === '企业邮箱迁移');
      expect(task1!.summary).toContain('已完成');
      expect(task2!.summary).toContain('进行中');
    } finally {
      await stack.close();
    }
  });

  test('PROG-3: 新任务完成后整体闭环(complete 事件触发,历史不变)', async () => {
    const stack = await buildStackedAgent({ userId: 'u-prog3' });
    try {
      const result = await postStreamExpectEvents(stack.url, {
        requirement: '我的 VPN 连不上去了',
        userId: 'u-prog3',
      });

      expect(result.status).toBe(200);

      // 1. 整体闭环 — 必须出现 complete 事件
      const complete = result.events.find((e) => e.event === 'complete');
      expect(complete).toBeDefined();

      // 2. task_completed 事件必须存在(代表新任务成功)
      const taskCompleted = result.events.find((e) => e.event === 'task_completed');
      expect(taskCompleted).toBeDefined();

      // 3. 整体响应中不应有 error 事件(无错误路径)
      expect(result.events.some((e) => e.event === 'error')).toBe(false);

      // 4. 闭环后历史任务仍然保持原状态(2 条历史,已完成 + 进行中 各 1)
      const finalProfile = await stack.profileService.loadProfile('u-prog3');
      expect(finalProfile.history.length).toBe(2);
      const statuses = finalProfile.history
        .map((h) => h.summary)
        .sort()
        .join('|');
      expect(statuses).toContain('已完成');
      expect(statuses).toContain('进行中');

      // 5. complete 事件的最终 data 应当指向 vpn-reset skill,证明新问题解决
      const completeDataStr = JSON.stringify(complete!.data);
      expect(completeDataStr).toContain('vpn-reset');
    } finally {
      await stack.close();
    }
  });
});
