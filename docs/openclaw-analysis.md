# OpenClaw 韧性机制 — 需求梳理与本系统实现分析

> 来源文档：[`openclaw-why-smart.md`](../openclaw-why-smart.md)
> 撰写日期：2026-08-03
> 目的：把 OpenClaw 五个核心韧性机制"翻译"成 ts-multi-agent 的需求语言，标注本系统的对应实现、未实现项与设计取舍。

---

## 1. 一句话总结

OpenClaw 的"聪明"不在模型，而在模型外面包的一层**修复 + 韧性工程层**——把"模型出错"当成正常情况来设计。本系统按这条思路补齐了 4 个机制（steer 队列、tool-call-repair、未知工具熔断、safe compaction），1 个机制（provider fallback）暂不实现。

---

## 2. OpenClaw 五个核心机制（需求原文）

### 2.1 三队列主循环（steer / followUp / nextTurn）

**需求**：主循环不是"模型说停就停"，而是在每个 turn 边界持续接受外部注入；用户改口、坐席旁路、跨轮消息都能自然汇入下一轮 LLM 决策。

**典型场景**：客服 Agent 正在查知识库，用户半路改口"我说的是 OA 不是 VPN"——传统做法要么打断 Agent（丢上下文）、要么忽略用户（体验差）。OpenClaw 让用户在 turn 边界自然看到所有信息，由 LLM 自己判断怎么整合。

**关键路径**：
- `agent-loop.ts:273-380` 双层 while 循环
- `agent-harness.ts:773/781/789` 三队列入口

### 2.2 tool-call-repair（自由文本 → 原生 tool_use）

**需求**：模型偶尔不按 provider 规范输出（bracket grammar、OpenAI Harmony 漏出、XML-ish），被 provider 解析为 `endTurn` 导致 Agent 退出。需要把这些"乱写"反向解析为原生 toolCall，并把 `stopReason` 强制改成 `toolUse`。

**典型场景**：模型输出纯文本 + `[tool:read]{"path":"/etc/hosts"}[/tool]`，原本会让这一 turn 报废；repair 之后当成正常 toolUse 继续推进。

**关键路径**：`tool-call-repair/src/{grammar,payload,promote}.ts`

### 2.3 未知工具死循环熔断

**需求**：Agent 反复调用不存在的工具时，常规"工具不存在"返回会形成鬼打墙。需要状态机计数，到阈值后改写 toolResult 为"必须放弃"的人话文本，逼 LLM 转向。

**典型场景**：连续 4 次调 `search_email_archive` → 第 4 次 toolResult 变成 "I can't use the tool 'search_email_archive' — it doesn't exist. I need to stop retrying it and answer without that tool."

**关键路径**：`attempt.tool-call-normalization.ts:38/780/835`

### 2.4 provider 失效自动回退

**需求**：rate-limit / 鉴权失败触发候选模型链路切换 + cooldown。用户感知不到模型切换，但任务没断。

**典型场景**：claude-opus-4 → 429 → 切 claude-sonnet-4 → 标记 opus-4 cooldown 60s → 下一轮直接跳过 opus-4。

**关键路径**：`model-fallback.ts:132/289/342`

**本系统状态**：❌ **未实现（v2 deferred）**。当前只配了单一 provider；等多 provider 部署或出现限流抖动再设计。

### 2.5 基于 token 阈值的安全 compaction

**需求**：超 token 阈值时压缩历史，但**不能破坏 toolUse / toolResult 配对**——粗暴截断会让模型下一轮"我没看到结果，让我重试"，造成新的死循环。

**典型场景**：context 180k → 找合法切点 → 摘要旧消息 → 保留 recent → 新 context 60k。

**关键路径**：`compaction.ts:140/308` `findValidCutPoints` 算法

---

## 3. 本系统的实现逻辑（4/5 已落地）

### 3.1 ✅ Steer 队列（用户改口场景）

**对应实现**：
- `src/memory/steering-buffer.ts` — 跨 session 隔离的 FIFO 缓冲（`enqueue/consume/peek/clear`）
- `src/events/request-lifecycle.ts` — 发射 `request_steered` 事件供前端展示
- `src/api/index.ts` `POST /tasks/stream` — 入口先调 `mainAgent.shouldSteer`，命中则 enqueue 后立即返回 202
- `src/agents/sub-agent.ts` — 工具循环里 `steeringBuffer.consume(sessionId)` 作为闭包，next LLM call 前注入

**关键时序**：
```
[当前 session 有 running 任务]
用户发新消息 → API shouldSteer=true → steeringBuffer.enqueue → 返回 202
                                                ↓
                            SubAgent 下一轮 LLM 调用前 consume
                                                ↓
                          trackedMessages.push({role:'user',content:msg.content})
                                                ↓
                                request_steered 事件发出
```

**与 OpenClaw 的差异**：我们没有 followUp / nextTurn 两个独立队列，只用单条 steer 队列覆盖"用户改口"这个最高频场景。优先级、冷却、批量消费都简化掉了。

### 3.2 ✅ tool-call-repair

