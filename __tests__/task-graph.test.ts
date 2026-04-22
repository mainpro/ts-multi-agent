import assert from 'assert';
import { TaskPlan, TaskGraph, TaskGraphNode } from '../src/types';

// ============================================================================
// Extract buildTaskGraph logic as standalone function for testing
// (mirrors MainAgent.buildTaskGraph exactly)
// ============================================================================

function buildTaskGraph(plan: TaskPlan): TaskGraph {
  const nodes: TaskGraphNode[] = plan.tasks.map(t => ({
    taskId: `${plan.id}-${t.id}`,
    content: t.requirement,
    skillName: t.skillName,
    dependencies: t.dependencies.map(depId => `${plan.id}-${depId}`),
    params: t.params || {},
  }));

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.taskId, node.dependencies.length);
    dependents.set(node.taskId, []);
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (dependents.has(dep)) {
        dependents.get(dep)!.push(node.taskId);
      }
    }
  }

  const layers: string[][] = [];
  const processed = new Set<string>();

  while (processed.size < nodes.length) {
    const readyNodes = nodes.filter(
      n => !processed.has(n.taskId) && (inDegree.get(n.taskId) || 0) === 0
    );

    if (readyNodes.length === 0) {
      const remaining = nodes.filter(n => !processed.has(n.taskId));
      layers.push(remaining.map(n => n.taskId));
      break;
    }

    layers.push(readyNodes.map(n => n.taskId));

    for (const node of readyNodes) {
      processed.add(node.taskId);
      for (const dep of dependents.get(node.taskId) || []) {
        inDegree.set(dep, (inDegree.get(dep) || 1) - 1);
      }
    }
  }

  return { id: plan.id, requirement: plan.requirement, nodes, layers };
}

// ============================================================================
// Extract resolveParams logic as standalone function for testing
// (mirrors MainAgent.resolveParams exactly)
// ============================================================================

