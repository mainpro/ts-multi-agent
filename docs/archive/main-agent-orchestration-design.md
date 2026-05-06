# 主智能体任务编排与结果汇总 — 架构调研与解决方案

## 一、当前问题

### 1.1 现状

当前系统的主智能体（MainAgent）在处理多任务请求时存在两个核心问题：

1. **任务编排能力缺失**：所有任务通过 IntentRouter 一次性生成，并行执行，无法支持串行依赖（如"先获取班级信息，再根据结果计算占比"）
2. **结果汇总缺失**：任务执行完毕后，`request.result` 为空，主智能体没有对多任务结果进行综合判断和汇总

### 1.2 理想行为

```
用户: "先获得所有的班级信息，再去计算每个班级的90分以上的人在全年级中的占比"

主智能体应该:
  1. 理解这是一个串行任务链
  2. 先派发任务A: 获取班级信息
  3. 等待任务A完成，获取结果
  4. 基于任务A的结果，派发任务B: 计算占比
  5. 等待任务B完成
  6. 汇总结果，判断是否满足用户需求
  7. 输出最终结果
```

---

## 二、主流 AI Agent 编排架构调研

### 2.1 Claude Code — 反应式循环（Reactive Loop）

**架构**：没有独立的规划阶段，通过 Agent Loop 的每一轮 forward pass 隐式决策。

```
while(true):
  1. 调用模型（带完整上下文 + 工具定义）
  2. 模型决定下一步（tool_use 或 text）
  3. 执行工具，结果追加为 user turn
  4. 循环直到 stop_reason = "end_turn"
```

**关键设计**：
- **模型驱动决策**：每一步都让模型基于完整上下文做一次 forward pass，没有规则引擎
- **子 Agent 隔离**：通过 Task 工具委派子任务，子 Agent 运行在完全隔离的对话中，边界之间只有任务描述进去、最终结论出来
- **结果聚合**：不做显式聚合，工具执行结果作为 tool_result 追加到对话历史，模型自行综合
- **终止判断**：模型主动返回 `end_turn`，且有恢复机制（上下文折叠 → 响应式压缩 → 增加 token 预算）后才真正退出

**对我们的启示**：
- ✅ 模型驱动的决策比规则引擎更灵活
- ✅ 子 Agent 隔离是好的设计（我们已经实现）
- ❌ 完全不做结果聚合不适合我们的场景——我们的子 Agent 执行的是独立的业务技能，结果需要主智能体汇总

### 2.2 OpenCode — 主循环 + 子 Agent 委派

**架构**：有显式的 Plan Agent，先规划后执行。

```
用户输入 → Plan Agent（制定计划）→ Build Agent（按计划执行）
                              ↘ Explore Agent（只读探索）
                              ↘ General Agent（通用子任务）
```

**关键设计**：
- **显式规划阶段**：Plan Agent 在执行前生成步骤计划
- **finish 字段控制循环**：`"tool-calls"` 继续、`"stop"` 终止
- **串行工具执行**：前一个工具的结果作为后一个的上下文
- **任务追踪**：Agent 可以维护待办列表

**对我们的启示**：
- ✅ 显式规划适合结构化多步骤任务
- ✅ 任务追踪（todo list）机制值得借鉴
- ❌ 纯串行执行限制了并行能力

### 2.3 OpenAI Codex CLI — 极简 Agent Loop

**架构**：没有多 Agent，没有显式规划器，一个 Agent Loop 搞定一切。

**关键设计**：
- **update_plan 工具**：模型可以主动调用此工具来更新和维护任务计划（不是独立 Agent，而是一个工具）
- **Prompt 作为不可变日志**：只追加新事件，不修改旧事件
- **自动压缩**：上下文超限时自动调用 compaction endpoint

**对我们的启示**：
- ✅ update_plan 工具是个好主意——让模型自主维护计划，而非外部 Planner Agent 强制规划
- ✅ 极简设计降低了系统复杂度

### 2.4 Aider — 单轮请求-响应

