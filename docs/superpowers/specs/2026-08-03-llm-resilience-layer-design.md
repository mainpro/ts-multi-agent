# LLM 韧性工程层 设计

> 基于 `openclaw-why-smart.md` 的 5 个核心机制,在 ts-multi-agent 内补齐 4 个缺失的"模型抖动恢复"能力。
> 已有 1 个:Provider 重试+指数退避(`fetchWithRetry`)。
> 待补 4 个:tool-call-repair、safe compaction、未知工具熔断、steer 队列。

---

## Context

当前 ts-multi-agent 的 LLM 客户端在 8 种错误分类(LLMError)和 3 次重试上做得扎实,但**只处理"网络/限流层"的抖动**;模型输出层的抖动(乱写工具调用、不知道换路径、循环同一工具、长会话超出 token 限)和交互层的抖动(用户中途改口)全部直接失败或低效兜底。本 spec 把 OpenClaw 的 5 个机制里**我们缺的 4 个**落地。

### 现状缺口

| 抖动类型 | 当前行为 | 后果 |
|---------|---------|------|
| 模型乱写工具调用(自由文本/Harmony/XML) | `generateWithTools` 中 `!tool_calls` 直接返回 content,文本被当工具结果 | 工具没执行,但 LLM 已经"以为执行了",任务卡死 |
| 长会话超 token 限 | 抛 `CONTEXT_TOO_LONG`,无重试,上层 failRequest | 请求失败,用户需重发 |
| 反复调用不存在工具 | 跑到 `maxIterations=10` 才退出 | 浪费 token、用户等多秒 |
| 用户中途改口 | 当前 request 完成后,新消息进 SessionGate 队列,等 checkpoint 合并 | 失去"实时改方向"能力 |

### 期望产出

- 模型输出格式抖动 → 自动恢复,用户无感
- 长会话 → 自动压缩历史,继续推进
- 死循环调不存在工具 → 主动改写 toolResult 让 LLM 换路径
- 用户中途改口 → 当前 turn 结束后下一轮插入新消息

---

## 设计决策(用户已锁定)

| 决策 | 选择 |
|------|------|
| Tool-call-repair 范围 | 三种 grammar 都修(bracket tag / Harmony / XML-ish) |
| Safe compaction 触发 | 只在 `CONTEXT_TOO_LONG` 报错后(被动) |
| 未知工具熔断粒度 | SubAgent.executeSkill 内的工具循环(per-taskId) |
| Steer 语义 | 等当前 turn 结束,下一轮插入 |
| Steer API | 复用现有 `POST /tasks/stream`(同 sessionId 路由识别) |
| 实施顺序 | tool-call-repair → safe compaction → 未知工具熔断 → steer |

### 为什么这样选

- **tool-call-repair 三种 grammar 全修**:与 OpenClaw 一致。单一 grammar 覆盖太薄,模型可能随机切换风格
- **被动 compaction**:短 session 零开销,长 session 由错误信号触发,避免主动检测引入估算复杂度
- **per-taskId 熔断**:全局计数器会把"两个无关任务同时调同一未知工具"误判为循环
- **steer turn-边界注入**:与 OpenClaw 一致,不打断当前工具(避免事务不完整)
- **复用现有 API**:零前端改动,gate 层做识别

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                       LLM 韧性工程层(本 spec)                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐ │
│  │ Tool-call-repair │    │ Safe Compaction  │    │ Unknown-Tool  │ │
│  │ (入口拦截)       │    │ (CONTEXT_TOO_    │    │ Loop Guard    │ │
│  │                  │    │  LONG 后处理)    │    │ (per-taskId)  │ │
│  └────────┬─────────┘    └────────┬─────────┘    └───────┬───────┘ │
│           │                       │                      │         │
│           ▼                       ▼                      ▼         │
│  src/llm/tool-call-repair.ts  src/llm/compaction.ts  src/agents/  │
│                                                         unknown-   │
│                                                         tool-guard │
│                                                         .ts        │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Steer Queue (跨 turn 通信)                                    │   │
│  │                                                              │   │
│  │  POST /tasks/stream ──► SessionGate ──┬─► mainAgent (active?)│   │
│  │                                       ├─► steerBuffer       │   │
│  │                                       └─► pendingRequests    │   │
│  │                                                              │   │
│  │  SubAgent 工具循环 ──► consumeSteering() ──► 插入 messages   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│         src/memory/steering-buffer.ts + SubAgent 接入                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Task 1: Tool-call-repair

### 模块 `src/llm/tool-call-repair.ts`

