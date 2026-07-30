/**
 * Direct unit test for MainAgent.handleMergedCompletion.
 *
 * This bypasses the e2e flow (where it's hard to coerce R2 into failing through
 * the LLM mock because every downstream path catches errors). We invoke the
 * private handler directly via a public adapter to verify:
 *
 *   1. A `success: false` result triggers `request_error` lifecycle event
 *   2. A rejected promise triggers `request_error`
 *   3. A `success: true` result does NOT emit `request_error`
 *   4. R2's status is set to 'failed' in session store
 *   5. session.activeRequestId is cleared
 *   6. The emitted event payload has correct fields (requestId, parentRequestId,
 *      error.type, error.code, error.message)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
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
import { requestLifecycle } from '../src/events/request-lifecycle';

describe('MainAgent.handleMergedCompletion', () => {
  let dataDir: string;
  let sessionStore: SessionStore;
  let mainAgent: MainAgent;
  let captured: Array<{ type: string; data: any }> = [];
  let capture: ((event: any) => void) | null = null;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `hmc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
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

    mainAgent = new MainAgent({
      llm: mockLLM, skillRegistry: mockRegistry, taskQueue, intentRouter,
      userProfileService, memoryService, dynamicContextBuilder, sessionStore,
      askAgent, systemSkillLoader, executorRegistry,
    });

    captured = [];
    capture = (event: any) => captured.push({ type: event.type, data: event });
    requestLifecycle.on('request_error', capture);
  });

  afterEach(async () => {
    if (capture) {
      requestLifecycle.off('request_error', capture);
      capture = null;
    }
    try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  test('success: true result → no request_error event, activeRequestId untouched', async () => {
    // Seed session with active R2
    const session = await sessionStore.loadSession('u1', 's1');
    session.requests.push({
      requestId: 'r2', content: 'merged', status: 'processing',
      createdAt: 'x', updatedAt: 'x',
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null, tasks: [], result: null,
    });
    session.activeRequestId = 'r2';
    await sessionStore.saveSession('u1', 's1', session);
    await new Promise(r => setTimeout(r, 150));

    // Call private handler via (any) cast
    await (mainAgent as any).handleMergedCompletion('u1', 's1', 'r2', 'r1', { success: true, data: { message: 'ok' } }, null);

    expect(captured).toHaveLength(0);
    const sessionFinal = await sessionStore.loadSession('u1', 's1');
    expect(sessionFinal.activeRequestId).toBe('r2');  // not cleared on success
  });

  test('success: false result → request_error event, R2 marked failed, activeRequestId cleared', async () => {
    const session = await sessionStore.loadSession('u1', 's1');
    session.requests.push({
      requestId: 'r2', content: 'merged', status: 'processing',
      createdAt: 'x', updatedAt: 'x',
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null, tasks: [], result: null,
    });
    session.activeRequestId = 'r2';
    await sessionStore.saveSession('u1', 's1', session);
    await new Promise(r => setTimeout(r, 150));

    await (mainAgent as any).handleMergedCompletion('u1', 's1', 'r2', 'r1', {
      success: false,
      error: { type: 'FATAL', message: 'task exploded', code: 'TASK_FAILED' },
    }, null);

    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('request_error');
    expect(captured[0].data.requestId).toBe('r2');
    expect(captured[0].data.parentRequestId).toBe('r1');
    expect(captured[0].data.error.type).toBe('FATAL');
    expect(captured[0].data.error.code).toBe('TASK_FAILED');
    expect(captured[0].data.error.message).toBe('task exploded');
    expect(typeof captured[0].data.timestamp).toBe('string');

    const sessionFinal = await sessionStore.loadSession('u1', 's1');
    const r2 = sessionFinal.requests.find(r => r.requestId === 'r2');
    expect(r2!.status).toBe('failed');
    expect(r2!.result).toBe('task exploded');
    expect(sessionFinal.activeRequestId).toBeNull();
  });

  test('rejected promise → request_error event with rejection message', async () => {
    const session = await sessionStore.loadSession('u1', 's1');
    session.requests.push({
      requestId: 'r2', content: 'merged', status: 'processing',
      createdAt: 'x', updatedAt: 'x',
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null, tasks: [], result: null,
    });
    session.activeRequestId = 'r2';
    await sessionStore.saveSession('u1', 's1', session);
    await new Promise(r => setTimeout(r, 150));

    await (mainAgent as any).handleMergedCompletion('u1', 's1', 'r2', 'r1', null, new Error('boom'));

    expect(captured).toHaveLength(1);
    expect(captured[0].data.error.message).toBe('boom');
    expect(captured[0].data.error.type).toBe('FATAL');

    const sessionFinal = await sessionStore.loadSession('u1', 's1');
    const r2 = sessionFinal.requests.find(r => r.requestId === 'r2');
    expect(r2!.status).toBe('failed');
    expect(sessionFinal.activeRequestId).toBeNull();
  });

  test('non-Error rejection (string) → still handled', async () => {
    const session = await sessionStore.loadSession('u1', 's1');
    session.requests.push({
      requestId: 'r2', content: 'merged', status: 'processing',
      createdAt: 'x', updatedAt: 'x',
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null, tasks: [], result: null,
    });
    session.activeRequestId = 'r2';
    await sessionStore.saveSession('u1', 's1', session);
    await new Promise(r => setTimeout(r, 150));

    await (mainAgent as any).handleMergedCompletion('u1', 's1', 'r2', 'r1', null, 'string failure');

    expect(captured).toHaveLength(1);
    expect(captured[0].data.error.message).toBe('string failure');
  });
});
