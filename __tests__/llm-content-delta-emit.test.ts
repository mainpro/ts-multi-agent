/**
 * LLM 流式 content delta 透传测试
 *
 * 覆盖:
 *  - readSSEStream 收到 emitContent: true 时,content 增量 emit 到 llmEvents
 *  - emitContent: false(或不传)时,content 不 emit(避免污染 SubAgent)
 *  - emitContent: true 时,reasoning 仍正常 emit
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 把字符串编码成 SSE 字节流
 */
function sseChunks(events: Array<{ reasoning?: string; content?: string }>): Uint8Array {
  const lines: string[] = [];
  for (const ev of events) {
    const delta: any = {};
    if (ev.reasoning !== undefined) delta.reasoning_content = ev.reasoning;
    if (ev.content !== undefined) delta.content = ev.content;
    const chunk = { choices: [{ delta }] };
    lines.push(`data: ${JSON.stringify(chunk)}`);
    lines.push('');
  }
  lines.push('data: [DONE]');
  lines.push('');
  lines.push('');
  return new TextEncoder().encode(lines.join('\n'));
}

class MockReader {
  private chunks: Uint8Array[];
  private pos = 0;
  constructor(text: Uint8Array) { this.chunks = [text]; }
  async read(): Promise<{ done: boolean; value?: Uint8Array }> {
    if (this.pos >= this.chunks.length) return { done: true };
    const v = this.chunks[this.pos++];
    return { done: false, value: v };
  }
  releaseLock() { /* noop */ }
  cancel() { return Promise.resolve(); }
}

class MockResponse {
  body = {
    getReader: () => new MockReader((this as any)._data),
  };
  constructor(public _data: Uint8Array) {}
  // readSSEStream 不需要其他 Response 字段
}

describe('LLM 流式 content delta 透传', () => {
  let LLMClient: any;
  let llmEvents: any;

  beforeEach(async () => {
    const mod = await import('../src/llm');
    LLMClient = mod.LLMClient;
    llmEvents = mod.llmEvents;
  });

  test('emitContent: true → content 增量通过 llmEvents 转发', async () => {
    const client = new LLMClient({ apiKey: 'fake' });
    const data = sseChunks([
      { content: '用户想' },
      { content: '查 GEAM 权限' },
      { content: '需要先' },
      { content: '确认身份' },
    ]);
    const captured: string[] = [];
    const listener = (d: any) => {
      const c = typeof d === 'string' ? d : d.content;
      captured.push(c);
    };
    llmEvents.on('reasoning', listener);
    try {
      const result = await (client as any).readSSEStream(new MockResponse(data) as any, undefined, { emitContent: true });
      expect(result.content).toBe('用户想查 GEAM 权限需要先确认身份');
      // content 增量已通过 llmEvents 透传
      expect(captured.join('')).toBe('用户想查 GEAM 权限需要先确认身份');
    } finally {
      llmEvents.off('reasoning', listener);
    }
  });

  test('默认(emitContent 不传)→ content 增量不 emit(避免污染 SubAgent 路径)', async () => {
    const client = new LLMClient({ apiKey: 'fake' });
    const data = sseChunks([
      { content: '不' },
      { content: '应' },
      { content: '该' },
      { content: '透' },
      { content: '传' },
    ]);
    const captured: string[] = [];
    const listener = (d: any) => {
      const c = typeof d === 'string' ? d : d.content;
      captured.push(c);
    };
    llmEvents.on('reasoning', listener);
    try {
      const result = await (client as any).readSSEStream(new MockResponse(data) as any);
      // content 已正常累加到返回结果(供调用方解析 JSON)
      expect(result.content).toBe('不应该透传');
      // 但 content 增量没有通过 llmEvents 透传
      // (reasoning 也没传,所以 captured 应该为空)
      expect(captured).toEqual([]);
    } finally {
      llmEvents.off('reasoning', listener);
    }
  });

  test('emitContent: true → reasoning 增量也正常 emit', async () => {
    const client = new LLMClient({ apiKey: 'fake' });
    const data = sseChunks([
      { reasoning: '思考-1' },
      { content: '回答-1' },
      { reasoning: '思考-2' },
      { content: '回答-2' },
    ]);
    const captured: string[] = [];
    const listener = (d: any) => {
      const c = typeof d === 'string' ? d : d.content;
      captured.push(c);
    };
    llmEvents.on('reasoning', listener);
    try {
      await (client as any).readSSEStream(new MockResponse(data) as any, undefined, { emitContent: true });
      // reasoning 和 content 全部按顺序 emit
      expect(captured).toEqual(['思考-1', '回答-1', '思考-2', '回答-2']);
    } finally {
      llmEvents.off('reasoning', listener);
    }
  });
});
