import assert from 'assert';
import request from 'supertest';
import { EventEmitter } from 'events';
import { createAPIServer } from '../src/api/index';
import { llmEvents } from '../src/llm';

// ============================================================================
// Test runner
// ============================================================================
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
      errors.push(`  ❌ ${name}: ${e.message}`);
      console.log(errors[errors.length - 1]);
    }
  })();
}

// ============================================================================
// Mocks
// ============================================================================

// Track calls on mockMainAgent
let processRequirementCalls: any[] = [];
let recallRequestCalls: any[] = [];

function createMockMainAgent(overrides: any = {}) {
  processRequirementCalls = [];
  recallRequestCalls = [];

  return {
    processRequirement: async (...args: any[]) => {
      processRequirementCalls.push(args);
      return overrides.processRequirementResult ?? { success: true, data: { type: 'skill_task' } };
    },
    recallRequest: async (...args: any[]) => {
      recallRequestCalls.push(args);
      return overrides.recallRequestResult ?? { success: true, data: { type: 'test' } };
    },
  } as any;
}

const mockSkillRegistry = {
  getAllMetadata: () => [],
} as any;

class MockTaskQueue extends EventEmitter {
  private tasks: Map<string, any> = new Map();
  addTask(task: any) {
    this.tasks.set(task.id, task);
  }
  getTask(id: string) {
    return this.tasks.get(id) || null;
  }
  getAllTasks() {
    return Array.from(this.tasks.values());
  }
  getTasksByStatus(status: string) {
    return this.getAllTasks().filter((t) => t.status === status);
  }
  cancelTask(id: string) {
    return this.tasks.has(id);
  }
  triggerProcess() {}
}

// ============================================================================
// Tests
// ============================================================================

async function run() {
  console.log('\n🧪 API Layer Tests\n');

  // API-01: POST /tasks/stream with recallRequestId → calls mainAgent.recallRequest
  await test('API-01: POST /tasks/stream with recallRequestId → calls mainAgent.recallRequest', async () => {
    const mockMainAgent = createMockMainAgent();
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());

    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', recallRequestId: 'req-001', userId: 'u1', sessionId: 's1' })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    assert.strictEqual(recallRequestCalls.length, 1, 'recallRequest should be called once');
    assert.strictEqual(recallRequestCalls[0][0], 'u1', 'First arg should be userId');
    assert.strictEqual(recallRequestCalls[0][1], 's1', 'Second arg should be sessionId');
    assert.strictEqual(recallRequestCalls[0][2], 'req-001', 'Third arg should be recallRequestId');
  });

  // API-02: POST /tasks/stream without recallRequestId → calls mainAgent.processRequirement
  await test('API-02: POST /tasks/stream without recallRequestId → calls mainAgent.processRequirement', async () => {
    const mockMainAgent = createMockMainAgent();
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());

    await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    assert.strictEqual(processRequirementCalls.length, 1, 'processRequirement should be called once');
    assert.strictEqual(recallRequestCalls.length, 0, 'recallRequest should not be called');
  });

  // API-03: POST /tasks/stream with sessionId → sessionId passed to mainAgent
  await test('API-03: POST /tasks/stream with sessionId → sessionId passed to mainAgent', async () => {
    const mockMainAgent = createMockMainAgent();
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());

    await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1', sessionId: 'sess-001' })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    assert.strictEqual(processRequirementCalls.length, 1, 'processRequirement should be called once');
    // processRequirement(requirement, imageAttachment, userId, sessionId)
    assert.strictEqual(processRequirementCalls[0][2], 'u1', 'Third arg should be userId');
    assert.strictEqual(processRequirementCalls[0][3], 'sess-001', 'Fourth arg should be sessionId');
  });

  // API-04: POST /tasks/stream without sessionId → uses userId as sessionId
  await test('API-04: POST /tasks/stream without sessionId → uses userId as sessionId', async () => {
    const mockMainAgent = createMockMainAgent();
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());

    await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    assert.strictEqual(processRequirementCalls.length, 1, 'processRequirement should be called once');
    // processRequirement(requirement, imageAttachment, userId, sessionId)
    assert.strictEqual(processRequirementCalls[0][2], 'u1', 'Third arg should be userId');
    assert.strictEqual(processRequirementCalls[0][3], 'u1', 'Fourth arg (sessionId) should default to userId');
  });

  // API-05: POST /tasks/stream missing requirement → returns 400
  await test('API-05: POST /tasks/stream missing requirement → returns 400', async () => {
    const mockMainAgent = createMockMainAgent();
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());

    const res = await request(app)
      .post('/tasks/stream')
      .send({ userId: 'u1' })
      .expect(400);

    const body = res.body;
    assert.strictEqual(body.code, 'INVALID_REQUEST', 'Error code should be INVALID_REQUEST');
    assert.strictEqual(processRequirementCalls.length, 0, 'processRequirement should not be called');
    assert.strictEqual(recallRequestCalls.length, 0, 'recallRequest should not be called');
  });

  // API-06: POST /tasks/stream success → SSE complete event
  await test('API-06: POST /tasks/stream success → SSE complete event', async () => {
    const mockMainAgent = createMockMainAgent({
      processRequirementResult: { success: true, data: { type: 'skill_task' } },
    });
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());

    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    const body = res.text;
    assert.ok(body.includes('event: complete'), `Expected SSE "event: complete" in response. Got: ${body}`);
    assert.ok(body.includes('skill_task'), `Expected "skill_task" in response. Got: ${body}`);
  });

  // API-07: POST /tasks/stream failure → SSE error event
  await test('API-07: POST /tasks/stream failure → SSE error event', async () => {
    const mockMainAgent = createMockMainAgent({
      processRequirementResult: {
        success: false,
        error: { type: 'FATAL', message: 'test error', code: 'TEST_ERROR' },
      },
    });
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());

    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    const body = res.text;
    assert.ok(body.includes('event: error'), `Expected SSE "event: error" in response. Got: ${body}`);
  });

  // API-08: POST /tasks/stream recall_prompt → SSE complete with suspendedRequest
  await test('API-08: POST /tasks/stream recall_prompt → SSE complete with suspendedRequest', async () => {
    const mockMainAgent = createMockMainAgent({
      processRequirementResult: {
        success: true,
        data: { type: 'recall_prompt', suspendedRequest: { requestId: 'req-old' } },
      },
    });
    const app = createAPIServer(mockMainAgent, mockSkillRegistry, new MockTaskQueue());

    const res = await request(app)
      .post('/tasks/stream')
      .send({ requirement: 'test', userId: 'u1' })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    const body = res.text;
    assert.ok(body.includes('recall_prompt'), `Expected "recall_prompt" in response. Got: ${body}`);
    assert.ok(body.includes('req-old'), `Expected "req-old" in response. Got: ${body}`);
  });

  // Summary
  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n❌ 失败详情:');
    errors.forEach((e) => console.log(e));
  }
}

run().catch(console.error);