**对应实现**：
- `src/llm/tool-call-repair.ts` — `repairToolCalls(llmOutput)` 主入口
- `src/llm/index.ts` — `LLMClient.chatCompletion` 调用前先 repair

**支持的语法**：bracket grammar `[tool:name]{args}[/name]`（OpenClaw 三种里我们只追了这一个）。XML-ish 和 OpenAI Harmony 漏出未处理。

**关键代码骨架**：
```ts
export function repairToolCalls(raw) {
  if (raw.tool_calls && raw.tool_calls.length > 0) {
    return { ...raw, repaired: false };  // 已经是原生,idempotent
  }
  // bracket grammar 解析:content 提取 [tool:NAME]{JSON}[/NAME]
  const tc = parseBracketGrammar(raw.content);
  if (tc) {
    return {
      ...raw,
      repaired: true,
      stopReason: 'toolUse',
      tool_calls: [{ id: nanoid(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    };
  }
  return raw;  // 不动,交给上层判 endTurn
}
```

### 3.3 ✅ 未知工具熔断

**对应实现**：
- `src/agents/unknown-tool-guard.ts` — `UnknownToolLoopGuard` 类
- `src/agents/sub-agent.ts` — `executeSkill` 的 `toolExecutor` 闭包里调用 `guard.check(name)`

**关键状态机**：
```ts
class UnknownToolLoopGuard {
  check(toolName: string): string | null {
    if (this.lastName === toolName) {
      this.count += 1;
      if (this.count > this.threshold) {
        return REWRITE_TEXT(this.lastName);  // "I can't use the tool 'X'..."
      }
    } else {
      this.lastName = toolName;
      this.count = 1;
    }
    return null;  // 常规"工具不在允许列表"
  }
  reset() { this.lastName = null; this.count = 0; }
}
```

**关键细节**：
- 切换到合法工具时 `guard.reset()`，counter 重新计数
- 不同未知工具不会互相串台（`lastName` 切换即 reset）
- 改写文本含 toolName，便于 LLM 知道是哪个工具出问题

### 3.4 ✅ Safe Compaction

**对应实现**：
- `src/llm/compaction.ts` — `findValidCutPoints / selectCutPoint / compactMessages`

**切点合法性规则**：
- ✅ 允许切：`user` 消息、`assistant` 消息但**无** `tool_calls`（完整 boundary）
- ❌ 不允许切：`toolUse` assistant、`tool` 消息、紧跟 toolUse 的 assistant（会孤立配对）

**选点策略**：`selectCutPoint` 从尾部向头部找，让剩余消息 ≤ tokenBudget（最小超标）。

**压缩流程**：
```ts
async function compactMessages(messages, llm, { tokenBudget, keepRecent }) {
  const cutIdx = selectCutPoint(messages, tokenBudget);
  const toSummarize = messages.slice(0, cutIdx);
  const recent = messages.slice(cutIdx).slice(-keepRecent);

  const summary = await llm.generateText(`请用一句话摘要以下对话：\n${JSON.stringify(toSummarize)}`);

  return [
    { role: 'user', content: `[对话历史摘要]\n${summary}` },
    { role: 'assistant', content: '已收到摘要。' },
    ...recent,
  ];
}
```

**触发链路**：`LLMClient.chatCompletion` 捕获 `LLMError('CONTEXT_TOO_LONG')` → `compactMessages` → 用精简 messages 重试。

### 3.5 ❌ Provider Fallback（v2 deferred）

**现状**：未实现。
**理由**：当前只配单一 provider，没有限流抖动场景；候选打分 + cooldown 缓存的复杂度性价比低。
**触发时机**：真要部署多 provider（OpenAI + Anthropic + 国产模型），或出现限流事故时再设计。

---

## 4. 借鉴到 Skill 系统的设计（OpenClaw 第三节）

OpenClaw 第三节专门写了 NESP 客服场景的借鉴点。我们环境无 NESP 业务耦合，但仍有部分设计可对照：

### 4.1 Steer 队列 → 用户改口

✅ 已落地（见 3.1）。我们的 steer buffer 替代了 OpenClaw 的三队列，单队列覆盖 80% 场景。

### 4.2 Skill 元数据注入 system prompt

**OpenClaw 做法**：XML `<available_skills><skill name="..." location="..." version="1.2">...</skill></available_skills>`

**本系统做法**：`src/skill-registry/index.ts` `getAllMetadata()` 返回非 hidden 技能的 `{name, description, license, compatibility}`，由主 Agent 在 system prompt 构造阶段注入。格式是 YAML frontmatter，不是 XML。

**差异**：YAML 比 XML 易编辑，前端可读性更好；但 LLM 看到的格式差异需要 prompt 适配（这部分已经处理过）。

### 4.3 参数清洗 adapter 层

**OpenClaw 做法**：主 Agent → [参数清洗 adapter] → Skill HTTP 调用；adapter 吃模型抖动（`catalogId` 字符串/数字混用），Skill 保持纯净。

