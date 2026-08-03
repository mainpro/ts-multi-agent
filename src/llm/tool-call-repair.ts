/**
 * Tool-call-repair
 *
 * 把 LLM 自由文本里"乱写"的工具调用反向提升为原生 tool_calls。
 *
 * 当某些模型不愿 / 不能输出原生 OpenAI 风格 tool_calls 时,会在 content 里
 * 写出三种常见的伪 grammar:
 *   - bracket:  [tool:NAME]{args}[/NAME]
 *   - Harmony:  <|channel|>commentary to=NAME<|message|>ARGS<|call|>
 *   - XML-ish:  <parameter=KEY>VALUE</parameter> 多个键
 *
 * 本模块在拿到 response.message 没有合法 tool_calls 时,依次尝试这三种解析,
 * 命中就抽出 tool_calls 并从 content 里剥掉 grammar 标记;不命中时原样返回。
 *
 * 参考 OpenClaw: packages/tool-call-repair/src/promote.ts
 *
 * 暴露:
 *   - tryParseBracketTag / tryParseHarmony / tryParseXml  (单 grammar 解析)
 *   - repairToolCalls                                   (统一入口)
 */

/** 提升后的工具调用,结构与 OpenAI tool_calls 对齐 */
export interface RepairedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** repairToolCalls 输入 */
export interface RepairInput {
  /** 模型原始 content */
  content: string | null;
  /** 模型原始 tool_calls(若已存在则无需修复) */
  tool_calls?: RepairedToolCall[];
}

/** repairToolCalls 输出 */
export interface RepairOutput {
  /** 修复后保留的文本内容(已剥掉 grammar 标记) */
  content: string;
  /** 修复后得到的 tool_calls */
  tool_calls: RepairedToolCall[];
  /** 推断的 stop reason */
  stopReason: 'toolUse' | 'endTurn';
  /** 是否触发过修复(便于上层打日志 / 上报) */
  repaired: boolean;
}

/** 32 位 djb2-like 字符串 hash,截取 16 字符 base36,用于 ID 稳定性 */
function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 16);
}

/**
 * 解析 bracket grammar: [tool:NAME]...[/NAME]
 *
 * 闭合标签用反向引用 \1 匹配同名,而不是固定的 [/tool],这样可以兼容
 * `[tool:write_file]...[/write_file]` 等写法。
 */
export function tryParseBracketTag(text: string): RepairedToolCall[] | null {
  const re = /\[tool:([a-zA-Z_][a-zA-Z0-9_]*)\]\s*([\s\S]*?)\s*\[\/\1\]/g;
  const matches: RepairedToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const rawArgs = m[2];
    let args: unknown = {};
    try {
      args = JSON.parse(rawArgs.trim());
    } catch {
      /* 参数不是合法 JSON 时退化为空对象 */
    }
    matches.push({
      id: `repair-bracket-${hashString(name + rawArgs)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return matches.length > 0 ? matches : null;
}

/**
 * 解析 Harmony grammar: <|channel|>commentary to=NAME<|message|>ARGS<|call|>
 */
export function tryParseHarmony(text: string): RepairedToolCall[] | null {
  const re = /<\|channel\|>commentary to=([a-zA-Z_][a-zA-Z0-9_]*)<\|message\|>([\s\S]*?)<\|call\|>/g;
  const matches: RepairedToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const rawArgs = m[2];
    let args: unknown = {};
    try {
      args = JSON.parse(rawArgs.trim());
    } catch {
      /* 参数不是合法 JSON 时退化为空对象 */
    }
    matches.push({
      id: `repair-harmony-${hashString(name + rawArgs)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return matches.length > 0 ? matches : null;
}

/**
 * 解析 XML-ish grammar: 多个 <parameter=KEY>VALUE</parameter>
 *
 * 此格式通常不附带显式工具名,而是把参数拼成一个 read 调用(read 是这类
 * 表达最常见的用途)。若不希望猜测 toolName,可改为始终返回 null。
 */
export function tryParseXml(text: string): RepairedToolCall[] | null {
  const paramRe = /<parameter=([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/parameter>/g;
  const params: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(text)) !== null) {
    params[m[1]] = m[2].trim();
  }
  if (Object.keys(params).length === 0) return null;
  return [
    {
      id: `repair-xml-${hashString(JSON.stringify(params))}`,
      type: 'function',
      function: {
        name: 'read',
        arguments: JSON.stringify(params),
      },
    },
  ];
}

/**
 * 统一入口
 *
 * 1. 已有合法 tool_calls → 原样返回 (repaired=false)
 * 2. 否则按 bracket → harmony → xml 顺序尝试
 * 3. 命中则把 grammar 从 content 里剥掉,返回 (repaired=true)
 * 4. 未命中则原 content 返回 (stopReason=endTurn)
 */
export function repairToolCalls(input: RepairInput): RepairOutput {
  if (input.tool_calls && input.tool_calls.length > 0) {
    return {
      content: input.content || '',
      tool_calls: input.tool_calls,
      stopReason: 'toolUse',
      repaired: false,
    };
  }

  const text = input.content || '';

  let repaired: RepairedToolCall[] | null = null;
  for (const parser of [tryParseBracketTag, tryParseHarmony, tryParseXml]) {
    repaired = parser(text);
    if (repaired) break;
  }

  if (!repaired) {
    return {
      content: text,
      tool_calls: [],
      stopReason: 'endTurn',
      repaired: false,
    };
  }

  // 移除 grammar 标记,残留作为 content(剥除顺序与解析顺序无关,各自独立)
  const content = text
    .replace(/\[tool:[a-zA-Z_][a-zA-Z0-9_]*\][\s\S]*?\[\/[a-zA-Z_][a-zA-Z0-9_]*\]/g, '')
    .replace(/<\|channel\|>commentary to=[a-zA-Z_][a-zA-Z0-9_]*<\|message\|>[\s\S]*?<\|call\|>/g, '')
    .replace(/<parameter=[a-zA-Z_][a-zA-Z0-9_]*>[\s\S]*?<\/parameter>/g, '')
    .trim();

  return {
    content,
    tool_calls: repaired,
    stopReason: 'toolUse',
    repaired: true,
  };
}
