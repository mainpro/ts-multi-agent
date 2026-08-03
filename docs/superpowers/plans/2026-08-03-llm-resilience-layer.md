# LLM 韧性工程层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 在 ts-multi-agent 中实现 4 个 LLM 韧性机制,把模型抖动当可恢复故障,而不依赖重试或抛错。

**Architecture**: 每个机制独立模块,接入现有 LLM 调用栈的 4 个不同位置。tool-call-repair 拦截 `makeToolRequestStream` 的原始 message;safe compaction 由 SubAgent 在 `CONTEXT_TOO_LONG` 后调用;unknown-tool guard 在 SubAgent 工具循环内 per-taskId 跟踪;steer queue 在 API 路由层和 SubAgent 循环顶部跨 turn 通信。

**Tech Stack**: TypeScript (strict), Bun runtime + test, 现有 `LLMClient` / `SubAgent` / `src/api/index.ts` 接入。

---

## Global Constraints

- 复用现有 `LLMError` 类型,不要新建错误分类
- 不引入新的 npm 依赖(Bun 自带,token 估算用 `content.length / 4`)
- 模块入口必须有 JSDoc,描述 OpenClaw 对应机制和文件位置(供后续维护追溯)
- 所有 commit 用 `feat:` / `fix:` / `test:` 前缀
- 不破坏现有 SSE/事件协议,新增事件类型必须先看 `request-lifecycle.ts` / `task-events.ts` 避免重复

---

## 任务分解(按用户锁定顺序)

### Task 1: Tool-call-repair

**Files**:
- Create: `src/llm/tool-call-repair.ts`
- Modify: `src/llm/index.ts:1085` (在 `makeToolRequestStream` 内插入 repair 调用)
- Test: `__tests__/tool-call-repair.test.ts`

**Interfaces**:
- `repairToolCalls(input: RepairInput): RepairOutput` — 入口
- 三个 grammar 解析器:`tryParseBracketTag` / `tryParseHarmony` / `tryParseXml`
- 返回 `RepairedToolCall[]`,格式与 OpenAI tool_calls 对齐

- [ ] **Step 1: 写失败测试**

在 `__tests__/tool-call-repair.test.ts` 写 5 个测试(见 spec 表)。运行 `bun test __tests__/tool-call-repair.test.ts`,确认全部 FAIL(模块未存在)。

- [ ] **Step 2: 实现 `src/llm/tool-call-repair.ts`**

```typescript
// 完整代码(参考 spec 第 Task 1 节)

interface RepairedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface RepairInput {
  content: string | null;
  tool_calls?: RepairedToolCall[];
}

interface RepairOutput {
  content: string;
  tool_calls: RepairedToolCall[];
  stopReason: 'toolUse' | 'endTurn';
  repaired: boolean;
}

// Bracket tag: [tool:name]\n{args}\n[/tool]
export function tryParseBracketTag(text: string): RepairedToolCall[] | null {
  const re = /\[tool:([a-zA-Z_][a-zA-Z0-9_]*)\]\s*([\s\S]*?)\s*\[\/\1\]/g;
  const matches: RepairedToolCall[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    let args: any = {};
    try { args = JSON.parse(m[2].trim()); } catch { /* leave empty */ }
    matches.push({
      id: `repair-bracket-${hashString(name + m[2])}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return matches.length > 0 ? matches : null;
}

