import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { MainAgent } from '../src/agents/main-agent';
import { SessionStore } from '../src/memory/session-store';
import { IntentRouter } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { UserProfileService } from '../src/user-profile';
import { MemoryService } from '../src/memory/memory-service';
import { SkillRegistry } from '../src/skill-registry';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';
import { TaskQueue } from '../src/task-queue';
import { requestLifecycle } from '../src/events/request-lifecycle';

describe('MainAgent queue integration', () => {
  let dataDir: string;
  let mainAgent: MainAgent;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `maq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
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

    mainAgent = new MainAgent({
      llm: mockLLM,
      skillRegistry: mockRegistry,
      taskQueue: new TaskQueue(async () => null),
      intentRouter,
      userProfileService,
      memoryService,
      dynamicContextBuilder,
      sessionStore,
      askAgent,
      systemSkillLoader,
      executorRegistry,
    });
  });

  test('processRequirement with active processing request returns queued=true and emits request_queued', async () => {
    // Seed session with active processing request
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

    const events: any[] = [];
    const handler = (e: any) => events.push(e);
    requestLifecycle.on('request_queued', handler);

    const result = await mainAgent.processRequirement(
      'second message',
      undefined,
      'u1',
      's1',
    );

    requestLifecycle.off('request_queued', handler);

    // Capture draftId BEFORE toMatchObject — bun's toMatchObject mutates the
    // received object, replacing matched fields with matcher instances (issue 9125).
    const resultDraftId = result.draftId;
    expect(result).toMatchObject({ queued: true, draftId: expect.any(String) });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('request_queued');
    expect(events[0].draftId).toBe(resultDraftId);

    // pendingRequests should now contain the draft
    const reloaded = await sessionStore.loadSession('u1', 's1');
    expect(reloaded.pendingRequests).toHaveLength(1);
    expect(reloaded.pendingRequests[0].requirement).toBe('second message');
  });
});