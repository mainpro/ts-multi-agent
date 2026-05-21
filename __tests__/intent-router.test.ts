/**
 * IntentRouter 单元测试（极简架构版）
 * 
 * 架构：所有输入统一走 LLM 判断
 * 
 * 运行: cd /sessions/6a0e89cba7d17499d8cf4b96/workspace && npx tsx __tests__/intent-router.test.ts
 */
import assert from 'assert';
import { IntentRouter } from '../src/routers/intent-router';

let passed = 0;
let failed = 0;
const errors: string[] = [];

function test(name: string, fn: () => Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e: any) {
      failed++;
      const msg = `  ✗ ${name}: ${e.message}`;
      errors.push(msg);
      console.log(msg);
    }
  })();
}

// ============================================================================
// Mock 对象工厂
// ============================================================================

function createMockLLM(overrides?: {
  generateStructured?: (prompt: any, schema: any, system?: any) => Promise<any>;
}) {
  return {
    generateText: async () => '',
    generateWithTools: async () => ({ response: '', toolCalls: [] }),
    generateWithToolsTracked: async () => ({
      response: '',
      toolCalls: [],
      messages: [],
    }),
    generateStructured: async (prompt: any, schema: any, system?: any) => {
      if (overrides?.generateStructured) {
        return overrides.generateStructured(prompt, schema, system);
      }
      return {
        intent: 'skill_task',
        confidence: 0.8,
        tasks: [{ requirement: '测试任务', skillName: 'test-skill', intent: 'skill_task' }],
      };
    },
  } as any;
}

function createMockSkillRegistry(skills: Array<{
  name: string;
  description: string;
  metadata?: { keywords?: string[]; systemName?: string };
}> = []) {
  return {
    getAllMetadata: () => skills,
    hasSkill: (name: string) => skills.some(s => s.name === name),
    getSkill: (name: string) => skills.find(s => s.name === name),
  } as any;
}

