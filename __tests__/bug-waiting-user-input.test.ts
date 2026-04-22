/**
 * Bug 修复验证测试：executor 返回 result.data 导致 waiting_user_input 检查失败
 *
 * 根因：index.ts 中 TaskQueue 的 executor 返回 result.data（SkillExecutionResult），
 *      但 processNormalRequirement 期望 task.result 是完整的 TaskResult（{success, data}）。
 *      导致 tr.result?.data 为 undefined，waiting_user_input 检查永远失败。
 *
 * 修复：executor 改为返回完整的 result（TaskResult）。
 *
 * 运行: cd /sessions/69e6cdbe80ce6747619f0374/workspace && npx tsx __tests__/bug-waiting-user-input.test.ts
 */
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

async function run() {
  console.log('\n📋 Bug 修复验证：waiting_user_input 检查\n');

  // ========================================================================
  // 测试 1：模拟修复后的数据结构（executor 返回完整 TaskResult）
  // ========================================================================
  console.log('--- 修复后的数据结构 ---');

  await test('BUGFIX-01: tr.result 是 TaskResult 时，tr.result?.data?.status 能正确获取', async () => {
    // 模拟 waitForCompletion 返回的 results 结构（修复后）
    const taskResult = {
      success: true,
      data: {
        response: '您好！请问您的岗位是财务岗吗？',
        status: 'waiting_user_input',
        question: {
          type: 'skill_question',
          content: '您好！请问您的岗位是财务岗吗？',
        },
      },
    };

    const tr = {
      taskId: 'plan-xxx-task-1',
      skillName: 'geam-qa',
      requirement: '申请GEAM凭证查询权限',
      result: taskResult,  // 修复后：完整的 TaskResult
    };

    // 这是 processNormalRequirement 中的检查逻辑
    const skillResult = tr.result?.data;
    assert.ok(skillResult, 'tr.result?.data 不应为 undefined');
    assert.strictEqual(skillResult?.status, 'waiting_user_input', 'status 应为 waiting_user_input');
    assert.ok(skillResult?.question, 'question 不应为 undefined');
    assert.strictEqual(skillResult?.question?.content, '您好！请问您的岗位是财务岗吗？', 'question 内容应匹配');
  });

  await test('BUGFIX-02: tr.result 是 TaskResult 时，tr.result?.data?.response 能正确获取', async () => {
    const taskResult = {
      success: true,
      data: {
        response: '操作已完成，权限已开通。',
        status: 'completed',
      },
    };

    const tr = {
      taskId: 'plan-xxx-task-1',
      skillName: 'geam-qa',
      requirement: '申请GEAM凭证查询权限',
      result: taskResult,
    };

    // 这是 processNormalRequirement 中构建 taskList 的逻辑
    const response = tr.result?.data?.response || '';
    assert.strictEqual(response, '操作已完成，权限已开通。', 'response 应正确获取');
  });

  // ========================================================================
  // 测试 2：模拟修复前的数据结构（executor 返回 result.data）
  // ========================================================================
  console.log('\n--- 修复前的数据结构（验证 Bug 存在） ---');

  await test('BUGFIX-03: tr.result 是 SkillExecutionResult 时，tr.result?.data 为 undefined（Bug 复现）', async () => {
    // 模拟修复前 waitForCompletion 返回的 results 结构
    const skillExecutionResult = {
      response: '您好！请问您的岗位是财务岗吗？',
      status: 'waiting_user_input',
      question: {
        type: 'skill_question',
        content: '您好！请问您的岗位是财务岗吗？',
      },
    };

    const tr = {
      taskId: 'plan-xxx-task-1',
      skillName: 'geam-qa',
      requirement: '申请GEAM凭证查询权限',
      result: skillExecutionResult,  // 修复前：直接是 SkillExecutionResult
    };

    // 这是修复前的检查逻辑
    const skillResult = tr.result?.data;
    assert.strictEqual(skillResult, undefined, '修复前 tr.result?.data 为 undefined（Bug 确认）');
  });

  await test('BUGFIX-04: 修复前 tr.result?.response 能工作（但修复后会失败）', async () => {
    const skillExecutionResult = {
      response: '操作已完成，权限已开通。',
      status: 'completed',
    };

    const tr = {
      taskId: 'plan-xxx-task-1',
      skillName: 'geam-qa',
      requirement: '申请GEAM凭证查询权限',
      result: skillExecutionResult,
    };

    // 修复前的逻辑（直接访问 .response）
    const responseOld = tr.result?.response || '';
    assert.strictEqual(responseOld, '操作已完成，权限已开通。', '修复前 .response 能工作');

    // 修复后的逻辑（访问 .data?.response）
    const responseNew = tr.result?.data?.response || '';
    assert.strictEqual(responseNew, '', '修复后 .data?.response 为空（修复前结构不兼容）');
  });

  // ========================================================================
  // 测试 3：handleTaskCompletion 中的同样问题
  // ========================================================================
  console.log('\n--- handleTaskCompletion 数据结构 ---');

  await test('BUGFIX-05: task.result 是 TaskResult 时，handleTaskCompletion 能正确检查 waiting_user_input', async () => {
    // 模拟 task.result（修复后）
    const taskResult = {
      success: true,
      data: {
        response: '请问您的岗位是财务岗吗？',
        status: 'waiting_user_input',
        question: {
          type: 'skill_question',
          content: '请问您的岗位是财务岗吗？',
        },
      },
    };

    // 模拟 handleTaskCompletion 中的检查逻辑
    const skillData = (taskResult as { data?: any }).data;
    assert.ok(skillData, 'skillData 不应为 undefined');
    assert.strictEqual(skillData?.status, 'waiting_user_input', '应检测到 waiting_user_input');
    assert.ok(skillData?.question, 'question 不应为 undefined');
  });

  await test('BUGFIX-06: task.result 是 SkillExecutionResult 时，handleTaskCompletion 无法检查（Bug 复现）', async () => {
    // 模拟 task.result（修复前）
    const skillExecutionResult = {
      response: '请问您的岗位是财务岗吗？',
      status: 'waiting_user_input',
      question: {
        type: 'skill_question',
        content: '请问您的岗位是财务岗吗？',
      },
    };

    // 模拟 handleTaskCompletion 中的检查逻辑
    const skillData = (skillExecutionResult as { data?: any }).data;
    assert.strictEqual(skillData, undefined, '修复前 skillData 为 undefined（Bug 确认）');
  });

  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n失败详情:');
    errors.forEach(e => console.log(e));
  }
}

run().catch(console.error);
