/**
 * detectQuestion + classifyError 测试（13 个用例）
 * 运行: npx tsx __tests__/sub-agent-unit.test.ts
 */
import { detectQuestion } from '../src/agents/sub-agent';
import assert from 'assert';

let passed = 0;
let failed = 0;
const errors: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e: any) {
    failed++;
    const msg = `  ❌ ${name}: ${e.message}`;
    errors.push(msg);
    console.log(msg);
  }
}

async function run() {
  console.log('\n📋 detectQuestion 测试\n');
  console.log('--- 基础检测 ---');

  test('DQ-01: 空字符串 → null', () => {
    assert.strictEqual(detectQuestion(''), null);
    assert.strictEqual(detectQuestion(''), null);
  });

  test('DQ-02: 结论性语句 "操作已完成" → null', () => {
    assert.strictEqual(detectQuestion('操作已完成，请稍后查看'), null);
  });

  test('DQ-03: 结论性语句 "已成功处理" → null', () => {
    assert.strictEqual(detectQuestion('已成功处理您的请求'), null);
  });

  console.log('\n--- 真正的提问 ---');

  test('DQ-04: "请选择您要的系统" → 返回 content', () => {
    const result = detectQuestion('请选择您要的系统：\n1. EES\n2. BCC');
    assert.ok(result !== null);
    assert.ok(result!.content.includes('请选择'));
  });

  test('DQ-05: "请问您的岗位是财务岗吗？" → 返回 content', () => {
    const result = detectQuestion('请问您的岗位是财务岗吗？');
    assert.ok(result !== null);
    assert.ok(result!.content.includes('请问'));
  });

  console.log('\n--- 上下文判断 ---');

  test('DQ-06: 查询结果展示（非提问）→ null', () => {
    const result = detectQuestion(
      '查询到3条记录，以下是结果：\n1. 记录A\n2. 记录B',
      [{ name: 'conversation-get', result: '3 records' }]
    );
    assert.strictEqual(result, null);
  });

  test('DQ-07: 查询结果 + 问号（是提问）→ 返回 content', () => {
    const result = detectQuestion(
      '查询到3条记录，请问您需要哪个？',
      [{ name: 'conversation-get', result: '3 records' }]
    );
    assert.ok(result !== null);
  });

  test('DQ-08: 无 toolCallResults 的提问 → 返回 content', () => {
    const result = detectQuestion('请确认是否继续执行此操作');
    assert.ok(result !== null);
  });

  console.log('\n📋 classifyError 测试\n');

  // classifyError 是私有方法，通过反射测试
  const { SubAgent } = await import('../src/agents/sub-agent');
  const { SkillRegistry } = await import('../src/skill-registry');

  // 创建一个 SubAgent 实例来访问 classifyError
  // 由于构造函数需要参数，我们用 any 绕过
  const mockLLM = { generateText: async () => '', generateWithTools: async () => ({ content: '', toolCalls: [] }), generateWithToolsTracked: async () => ({ content: '', toolCalls: [], messages: [] }), generateStructured: async () => ({}) };
  const mockRegistry = new SkillRegistry();
  const agent = new SubAgent(mockRegistry as any, mockLLM as any);
  const classifyError = (agent as any).classifyError.bind(agent);

  test('SA-07: 超时错误 → RETRYABLE/TIMEOUT', () => {
    const err = classifyError(new Error('request timeout'));
    assert.strictEqual(err.type, 'RETRYABLE');
    assert.strictEqual(err.code, 'TIMEOUT');
  });

  test('SA-08: 文件不存在 → FATAL/FILE_NOT_FOUND', () => {
    const err = classifyError(new Error('file not found: /tmp/test'));
    assert.strictEqual(err.type, 'FATAL');
    assert.strictEqual(err.code, 'FILE_NOT_FOUND');
  });

  test('SA-09: 权限错误 → FATAL/PERMISSION_DENIED', () => {
    const err = classifyError(new Error('permission denied'));
    assert.strictEqual(err.type, 'FATAL');
    assert.strictEqual(err.code, 'PERMISSION_DENIED');
  });

  test('SA-10: 其他错误 → RETRYABLE/EXECUTION_ERROR', () => {
    const err = classifyError(new Error('something went wrong'));
    assert.strictEqual(err.type, 'RETRYABLE');
    assert.strictEqual(err.code, 'EXECUTION_ERROR');
  });

  test('SA-11: 非 Error 类型 → RETRYABLE/UNKNOWN_ERROR', () => {
    const err = classifyError('string error');
    assert.strictEqual(err.type, 'RETRYABLE');
    assert.strictEqual(err.code, 'UNKNOWN_ERROR');
  });

  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach(e => console.log(e));
  }
}

run().catch(console.error);
