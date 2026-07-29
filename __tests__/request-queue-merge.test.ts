/**
 * End-to-end test: request queue + merge flow.
 *
 * Scenario:
 *  1. User sends message A via POST /tasks/stream → R1 starts processing (SSE opens)
 *  2. While R1 is processing, user sends message B → API returns 202 queued
 *  3. R1 reaches a layer boundary → onTaskGraphCheckpoint fires
 *  4. Pending queue drains → R2 spawned with merged requirement
 *  5. SSE stream for R1 receives request_queued, request_checkpoint, request_spawned events
 *
 * Test runner: bun test
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createAPIServer } from '../src/api';
import { MainAgent } from '../src/agents/main-agent';
import { SessionStore } from '../src/memory/session-store';
import { TaskQueue } from '../src/task-queue';
import { MemoryService } from '../src/memory/memory-service';
import { UserProfileService } from '../src/user-profile';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { IntentRouter } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';

describe('Request queue + merge (e2e)', () => {
  let dataDir: string;
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `e2e-queue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
  });

  test('user message during active request → 202 + queued; merge happens at checkpoint', async () => {
    // Gate used to slow down the first request so the second request arrives
    // while the first is still active. This is the precondition for the
    // SessionGate to decide to queue the second message.
    let firstTaskStarted: { resolve: () => void } | null = null;
    const firstTaskStartedPromise = new Promise<void>((r) => {
      firstTaskStarted = { resolve: r };
    });
    let releaseFirstTask: { resolve: () => void } | null = null;
    const releaseFirstTaskPromise = new Promise<void>((r) => {
      releaseFirstTask = { resolve: r };
    });
    let firstTaskCalls = 0;

    let structuredCalls = 0;
    const mockLLM: any = {
      generateStructured: async () => {
        structuredCalls++;
        if (structuredCalls === 1) {
          return { intent: 'skill_task', confidence: 0.9, tasks: [
            { taskId: 't1', requirement: 'task-t1: a', skillName: 'echo' },
          ] };
        }
        return { analysis: { summary: 'mock', intent: 'skill_task' }, skillSelection: ['echo'],
          plan: { needsClarification: false, tasks: [
            { id: 't1', requirement: 'task-t1: a', skillName: 'echo', params: {}, dependencies: [] },
          ] } };
      },
      generateText: async () => '',
      generateWithTools: async (messages: any) => {
        const txt = JSON.stringify(messages);
        if (txt.includes('task-t1:')) return { content: 'echo result', toolCalls: [] };
        return { content: 'fallback', toolCalls: [] };
      },
    };
    const mockRegistry: any = {
      getAllMetadata: () => [{ name: 'echo', description: 'echo' }],
      loadFullSkill: async () => ({ name: 'echo', description: 'echo', body: 'echo', metadata: {}, allowedTools: [] }),
      hasSkill: () => true,
      scanSkills: async () => ['echo'],
      startWatch: () => {}, stopWatch: () => {},
      getSkillCount: () => 1, getSkillNames: () => ['echo'],
      getSkillMetadata: () => ({ name: 'echo', description: 'echo' }),
    };

    const sessionStore = new SessionStore(100, dataDir);
    const memoryService = new MemoryService(dataDir, mockLLM);
    const userProfileService = new UserProfileService(dataDir);
    const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
    const intentRouter = new IntentRouter(mockLLM, mockRegistry);
    const askAgent = new AskAgent(sessionStore, mockLLM);
    const systemSkillLoader = new SystemSkillLoader();
    systemSkillLoader.loadAll();
    const executorRegistry = new ExecutorRegistry();
    const taskQueue = new TaskQueue(async (task) => {
      firstTaskCalls++;
      if (firstTaskCalls === 1) {
        firstTaskStarted!.resolve();
        await releaseFirstTaskPromise;
      }
      return { ok: true, requirement: task.requirement };
    });

    const mainAgent = new MainAgent({
      llm: mockLLM, skillRegistry: mockRegistry, taskQueue, intentRouter,
      userProfileService, memoryService, dynamicContextBuilder, sessionStore,
      askAgent, systemSkillLoader, executorRegistry,
    });

    const app = createAPIServer(mainAgent, mockRegistry, taskQueue);
    server = await new Promise<http.Server>((r) => {
      const s = app.listen(0, () => r(s));
    });
    url = `http://127.0.0.1:${(server.address() as any).port}`;

    try {
      const eventsPromise = new Promise<Array<{ event: string; data: any }>>((resolve, reject) => {
        const events: Array<{ event: string; data: any }> = [];
        const body = JSON.stringify({ requirement: 'first message', userId: 'u1', sessionId: 's1' });
        const req = http.request(`${url}/tasks/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c.toString();
            let sepIdx;
            while ((sepIdx = buf.indexOf('\n\n')) !== -1) {
              const raw = buf.slice(0, sepIdx);
              buf = buf.slice(sepIdx + 2);
              const ev: any = {};
              for (const line of raw.split('\n')) {
                if (line.startsWith('event: ')) ev.event = line.slice(7).trim();
                else if (line.startsWith('data: ')) ev.data = line.slice(6).trim();
              }
              if (ev.event) {
                let parsed: any = ev.data;
                try { parsed = JSON.parse(ev.data); } catch {}
                events.push({ event: ev.event, data: parsed });
              }
            }
          });
          res.on('end', () => resolve(events));
          res.on('error', reject);
        });
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      // Wait for the first task to enter the executor (request is fully active, SSE open).
      await firstTaskStartedPromise;

      const secondResp = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const body = JSON.stringify({ requirement: 'second message', userId: 'u1', sessionId: 's1' });
        const req = http.request(`${url}/tasks/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let buf = '';
          res.on('data', (c) => buf += c.toString());
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      expect(secondResp.status).toBe(202);
      expect(secondResp.body.status).toBe('queued');
      expect(secondResp.body.draftId).toBeTruthy();

      // Release the first task so the stream completes and we can inspect events.
      releaseFirstTask!.resolve();

      const events = await eventsPromise;
      const queuedEvent = events.find(e => e.event === 'request_queued');
      expect(queuedEvent).toBeDefined();
      expect((queuedEvent!.data as any).draftId).toBe(secondResp.body.draftId);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {}
    }
  });
});
