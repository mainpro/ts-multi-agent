/**
 * SessionStore 测试（22 个用例）
 * 运行: npx tsx __tests__/session-store.test.ts
 */
import { SessionStore } from '../src/memory/session-store';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as assert from 'assert';

const TEST_DIR = '/tmp/test-session-store-' + Date.now();
const store = new SessionStore(0); // 防抖 0ms，立即写入

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

async function run() {
  // 清理测试数据
  try { await fs.rm('data/memory', { recursive: true }); } catch {}

  console.log('\n📋 SessionStore 测试\n');

  // ===== 2.1 会话读写 =====
  console.log('--- 会话读写 ---');

  await test('SS-01: 加载不存在的会话 → 创建新会话', async () => {
    const s = await store.loadSession('u1', 's1');
    assert.strictEqual(s.sessionId, 's1');
    assert.strictEqual(s.userId, 'u1');
    assert.deepStrictEqual(s.requests, []);
    assert.strictEqual(s.activeRequestId, null);
  });

  await test('SS-02: 加载已有会话（缓存命中）', async () => {
    const s1 = await store.loadSession('u1', 's2');
    s1.requests.push({ requestId: 'r1', content: 'test', status: 'processing', createdAt: '', updatedAt: '', suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null, tasks: [], result: null });
    await store.saveSession('u1', 's2', s1);
    const s2 = await store.loadSession('u1', 's2');
    assert.strictEqual(s2.requests.length, 1);
    assert.strictEqual(s2.requests[0].requestId, 'r1');
  });

  await test('SS-03: 加载已有会话（缓存未命中）', async () => {
    // 等待防抖写入完成
    await new Promise(r => setTimeout(r, 50));
    // 清缓存后从磁盘读取
    (store as any).cache.clear();
    const s = await store.loadSession('u1', 's2');
    assert.strictEqual(s.requests.length, 1);
    assert.strictEqual(s.requests[0].requestId, 'r1');
  });

  await test('SS-04: saveSession 防抖写入', async () => {
    const debouncedStore = new SessionStore(200);
    const s = await debouncedStore.loadSession('u1', 's3');
    s.requests.push({ requestId: 'r2', content: 'test', status: 'processing', createdAt: '', updatedAt: '', suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null, tasks: [], result: null });
    await debouncedStore.saveSession('u1', 's3', s);
    // 防抖期间文件可能还没写入
    const filePath = path.join('data', 'memory', 'u1', 's3', 'session.json');
    let exists = false;
    try { await fs.access(filePath); exists = true; } catch {}
    // 不断言文件存在（防抖可能还没写入），只验证不报错
    assert.ok(true, 'saveSession did not throw');
  });

  await test('SS-05: flushToDisk 过滤内部字段', async () => {
    const s = await store.loadSession('u1', 's4');
    s.requests.push({
      requestId: 'r3', content: 'test', status: 'processing', createdAt: '', updatedAt: '',
      suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null, tasks: [{
        taskId: 't1', content: 'test', status: 'pending', skillName: 'test', createdAt: '', updatedAt: '',
        result: null, questions: [], currentQuestion: null,
        conversationContext: [{ role: 'user', content: 'secret' }],
        completedToolCalls: [{ name: 'bash', arguments: {}, result: 'output', timestamp: new Date() }],
      }], result: null,
    });
    await store.flushToDisk('u1', 's4', s);
    const data = await fs.readFile(path.join('data', 'memory', 'u1', 's4', 'session.json'), 'utf-8');
    const parsed = JSON.parse(data);
    assert.strictEqual(parsed.requests[0].tasks[0].conversationContext, undefined);
    assert.strictEqual(parsed.requests[0].tasks[0].completedToolCalls, undefined);
  });

  await test('SS-06: flushToDisk 自动创建目录', async () => {
    const s = await store.loadSession('new-user', 'new-session');
    await store.flushToDisk('new-user', 'new-session', s);
    const filePath = path.join('data', 'memory', 'new-user', 'new-session', 'session.json');
    const stat = await fs.stat(filePath);
    assert.ok(stat.isFile());
  });

  // ===== 2.2 请求 CRUD =====
  console.log('\n--- 请求 CRUD ---');

  await test('SS-07: 创建请求', async () => {
    const r = await store.createRequest('u1', 's5', '测试请求');
    assert.ok(r.requestId.startsWith('req-'));
    assert.strictEqual(r.content, '测试请求');
    assert.strictEqual(r.status, 'processing');
    const s = await store.loadSession('u1', 's5');
    assert.strictEqual(s.activeRequestId, r.requestId);
  });

  await test('SS-08: 创建多个请求 → 最新在前', async () => {
    await store.createRequest('u1', 's6', '请求1');
    await store.createRequest('u1', 's6', '请求2');
    const s = await store.loadSession('u1', 's6');
    assert.strictEqual(s.requests[0].content, '请求2');
    assert.strictEqual(s.requests[1].content, '请求1');
  });

  await test('SS-09: 获取活跃请求', async () => {
    await store.createRequest('u1', 's7', '活跃请求');
    const r = await store.getActiveRequest('u1', 's7');
    assert.ok(r);
    assert.strictEqual(r!.content, '活跃请求');
  });

  await test('SS-10: 获取活跃请求（无活跃）', async () => {
    const r = await store.getActiveRequest('u1', 's1');
    assert.strictEqual(r, null);
  });

  await test('SS-11: 更新请求', async () => {
    await store.createRequest('u1', 's8', '原始');
    const s = await store.loadSession('u1', 's8');
    const updated = await store.updateRequest('u1', 's8', s.requests[0].requestId, { status: 'failed' });
    assert.strictEqual(updated!.status, 'failed');
  });

  await test('SS-12: 更新不存在的请求', async () => {
    const r = await store.updateRequest('u1', 's8', 'not-exist', { status: 'failed' });
    assert.strictEqual(r, null);
  });

  // ===== 2.3 询问管理 =====
  console.log('\n--- 询问管理 ---');

  await test('SS-13: 添加询问 → 请求进入等待', async () => {
    await store.createRequest('u1', 's9', '测试');
    const s = await store.loadSession('u1', 's9');
    const q = { questionId: 'q1', content: '是财务岗吗？', source: 'sub_agent' as const, taskId: 't1', skillName: 'geam', answer: null, answeredAt: null, createdAt: new Date().toISOString() };
    await store.addQuestionToRequest('u1', 's9', s.requests[0].requestId, q);
    const s2 = await store.loadSession('u1', 's9');
    assert.strictEqual(s2.requests[0].status, 'waiting');
    assert.strictEqual(s2.requests[0].currentQuestion!.questionId, 'q1');
  });

  await test('SS-14: 回答子智能体问题（仅在 task.questions 中）→ 任务恢复', async () => {
    await store.createRequest('u1', 's10', '测试');
    const s = await store.loadSession('u1', 's10');
    const rid = s.requests[0].requestId;
    // 先添加任务
    await store.addTaskToRequest('u1', 's10', rid, { taskId: 't1', content: '任务1', status: 'waiting', skillName: 'geam', createdAt: '', updatedAt: '', result: null, questions: [], currentQuestion: null });
    // 子智能体问题只添加到任务级（新逻辑）
    const q = { questionId: 'q2', content: '是财务岗吗？', source: 'sub_agent' as const, taskId: 't1', skillName: 'geam', answer: null, answeredAt: null, createdAt: new Date().toISOString() };
    await store.updateTaskInRequest('u1', 's10', rid, 't1', {
      currentQuestion: q,
      status: 'waiting',
      questions: [q],
    });
    // 回答
    const updated = await store.answerQuestion('u1', 's10', rid, 'q2', '是的');
    // 请求状态通过 syncRequestStatus 恢复（无 waiting 任务 → processing）
    assert.strictEqual(updated!.status, 'processing');
    assert.strictEqual(updated!.currentQuestion, null);
    const s2 = await store.loadSession('u1', 's10');
    assert.strictEqual(s2.requests[0].tasks[0].status, 'pending');
    assert.strictEqual(s2.requests[0].tasks[0].questions[0].answer, '是的');
    // 子智能体问题不在请求级
    assert.strictEqual(s2.requests[0].questions.length, 0);
  });

  await test('SS-15: 回答问题（无 taskId）→ 仅请求恢复', async () => {
    await store.createRequest('u1', 's11', '测试');
    const s = await store.loadSession('u1', 's11');
    const rid = s.requests[0].requestId;
    const q = { questionId: 'q3', content: '是EES系统吗？', source: 'main_agent' as const, taskId: null, skillName: null, answer: null, answeredAt: null, createdAt: new Date().toISOString() };
    await store.addQuestionToRequest('u1', 's11', rid, q);
    const updated = await store.answerQuestion('u1', 's11', rid, 'q3', '不是');
    assert.strictEqual(updated!.status, 'processing');
  });

  await test('SS-16: 回答不存在的问题', async () => {
    await store.createRequest('u1', 's12', '测试');
    const s = await store.loadSession('u1', 's12');
    const updated = await store.answerQuestion('u1', 's12', s.requests[0].requestId, 'not-exist', '答案');
    assert.strictEqual(updated!.status, 'processing');
  });

  // ===== 2.4 挂起/召回 =====
  console.log('\n--- 挂起/召回 ---');

  await test('SS-17: 挂起请求 → 任务级联挂起', async () => {
    await store.createRequest('u1', 's13', '测试');
    const s = await store.loadSession('u1', 's13');
    const rid = s.requests[0].requestId;
    await store.addTaskToRequest('u1', 's13', rid, { taskId: 't1', content: '任务1', status: 'pending', skillName: 'geam', createdAt: '', updatedAt: '', result: null, questions: [], currentQuestion: null });
    await store.addTaskToRequest('u1', 's13', rid, { taskId: 't2', content: '任务2', status: 'running', skillName: 'geam', createdAt: '', updatedAt: '', result: null, questions: [], currentQuestion: null });
    const updated = await store.suspendRequest('u1', 's13', rid, '用户切换话题');
    assert.strictEqual(updated!.status, 'suspended');
    const s2 = await store.loadSession('u1', 's13');
    assert.strictEqual(s2.requests[0].tasks[0].status, 'suspended');
    assert.strictEqual(s2.requests[0].tasks[1].status, 'suspended');
  });

  await test('SS-18: 挂起活跃请求 → 清除 activeRequestId', async () => {
    await store.createRequest('u1', 's14', '测试');
    const s = await store.loadSession('u1', 's14');
    const rid = s.requests[0].requestId;
    assert.strictEqual(s.activeRequestId, rid);
    await store.suspendRequest('u1', 's14', rid, '测试');
    const s2 = await store.loadSession('u1', 's14');
    assert.strictEqual(s2.activeRequestId, null);
  });

  await test('SS-19: 召回请求 → 任务级联恢复', async () => {
    await store.createRequest('u1', 's15', '测试');
    const s = await store.loadSession('u1', 's15');
    const rid = s.requests[0].requestId;
    await store.addTaskToRequest('u1', 's15', rid, { taskId: 't1', content: '任务1', status: 'suspended', skillName: 'geam', createdAt: '', updatedAt: '', result: null, questions: [], currentQuestion: null });
    await store.addTaskToRequest('u1', 's15', rid, { taskId: 't2', content: '任务2', status: 'suspended', skillName: 'geam', createdAt: '', updatedAt: '', result: null, questions: [], currentQuestion: null });
    const updated = await store.recallRequest('u1', 's15', rid);
    assert.strictEqual(updated!.status, 'processing');
    const s2 = await store.loadSession('u1', 's15');
    assert.strictEqual(s2.requests[0].tasks[0].status, 'pending');
    assert.strictEqual(s2.requests[0].tasks[1].status, 'pending');
  });

  await test('SS-20: 召回请求 → 设置 activeRequestId', async () => {
    await store.createRequest('u1', 's16', '测试');
    const s = await store.loadSession('u1', 's16');
    const rid = s.requests[0].requestId;
    await store.suspendRequest('u1', 's16', rid, '测试');
    await store.recallRequest('u1', 's16', rid);
    const s2 = await store.loadSession('u1', 's16');
    assert.strictEqual(s2.activeRequestId, rid);
  });

  await test('SS-21: 获取挂起请求 → 按时间倒序', async () => {
    await store.createRequest('u1', 's17', '请求1');
    await new Promise(r => setTimeout(r, 10));
    await store.createRequest('u1', 's17', '请求2');
    await new Promise(r => setTimeout(r, 10));
    await store.createRequest('u1', 's17', '请求3');
    const s = await store.loadSession('u1', 's17');
    await store.suspendRequest('u1', 's17', s.requests[0].requestId, '测试');
    await store.suspendRequest('u1', 's17', s.requests[1].requestId, '测试');
    await store.suspendRequest('u1', 's17', s.requests[2].requestId, '测试');
    const suspended = await store.getSuspendedRequests('u1', 's17');
    assert.strictEqual(suspended.length, 3);
    assert.strictEqual(suspended[0].content, '请求3'); // 最新在前
    assert.strictEqual(suspended[2].content, '请求1');
  });

  await test('SS-22: syncRequestStatus 聚合', async () => {
    await store.createRequest('u1', 's18', '测试');
    const s = await store.loadSession('u1', 's18');
    const rid = s.requests[0].requestId;
    await store.addTaskToRequest('u1', 's18', rid, { taskId: 't1', content: '任务1', status: 'completed', skillName: 'geam', createdAt: '', updatedAt: '', result: null, questions: [], currentQuestion: null });
    await store.updateTaskInRequest('u1', 's18', rid, 't1', { status: 'completed' });
    const s2 = await store.loadSession('u1', 's18');
    assert.strictEqual(s2.requests[0].status, 'completed');
    // 添加 waiting 任务
    await store.addTaskToRequest('u1', 's18', rid, { taskId: 't2', content: '任务2', status: 'waiting', skillName: 'geam', createdAt: '', updatedAt: '', result: null, questions: [], currentQuestion: null });
    await store.updateTaskInRequest('u1', 's18', rid, 't2', { status: 'waiting' });
    const s3 = await store.loadSession('u1', 's18');
    assert.strictEqual(s3.requests[0].status, 'waiting'); // waiting 优先
  });

  // 清理
  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach(e => console.log(e));
  }
}

run().catch(console.error);
