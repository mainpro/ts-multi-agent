/**
 * Sandbox 单元测试（9 个用例）
 * 运行: cd /sessions/69eed61294ec0f175d15a39c/workspace && npx tsx __tests__/sandbox.test.ts
 */
import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { Sandbox } from '../src/security/sandbox';

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

// ============================================================================
// 可用性检测测试
// ============================================================================
async function testAvailability() {
  await test('bwrap 可用性检测应返回布尔值', () => {
    const result = Sandbox.isBwrapAvailable();
    assert.strictEqual(typeof result, 'boolean');
    console.log(`    (bwrap ${result ? '可用' : '不可用'})`);
  });
}

// ============================================================================
// 执行测试
// ============================================================================
async function testExecution() {
  // 当 bwrap 不可用时，所有命令应被拒绝（安全策略）
  if (!Sandbox.isBwrapAvailable()) {
    await test('bwrap 不可用时命令应被拒绝', async () => {
      const result = await Sandbox.execute('echo hello', os.tmpdir());
      assert.strictEqual(result.exitCode, 126);
      assert.strictEqual(result.sandboxed, false);
      assert.ok(result.stderr.includes('Sandbox unavailable'));
    });

    await test('bwrap 不可用时 stderr 应包含安全提示', async () => {
      const result = await Sandbox.execute('echo error >&2', os.tmpdir());
      assert.strictEqual(result.exitCode, 126);
      assert.ok(result.stderr.includes('refused for security'));
    });

    await test('bwrap 不可用时失败命令也应返回 126', async () => {
      const result = await Sandbox.execute('exit 42', os.tmpdir());
      assert.strictEqual(result.exitCode, 126);
    });

    await test('bwrap 不可用时超时命令应立即拒绝', async () => {
      const start = Date.now();
      const result = await Sandbox.execute('sleep 30', os.tmpdir(), { timeout: 1000 });
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 1000, `拒绝应立即返回，实际耗时 ${elapsed}ms`);
      assert.strictEqual(result.exitCode, 126);
    });

    await test('bwrap 不可用时环境变量不应传递', async () => {
      const result = await Sandbox.execute('echo $TEST_SANDBOX_VAR', os.tmpdir(), {
        env: { TEST_SANDBOX_VAR: 'sandbox_value' },
      });
      assert.strictEqual(result.exitCode, 126);
      assert.ok(!result.stdout.includes('sandbox_value'));
    });

    await test('bwrap 不可用时 network 测试跳过', () => {
      console.log('    (跳过：bwrap 不可用)');
    });
    return;
  }

  await test('简单 echo 命令应正确返回 stdout', async () => {
    const result = await Sandbox.execute('echo hello', os.tmpdir());
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello'));
  });

  await test('stderr 应正确捕获', async () => {
    const result = await Sandbox.execute('echo error >&2', os.tmpdir());
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stderr.includes('error'));
  });

  await test('失败命令应返回非零 exitCode', async () => {
    const result = await Sandbox.execute('exit 42', os.tmpdir());
    assert.ok(result.exitCode !== 0, `exitCode 应为非零，实际为 ${result.exitCode}`);
  });

  await test('超时命令应在 timeout 内终止', async () => {
    const start = Date.now();
    const result = await Sandbox.execute('sleep 30', os.tmpdir(), { timeout: 1000 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `超时命令应在 5 秒内终止，实际耗时 ${elapsed}ms`);
    assert.ok(result.exitCode !== 0, `exitCode 应为非零，实际为 ${result.exitCode}`);
  });

  await test('环境变量应正确传递', async () => {
    const result = await Sandbox.execute('echo $TEST_SANDBOX_VAR', os.tmpdir(), {
      env: { TEST_SANDBOX_VAR: 'sandbox_value' },
    });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('sandbox_value'));
  });

  await test('不传 network 参数应默认禁用网络', async () => {
    const result = await Sandbox.execute('curl -s --connect-timeout 2 http://example.com || echo "no-network"', os.tmpdir(), {
      timeout: 5000,
    });
    assert.ok(result.stdout.includes('no-network') || result.exitCode !== 0);
  });
}

// ============================================================================
// 运行所有测试
// ============================================================================
async function main() {
  console.log('\n=== Sandbox 单元测试 ===\n');

  console.log('--- 可用性检测 ---');
  await testAvailability();

  console.log('\n--- 执行测试 ---');
  await testExecution();

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
  if (errors.length > 0) {
    console.log('失败详情:');
    errors.forEach(e => console.log(e));
    process.exit(1);
  }
}

main().catch(e => {
  console.error('测试运行失败:', e);
  process.exit(1);
});