**架构**：没有 Agent Loop 的多轮工具调用，每次用户请求对应一次 LLM 调用。

**关键设计**：
- **Repo Map**：用图排序算法为整个仓库生成精简地图，提供全局代码理解
- **单轮编辑**：LLM 一次响应中可以输出多个编辑块

**对我们的启示**：
- ❌ 单轮模式不适合我们的多步骤业务场景

### 2.5 主流编排模式对比

| 维度 | Claude Code | OpenCode | Codex CLI | Aider | 当前系统 |
|------|------------|----------|-----------|-------|---------|
| 编排模型 | 反应式循环 | 规划+执行 | 极简循环 | 单轮 | 一次性派发 |
| 规划阶段 | 无（隐式） | 有（Plan Agent） | 无（update_plan 工具） | 无 | 有（IntentRouter） |
| 多 Agent | 是（Task 委派） | 是（角色分层） | 否 | 否 | 是（SubAgent） |
| 串行依赖 | 隐式（模型决策） | 显式（计划步骤） | 隐式（模型决策） | 无 | ❌ 不支持 |
| 结果聚合 | 模型自行综合 | Agent 汇总 | 模型自行综合 | 单次输出 | ❌ 缺失 |
| 终止判断 | 模型 end_turn | finish=stop | 不再请求工具 | 响应完成 | 所有任务完成 |

---

## 三、解决方案设计

### 3.1 设计原则

基于调研结果和我们的业务场景（企业级智能助手，技能驱动的任务执行），确定以下原则：

1. **模型驱动 + 结构化约束**：让 LLM 做决策（灵活性），但用结构化数据约束执行路径（可靠性）
2. **两阶段编排**：规划阶段生成任务图，执行阶段按图执行
3. **结果汇总由主智能体负责**：所有子任务完成后，主智能体进行综合判断
4. **渐进式增强**：不破坏现有架构，在现有流程上增量改进

### 3.2 方案：Plan-Execute-Summarize 三阶段架构

#### 阶段一：Plan（规划）

在现有 IntentRouter 的基础上增强，输出**任务执行图（TaskGraph）**而非简单的任务列表：

```typescript
interface TaskGraphNode {
  taskId: string;
  content: string;           // 任务描述
  skillName: string;         // 使用的技能
  dependencies: string[];    // 依赖的 taskId 列表（空数组=可立即执行）
  params?: Record<string, any>;  // 任务参数（可能引用上游任务的输出）
}

interface TaskGraph {
  nodes: TaskGraphNode[];
  // 拓扑排序后的执行层级
  layers: string[][];  // layers[0] = 可立即执行的任务，layers[1] = 依赖 layers[0] 的任务...
}
```

**关键改进**：IntentRouter 的 LLM 调用 prompt 中增加：
- 要求输出任务间的依赖关系
- 支持参数引用（如 `$taskA.result.classes` 引用任务A的输出）
- 支持条件分支（如"如果任务A返回空，跳过任务B"）

**示例**：
```
用户: "先获得所有的班级信息，再去计算每个班级的90分以上的人在全年级中的占比"

TaskGraph:
  layers[0]: [
    { taskId: "t1", content: "获取所有班级信息", skillName: "class-query", dependencies: [] }
  ]
  layers[1]: [
    { taskId: "t2", content: "计算每个班级90分以上人数占比", skillName: "score-calc", dependencies: ["t1"], params: { classes: "$t1.result" } }
  ]
```

#### 阶段二：Execute（执行）

改造 `monitorAndReplan` 方法，支持**分层执行**：