// ============================================================================
// 测试运行
// ============================================================================
async function run() {
  console.log('\nIntentRouter 单元测试（统一 LLM 架构）\n');

  // ========================================================================
  // IR-01: 所有输入统一走 LLM
  // ========================================================================
  await test('IR-01: 问候语应走 LLM 判断', async () => {
    let llmCalled = false;
    const mockLLM = createMockLLM({
      generateStructured: async () => {
        llmCalled = true;
        return {
          intent: 'small_talk',
          confidence: 1.0,
          tasks: [],
          friendlyResponse: '您好！很高兴为您服务。',
        };
      },
    });

    const router = new IntentRouter(mockLLM, createMockSkillRegistry());

    const result = await router.classify('你好');

    assert.strictEqual(llmCalled, true, '问候语应调用 LLM');
    assert.strictEqual(result.intent, 'small_talk');
    assert.ok(result.question?.content.includes('您好') || result.question.content.includes('高兴'));
  });

  await test('IR-01: 时间查询应走 LLM 判断', async () => {
    const mockLLM = createMockLLM({
      generateStructured: async () => ({
        intent: 'small_talk',
        confidence: 1.0,
        tasks: [],
        friendlyResponse: '现在是 2026年5月21日 14:51。',
      }),
    });

    const router = new IntentRouter(mockLLM, createMockSkillRegistry());

    const result = await router.classify('现在几点了');

    assert.strictEqual(result.intent, 'small_talk');
    assert.ok(result.question?.content);
  });

  await test('IR-01: 感谢语应走 LLM 判断', async () => {
    const mockLLM = createMockLLM({
      generateStructured: async () => ({
        intent: 'small_talk',
        confidence: 1.0,
        tasks: [],
        friendlyResponse: '不客气！有需要随时说。',
      }),
    });

    const router = new IntentRouter(mockLLM, createMockSkillRegistry());

    const result = await router.classify('谢谢');

    assert.strictEqual(result.intent, 'small_talk');
  });

  // ========================================================================
  // IR-02: LLM 判断超范围输入
  // ========================================================================
  await test('IR-02: 天气查询应由 LLM 生成友好回复', async () => {
    const mockLLM = createMockLLM({
      generateStructured: async () => ({
        intent: 'unclear',
        confidence: 0.8,
        tasks: [],
        friendlyResponse: '抱歉，我暂时无法查询天气信息哦。我是运维智能助手，主要帮您处理请假、报销等事务。',
      }),
    });

    const router = new IntentRouter(mockLLM, createMockSkillRegistry());

    const result = await router.classify('今天天气怎么样');

    assert.strictEqual(result.intent, 'unclear');
    assert.ok(result.question?.content);
    assert.ok(result.question.content.includes('抱歉') || result.question.content.includes('天气'));
  });

  await test('IR-02: 汇率查询应由 LLM 生成友好回复', async () => {
    const mockLLM = createMockLLM({
      generateStructured: async () => ({
        intent: 'unclear',
        confidence: 0.8,
        tasks: [],
        friendlyResponse: '抱歉，我暂时无法查询汇率信息。',
      }),
    });

    const router = new IntentRouter(mockLLM, createMockSkillRegistry());

    const result = await router.classify('美元汇率是多少');

    assert.strictEqual(result.intent, 'unclear');
    assert.ok(result.question?.content);
  });

  // ========================================================================
  // IR-03: LLM 判断技能匹配
  // ========================================================================
  await test('IR-03: 技能查询应返回 skill_task', async () => {
    const mockLLM = createMockLLM({
      generateStructured: async () => ({
        intent: 'skill_task',
        confidence: 0.9,
        tasks: [{ requirement: '请假', skillName: 'leave-request', intent: 'skill_task' }],
      }),
    });

    const router = new IntentRouter(
      mockLLM,
      createMockSkillRegistry([
        {
          name: 'leave-request',
          description: '请假申请',
          metadata: { keywords: ['请假', '休假'], systemName: '考勤系统' },
        },
      ])
    );

    const result = await router.classify('我要请假');

    assert.strictEqual(result.intent, 'skill_task');
    assert.strictEqual(result.tasks[0]?.skillName, 'leave-request');
  });

  await test('IR-03: LLM 返回的友好回复应正确传递', async () => {
    const mockLLM = createMockLLM({
      generateStructured: async () => ({
        intent: 'unclear',
        confidence: 0.7,
        tasks: [],
        friendlyResponse: '抱歉，我暂时无法帮您查询天气。请试试问我关于请假、报销等问题！',
      }),
    });

    const router = new IntentRouter(mockLLM, createMockSkillRegistry());

    const result = await router.classify('今天会下雨吗');

    assert.strictEqual(result.intent, 'unclear');
    assert.ok(result.question?.content);
    assert.ok(result.question.content.includes('天气') || result.question.content.includes('请假') || result.question.content.includes('报销'));
  });

  // ========================================================================
  // IR-04: 对话历史传递给 LLM
  // ========================================================================
  await test('IR-04: 对话历史应传递给 LLM', async () => {
    let capturedPrompt = '';
    const mockLLM = createMockLLM({
      generateStructured: async (prompt: any) => {
        capturedPrompt = prompt;
        return { intent: 'skill_task', confidence: 0.8, tasks: [] };
      },
    });

    const router = new IntentRouter(mockLLM, createMockSkillRegistry());

    const history = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '您好！' },
      { role: 'user', content: '我要请假' },
    ];

    await router.classify('请假流程是什么', undefined, history);

    assert.ok(capturedPrompt.includes('对话历史'), 'Prompt 应包含对话历史');
    assert.ok(capturedPrompt.includes('请假'), '对话历史应包含请假相关');
  });

  // ========================================================================
  // IR-05: 错误处理
  // ========================================================================
  await test('IR-05: LLM 异常应返回 unclear 并有友好回复', async () => {
    const mockLLM = createMockLLM({
      generateStructured: async () => {
        throw new Error('LLM 服务不可用');
      },
    });

    const router = new IntentRouter(mockLLM, createMockSkillRegistry());

    const result = await router.classify('测试输入');

    assert.strictEqual(result.intent, 'unclear');
    assert.ok(result.question?.content);
    assert.ok(result.question.content.length > 0, '错误时应有友好回复');
  });

  // ========================================================================
  // IR-06: 边界情况
  // ========================================================================
  await test('IR-06: 空输入应走 LLM 判断', async () => {
    let llmCalled = false;
    const mockLLM = createMockLLM({
      generateStructured: async () => {
        llmCalled = true;
        return { intent: 'unclear', confidence: 0.5, tasks: [], friendlyResponse: '请告诉我您需要什么帮助？' };
      },
    });

    const router = new IntentRouter(mockLLM, createMockSkillRegistry());

    const result = await router.classify('');

    assert.strictEqual(llmCalled, true, '空输入应调用 LLM');
    assert.strictEqual(result.intent, 'unclear');
  });

  await test('IR-06: 超长输入应正常处理', async () => {
    const router = new IntentRouter(
      createMockLLM(),
      createMockSkillRegistry()
    );

    const longInput = '我要'.repeat(1000);
    const result = await router.classify(longInput);

    assert.ok(result.intent);
  });

  await test('IR-06: 特殊字符输入应正常处理', async () => {
    const router = new IntentRouter(
      createMockLLM(),
      createMockSkillRegistry()
    );

    const specialInput = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    const result = await router.classify(specialInput);

    assert.ok(result.intent);
  });

  // ========================================================================
  // 测试总结
  // ========================================================================
  console.log(`\n测试完成: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach((e) => console.log(e));
  }
  process.exit(failed > 0 ? 1 : 0);
}

run();
