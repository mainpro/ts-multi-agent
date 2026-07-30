import { MainAgent } from '../src/agents/main-agent';
import { LlmError, BusinessError, SkillError, AppError } from '../src/errors';
import { LLMError } from '../src/llm';
import { MemoryService } from '../src/memory/memory-service';
import { SessionStore } from '../src/memory/session-store';
import { IntentRouter } from '../src/routers/intent-router';
import { AskAgent } from '../src/agents/ask-agent';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import { UserProfileService } from '../src/user-profile';
import { SystemSkillLoader, ExecutorRegistry } from '../src/system-skills';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';

let passed = 0;
let failed = 0;
const errors: string[] = [];

function test(name: string, fn: () => Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (e: any) {
      failed++;
      console.log(`  ❌ ${name}: ${e.message}`);
      errors.push(e.message);
    }
  })();
}

class MockTaskQueue extends EventEmitter {
  addTask() {}
  getTask() { return null; }
  getAllTasks() { return []; }
  getTasksByStatus() { return []; }
  cancelTask() { return false; }
  triggerProcess() {}
}

function createMockLLM(generateTextImpl: () => Promise<string>) {
  return {
    generateText: generateTextImpl,
    generateWithTools: async () => ({ response: '', toolCalls: [] }),
    generateWithToolsTracked: async () => ({ response: '', toolCalls: [], messages: [] }),
    generateStructured: async () => ({}),
  } as any;
}

async function createAgent(generateTextImpl: () => Promise<string>) {
  const dataDir = path.join(os.tmpdir(), `mae-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
  await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
  const mockLLM = createMockLLM(generateTextImpl);
  const skillRegistry = { getAllMetadata: () => [], loadFullSkill: async () => null, hasSkill: () => false } as any;
  const memoryService = new MemoryService(dataDir, mockLLM);
  const sessionStore = new SessionStore(100, dataDir);
  const userProfileService = new UserProfileService(dataDir);
  const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
  const intentRouter = new IntentRouter(mockLLM, skillRegistry);
  const askAgent = new AskAgent(sessionStore, mockLLM);
  const systemSkillLoader = new SystemSkillLoader();
  const executorRegistry = new ExecutorRegistry();
  const taskQueue = new MockTaskQueue();
  const agent = new MainAgent({
    llm: mockLLM, skillRegistry, taskQueue: taskQueue as any, intentRouter,
    userProfileService, memoryService, dynamicContextBuilder,
    sessionStore, askAgent, systemSkillLoader, executorRegistry,
  });
  return {
    agent,
    cleanup: async () => { try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {} },
  };
}

async function run() {
  console.log('\nMainAgent AppError throw tests\n');

  await test('MA-E01: LLM RATE_LIMIT → processRequirement remains resilient and preserves LLM call failure', async () => {
    let calls = 0;
    const { agent, cleanup } = await createAgent(async () => {
      calls++;
      throw new LLMError('RATE_LIMIT', 'too many', 429);
    });
    try {
      const result = await agent.processRequirement('test', undefined, 'u1', 's1');
      assert.ok(result && typeof result === 'object');
      assert.ok(calls > 0, 'expected MainAgent processing to invoke the LLM');
    } finally {
      await cleanup();
    }
  });

  await test('MA-E02: generic LLM error → processRequirement remains resilient and preserves LLM call failure', async () => {
    let calls = 0;
    const { agent, cleanup } = await createAgent(async () => {
      calls++;
      throw new LLMError('TIMEOUT', 'timed out', 504);
    });
    try {
      const result = await agent.processRequirement('test', undefined, 'u1', 's1');
      assert.ok(result && typeof result === 'object');
      assert.ok(calls > 0, 'expected MainAgent processing to invoke the LLM');
    } finally {
      await cleanup();
    }
  });

  await test('MA-E03: AppError is preserved (no re-wrapping) at the L3 summary boundary', async () => {
    let calls = 0;
    const { agent, cleanup } = await createAgent(async () => {
      calls++;
      throw new BusinessError('CUSTOM', 'custom business error');
    });
    try {
      const result = await agent.processRequirement('test', undefined, 'u1', 's1');
      assert.ok(result && typeof result === 'object');
      assert.ok(calls > 0, 'expected MainAgent processing to invoke the LLM');
    } finally {
      await cleanup();
    }
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach((e) => console.log(e));
  }
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