```typescript
async executeTaskGraph(graph: TaskGraph, sessionId: string, userId: string, request: Request) {
  const results: Map<string, any> = new Map();

  for (const layer of graph.layers) {
    // 同一层内的任务并行执行
    const promises = layer.map(async (taskId) => {
      const node = graph.nodes.find(n => n.taskId === taskId)!;

      // 解析参数引用（将 $t1.result 替换为实际结果）
      const resolvedParams = this.resolveParams(node.params, results);

      // 派发任务到 TaskQueue
      const task = await this.taskQueue.addTask({
        content: node.content,
        skillName: node.skillName,
        params: resolvedParams,
      });

      // 等待任务完成
      const result = await this.waitForTaskCompletion(task.id);
      results.set(taskId, result);
      return { taskId, result };
    });

    const layerResults = await Promise.all(promises);

    // 检查是否有任务需要用户输入
    for (const { taskId, result } of layerResults) {
      if (result?.data?.status === 'waiting_user_input') {
        // 保存当前执行进度，等待用户回复后继续
        await this.saveExecutionProgress(request, graph, results, layer);
        return { type: 'waiting', ... };
      }
    }

    // 检查是否需要重规划（某任务失败且可重试）
    if (layerResults.some(r => r.result?.success === false)) {
      const replanResult = await this.replan(graph, results, layerResults);
      if (replanResult.modified) {
        // 使用新计划继续执行
        graph = replanResult.newGraph;
      }
    }
  }

  return results;
}
```

**关键设计**：
- **分层并行**：同一层内的任务并行执行，层与层之间串行
- **参数传递**：上游任务的输出通过 `$taskId.result` 引用传递给下游任务
- **断点续传**：任务等待用户输入时保存执行进度，用户回复后从断点恢复
- **动态重规划**：某层任务失败时，可选择重规划后续步骤

#### 阶段三：Summarize（汇总）

所有任务执行完毕后，主智能体进行结果汇总：

```typescript
async summarizeResults(
  originalRequirement: string,
  taskResults: Map<string, any>,
  request: Request
): Promise<{ completed: boolean; summary: string }> {
  // 构建汇总 prompt
  const resultsContext = Array.from(taskResults.entries())
    .map(([taskId, result]) => `任务 ${taskId}: ${JSON.stringify(result?.data?.response || result)}`)
    .join('\n');

  const summaryPrompt = `
用户原始需求: ${originalRequirement}

以下是各子任务的执行结果:
${resultsContext}

请判断:
1. 所有子任务的结果是否已经完整满足了用户的需求？
2. 如果满足，请生成一段简洁的汇总回复
3. 如果不满足，请说明还需要执行什么操作

输出格式:
{
  "completed": true/false,
  "summary": "汇总文本",
  "nextSteps": ["如果未完成，需要执行的后续步骤"]
}
`;

  const judgment = await this.llm.generateStructured(summaryPrompt, judgmentSchema);

  if (judgment.completed) {
    // 更新 request.result
    request.result = judgment.summary;
    request.status = 'completed';
  } else {
    // 根据判断结果，可能需要派发新任务
    // 这里可以递归调用 executeTaskGraph
  }

  return judgment;
}
```

**关键设计**：
- **原始需求驱动**：汇总时将用户原始需求作为判断标准，而非简单地"所有任务完成=请求完成"
- **结构化判断**：通过 LLM 输出结构化的 `completed` + `summary`，而非依赖自然语言
- **闭环能力**：如果判断未完成，可以触发新一轮任务派发

### 3.3 完整流程图

```
用户输入
  |
  v
┌─────────────────────────────────────────────────┐
│  MainAgent.processRequirement()                  │
│                                                  │
│  1. RequestManager.handleUserInput()             │
│     ├─ 等待请求? → 延续判断 → continue/recall    │
│     └─ 新请求? → 继续                             │
│                                                  │
│  2. IntentRouter.classify()                      │
│     └─ 输出: TaskGraph（含依赖关系）              │
│                                                  │
│  3. executeTaskGraph(graph)                       │
│     ├─ Layer 0: [t1] ──并行──→ 完成              │
│     │   └─ t1 等待用户? → 保存进度, return        │
│     ├─ Layer 1: [t2] ──依赖 t1──→ 完成           │
│     │   └─ t2 等待用户? → 保存进度, return        │
│     └─ 所有层完成                                 │
│                                                  │
│  4. summarizeResults()                           │
│     ├─ completed=true → request.result = summary  │
│     └─ completed=false → 派发新任务, 回到步骤 3   │
│                                                  │
│  5. 返回最终结果给用户                            │
└─────────────────────────────────────────────────┘
```