```typescript
// 类型:与 OpenAI tool_calls 对齐
interface RepairedToolCall {
  id: string;           // 生成的稳定 ID(同输入同 ID)
  type: 'function';
  function: {
    name: string;
    arguments: string;  // JSON 字符串
  };
}

interface RepairInput {
  content: string | null;
  tool_calls?: RepairedToolCall[];
}

interface RepairOutput {
  content: string;       // 残余文本(可空)
  tool_calls: RepairedToolCall[];
  stopReason: 'toolUse' | 'endTurn';
  repaired: boolean;     // 是否经过了 repair(用于日志/可观测)
}

// 三种 grammar 解析器(每个返回 null 表示无法解析)
export function tryParseBracketTag(text: string): RepairedToolCall[] | null
export function tryParseHarmony(text: string): RepairedToolCall[] | null
export function tryParseXml(text: string): RepairedToolCall[] | null

// 统一入口
export function repairToolCalls(input: RepairInput): RepairOutput
```

### Grammar 形式

**1. Bracket tag**(OpenClaw `payload.ts:45`):
```
我需要读取这个文件。
[tool:read]
{"path": "/etc/hosts"}
[/read]
```

**2. Harmony**(OpenClaw `payload.ts:83`):
```
<|channel|>commentary to=read<|message|>{"path":"/etc/hosts"}<|call|>
```

**3. XML-ish**:
```
<parameter=path>/etc/hosts</parameter>
```

### 解析优先级

`repairToolCalls` 流程:
1. 若 `input.tool_calls` 非空 → 原样返回,`repaired: false`
2. 否则依次尝试 `tryParseBracketTag` → `tryParseHarmony` → `tryParseXml`
3. 第一个非 null 的解析器返回 `tool_calls`,`repaired: true`,`stopReason: 'toolUse'`
4. 三个都解析失败 → `tool_calls: []`,`stopReason: 'endTurn'`,`repaired: false`

### 接入点

`src/llm/index.ts` 的 `makeToolRequestStream`(line 1081 附近),拿到 `choice.message` 后、return 前:

```typescript
const message = choice.message;
// 新增:tool-call-repair
const repaired = repairToolCalls({
  content: message.content,
  tool_calls: message.tool_calls as any,
});
// 用 repaired 构造返回 message
return {
  message: {
    role: 'assistant',
    content: repaired.content,
    tool_calls: repaired.tool_calls.length > 0 ? repaired.tool_calls : undefined,
  },
  reasoning,
};
```

### 测试 `__tests__/tool-call-repair.test.ts`

| Case | 输入 | 期望 |
|------|------|------|
| bracket tag 解析 | `[tool:read]{"path":"/etc/hosts"}[/read]` | `tool_calls[0].function.name='read'` |
| harmony 解析 | `<|channel\|>commentary to=read<\|message\|>{"path":"/etc/hosts"}<\|call\|>` | 同上 |
| xml-ish 解析 | `<parameter=path>/etc/hosts</parameter>` | 构造 `read` 工具调用,`args.path='/etc/hosts'` |
| 已合法 tool_calls 不动 | `{tool_calls:[{name:'read'}]}` | 原样返回,`repaired: false` |
| 三种都不匹配 | `"普通对话内容"` | `tool_calls: []`,`stopReason: 'endTurn'` |
| 混合文本+bracket | 前缀文本 + `[tool:read]...[/read]` | `content` 去掉 bracket 段,`tool_calls` 正常 |
| ID 稳定性 | 同输入两次解析 | ID 一致(便于上层 dedup) |

---

## Task 2: Safe Compaction

### 模块 `src/llm/compaction.ts`

```typescript
// 切点位置(消息数组下标):可切的位置
export function findValidCutPoints(messages: Message[]): number[]

// 选择最优切点(从末尾向头找,选第一个让 token 数 <= budget 的)
export function selectCutPoint(
  messages: Message[],
  tokenBudget: number,
  tokenCounter: (msgs: Message[]) => number,
): number | null

// 摘要旧消息 + 保留 recent
export async function compactMessages(
  messages: Message[],
  llm: ILLMClient,
  options: { tokenBudget: number; keepRecent: number; signal?: AbortSignal }
): Promise<Message[]>
```

### 切点规则

- ✅ **可切**:user 消息开头
- ✅ **可切**:assistant 消息开头(且无 `tool_calls`)
- ✅ **可切**:连续 tool 消息之后、回到 assistant 之前的边界
- ❌ **不可切**:assistant `tool_calls` 之后、对应 `tool` 之前(中间)
- ❌ **不可切**:system prompt 中间

### 触发流程

```
SubAgent.generateWithTools 循环:
  while (maxIterations-- > 0) {
    try {
      result = await llm.makeToolRequestStream(...)
    } catch (e) {
      if (e.type === 'CONTEXT_TOO_LONG') {
        messages = await compactMessages(messages, llm, {...});
        continue;  // 用压缩后的 messages 重试
      }
      throw e;
    }
    ...
  }
```

注意:**只在 generateWithTools 循环内做 compaction**;`generateStructured`(IntentRouter)失败走另一条路径(LLMError 直接抛,不压缩)。

