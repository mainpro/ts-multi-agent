import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { ResultAggregator } from '../src/agents/result-aggregator';

describe('ResultAggregator mixed status + transfer hook + B-1 fix', () => {
  const llm = {
    generateStructured: async (prompt: string, schema: any) => {
      // 模拟 LLM 生成含"X 成功, Y 失败"语气的摘要
      const hasFailure = prompt.includes('❌');
      return schema.parse({
        completed: !hasFailure,
        summary: hasFailure ? '合同查询成功,但审批失败。' : '全部成功',
      });
    },
  } as any;
  const memSvc = {
    saveAssistantMessage: async () => {},
    summarizeRequest: async () => {},
  } as any;
  const sessionStore = {
    completeRequest: async () => {},
  } as any;

  it('does NOT add rewriter suffix when some tasks failed (B-1 fix)', async () => {
    const rewriter = {
      match: { status: 'completed' },
      transform: 'append' as const,
      value: '\n\n---\n如有问题请回复「转人工」',
    };
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), rewriter);

    const taskResults = [
      { taskId: 't1', skillName: 'fawu', requirement: '查询', response: 'ok', status: 'completed' },
      { taskId: 't2', skillName: 'fawu', requirement: '审批', response: 'failed', status: 'failed' },
    ];
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(summary.completed).toBe(false);
    expect(summary.summary).not.toContain('如有问题请回复'); // rewriter 不追加
    expect(summary.failedTaskIds).toEqual(['t2']);
  });

  it('adds rewriter suffix when ALL tasks completed (regression)', async () => {
    const rewriter = {
      match: { status: 'completed' },
      transform: 'append' as const,
      value: '\n\n---\n如有问题请回复「转人工」',
    };
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }), rewriter);

    const taskResults = [
      { taskId: 't1', skillName: 'fawu', requirement: '查询', response: 'ok', status: 'completed' },
      { taskId: 't2', skillName: 'fawu', requirement: '审批', response: 'ok', status: 'completed' },
    ];
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(summary.completed).toBe(true);
    expect(summary.summary).toContain('如有问题请回复'); // rewriter 追加
    expect(summary.failedTaskIds).toEqual([]);
  });

  it('transferHook is called when partial failure', async () => {
    let hookCalled = false;
    const transferHook = () => { hookCalled = true; return true; };
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }),
      undefined, transferHook);

    const taskResults = [
      { taskId: 't1', skillName: 's', requirement: 'r', response: 'ok', status: 'completed' },
      { taskId: 't2', skillName: 's', requirement: 'r', response: 'fail', status: 'failed' },
    ];
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(hookCalled).toBe(true);
    expect(summary.transferTriggered).toBe(true);
    expect(summary.summary).toContain('转人工');
  });

  it('transferHook is NOT called when all completed', async () => {
    let hookCalled = false;
    const transferHook = () => { hookCalled = true; return true; };
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }),
      undefined, transferHook);

    const taskResults = [
      { taskId: 't1', skillName: 's', requirement: 'r', response: 'ok', status: 'completed' },
    ];
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(hookCalled).toBe(false);
    expect(summary.transferTriggered).toBe(false);
  });

  it('transferHook default is noop (does not crash without arg)', async () => {
    const agg = new ResultAggregator(llm, memSvc, sessionStore, async () => ({ success: true }));
    const taskResults = [
      { taskId: 't1', skillName: 's', requirement: 'r', response: 'fail', status: 'failed' },
    ];
    // 不应 throw
    const summary = await agg.summarizeResults('原需求', taskResults, 'u1', 's1', {} as any);
    expect(summary.transferTriggered).toBe(false);
  });
});