// Harmony: <|channel|>commentary to=NAME<|message|>ARGS<|call|>
export function tryParseHarmony(text: string): RepairedToolCall[] | null {
  const re = /<\|channel\|>commentary to=([a-zA-Z_][a-zA-Z0-9_]*)<\|message\|>([\s\S]*?)<\|call\|>/g;
  const matches: RepairedToolCall[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    let args: any = {};
    try { args = JSON.parse(m[2].trim()); } catch { /* leave empty */ }
    matches.push({
      id: `repair-harmony-${hashString(name + m[2])}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return matches.length > 0 ? matches : null;
}

// XML-ish: <parameter=KEY>VALUE</parameter> 多个键 → 一个工具调 read/glob/grep 用此格式
export function tryParseXml(text: string): RepairedToolCall[] | null {
  const paramRe = /<parameter=([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/parameter>/g;
  const params: Record<string, string> = {};
  let m;
  while ((m = paramRe.exec(text)) !== null) {
    params[m[1]] = m[2].trim();
  }
  if (Object.keys(params).length === 0) return null;
  // XML-ish 没有 toolName,默认 'read'(因为此格式最常用于读文件)
  // 不确定时返回 null,避免误猜
  return [{
    id: `repair-xml-${hashString(JSON.stringify(params))}`,
    type: 'function',
    function: { name: 'read', arguments: JSON.stringify(params) },
  }];
}

// 稳定 hash → 16 字符
function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 16);
}

// 统一入口
export function repairToolCalls(input: RepairInput): RepairOutput {
  // 已有合法 tool_calls → 原样返回
  if (input.tool_calls && input.tool_calls.length > 0) {
    return {
      content: input.content || '',
      tool_calls: input.tool_calls,
      stopReason: 'toolUse',
      repaired: false,
    };
  }

  const text = input.content || '';
  // 依次尝试三种 grammar
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

  // 移除已提取的 grammar 标记,残留文本作为 content
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
```

- [ ] **Step 3: 运行测试**

```bash
bun test __tests__/tool-call-repair.test.ts
```

期望:全部 PASS。

- [ ] **Step 4: 接入 `src/llm/index.ts:makeToolRequestStream`**

找到 `makeToolRequestStream` 函数(line 1081 附近),在拿到 `choice.message` 后、return 前:

```typescript
// 原代码
const message = choice.message;
const reasoning = message.reasoning_content || message.reasoning || '';
// ... return { message: {...}, reasoning };

// 改为
import { repairToolCalls } from './tool-call-repair';

const rawMessage = choice.message;
const repaired = repairToolCalls({
  content: rawMessage.content,
  tool_calls: rawMessage.tool_calls as any,
});

const message = {
  role: 'assistant' as const,
  content: repaired.content || rawMessage.content || '',
  tool_calls: repaired.tool_calls.length > 0 ? repaired.tool_calls : undefined,
};
const reasoning = rawMessage.reasoning_content || rawMessage.reasoning || '';

if (repaired.repaired) {
  log.warn('tool-call-repair 触发', {
    parser: '(see logs)',
    toolCount: repaired.tool_calls.length,
  });
}
```

- [ ] **Step 5: 验证回归**

```bash
bun test __tests__/llm-content-delta-emit.test.ts
bun test __tests__/api.test.ts 2>/dev/null || echo "no api test"
```

期望:不破坏现有 LLM 测试。

- [ ] **Step 6: Commit**

```bash
git add src/llm/tool-call-repair.ts src/llm/index.ts __tests__/tool-call-repair.test.ts
git commit -m "feat(llm): add tool-call-repair for bracket/harmony/xml grammar

把模型乱写的三种自由文本格式反向提升为原生 tool_use。
当 LLM 没有输出原生 tool_calls 时,自动检测并修复。

参考 OpenClaw packages/tool-call-repair/src/promote.ts:174

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Safe Compaction

**Files**:
- Create: `src/llm/compaction.ts`
- Modify: `src/agents/sub-agent.ts:generateWithTools` 调用处(在 line 400 附近 `await this.llm.generateWithTools(...)`)
- Test: `__tests__/compaction.test.ts`

**Interfaces**:
- `findValidCutPoints(messages: Message[]): number[]`
- `selectCutPoint(messages, tokenBudget, counter): number | null`
- `compactMessages(messages, llm, options): Promise<Message[]>`

- [ ] **Step 1: 写失败测试**

`__tests__/compaction.test.ts` 5 个 case(见 spec)。运行 `bun test`,确认 FAIL。

- [ ] **Step 2: 实现 `src/llm/compaction.ts`**

```typescript
import type { Message } from '../types';

// 默认 token 估算:每 4 字符约 1 token
function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    total += Math.ceil(content.length / 4);
    if (m.tool_calls) {
      total += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
    }
  }
  return total;
}

/**
 * 找出所有合法的切点下标(可从此下标开始切,前面的消息可以被丢弃)
 *
 * 合法切点:
 *  - 0(开头)
 *  - 任意 user 消息下标
 *  - 任意 assistant 消息下标(且无 tool_calls)
 *  - tool 消息之后回到 assistant/user 前的位置(隐式边界)
 */
export function findValidCutPoints(messages: Message[]): number[] {
  const points: number[] = [0];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      points.push(i);
    } else if (m.role === 'assistant' && !m.tool_calls) {
      points.push(i);
    }
    // tool 消息不加入切点(避免切断 toolUse/toolResult 配对)
  }
  return points;
}