### token 估算

复用 `src/memory/token-counter.ts` 的实现(若不存在则用 `messages.content.length / 4` 估算)。

### 测试 `__tests__/compaction.test.ts`

| Case | 输入 | 期望 |
|------|------|------|
| 切点不在 toolUse 后 | `[user, assistant(toolCalls), tool, assistant]` | 切点只能是 0(用户开头)或 3(assistant 开头) |
| 切点不在 toolResult 中间 | `[user, assistant(toolCalls), tool1, tool2, assistant]` | 切点不能在 2(切断 tool1)和 3(切断 tool2)之间 |
| selectCutPoint 选最优 | 20 条消息,budget=4000 | 选最近的可让总 token ≤ budget 的下标 |
| 压缩保留 recent | keepRecent=5 | 压缩后的 messages 末尾 5 条原样保留 |
| 压缩失败时抛错 | LLM 摘要调用失败 | 抛 LLMError,不上抛为无害结果 |

---

## Task 3: Unknown-Tool Loop Guard

### 模块 `src/agents/unknown-tool-guard.ts`

```typescript
export class UnknownToolLoopGuard {
  private lastToolName: string | null = null;
  private count: number = 0;
  
  constructor(private threshold: number = 3) {}
  
  /**
   * 检查是否需要改写 toolResult
   * @param toolName LLM 调用的工具名
   * @returns 若需要改写,返回改写后的 toolResult 文本;否则返回 null
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
  
  /** 成功切换工具或被熔断后,重置计数 */
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

### 接入点 `src/agents/sub-agent.ts`

在 `executeSkill` 内的 `generateWithTools` 调用中(`toolExecutor` 回调):
```typescript
async (toolCall) => {
  // 1. 检查是否在 allowedTools
  if (!allowedToolNames.has(toolCall.name)) {
    const rewrite = unknownToolGuard.check(toolCall.name);
    if (rewrite) {
      return rewrite;  // 改写 toolResult,让 LLM 看到人话
    }
    // 没到阈值,但仍不在允许名单 → 仍走"未知工具"返回
    // (允许名单是 SubAgent 自己的过滤,这里只是熔断)
  } else {
    unknownToolGuard.reset();  // 合法工具调用,重置计数
  }
  // ... 原 toolExecutor 逻辑
}
```

`unknownToolGuard` 实例化在 `executeSkill` 入口,task 完成时随 task 销毁。

### 测试 `__tests__/unknown-tool-guard.test.ts`

| Case | 行为 | 期望 |
|------|------|------|
| 阈值内不触发 | `check('unknown_x')` × 3 | 第 4 次返回 null(<=3 都不返回改写) |
| 超阈值返回改写 | `check('unknown_x')` × 4 | 第 4 次返回包含 `can't use the tool` 的文本 |
| 切换工具重置 | `check('unknown_x')` × 2, `check('unknown_y')` × 1 | 'y' 计数 = 1,从 0 开始 |
| reset 清零 | `check('x')` × 4, `reset()`, `check('x')` | 计数重新从 1 开始 |
| 同名不同 ID | `check('x')` × 4 | 仍触发熔断(只看名字) |

---

## Task 4: Steer Queue

### 模块 `src/memory/steering-buffer.ts`

```typescript
// 进程内 Map,key=sessionId,value=消息队列
// 不持久化(steer 消息是实时的,崩了丢失可接受)
class SteeringBuffer {
  private buffers = new Map<string, SteeringMessage[]>();
  
  enqueue(sessionId: string, msg: SteeringMessage): void
  consume(sessionId: string): SteeringMessage[]  // 取出并清空
  peek(sessionId: string): SteeringMessage[]     // 仅查看
  clear(sessionId: string): void
}

interface SteeringMessage {
  content: string;
  enqueuedAt: string;
}

export const steeringBuffer = new SteeringBuffer();
```

### 接入点 1:API 层 `src/api/index.ts`

`POST /tasks/stream` 处理函数中,在调用 `mainAgent.processRequirement(...)` 之前:

```typescript
// 检查同 session 是否有 active request
const session = await sessionStore.loadSession(userId, sessionId);
if (session.activeRequestId) {
  const activeReq = session.requests.find(r => r.requestId === session.activeRequestId);
  if (activeReq?.status === 'processing') {
    // 不是 ask_user 等待,而是正在跑 → 进 steer 队列
    steeringBuffer.enqueue(sessionId, {
      content: requirement,
      enqueuedAt: new Date().toISOString(),
    });
    // 立即返回 202(steer 已注入,主请求继续)
    res.status(202).json({ steered: true });
    return;
  }
}
// 否则走原 processRequirement 路径
```

### 接入点 2:SubAgent `src/agents/sub-agent.ts`