function resolveParams(
  params: Record<string, unknown> | undefined,
  completedResults: Map<string, any>,
): Record<string, unknown> {
  if (!params) return {};

  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.startsWith('$')) {
      const match = value.match(/^\$([^.]+)\.result(?:\.(.+))?$/);
      if (match) {
        const refTaskId = match[1];
        const field = match[2];
        const refResult = completedResults.get(refTaskId);
        if (refResult !== undefined) {
          const data = (refResult as any)?.data || refResult;
          if (field) {
            resolved[key] = field.split('.').reduce((obj: any, f: string) => obj?.[f], data);
          } else {
            resolved[key] = typeof data === 'string' ? data : JSON.stringify(data);
          }
        } else {
          resolved[key] = value;
        }
      } else {
        resolved[key] = value;
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// ============================================================================
// Test harness
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

async function run() {
  console.log('\n🧪 buildTaskGraph & resolveParams 单元测试\n');

  // ========================================================================
  // buildTaskGraph tests (TG-01 ~ TG-07)
  // ========================================================================

  // TG-01: Single task with no dependencies → 1 layer with 1 task
  await test('TG-01: 单任务无依赖 → 1层1任务', async () => {
    const plan: TaskPlan = {
      id: 'plan-1',
      requirement: 'test',
      tasks: [
        { id: 'task-1', requirement: 'do something', skillName: 'skill-a', dependencies: [] },
      ],
    };
    const graph = buildTaskGraph(plan);
    assert.strictEqual(graph.layers.length, 1, 'should have 1 layer');
    assert.strictEqual(graph.layers[0].length, 1, 'layer 0 should have 1 task');
    assert.strictEqual(graph.layers[0][0], 'plan-1-task-1', 'task id should match');
    assert.strictEqual(graph.nodes.length, 1, 'should have 1 node');
  });

  // TG-02: Two independent tasks → 1 layer with 2 tasks (parallel)
  await test('TG-02: 两个独立任务 → 1层2任务（并行）', async () => {
    const plan: TaskPlan = {
      id: 'plan-2',
      requirement: 'test',
      tasks: [
        { id: 'task-1', requirement: 'task a', skillName: 'skill-a', dependencies: [] },
        { id: 'task-2', requirement: 'task b', skillName: 'skill-b', dependencies: [] },
      ],
    };
    const graph = buildTaskGraph(plan);
    assert.strictEqual(graph.layers.length, 1, 'should have 1 layer');
    assert.strictEqual(graph.layers[0].length, 2, 'layer 0 should have 2 tasks');
    assert.strictEqual(graph.nodes.length, 2, 'should have 2 nodes');
  });

  // TG-03: Two sequential tasks (task-2 depends on task-1) → 2 layers
  await test('TG-03: 两个顺序任务 → 2层', async () => {
    const plan: TaskPlan = {
      id: 'plan-3',
      requirement: 'test',
      tasks: [
        { id: 'task-1', requirement: 'first', skillName: 'skill-a', dependencies: [] },
        { id: 'task-2', requirement: 'second', skillName: 'skill-b', dependencies: ['task-1'] },
      ],
    };
    const graph = buildTaskGraph(plan);
    assert.strictEqual(graph.layers.length, 2, 'should have 2 layers');
    assert.strictEqual(graph.layers[0].length, 1, 'layer 0 should have 1 task');
    assert.strictEqual(graph.layers[0][0], 'plan-3-task-1', 'layer 0 should be task-1');
    assert.strictEqual(graph.layers[1].length, 1, 'layer 1 should have 1 task');
    assert.strictEqual(graph.layers[1][0], 'plan-3-task-2', 'layer 1 should be task-2');
  });

  // TG-04: Complex graph (task-3 depends on task-1 and task-2, task-1 and task-2 independent)
  //        → 2 layers: [t1, t2], [t3]
  await test('TG-04: 菱形依赖 → 2层 [t1,t2], [t3]', async () => {
    const plan: TaskPlan = {
      id: 'plan-4',
      requirement: 'test',
      tasks: [
        { id: 'task-1', requirement: 'a', skillName: 'skill-a', dependencies: [] },
        { id: 'task-2', requirement: 'b', skillName: 'skill-b', dependencies: [] },
        { id: 'task-3', requirement: 'c', skillName: 'skill-c', dependencies: ['task-1', 'task-2'] },
      ],
    };
    const graph = buildTaskGraph(plan);
    assert.strictEqual(graph.layers.length, 2, 'should have 2 layers');
    assert.strictEqual(graph.layers[0].length, 2, 'layer 0 should have 2 tasks');
    assert.strictEqual(graph.layers[1].length, 1, 'layer 1 should have 1 task');
    assert.strictEqual(graph.layers[1][0], 'plan-4-task-3', 'layer 1 should be task-3');
  });

  // TG-05: Linear chain (t1 → t2 → t3) → 3 layers
  await test('TG-05: 线性链 t1→t2→t3 → 3层', async () => {
    const plan: TaskPlan = {
      id: 'plan-5',
      requirement: 'test',
      tasks: [
        { id: 'task-1', requirement: 'a', skillName: 'skill-a', dependencies: [] },
        { id: 'task-2', requirement: 'b', skillName: 'skill-b', dependencies: ['task-1'] },
        { id: 'task-3', requirement: 'c', skillName: 'skill-c', dependencies: ['task-2'] },
      ],
    };
    const graph = buildTaskGraph(plan);
    assert.strictEqual(graph.layers.length, 3, 'should have 3 layers');
    assert.strictEqual(graph.layers[0][0], 'plan-5-task-1');
    assert.strictEqual(graph.layers[1][0], 'plan-5-task-2');
    assert.strictEqual(graph.layers[2][0], 'plan-5-task-3');
  });

  // TG-06: Empty plan → 0 layers
  await test('TG-06: 空计划 → 0层', async () => {
    const plan: TaskPlan = {
      id: 'plan-6',
      requirement: 'test',
      tasks: [],
    };
    const graph = buildTaskGraph(plan);
    assert.strictEqual(graph.layers.length, 0, 'should have 0 layers');
    assert.strictEqual(graph.nodes.length, 0, 'should have 0 nodes');
  });

  // TG-07: Circular dependency → all remaining tasks in one layer (fallback)
  await test('TG-07: 循环依赖 → 剩余任务放入同一层', async () => {
    const plan: TaskPlan = {
      id: 'plan-7',
      requirement: 'test',
      tasks: [
        { id: 'task-1', requirement: 'a', skillName: 'skill-a', dependencies: ['task-2'] },
        { id: 'task-2', requirement: 'b', skillName: 'skill-b', dependencies: ['task-1'] },
      ],
    };
    const graph = buildTaskGraph(plan);
    // Both tasks have in-degree 1, so no ready node → fallback puts all in one layer
    assert.strictEqual(graph.layers.length, 1, 'should have 1 layer (fallback)');
    assert.strictEqual(graph.layers[0].length, 2, 'fallback layer should contain both tasks');
    const layerSet = new Set(graph.layers[0]);
    assert.ok(layerSet.has('plan-7-task-1'), 'should contain task-1');
    assert.ok(layerSet.has('plan-7-task-2'), 'should contain task-2');
  });

  // ========================================================================
  // resolveParams tests (RP-01 ~ RP-05)
  // ========================================================================

  // RP-01: No params → empty object
  await test('RP-01: 无参数 → 空对象', async () => {
    const result = resolveParams(undefined, new Map());
    assert.deepStrictEqual(result, {}, 'should return empty object');
  });

  // RP-02: No references (plain values) → returned as-is
  await test('RP-02: 纯值参数 → 原样返回', async () => {
    const params = { name: 'hello', count: 42, flag: true };
    const result = resolveParams(params, new Map());
    assert.strictEqual(result.name, 'hello');
    assert.strictEqual(result.count, 42);
    assert.strictEqual(result.flag, true);
  });

  // RP-03: $taskId.result reference → replaced with actual result data
  await test('RP-03: $taskId.result 引用 → 替换为实际结果', async () => {
    const completedResults = new Map<string, any>();
    completedResults.set('plan-1-task-1', {
      data: { response: 'task completed successfully' },
    });

    const params = { summary: '$plan-1-task-1.result' };
    const result = resolveParams(params, completedResults);
    assert.strictEqual(result.summary, '{"response":"task completed successfully"}');
  });

  // RP-04: $taskId.result.field nested reference → replaced with nested field
  await test('RP-04: $taskId.result.field 嵌套引用 → 替换为嵌套字段', async () => {
    const completedResults = new Map<string, any>();
    completedResults.set('plan-1-task-1', {
      data: { response: 'done', items: [{ name: 'alpha' }, { name: 'beta' }] },
    });

    const params = { response: '$plan-1-task-1.result.response' };
    const result = resolveParams(params, completedResults);
    assert.strictEqual(result.response, 'done');

    // Also test deep nested field
    const params2 = { firstName: '$plan-1-task-1.result.items.0.name' };
    const result2 = resolveParams(params2, completedResults);
    assert.strictEqual(result2.firstName, 'alpha');
  });

  // RP-05: Reference to non-existent task → original reference preserved
  await test('RP-05: 引用不存在的任务 → 保留原始引用', async () => {
    const completedResults = new Map<string, any>();
    // No results added

    const params = { data: '$plan-99-task-1.result' };
    const result = resolveParams(params, completedResults);
    assert.strictEqual(result.data, '$plan-99-task-1.result', 'should preserve original reference');
  });

  // ========================================================================
  // Summary
  // ========================================================================

  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  if (errors.length > 0) {
    console.log('\n错误详情:');
    for (const err of errors) {
      console.log(err);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

// ============================================================================
// Bootstrap
// ============================================================================

(async () => {
  try { await (await import('fs')).promises.rm('data', { recursive: true }); } catch {}
  run().catch(console.error);
})();
