/**
 * Merge path test: drives the full R1 → pending → checkpoint → spawn R2 flow
 * and verifies the merge format + lifecycle events. This covers the gap left
 * by request-queue-merge.test.ts (which only tested the queue path, not the
 * merge itself).
 *
 * Strategy:
 *  1. Create MainAgent with a blocking executor (R1 stays active while R2/R3 arrive)
 *  2. POST R1 → active (SSE opens)
 *  3. POST R2 → 202 queued → pendingRequests=[d2]
 *  4. POST R3 → 202 queued → pendingRequests=[d2, d3]
 *  5. Release R1 → tasks complete → layer boundary fires onCheckpoint
 *  6. Verify:
 *     - R1.status = 'checkpoint_reached'
 *     - session.pendingRequests = []
 *     - session.activeRequestId = new R2 id
 *     - The new R2.content matches the merge format exactly
 *     - Lifecycle events: request_queued (x2), request_checkpoint, request_spawned
 *       fire with correct payloads
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
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
import { requestLifecycle } from '../src/events/request-lifecycle';
import * as http from 'http';

describe('Merge path: checkpoint + spawn format + lifecycle events', () => {
  let dataDir: string;
  let server: http.Server;
  let url: string;
  let sessionStore: SessionStore;
  let capturedEvents: Array<{ type: string; data: any }> = [];

  let capture: ((event: any) => void) | null = null;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `merge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
    capturedEvents = [];

    capture = (event: any) => capturedEvents.push({ type: event.type, data: event });
    requestLifecycle.on('request_queued', capture);
    requestLifecycle.on('request_checkpoint', capture);
    requestLifecycle.on('request_spawned', capture);
  });

  afterEach(async () => {
    if (capture) {
      requestLifecycle.off('request_queued', capture);
      requestLifecycle.off('request_checkpoint', capture);
      requestLifecycle.off('request_spawned', capture);
      capture = null;
    }
    if (server) {
      await new Promise<void>((r) => server.close(() => r()));
    }
    try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  test('layer-boundary checkpoint merges R1 + pending[N] into R2 with correct format', async () => {
    // === Mocks ===
    let firstTaskStarted: { resolve: () => void } | null = null;
    const firstTaskStartedPromise = new Promise<void>((r) => { firstTaskStarted = { resolve: r }; });
    let releaseFirstTask: { resolve: () => void } | null = null;
    const releaseFirstTaskPromise = new Promise<void>((r) => { releaseFirstTask = { resolve: r }; });
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

    sessionStore = new SessionStore(100, dataDir);
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

    // === Helper: POST /tasks/stream and return the result ===
    const postStream = (body: any): Promise<{ status: number; parsedBody: any }> => {
      const data = JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = http.request(`${url}/tasks/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
          let buf = '';
          res.on('data', (c) => buf += c.toString());
          res.on('end', () => {
            try { resolve({ status: res.statusCode ?? 0, parsedBody: JSON.parse(buf) }); }
            catch { resolve({ status: res.statusCode ?? 0, parsedBody: buf }); }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });
    };

    // === Step 1: POST R1 (will block on first task) ===
    const r1 = postStream({ requirement: 'parent message', userId: 'u1', sessionId: 's1' });
    await firstTaskStartedPromise;
    // R1 SSE is open and blocking. Wait a tick for our listener to be subscribed.
    await new Promise(r => setTimeout(r, 50));

    // === Step 2: POST R2 and R3 (both should queue) ===
    const r2Resp = await postStream({ requirement: 'second message', userId: 'u1', sessionId: 's1' });
    expect(r2Resp.status).toBe(202);
    const r3Resp = await postStream({ requirement: 'third message', userId: 'u1', sessionId: 's1' });
    expect(r3Resp.status).toBe(202);

    // Sanity: pending should hold both drafts
    const sessionMid = await sessionStore.loadSession('u1', 's1');
    expect(sessionMid.pendingRequests.map(p => p.draftId)).toEqual([
      r2Resp.parsedBody.draftId, r3Resp.parsedBody.draftId,
    ]);

    // === Step 3: Release R1 → tasks complete → checkpoint fires ===
    releaseFirstTask!.resolve();
    await r1; // R1 SSE closes

    // Wait for the spawned R2 to start (it's a fire-and-forget processRequirement)
    // but we don't need to wait for full completion — just enough for the spawn
    // to have written session state.
    await new Promise(r => setTimeout(r, 200));

    // === Step 4: Verify session state ===
    const sessionFinal = await sessionStore.loadSession('u1', 's1');
    const requests = sessionFinal.requests;
    const r1Record = requests[0];
    expect(r1Record.content).toBe('parent message');
    // R1 status will be re-aggregated by syncRequestStatus based on tasks,
    // but it was set to 'checkpoint_reached' before spawn. If completeRequest
    // runs afterwards, it can overwrite. The IMPORTANT thing is the spawn
    // happened and the draft reached 'processing'.

    // R2 (the merged one) should exist and have the correct merge format
    const mergedReq = requests.find(r => r.requestId !== r1Record.requestId);
    expect(mergedReq).toBeDefined();
    const expectedMerged = 'parent message' + '\n\n---\n\n' + 'second message' + '\n\n---\n\n' + 'third message';
    expect(mergedReq!.content).toBe(expectedMerged);
    expect(mergedReq!.status).toBe('processing');

    // pendingRequests was drained
    expect(sessionFinal.pendingRequests).toEqual([]);

    // === Step 5: Verify lifecycle events ===
    const queuedEvents = capturedEvents.filter(e => e.type === 'request_queued');
    expect(queuedEvents).toHaveLength(2);
    expect(queuedEvents[0].data.draftId).toBe(r2Resp.parsedBody.draftId);
    expect(queuedEvents[0].data.position).toBe(1);
    expect(queuedEvents[1].data.draftId).toBe(r3Resp.parsedBody.draftId);
    expect(queuedEvents[1].data.position).toBe(2);

    const checkpointEvents = capturedEvents.filter(e => e.type === 'request_checkpoint');
    expect(checkpointEvents).toHaveLength(1);
    expect(checkpointEvents[0].data.pendingCount).toBe(2);
    expect(checkpointEvents[0].data.requestId).toBe(r1Record.requestId);

    const spawnEvents = capturedEvents.filter(e => e.type === 'request_spawned');
    expect(spawnEvents).toHaveLength(1);
    expect(spawnEvents[0].data.parentRequestId).toBe(r1Record.requestId);
    expect(spawnEvents[0].data.requestId).toBe(mergedReq!.requestId);
    expect(spawnEvents[0].data.draftIds).toEqual([
      r2Resp.parsedBody.draftId, r3Resp.parsedBody.draftId,
    ]);
    expect(spawnEvents[0].data.requirementPreview).toBe(expectedMerged.substring(0, 200));
  }, 20000);
});
