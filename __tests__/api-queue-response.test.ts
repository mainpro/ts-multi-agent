import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createAPIServer } from '../src/api';
import { MainAgent } from '../src/agents/main-agent';
import { SessionStore } from '../src/memory/session-store';
import { TaskQueue } from '../src/task-queue';
import { SkillRegistry } from '../src/skill-registry';
import { MemoryService } from '../src/memory/memory-service';
import { UserProfileService } from '../src/user-profile';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { IntentRouter } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';

describe('POST /tasks/stream 202 queue path', () => {
  let dataDir: string;
  let server: http.Server;
  let url: string;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `apiq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });

    const mockLLM = { generateStructured: async () => null, generateText: async () => '', generateWithTools: async () => ({ content: '', toolCalls: [] }) } as any;
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
    const port = (server.address() as any).port;
    url = `http://127.0.0.1:${port}`;
  });

  test('returns 202 + JSON when session has active processing request', async () => {
    // Seed active processing request
    const session = await sessionStore.loadSession('u1', 's1');
    session.activeRequestId = 'r-existing';
    session.requests.push({
      requestId: 'r-existing', content: 'first', status: 'processing',
      createdAt: 'x', updatedAt: 'x',
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null, tasks: [], result: null,
    });
    session.pendingRequests = [];
    await sessionStore.saveSession('u1', 's1', session);
    await new Promise(r => setTimeout(r, 150));

    const body = JSON.stringify({ requirement: 'second', userId: 'u1', sessionId: 's1' });
    const { status, headers, rawBody } = await new Promise<{ status: number; headers: any; rawBody: string }>((resolve, reject) => {
      const req = http.request(`${url}/tasks/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => buf += c.toString());
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, rawBody: buf }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    expect(status).toBe(202);
    expect(headers['content-type']).toMatch(/application\/json/);
    const parsed = JSON.parse(rawBody);
    expect(parsed.status).toBe('queued');
    expect(parsed.draftId).toBeTruthy();
    expect(typeof parsed.position).toBe('number');
  });

  // Cleanup helper
  test('cleanup', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {}
  });
});