### 3.4 与现有架构的兼容性

| 现有组件 | 改动 | 兼容性 |
|---------|------|--------|
| IntentRouter | 增强输出格式（增加 dependencies 字段） | 向后兼容 |
| TaskQueue | 不变 | 完全兼容 |
| SubAgent | 不变 | 完全兼容 |
| SessionStore | 增加 `executionProgress` 字段到 Request | 向后兼容 |
| MainAgent | 改造 `processNormalRequirement` 和 `monitorAndReplan` | 核心改动 |
| RequestManager | 不变 | 完全兼容 |

### 3.5 渐进式实施路径

**Phase 1（最小改动，解决 result 为空的问题）**：
- 在 `processNormalRequirement` 中，所有任务完成后调用 `summarizeResults()`
- 不改变任务编排方式（仍为一次性并行派发）
- 预计改动量：~50 行

**Phase 2（支持串行依赖）**：
- 增强 IntentRouter 输出 TaskGraph（含 dependencies）
- 改造 `monitorAndReplan` 为分层执行
- 支持参数引用（`$taskId.result`）
- 预计改动量：~200 行

**Phase 3（支持动态重规划和断点续传）**：
- 任务失败时触发重规划
- 等待用户输入时保存/恢复执行进度
- 预计改动量：~150 行

---

## 四、关键设计决策

### 4.1 为什么选择 Plan-Execute-Summarize 而非纯 ReAct？

| 维度 | ReAct（Claude Code 模式） | Plan-Execute-Summarize |
|------|--------------------------|----------------------|
| 适用场景 | 通用编码助手（工具调用密集） | 业务技能驱动（技能调用稀疏但结果重要） |
| 任务粒度 | 细粒度（读文件、写文件、运行命令） | 粗粒度（一个技能调用=一个完整业务操作） |
| 结果重要性 | 过程重要（用户看代码变更过程） | 结果重要（用户只关心最终答案） |
| 上下文消耗 | 高（每步都要完整上下文） | 低（只在规划/汇总时需要 LLM） |
| 成本 | 高（多次 LLM 调用） | 低（规划1次 + 汇总1次 + 每任务1次） |

**结论**：我们的场景是**技能驱动的业务助手**，每个子任务是一个完整的业务操作（如"查询班级信息"），而非细粒度的工具调用。Plan-Execute-Summarize 更适合。

### 4.2 为什么结果汇总由主智能体做而非子智能体？

- 子智能体只负责执行单个技能，它不知道全局需求
- 主智能体持有用户原始需求，能判断结果是否满足需求
- 与 Claude Code 的"模型自行综合"不同，我们的子 Agent 是隔离的（看不到父 Agent 上下文），必须由主智能体做汇总

### 4.3 为什么用结构化 TaskGraph 而非 LLM 自主决策？

- LLM 自主决策（ReAct 模式）在每一步都需要完整上下文，成本高
- 结构化 TaskGraph 可以预计算执行顺序，支持并行优化
- 结构化数据更容易做断点续传和进度追踪
- 对于业务场景，任务间的依赖关系通常是确定性的（先查数据再计算），不需要 LLM 每步重新判断

---

## 五、参考来源

- [Claude Code 源码分析 — Agent Loop 机制](https://github.com/anthropics/claude-code)
- [OpenCode 架构深度解析](https://juejin.cn/post/7592170706026266659)
- [OpenAI Codex CLI Agent Loop 拆解](https://github.com/openai/codex)
- [Aider Repo Map 官方文档](https://aider.chat/docs/repomap.html)
- [AI Agent 三种设计范式: ReAct、Plan & Execute、Multi-Agent](https://toutiao.com/group/7615526331576631846/)
- [LangGraph 构建 AI Agent](https://juejin.cn/post/7545071098758807602)
- [从 ReAct 到 Ralph Loop: AI Agent 的持续迭代范式](https://toutiao.com/group/7599589996558828084/)