/**
 * 从尾部向头部扫描,选第一个让估算 token ≤ budget 的切点
 */
export function selectCutPoint(
  messages: Message[],
  tokenBudget: number,
  tokenCounter: (msgs: Message[]) => number = estimateTokens,
): number | null {
  const points = findValidCutPoints(messages);
  // 从最大切点向最小切点扫描
  for (let i = points.length - 1; i >= 0; i--) {
    const cut = points[i];
    const remaining = messages.slice(cut);
    if (tokenCounter(remaining) <= tokenBudget) {
      return cut;
    }
  }
  return null; // 单条消息就超 budget,无法压缩
}

export interface CompactOptions {
  tokenBudget: number;     // 压缩后总 token 上限
  keepRecent: number;      // 保留最近 N 条原样
  signal?: AbortSignal;
}

/**
 * 摘要旧消息 + 保留 recent。失败时抛 LLMError。
 */
export async function compactMessages(
  messages: Message[],
  llm: { generateText(prompt: string, systemPrompt?: string): Promise<string> },
  options: CompactOptions,
): Promise<Message[]> {
  if (messages.length <= options.keepRecent) {
    return messages; // 不需要压缩
  }

  const cutPoint = selectCutPoint(messages, options.tokenBudget);
  if (cutPoint === null) {
    throw new Error('无法选择合法切点(单条消息已超 token 预算)');
  }

  // recent = 切点到末尾的所有消息
  const recent = messages.slice(cutPoint);
  if (recent.length >= messages.length - cutPoint && recent.length === messages.length) {
    return messages; // 选中的切点 = 0,等于没压缩
  }

  // 旧消息:0 ~ cutPoint(不含)
  const oldMessages = messages.slice(0, cutPoint);
  if (oldMessages.length === 0) {
    return messages;
  }

  // 摘要旧消息
  const summaryText = oldMessages
    .map((m, i) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${i}] ${m.role}: ${content.substring(0, 500)}`;
    })
    .join('\n');

  const summary = await llm.generateText(
    `请用 200 字以内总结以下对话历史的关键信息(用户意图、已完成工具调用、当前进度):\n\n${summaryText}`,
    '你是一个对话摘要助手,只输出摘要文本,不要输出其他内容。',
  );

  const summaryMessage: Message = {
    role: 'user',
    content: `[对话历史摘要]\n${summary}\n\n(以上是早期对话的摘要,后续对话是新内容)`,
  };

  // 保留 summary + recent
  return [summaryMessage, ...recent];
}
```

- [ ] **Step 3: 运行测试**

```bash
bun test __tests__/compaction.test.ts
```

期望:全部 PASS。

- [ ] **Step 4: 接入 `src/agents/sub-agent.ts:generateWithTools`**

找到 `await this.llm.generateWithTools(messages, tools, async (toolCall) => {...}, signal, concurrencyChecker);`(line 400 附近),改为:

```typescript
import { compactMessages } from '../llm/compaction';

// 包一层,捕获 CONTEXT_TOO_LONG 后压缩并重试
let currentMessages = messages;
let attempts = 0;
const MAX_COMPACTION_ATTEMPTS = 1; // 最多压缩 1 次

while (attempts <= MAX_COMPACTION_ATTEMPTS) {
  try {
    const result = await this.llm.generateWithTools(
      currentMessages,
      tools,
      async (toolCall) => { /* 原 toolExecutor */ },
      signal,
      concurrencyChecker,
    );
    // 成功:把后续用到的 result.messages 同步成 currentMessages
    currentMessages = result.messages;
    return result;
  } catch (err) {
    if (err instanceof LLMError && err.type === 'CONTEXT_TOO_LONG' && attempts < MAX_COMPACTION_ATTEMPTS) {
      SubAgent.log.warn('CONTEXT_TOO_LONG,触发 safe compaction', { beforeLength: currentMessages.length });
      currentMessages = await compactMessages(currentMessages, this.llm, {
        tokenBudget: Math.floor(this.llm['maxTokens'] * 0.7),  // 用 70% 作为压缩目标
        keepRecent: 5,
        signal,
      });
      attempts++;
      continue;
    }
    throw err;
  }
}
```

注意:`generateWithTools` 返回的 `result.messages` 是完整轨迹,**不能用压缩后的 messages 覆盖它**,否则丢掉 tool 配对。**应改为:把压缩后的 messages 作为下次 LLM 调用起点,返回时仍用 result.messages**。重新调整:

```typescript
let baseMessages = messages;
let attempts = 0;

while (attempts <= 1) {
  try {
    const result = await this.llm.generateWithTools(
      baseMessages,  // ← 用 baseMessages 作起点
      tools,
      toolExecutor,
      signal,
      concurrencyChecker,
    );
    return result;  // result.messages 已经是完整轨迹
  } catch (err) {
    if (err instanceof LLMError && err.type === 'CONTEXT_TOO_LONG' && attempts < 1) {
      baseMessages = await compactMessages(baseMessages, this.llm, {
        tokenBudget: 8000,
        keepRecent: 5,
        signal,
      });
      attempts++;
      continue;
    }
    throw err;
  }
}
```

- [ ] **Step 5: 验证**

```bash
bun test __tests__/compaction.test.ts __tests__/llm-content-delta-emit.test.ts
```

期望:全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/llm/compaction.ts src/agents/sub-agent.ts __tests__/compaction.test.ts
git commit -m "feat(llm): safe compaction on CONTEXT_TOO_LONG

按 turn 边界找切点,压缩旧消息为摘要,保留 recent。
绝不切断 toolUse/toolResult 配对。

参考 OpenClaw packages/agent-core/src/harness/compaction/compaction.ts:308 findValidCutPoints

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Unknown-Tool Loop Guard

**Files**:
- Create: `src/agents/unknown-tool-guard.ts`
- Modify: `src/agents/sub-agent.ts:executeSkill` 的 toolExecutor 回调
- Test: `__tests__/unknown-tool-guard.test.ts`

**Interfaces**:
- `class UnknownToolLoopGuard`
- `check(toolName: string): string | null` — 返回改写文本或 null
- `reset(): void`

- [ ] **Step 1: 写失败测试**

5 个 case。运行 `bun test`,FAIL。

- [ ] **Step 2: 实现 `src/agents/unknown-tool-guard.ts`**

```typescript
/**
 * 未知工具死循环熔断
 *
 * 参考 OpenClaw src/agents/embedded-agent-runner/run/attempt.tool-call-normalization.ts:38
 * 当 LLM 连续 N 次调用同一未知工具时,改写 toolResult 让 LLM 换路径。
 * 状态机:同一工具名 → 计数器+1,切换工具 → 重置。
 */
export class UnknownToolLoopGuard {
  private lastToolName: string | null = null;
  private count: number = 0;

  constructor(private threshold: number = 3) {}

  /**
   * 检查当前工具调用是否需要熔断
   * @returns 若需要熔断,返回改写后的 toolResult;否则返回 null
   */
  check(toolName: string): string | null {
    if (this.lastToolName === toolName) {
      this.count++;
      if (this.count > this.threshold) {
        return this.buildRewriteMessage(toolName);
      }
    } else {
      this.lastToolName = toolName;
      this.count = 1;
    }
    return null;
  }

  /** 切换到合法工具后调用,重置计数 */
  reset(): void {
    this.lastToolName = null;
    this.count = 0;
  }

  private buildRewriteMessage(toolName: string): string {
    return `I can't use the tool '${toolName}' — it doesn't exist in this environment. ` +
           `I need to stop retrying it and answer without that tool.`;
  }
}
```

- [ ] **Step 3: 运行测试**

```bash
bun test __tests__/unknown-tool-guard.test.ts
```

期望:全部 PASS。

- [ ] **Step 4: 接入 `src/agents/sub-agent.ts`**

在 `executeSkill` 入口(line 212 附近),创建 `unknownToolGuard`:

```typescript
// v4: 未知工具熔断(per-taskId,与 OpenClaw 一致)
const unknownToolGuard = new UnknownToolLoopGuard(3);
```

在 `generateWithTools` 的 `toolExecutor` 回调(line 403 附近)开头加:

```typescript
async (toolCall) => {
  // v4: 未知工具熔断检查
  if (!allowedToolNames.has(toolCall.name)) {
    const rewrite = unknownToolGuard.check(toolCall.name);
    if (rewrite) {
      SubAgent.log.warn('未知工具熔断触发', { toolName: toolCall.name, count: '>3' });
      return rewrite;  // 直接返回改写后的 toolResult
    }
    // 未超阈值但仍不在允许名单 → 走原有 "工具不存在" 返回
    return `工具执行失败: 工具 '${toolCall.name}' 不在允许列表中,可用工具: ${Array.from(allowedToolNames).join(', ')}`;
  } else {
    unknownToolGuard.reset();  // 合法工具调用,重置计数
  }
  // ... 原 toolExecutor 逻辑
}
```

- [ ] **Step 5: 验证**

```bash
bun test __tests__/unknown-tool-guard.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/agents/unknown-tool-guard.ts src/agents/sub-agent.ts __tests__/unknown-tool-guard.test.ts
git commit -m "feat(agent): unknown-tool loop guard

LLM 连续 3 次调同一未知工具时,改写 toolResult 让 LLM 换路径。
per-taskId 隔离,避免多任务串台。

参考 OpenClaw src/agents/embedded-agent-runner/run/attempt.tool-call-normalization.ts:835

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Steer Queue

**Files**:
- Create: `src/memory/steering-buffer.ts`
- Modify: `src/api/index.ts`(POST /tasks/stream 路由识别 active request)
- Modify: `src/agents/sub-agent.ts`(generateWithTools 循环顶部 consume)
- Test: `__tests__/steering-buffer.test.ts`
- Test: `__tests__/api-steering-flow.test.ts`

**Interfaces**:
- `class SteeringBuffer`
- `enqueue(sessionId, msg)`, `consume(sessionId)`, `peek(sessionId)`, `clear(sessionId)`

- [ ] **Step 1: 写失败测试**

单元测试 4 个 case(入队/消费/隔离/clear)。运行 FAIL。

- [ ] **Step 2: 实现 `src/memory/steering-buffer.ts`**

```typescript
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'SteeringBuffer' });

