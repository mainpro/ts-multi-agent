/**
 * RequestManager 测试（12 个用例）
 * 运行: npx tsx __tests__/request-manager.test.ts
 */
import { RequestManager } from '../src/agents/request-manager';
import { SessionStore } from '../src/memory/session-store';
import { QAEntry, HandleResult } from '../src/types';
import { promises as fs } from 'fs';
import assert from 'assert';

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
      const msg = `  ❌ ${name}: ${e.message}`;
      errors.push(msg);
      console.log(msg);
    }
  })();
}

// Mock LLM: 默认返回延续
function createMockLLM(overrides?: { continuationResult?: string }) {
  const defaultContinuation = '{"isContinuation": true, "confidence": 0.9}';
  return {
    generateText: async (prompt: string, _systemPrompt?: string) => {
      if (prompt.includes('上一个问题') || prompt.includes('用户最新回复')) {
        return overrides?.continuationResult || defaultContinuation;
      }
      return '{}';
    },
  } as any;
}

async function run() {
  console.log('\n📋 RequestManager 测试\n');

  // 清理之前测试遗留的磁盘数据
  try { await fs.rm('data/memory', { recursive: true }); } catch {}

  // ===== handleUserInput 主路径 =====
  console.log('--- handleUserInput 主路径 ---');

  await test('RM-01: 有等待请求 + 延续判断 YES', async () => {
    const store = new SessionStore(0);
    const llm = createMockLLM();
    const rm = new RequestManager(store, llm);

    // 创建一个等待请求
    const req = await store.createRequest('u1', 's1', '申请GEAM权限');
    const q: QAEntry = { questionId: 'q1', content: '是财务岗吗？', source: 'sub_agent', taskId: null, skillName: null, answer: null, answeredAt: null, createdAt: new Date().toISOString() };
    await store.addQuestionToRequest('u1', 's1', req.requestId, q);

    const result = await rm.handleUserInput('u1', 's1', '是的');
    assert.strictEqual(result.type, 'continue');
    if (result.type === 'continue') {
      assert.strictEqual(result.question.questionId, 'q1');
      assert.strictEqual(result.request.status, 'processing');
    }
  });

  await test('RM-02: 有等待请求 + 延续判断 NO', async () => {
    const store = new SessionStore(0);
    const llm = createMockLLM({ continuationResult: '{"isContinuation": false, "confidence": 0.9, "reason": "用户切换话题"}' });
    const rm = new RequestManager(store, llm);

    const req = await store.createRequest('u1', 's2', '申请GEAM权限');
    const q: QAEntry = { questionId: 'q1', content: '是财务岗吗？', source: 'sub_agent', taskId: null, skillName: null, answer: null, answeredAt: null, createdAt: new Date().toISOString() };
    await store.addQuestionToRequest('u1', 's2', req.requestId, q);

    const result = await rm.handleUserInput('u1', 's2', 'EES怎么登录');
    assert.strictEqual(result.type, 'new_request');
    // 旧请求应该被挂起
    const oldReq = await store.getRequest('u1', 's2', req.requestId);
    assert.strictEqual(oldReq!.status, 'suspended');
  });

  await test('RM-05: 无等待 + 无挂起 → 新请求', async () => {
    const store = new SessionStore(0);
    const llm = createMockLLM();
    const rm = new RequestManager(store, llm);

    const result = await rm.handleUserInput('u1', 's5', '帮我查发票');
    assert.strictEqual(result.type, 'new_request');
  });

  await test('RM-06: 同时有等待和挂起 → 等待优先', async () => {
    const store = new SessionStore(0);
    const llm = createMockLLM();
    const rm = new RequestManager(store, llm);

    // 创建等待请求
    const req1 = await store.createRequest('u1', 's6', '申请GEAM权限');
    const q: QAEntry = { questionId: 'q1', content: '是财务岗吗？', source: 'sub_agent', taskId: null, skillName: null, answer: null, answeredAt: null, createdAt: new Date().toISOString() };
    await store.addQuestionToRequest('u1', 's6', req1.requestId, q);

    // 创建挂起请求
    const req2 = await store.createRequest('u1', 's6', '旧请求');
    await store.suspendRequest('u1', 's6', req2.requestId, '测试');

    const result = await rm.handleUserInput('u1', 's6', '是的');
    assert.strictEqual(result.type, 'continue'); // 等待优先，不检查挂起
  });

  // ===== judgeContinuation 容错 =====
  console.log('\n--- judgeContinuation 容错 ---');

  await test('RM-10: LLM 返回无效 JSON → 默认延续', async () => {
    const store = new SessionStore(0);
    const llm = createMockLLM({ continuationResult: '我不知道' });
    const rm = new RequestManager(store, llm);

    const result = await rm.judgeContinuation(
      { questionId: 'q1', content: '测试', source: 'sub_agent', taskId: null, skillName: null, answer: null, answeredAt: null, createdAt: '' },
      '用户回复'
    );
    assert.strictEqual(result.isContinuation, true);
    assert.strictEqual(result.confidence, 0.5);
  });

  await test('RM-11: LLM 调用抛异常 → 默认延续', async () => {
    const store = new SessionStore(0);
    const llm = { generateText: async () => { throw new Error('LLM error'); } } as any;
    const rm = new RequestManager(store, llm);

    const result = await rm.judgeContinuation(
      { questionId: 'q1', content: '测试', source: 'sub_agent', taskId: null, skillName: null, answer: null, answeredAt: null, createdAt: '' },
      '用户回复'
    );
    assert.strictEqual(result.isContinuation, true);
    assert.strictEqual(result.confidence, 0.5);
  });

  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach(e => console.log(e));
  }
}

run().catch(console.error);