**本系统状态**：❌ 未单独抽 adapter 层。参数清洗分散在各 Skill 内部做（每个 Skill 自己处理类型转换）。长期看可能需要合并到独立模块，但当前 Skill 数量少，单点维护成本更低。

### 4.4 转人工时附"未知工具熔断"思路

**OpenClaw 思路**：连续 N 次 score < 0.5 → adapter 层注入引导文本 → 主 Agent 改调转人工。

**本系统状态**：部分通过 `UnknownToolLoopGuard` 覆盖（针对未知工具），但"低分命中"的引导未实现。当前 ResultAggregator 里有"统一低分转人工"的逻辑，但触发条件是聚合后判断，不是单 Skill 内的连续计数。

---

## 5. 优点与设计取舍

### 5.1 OpenClaw 设计的核心优点（我们继承的）

| 优点 | 体现 |
|------|------|
| **韧性当一等公民** | "模型出错"不是 fatal，是可恢复故障 → 全部 4 个机制都是这个思路 |
| **错误信息也是 prompt** | 未知工具熔断的改写文本是给 LLM 看的人话，不是技术错误 |
| **切点算法对齐矛盾** | compaction 既要截断又要保 toolUse 配对，用切点选择算法同时满足 |
| **LLM 决策 vs Skill 原子分层** | 编排层（主 Agent）做决策，Skill 保持无状态原子能力 |
| **不打断当前 turn** | steer 队列在 turn 边界自然注入，不丢上下文、不切流程 |

### 5.2 本系统相对 OpenClaw 的额外优势

| 优势 | 来源 |
|------|------|
| **YAML frontmatter vs XML** | Skill 元数据 YAML 比 OpenClaw 的 XML 易编辑、版本控制友好 |
| **fs.watch 热重载** | `skill-registry/startWatch()` 500ms debounce，编辑 SKILL.md 自动生效，OpenClaw 无 |
| **metadata-only 缓存** | `metadataCache` 只缓存 frontmatter，body 懒加载，省内存 |
| **hidden skill flag** | frontmatter `hidden: true` 让某些技能不暴露给 LLM（管理用途），OpenClaw 无 |
| **allowedTools 限制** | frontmatter 声明技能允许的工具，SubAgent `allowedToolNames` 强制校验，越权即拒绝 |
| **SSE buffer 模式** | lifecycle / task / reasoning 三类事件都有 headersSent 之前的 buffer，flush 后按序重放，避免事件丢失 |

### 5.3 我们的取舍 / 简化

| 取舍 | 理由 |
|------|------|
| **steer 单队列** | 覆盖 80% 场景，避免 followUp 优先级排序的复杂度 |
| **tool-call-repair 只追 bracket grammar** | 我们用的是 OpenAI 兼容 API，Harmony 漏出概率低；XML-ish 也没见过 |
| **参数清洗不进 adapter 层** | 当前 Skill 数量 < 10，分散维护成本更低 |
| **provider fallback 不做** | 单 provider 场景下没价值 |
| **没有 branch-summarization** | 树形会话导航用不到，单线 conversation 已够 |

---

## 6. v2 跟踪项

详见 `memory/v2-skill-tracker.md`：

| 项 | 状态 | 触发时机 |
|----|------|----------|
| compatibility 字段 | 死字段，已决定保留（2026-08-03） | 想用随时补消费逻辑 |
| Skill 版本管理（`version="1.2"`） | 未实现 | 真要做 A/B 灰度时 |
| MCP bundle runtime | 不做 | 我们环境用不到 MCP |

---

## 7. OpenClaw 未验证部分（留作参考）

来源文档第 318-326 行明示没看完：

- MCP 加载机制（`compact.ts:45 createBundleMcpToolRuntime`）
- provider 候选打分算法（`model-fallback.ts` 顶层结构清楚，但打分细节未追）
- memory-host-sdk 跨会话记忆
- branch-summarization 树形会话导航（`agent-harness.ts:885`）
- `prepareCompaction` 的 token 累积停止规则

如未来要补 provider fallback，需要回头看这块。

---

## 附录：关键文件路径速查

### 本系统实现

```
src/llm/tool-call-repair.ts              # 机制 2
src/llm/compaction.ts                    # 机制 5
src/memory/steering-buffer.ts            # 机制 1
src/agents/unknown-tool-guard.ts         # 机制 3
src/agents/sub-agent.ts                  # 机制 1/3 集成点
src/events/request-lifecycle.ts          # 机制 1 事件
src/api/index.ts                         # 机制 1 入口
__tests__/resilience-e2e.test.ts         # 机制 1/2/5 e2e
__tests__/unknown-tool-guard-e2e.test.ts # 机制 3 e2e
```

### OpenClaw 参考

```
packages/agent-core/src/agent-loop.ts                          # 机制 1
packages/tool-call-repair/src/{grammar,payload,promote}.ts     # 机制 2
src/agents/embedded-agent-runner/run/attempt.tool-call-normalization.ts  # 机制 3
src/agents/model-fallback.ts                                   # 机制 4
packages/agent-core/src/harness/compaction/compaction.ts       # 机制 5
```