export interface SteeringMessage {
  content: string;
  enqueuedAt: string;
}

/**
 * 进程内的用户改口缓冲区
 *
 * 与 SessionGate.pendingRequests 的区别:
 * - pendingRequests: 跨 request 边界,等 checkpoint 合并 → 长延迟
 * - steeringBuffer:  当前 turn 边界插入,几乎实时
 *
 * 不持久化:进程重启后丢失可接受(steer 是实时语义)
 */
class SteeringBuffer {
  private buffers = new Map<string, SteeringMessage[]>();

  enqueue(sessionId: string, msg: SteeringMessage): void {
    const queue = this.buffers.get(sessionId) || [];
    queue.push(msg);
    this.buffers.set(sessionId, queue);
    log.info('steering 消息入队', { sessionId, content: msg.content.substring(0, 50), queueSize: queue.length });
  }

  /**
   * 取出并清空指定 session 的所有 steering 消息
   */
  consume(sessionId: string): SteeringMessage[] {
    const queue = this.buffers.get(sessionId) || [];
    this.buffers.set(sessionId, []);
    return queue;
  }

  peek(sessionId: string): SteeringMessage[] {
    return [...(this.buffers.get(sessionId) || [])];
  }

  clear(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}

export const steeringBuffer = new SteeringBuffer();
```

- [ ] **Step 3: 运行测试**

```bash
bun test __tests__/steering-buffer.test.ts
```

- [ ] **Step 4: 接入 `src/api/index.ts`**

找到 POST /tasks/stream 路由(line 约 200-300),在调用 `mainAgent.processRequirement(...)` 之前加 steer 识别:

```typescript
import { steeringBuffer } from '../memory/steering-buffer';

// 在路由处理函数内,调用 mainAgent 之前:
const session = await sessionStore.loadSession(userId, sessionId);
if (session.activeRequestId) {
  const activeReq = session.requests.find(r => r.requestId === session.activeRequestId);
  if (activeReq?.status === 'processing') {
    // 当前有正在跑的 request → steer 注入
    steeringBuffer.enqueue(sessionId, {
      content: requirement,
      enqueuedAt: new Date().toISOString(),
    });
    res.status(202).json({
      success: true,
      steered: true,
      message: '已注入 steer 队列,主请求处理完后会看到这条消息',
    });
    return;
  }
  // waiting 状态 → 走 continueRequest(原逻辑)
}
// 否则走原 processRequirement
```

- [ ] **Step 5: 接入 `src/agents/sub-agent.ts`**

在 `generateWithTools` 工具循环外层,把 `messages` 包成会被修改的 `trackedMessages`(已经存在):

```typescript
import { steeringBuffer } from '../memory/steering-buffer';

// 在 generateWithTools 函数顶部(找到 messages 参数):
async generateWithTools(
  messages: Message[],
  ...
) {
  // ...原有逻辑...
  
  // v4: steer 队列消费(每轮 LLM 调用前)
  const consumeSteering = () => {
    const steering = steeringBuffer.consume(sessionId || '');
    if (steering.length > 0) {
      for (const msg of steering) {
        trackedMessages.push({ role: 'user', content: msg.content });
        SubAgent.log.info('steering 消息注入到 messages', { content: msg.content.substring(0, 50) });
      }
    }
  };
  
  // 在 while 循环顶部调用:
  while (maxIterations-- > 0) {
    consumeSteering();  // ← 加这一行
    // ...原有循环体...
  }
}
```

- [ ] **Step 6: 端到端测试 `__tests__/api-steering-flow.test.ts`**

模拟:active request processing → POST /tasks/stream → 断言 202 + steeringBuffer.consume 返回新消息。

- [ ] **Step 7: 验证**

```bash
bun test __tests__/steering-buffer.test.ts __tests__/api-steering-flow.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/memory/steering-buffer.ts src/api/index.ts src/agents/sub-agent.ts __tests__/steering-buffer.test.ts __tests__/api-steering-flow.test.ts
git commit -m "feat(agent): steer queue for user mid-flight corrections

用户在当前 request 跑着时发新消息 → 不阻塞,进 steeringBuffer。
SubAgent 工具循环每轮开头消费,作为新 user message 插入。
不等 checkpoint 合并,接近实时。

参考 OpenClaw packages/agent-core/src/harness/agent-harness.ts:773 steer()

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验证清单

每个任务完成后跑:

```bash
bun test __tests__/<新测试文件>
bun test  # 全部测试
npx tsc --noEmit  # 类型检查
```

全部 4 任务完成后:
- [ ] 重启 dev server
- [ ] 跑 `bun run src/index.ts` 启动
- [ ] curl 一次正常请求,确认无回归
- [ ] 用 SSE 客户端订阅,观察 reasoning 事件仍正常

## 不做的事

- ❌ 不引入新的 npm 依赖
- ❌ 不修改 SSE 事件协议(只在内部加 consume/enqueue)
- ❌ 不持久化 steering buffer
- ❌ 不让 steer 跨越 task 边界
- ❌ 不做 Provider 回退(留给 v2)
