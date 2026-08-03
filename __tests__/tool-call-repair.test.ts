/**
 * Tool-call-repair 测试
 *
 * 覆盖三种 grammar(bracket / Harmony / XML-ish)反向提升为原生 tool_calls,
 * 以及统一入口 repairToolCalls 的 fallback 行为和稳定性。
 *
 * 参考:OpenClaw packages/tool-call-repair/src/promote.ts
 */
import { describe, test, expect } from 'bun:test';
import {
  repairToolCalls,
  tryParseBracketTag,
  tryParseHarmony,
  tryParseXml,
} from '../src/llm/tool-call-repair';

describe('tryParseBracketTag', () => {
  test('解析单个 [tool:name]...[/tool]', () => {
    const text = `[tool:read_file]
{"path":"/a/b.txt"}
[/read_file]`;
    const result = tryParseBracketTag(text);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].function.name).toBe('read_file');
    expect(result![0].id.startsWith('repair-bracket-')).toBe(true);
    expect(JSON.parse(result![0].function.arguments)).toEqual({ path: '/a/b.txt' });
  });

  test('闭合标签名由反向引用匹配(不是固定 [/tool])', () => {
    const text = `[tool:write_file]
{"p":1}
[/write_file]`;
    const result = tryParseBracketTag(text);
    expect(result).not.toBeNull();
    expect(result![0].function.name).toBe('write_file');
  });

  test('参数 JSON 解析失败时退化为空对象', () => {
    const text = `[tool:foo]
not valid json
[/foo]`;
    const result = tryParseBracketTag(text);
    expect(result).not.toBeNull();
    expect(result![0].function.name).toBe('foo');
    expect(result![0].function.arguments).toBe('{}');
  });

  test('无任何 bracket tag → null', () => {
    expect(tryParseBracketTag('just plain text')).toBeNull();
  });
});

describe('tryParseHarmony', () => {
  test('解析单个 <|channel|>commentary to=NAME<|message|>ARGS<|call|>', () => {
    const text = `<|channel|>commentary to=bash<|message|>{"cmd":"ls"}<|call|>`;
    const result = tryParseHarmony(text);
    expect(result).not.toBeNull();
    expect(result![0].function.name).toBe('bash');
    expect(result![0].id.startsWith('repair-harmony-')).toBe(true);
    expect(JSON.parse(result![0].function.arguments)).toEqual({ cmd: 'ls' });
  });

  test('无 harmony token → null', () => {
    expect(tryParseHarmony('hello world')).toBeNull();
  });
});

describe('tryParseXml', () => {
  test('解析多个 <parameter=KEY>VALUE</parameter> → 合成一个 read 调用', () => {
    const text = `<parameter=file_path>/x.txt</parameter>
<parameter=limit>10</parameter>`;
    const result = tryParseXml(text);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].function.name).toBe('read');
    expect(JSON.parse(result![0].function.arguments)).toEqual({
      file_path: '/x.txt',
      limit: '10',
    });
  });

  test('无 parameter 标签 → null', () => {
    expect(tryParseXml('plain content')).toBeNull();
  });
});

describe('repairToolCalls (统一入口)', () => {
  test('已有合法 tool_calls → 原样返回, repaired=false', () => {
    const original = [{
      id: 'tc-1',
      type: 'function' as const,
      function: { name: 'foo', arguments: '{"a":1}' },
    }];
    const out = repairToolCalls({ content: 'hi', tool_calls: original });
    expect(out.repaired).toBe(false);
    expect(out.stopReason).toBe('toolUse');
    expect(out.tool_calls).toEqual(original);
  });

  test('bracket grammar 触发修复, 文本中残留非 grammar 内容', () => {
    const out = repairToolCalls({
      content: '先看下文件 [tool:read_file]\n{"path":"/x"}\n[/read_file] 然后继续',
    });
    expect(out.repaired).toBe(true);
    expect(out.stopReason).toBe('toolUse');
    expect(out.tool_calls.length).toBe(1);
    expect(out.tool_calls[0].function.name).toBe('read_file');
    // 残留文本不应再带 [tool:...] 标签
    expect(out.content).not.toContain('[tool:');
  });

  test('无法识别 grammar → endTurn, repaired=false', () => {
    const out = repairToolCalls({ content: 'just talking, no tools' });
    expect(out.stopReason).toBe('endTurn');
    expect(out.tool_calls).toEqual([]);
    expect(out.repaired).toBe(false);
    expect(out.content).toBe('just talking, no tools');
  });

  test('ID 稳定性:同一输入产生同一 ID', () => {
    const text = `[tool:read_file]
{"path":"/y"}
[/read_file]`;
    const a = repairToolCalls({ content: text });
    const b = repairToolCalls({ content: text });
    expect(a.tool_calls[0].id).toBe(b.tool_calls[0].id);
  });

  test('grammar 优先级: bracket > harmony > xml', () => {
    const text = `[tool:foo]
{}
[/foo]
<|channel|>commentary to=bar<|message|>{}<|call|>`;
    const out = repairToolCalls({ content: text });
    expect(out.tool_calls[0].function.name).toBe('foo');
  });
});