在 `generateWithTools` 工具循环的**外层循环顶部**(每次 LLM 调用前):

```typescript
// 消费 steer 队列(若有)
const steering = steeringBuffer.consume(sessionId);
if (steering.length > 0) {
  for (const msg of steering) {
    trackedMessages.push({ role: 'user', content: msg.content });
    log.info('steering message inserted', { content: msg.content.substring(0, 50) });
  }
}
```

**注意**:只在 SubAgent 循环顶部消费,避免在工具执行中途插入(保护事务完整)。MainAgent 不消费 steer 队列(主 Agent LLM 调用是单次,适合用现有 SessionGate 队列机制)。

### 边界约束

| 约束 | 原因 |
|------|------|
| steer buffer 不持久化 | 进程重启后 steer 消息丢失可接受(用户的"改口"语义有时效) |
| steer 消息不跨 task 边界 | SubAgent 任务完成即销毁 trackedMessages,steer 仅影响当前 task |
| MainAgent 不消费 steer | MainAgent LLM 调用是单次短路径,steer 走 SessionGate 队列更合理 |
| steer 与 ask_user 互斥 | `activeReq.status === 'waiting'` 不走 steer(走 continueRequest) |

### 测试

`__tests__/steering-buffer.test.ts`(单元):
- enqueue → consume 取出 → 第二次 consume 为空
- 多 session 隔离
- clear 显式清空

`__tests__/api-steering-flow.test.ts`(集成):
- 模拟 active request + POST /tasks/stream
- 断言 202 + steeringBuffer 长度变化
- 断言后续 SubAgent 工具循环消费到该消息

---

## 关键文件

| 文件 | 动作 | 行数估计 |
|------|------|---------|
| `src/llm/tool-call-repair.ts` | 新建 | ~180 |
| `src/llm/index.ts` | 改 (line 1085 makeToolRequestStream) | +8 |
| `__tests__/tool-call-repair.test.ts` | 新建 | ~150 |
| `src/llm/compaction.ts` | 新建 | ~150 |
| `src/agents/sub-agent.ts` | 改 (generateWithTools 入口加 try/catch CONTEXT_TOO_LONG) | +20 |
| `__tests__/compaction.test.ts` | 新建 | ~120 |
| `src/agents/unknown-tool-guard.ts` | 新建 | ~50 |
| `src/agents/sub-agent.ts` | 改 (toolExecutor 回调加 guard.check) | +15 |
| `__tests__/unknown-tool-guard.test.ts` | 新建 | ~80 |
| `src/memory/steering-buffer.ts` | 新建 | ~40 |
| `src/api/index.ts` | 改 (POST /tasks/stream 路由识别) | +20 |
| `src/agents/sub-agent.ts` | 改 (generateWithTools 循环顶部 consume) | +12 |
| `__tests__/steering-buffer.test.ts` | 新建 | ~60 |
| `__tests__/api-steering-flow.test.ts` | 新建 | ~120 |

---

## 验证方法

1. **每个模块单元测试通过**:`bun test __tests__/tool-call-repair.test.ts __tests__/compaction.test.ts __tests__/unknown-tool-guard.test.ts __tests__/steering-buffer.test.ts`
2. **回归**:既有 SSE/工具调用/api test 全部通过
3. **类型检查**:`npx tsc --noEmit` 无错
4. **运行时手动验证**(dev server):
   - **repair**:在 prompt 里要求模型故意用 bracket tag 调工具(可通过测试 prompt 注入),确认 LLMClient 自动修复后工具正常执行
   - **compaction**:模拟长 session(连续 20 轮带工具调用),手动触发 token 超限,确认自动压缩后继续
   - **unknown guard**:故意注册一个被过滤掉的工具名,让模型反复调,确认第 4 次返回改写文本后 LLM 换路径
   - **steer**:发一条会跑 5s 的请求,5s 内再发一条改口,确认前端 202 + 后端 SubAgent 下一轮看到新消息

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Tool-call-repair 把合法 JSON 误判为 grammar | 三个 grammar 都有"必须含标记字符"的强约束(`[tool:` / `<|channel|>` / `<parameter=`),无标记时直接返回原 tool_calls |
| 压缩破坏了 tool 配对 | `findValidCutPoints` 显式排除 toolUse/toolResult 中间;单元测试覆盖所有 case |
| Unknown-tool guard 在多 task 并发下串台 | guard 实例 per-taskId,在 executeSkill 入口 new,task 结束 GC |
| Steer buffer 进程重启丢失 | 用户感:刷新页面后改口消息没了 — 可接受(用户可重发) |
| Steer 与 ask_user 状态机冲突 | API 层用 `activeReq.status === 'processing'` 判断;`waiting` 走 continueRequest |
| compaction 重试无限循环 | `compactMessages` 内部加 `maxAttempts=1`,失败抛错不再压缩 |
