/**
 * buildSessionPrompt + buildTaskContextPrompt 测试（15 个用例）
 * 运行: npx tsx __tests__/session-context-prompt.test.ts
 */
import assert from 'assert';
import { buildSessionPrompt, buildTaskContextPrompt } from '../src/prompts/session-context-prompt';
import { Session, Request, QAEntry, RequestTask } from '../src/types';

// ============================================================================
// 测试辅助函数
// ============================================================================

function makeSession(overrides?: Partial<Session>): Session {
  return {
    sessionId: 's1', userId: 'u1',
    createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
    requests: [], activeRequestId: null,
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<Request>): Request {
  return {
    requestId: 'req-001', content: '测试请求', status: 'processing',
    createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
    suspendedAt: null, suspendedReason: null,
    questions: [], currentQuestion: null, tasks: [], result: null,
    ...overrides,
  };
}

function makeQA(overrides?: Partial<QAEntry>): QAEntry {
  return {
    questionId: 'q1', content: '测试问题', source: 'sub_agent',
    taskId: null, skillName: null, answer: null, answeredAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeTask(overrides?: Partial<RequestTask>): RequestTask {
  return {
    taskId: 'task-001', content: '测试任务', status: 'pending',
    skillName: 'test-skill', createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z', result: null,
    questions: [], currentQuestion: null,
    ...overrides,
  };
}

// ============================================================================
// 测试框架
// ============================================================================

let passed = 0;
let failed = 0;
const errors: string[] = [];

function test(name: string, fn: () => Promise<void>) {
  return (async () => {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e: any) { failed++; errors.push(`  ❌ ${name}: ${e.message}`); console.log(errors[errors.length - 1]); }
  })();
}

async function run() {
  console.log('\n📋 buildSessionPrompt 测试\n');

  // SP-01: 空会话
  await test('SP-01: 空会话（无请求、无 activeRequestId）→ 仅输出 header', async () => {
    const session = makeSession();
    const result = buildSessionPrompt(session);
    assert.strictEqual(result, '## 当前会话状态');
  });

  // SP-02: 活跃请求（无问题/任务）
  await test('SP-02: 活跃请求（无问题/任务）→ 显示请求信息', async () => {
    const req = makeRequest({ requestId: 'req-002', content: '帮我查天气', status: 'processing' });
    const session = makeSession({ requests: [req], activeRequestId: 'req-002' });
    const result = buildSessionPrompt(session);
    assert.ok(result.includes('## 当前会话状态'));
    assert.ok(result.includes('### 活跃请求'));
    assert.ok(result.includes('- 请求ID: req-002'));
    assert.ok(result.includes('- 内容: "帮我查天气"'));
    assert.ok(result.includes('- 状态: processing'));
    assert.ok(!result.includes('询问历史'));
    assert.ok(!result.includes('子任务'));
  });

  // SP-03: 活跃请求 + 问题（source='main_agent'）→ 显示"主智能体"
  await test('SP-03: 活跃请求 + 问题（source=main_agent）→ 显示"主智能体"标签', async () => {
    const qa = makeQA({ questionId: 'q1', content: '哪个城市？', source: 'main_agent', answer: '北京' });
    const req = makeRequest({ questions: [qa] });
    const session = makeSession({ requests: [req], activeRequestId: 'req-001' });
    const result = buildSessionPrompt(session);
    assert.ok(result.includes('[主智能体]'));
    assert.ok(result.includes('"哪个城市？"'));
    assert.ok(result.includes('"北京"'));
  });

  // SP-04: 活跃请求 + 问题（source='sub_agent'）→ 显示"子智能体"
  await test('SP-04: 活跃请求 + 问题（source=sub_agent）→ 显示"子智能体"标签', async () => {
    const qa = makeQA({ questionId: 'q2', content: '需要什么格式？', source: 'sub_agent', answer: 'PDF' });
    const req = makeRequest({ questions: [qa] });
    const session = makeSession({ requests: [req], activeRequestId: 'req-001' });
    const result = buildSessionPrompt(session);
    assert.ok(result.includes('[子智能体]'));
    assert.ok(result.includes('"需要什么格式？"'));
    assert.ok(result.includes('"PDF"'));
  });

  // SP-05: 活跃请求 + 未回答的问题 → 显示"(等待回答)"
  await test('SP-05: 活跃请求 + 未回答问题 → 显示"(等待回答)"', async () => {
    const qa = makeQA({ questionId: 'q3', content: '确认执行？', answer: null });
    const req = makeRequest({ questions: [qa] });
    const session = makeSession({ requests: [req], activeRequestId: 'req-001' });
    const result = buildSessionPrompt(session);
    assert.ok(result.includes('(等待回答)'));
    assert.ok(!result.includes('确认执行？ → ""'));
  });

  // SP-06: 活跃请求 + 任务 → 显示任务信息
  await test('SP-06: 活跃请求 + 任务 → 显示任务信息', async () => {
    const task = makeTask({ taskId: 'task-100', skillName: 'weather-skill', status: 'running' });
    const req = makeRequest({ tasks: [task] });
    const session = makeSession({ requests: [req], activeRequestId: 'req-001' });
    const result = buildSessionPrompt(session);
    assert.ok(result.includes('- 子任务:'));
    assert.ok(result.includes('task-100 [weather-skill] running'));
  });

  // SP-07: 任务包含问题 → 显示任务级别问题
  await test('SP-07: 任务包含问题 → 显示任务级别问题', async () => {
    const taskQA = makeQA({ questionId: 'tq1', content: '任务需要确认吗？', answer: '是的' });
    const task = makeTask({ taskId: 'task-200', questions: [taskQA] });
    const req = makeRequest({ tasks: [task] });
    const session = makeSession({ requests: [req], activeRequestId: 'req-001' });
    const result = buildSessionPrompt(session);
    assert.ok(result.includes('- 询问1: "任务需要确认吗？" → "是的"'));
  });

  // SP-08: 挂起的请求 → 显示"### 挂起的请求"
  await test('SP-08: 挂起的请求 → 显示"### 挂起的请求"', async () => {
    const suspendedReq = makeRequest({
      requestId: 'req-s1', content: '挂起的请求', status: 'suspended',
      suspendedReason: '等待用户确认',
    });
    const session = makeSession({ requests: [suspendedReq], activeRequestId: null });
    const result = buildSessionPrompt(session);
    assert.ok(result.includes('### 挂起的请求'));
    assert.ok(result.includes('- 请求ID: req-s1'));
    assert.ok(result.includes('- 内容: "挂起的请求"'));
    assert.ok(result.includes('- 挂起原因: 等待用户确认'));
  });

  // SP-09: 无活跃请求但有挂起请求 → 仅显示挂起部分
  await test('SP-09: 无活跃请求但有挂起请求 → 仅显示挂起部分', async () => {
    const suspendedReq = makeRequest({
      requestId: 'req-s2', content: '另一个挂起', status: 'suspended',
      suspendedReason: '缺少参数',
    });
    const session = makeSession({ requests: [suspendedReq], activeRequestId: null });
    const result = buildSessionPrompt(session);
    assert.ok(result.includes('## 当前会话状态'));
    assert.ok(result.includes('### 挂起的请求'));
    assert.ok(!result.includes('### 活跃请求'));
  });

  // SP-10: 完整会话（活跃 + 问题 + 任务 + 挂起）→ 所有部分都存在
  await test('SP-10: 完整会话 → 所有部分都存在', async () => {
    const qa = makeQA({ questionId: 'q10', content: '问题1', source: 'main_agent', answer: '回答1' });
    const taskQA = makeQA({ questionId: 'tq10', content: '任务问题1', answer: '任务回答1' });
    const task = makeTask({ taskId: 'task-full', skillName: 'full-skill', status: 'completed', questions: [taskQA] });
    const activeReq = makeRequest({
      requestId: 'req-active', content: '活跃请求内容', status: 'processing',
      questions: [qa], tasks: [task],
    });
    const suspendedReq = makeRequest({
      requestId: 'req-suspended', content: '挂起内容', status: 'suspended',
      suspendedReason: '原因A',
    });
    const session = makeSession({
      requests: [activeReq, suspendedReq],
      activeRequestId: 'req-active',
    });
    const result = buildSessionPrompt(session);
    // header
    assert.ok(result.includes('## 当前会话状态'));
    // 活跃请求
    assert.ok(result.includes('### 活跃请求'));
    assert.ok(result.includes('- 请求ID: req-active'));
    assert.ok(result.includes('- 内容: "活跃请求内容"'));
    // 询问历史
    assert.ok(result.includes('- 询问历史:'));
    assert.ok(result.includes('[主智能体]'));
    // 子任务
    assert.ok(result.includes('- 子任务:'));
    assert.ok(result.includes('task-full [full-skill] completed'));
    // 任务问题
    assert.ok(result.includes('- 询问1: "任务问题1" → "任务回答1"'));
    // 挂起请求
    assert.ok(result.includes('### 挂起的请求'));
    assert.ok(result.includes('- 请求ID: req-suspended'));
    assert.ok(result.includes('- 挂起原因: 原因A'));
  });

  console.log('\n📋 buildTaskContextPrompt 测试\n');

  // SP-11: 任务存在但无问题 → 显示请求信息，无询问历史
  await test('SP-11: 任务存在但无问题 → 显示请求信息，无询问历史', async () => {
    const task = makeTask({ taskId: 'task-t1' });
    const req = makeRequest({ requestId: 'req-t1', content: '请求内容A', tasks: [task] });
    const result = buildTaskContextPrompt(req, 'task-t1');
    assert.ok(result.includes('## 当前任务上下文'));
    assert.ok(result.includes('### 所属请求'));
    assert.ok(result.includes('- 请求ID: req-t1'));
    assert.ok(result.includes('- 请求内容: "请求内容A"'));
    assert.ok(!result.includes('询问历史'));
  });

  // SP-12: 任务存在且有已回答问题 → 显示"询问历史（请勿重复询问）"
  await test('SP-12: 任务存在且有已回答问题 → 显示"询问历史（请勿重复询问）"', async () => {
    const qa = makeQA({ questionId: 'qt1', content: '颜色偏好？', answer: '红色' });
    const task = makeTask({ taskId: 'task-t2', questions: [qa] });
    const req = makeRequest({ tasks: [task] });
    const result = buildTaskContextPrompt(req, 'task-t2');
    assert.ok(result.includes('### 询问历史（请勿重复询问）'));
    assert.ok(result.includes('1. "颜色偏好？" → "红色"'));
  });

  // SP-13: 任务存在且有未回答问题 → 显示"(等待回答)"
  await test('SP-13: 任务存在且有未回答问题 → 显示"(等待回答)"', async () => {
    const qa = makeQA({ questionId: 'qt2', content: '确认删除？', answer: null });
    const task = makeTask({ taskId: 'task-t3', questions: [qa] });
    const req = makeRequest({ tasks: [task] });
    const result = buildTaskContextPrompt(req, 'task-t3');
    assert.ok(result.includes('### 询问历史（请勿重复询问）'));
    assert.ok(result.includes('(等待回答)'));
  });

  // SP-14: 任务未找到（无效 taskId）→ 仅显示请求信息
  await test('SP-14: 任务未找到（无效 taskId）→ 仅显示请求信息', async () => {
    const req = makeRequest({ requestId: 'req-t4', content: '请求内容B', tasks: [] });
    const result = buildTaskContextPrompt(req, 'invalid-task-id');
    assert.ok(result.includes('## 当前任务上下文'));
    assert.ok(result.includes('### 所属请求'));
    assert.ok(result.includes('- 请求ID: req-t4'));
    assert.ok(!result.includes('询问历史'));
  });

  // SP-15: 多个问题 → 编号列表
  await test('SP-15: 多个问题 → 编号列表', async () => {
    const qa1 = makeQA({ questionId: 'm1', content: '问题一', answer: '回答一' });
    const qa2 = makeQA({ questionId: 'm2', content: '问题二', answer: '回答二' });
    const qa3 = makeQA({ questionId: 'm3', content: '问题三', answer: null });
    const task = makeTask({ taskId: 'task-t5', questions: [qa1, qa2, qa3] });
    const req = makeRequest({ tasks: [task] });
    const result = buildTaskContextPrompt(req, 'task-t5');
    assert.ok(result.includes('### 询问历史（请勿重复询问）'));
    assert.ok(result.includes('1. "问题一" → "回答一"'));
    assert.ok(result.includes('2. "问题二" → "回答二"'));
    assert.ok(result.includes('3. "问题三" → "(等待回答)"'));
  });

  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach(e => console.log(e));
  }
}

run().catch(console.error);
