# Multi-Agent Collaboration System

多智能体协作系统 —— 主智能体负责需求分析、任务分派与调度，子智能体负责按技能执行任务。

**技术栈**: TypeScript + Bun 运行时 + Express HTTP 框架 + Zod Schema 校验

---

## 目录

- [系统架构](#系统架构)
  - [整体架构图](#整体架构图)
  - [项目结构](#项目结构)
  - [核心设计原则](#核心设计原则)
- [主智能体 (MainAgent)](#主智能体-mainagent)
  - [核心职责](#核心职责)
  - [processRequirement 主流程](#processrequirement-主流程)
  - [关键设计决策](#关键设计决策)
- [子智能体 (SubAgent)](#子智能体-subagent)
  - [核心职责](#核心职责)
  - [执行流程](#执行流程)
  - [参数获取优先级](#参数获取优先级)
- [任务调度 (TaskQueue)](#任务调度-taskqueue)
  - [核心特性](#核心特性)
  - [调度流程](#调度流程)
- [意图路由 (IntentRouter)](#意图路由-intentrouter)
  - [多层信号收集](#多层信号收集)
  - [快速路径 vs LLM 路径](#快速路径-vs-llm-路径)
- [统一规划器 (UnifiedPlanner)](#统一规划器-unifiedplanner)
- [工具体系](#工具体系)
  - [工具接口设计](#工具接口设计)
  - [已注册工具一览](#已注册工具一览)
- [记忆与上下文系统](#记忆与上下文系统)
  - [三层记忆架构](#三层记忆架构)
  - [四层上下文压缩](#四层上下文压缩)
  - [动态上下文构建](#动态上下文构建)
- [技能注册表 (SkillRegistry)](#技能注册表-skillregistry)
  - [渐进式披露设计](#渐进式披露设计)
  - [技能文件结构](#技能文件结构)
- [LLM 客户端](#llm-客户端)
  - [多 Provider 支持](#多-provider-支持)
  - [可靠性机制](#可靠性机制)
- [通信协议与数据流](#通信协议与数据流)
  - [MainAgent ↔ SubAgent 通信](#mainagent--subagent-通信)
  - [SubAgent ↔ 工具通信](#subagent--工具通信)
  - [前端 ↔ API 通信 (SSE)](#前端--api-通信-sse)
  - [LLM 事件系统](#llm-事件系统)
- [保底机制 (Fallback)](#保底机制-fallback)
- [API 接口](#api-接口)
- [会话管理](#会话管理)
- [配置](#配置)
- [快速开始](#快速开始)

---

## 系统架构

### 整体架构图

```
用户请求
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  API 层 (Express + SSE)                                         │
│  POST /tasks/stream → event: start/step/reasoning/complete/error│
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  MainAgent (规划与调度中枢)                                      │
│                                                                 │
│  ① 图片分析 (VisionLLMClient)                                   │
│  ② 上下文加载 (UserProfile + Memory + SessionContext)            │
│  ③ 意图路由 (IntentRouter) ──→ small_talk / confirm / unclear   │
│  ④ 任务规划 (UnifiedPlanner) ──→ 单任务直接 / 多任务 LLM 规划    │
│  ⑤ 任务调度 (TaskQueue) ──→ DAG 依赖 + 并发控制                 │
│  ⑥ 结果汇总 + 持久化                                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ submitPlanTasks()
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  TaskQueue (调度引擎)                                           │
│                                                                 │
│  • DAG 依赖管理 (DFS 循环检测)                                   │
│  • 并发控制 (MAX_CONCURRENT_SUBAGENTS = 5)                      │
│  • 任务状态机: pending → running → completed / failed            │
│  • 超时处理 (AbortController, 默认 400s)                         │
│  • 失败传播 (级联标记依赖任务)                                    │
│  • 自动清理 (每 5 分钟清理已完成/失败 > 1h 的任务)               │
└──────────────────────────┬──────────────────────────────────────┘
                           │ executeTask(task)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  SubAgent (纯执行层)                                            │
│                                                                 │
│  ① 加载技能定义 (SkillRegistry.loadFullSkill)                   │
│  ② 构建 System Prompt (技能说明 + 参数 + 保底规则)               │
│  ③ 注册可用工具列表 (10 个工具)                                  │
│  ④ LLM 工具调用循环 (generateWithTools, maxIterations=5)        │
│  ⑤ 返回最终文本响应                                              │
└─────────────────────────────────────────────────────────────────┘
```

### 项目结构

```
src/
├── index.ts                  # 应用入口，bootstrap 初始化流程
├── agents/
│   ├── main-agent.ts         # 主智能体（规划层）
│   └── sub-agent.ts          # 子智能体（执行层）
├── api/
│   └── index.ts              # Express HTTP API 层（SSE 流式支持）
├── config/
│   └── fallback.ts           # 保底机制配置加载器
├── context/
│   ├── dynamic-context.ts    # 动态上下文构建器
│   └── claude-md-loader.ts   # CLAUDE.md 加载器
├── llm/
│   ├── index.ts              # LLM 客户端（多 provider 支持）
│   └── vision-client.ts      # 视觉模型客户端（GLM-4V）
├── memory/
│   ├── memory-service.ts     # 统一记忆服务
│   ├── conversation-memory.ts # 对话历史持久化
│   ├── session-context.ts    # 短期会话上下文（内存）
│   ├── auto-compact.ts       # 四层上下文压缩服务
│   └── types.ts              # 记忆类型定义
├── planners/
│   └── unified-planner.ts    # 统一规划器（合并分析+匹配+规划）
├── prompts/
│   ├── main-agent.ts         # 主智能体/匹配器/规划器/重规划器 Prompt
│   ├── sub-agent.ts          # 子智能体 Prompt
│   └── index.ts              # Prompt 导出
├── routers/
│   └── intent-router.ts      # 意图路由器（快速路径 + LLM 判断）
├── skill-registry/
│   └── index.ts              # 技能注册表（渐进式披露）
├── task-queue/
│   └── index.ts              # 任务队列（DAG 调度 + 并发控制）
├── tools/
│   ├── interfaces.ts         # 工具接口定义
│   ├── base-tool.ts          # 工具抽象基类
│   ├── tool-registry.ts      # 工具注册表
│   ├── file-read-tool.ts     # 文件读取工具
│   ├── bash-tool.ts          # Shell 命令工具
│   ├── glob-tool.ts          # 文件模式匹配工具
│   ├── grep-tool.ts          # 文件内容搜索工具
│   ├── write-tool.ts         # 文件写入工具
│   ├── edit-tool.ts          # 文件编辑工具
│   ├── context-tool.ts       # 上下文管理工具
│   └── vision-analyze-tool.ts # 视觉分析工具
├── types/
│   ├── index.ts              # 核心类型定义 + CONFIG 常量 + Zod Schema
│   └── requirement-types.ts  # 需求拆解类型定义
└── user-profile/
    └── index.ts              # 用户画像服务
```

### 核心设计原则

| 原则 | 说明 |
|------|------|
| **规划-执行分离** | MainAgent 只规划不执行，SubAgent 只执行不规划 |
| **渐进式披露** | SkillRegistry 启动时只加载元数据，执行时才加载完整内容 |
| **保守默认策略** | BaseTool 的 isConcurrencySafe / isReadOnly 默认 false |
| **事件驱动** | LLMEventEmitter 实时推送推理过程到前端 |
| **熔断器** | AutoCompactService 连续失败 3 次停止压缩 |
| **DAG 调度** | TaskQueue 基于依赖关系的任务调度 + 循环检测 |
| **策略模式** | IntentRouter 快速路径（正则） vs LLM 路径 |
| **依赖注入** | LLMClient、SkillRegistry、TaskQueue 通过构造函数注入 |

---

## 主智能体 (MainAgent)

主智能体是整个系统的 **规划与调度中枢**，不执行具体任务。

### 核心职责

1. **需求接收与预处理** — 接收用户输入，处理图片附件（调用 VisionLLMClient 分析）
2. **上下文加载与注入** — 加载用户画像、对话历史、动态上下文
3. **意图路由** — 通过 IntentRouter 分类用户意图
4. **任务规划** — 单任务直接创建计划，多任务调用 UnifiedPlanner
5. **任务调度与监控** — 提交任务到 TaskQueue，轮询等待完成
6. **失败重规划** — 最多 3 次重规划（replan），仅对 RETRYABLE 错误重试
7. **结果汇总与持久化** — 合并子任务结果，保存交互记录

### processRequirement 主流程

```
用户请求
  │
  ├─ [步骤1] 图片分析（如有附件）→ VisionLLMClient.analyzeImage()
  │
  ├─ [步骤2] 上下文加载
  │   ├─ 加载用户画像 (UserProfileService)
  │   ├─ 加载对话历史 (MemoryService)
  │   ├─ 微压缩 (microCompact) → 清除 >5min 的工具结果
  │   ├─ 自动压缩 (checkAndCompact) → tokens > 167K 时 LLM 摘要
  │   ├─ 加载 SessionContext（当前会话状态）
  │   └─ 构建动态上下文 (DynamicContextBuilder)
  │
  ├─ [步骤3] 意图路由 (IntentRouter.classify)
  │   ├─ small_talk → 直接返回闲聊回复
  │   ├─ confirm_system → 返回确认问题
  │   ├─ unclear → 返回转人工消息
  │   └─ skill_task → 继续处理
  │
  ├─ [步骤4] 任务规划
  │   ├─ 单任务 → 直接构建 TaskPlan
  │   └─ 多任务 → UnifiedPlanner.plan()（一次 LLM 调用）
  │
  ├─ [步骤5] 任务执行 (monitorAndReplan)
  │   ├─ submitPlanTasks() → 提交到 TaskQueue
  │   ├─ waitForCompletion() → 轮询等待（指数退避 100ms→1s）
  │   └─ 失败时 replan() → 最多 3 次
  │
  └─ [步骤6] 结果汇总
      ├─ 合并所有子任务响应
      ├─ 更新用户画像
      ├─ 保存交互记录
      └─ 返回最终结果
```

### 关键设计决策

- **规划与执行分离**: MainAgent 绝不直接调用工具，所有具体操作通过 SubAgent 执行
- **指数退避轮询**: `waitForCompletion` 使用 100ms 起步、最大 1s 的指数退避轮询机制
- **重规划机制**: `monitorAndReplan` 实现了最多 3 次的自动重规划循环，仅对 RETRYABLE 错误重试
- **复合需求处理**: 支持一个用户请求中包含多个技能任务（如"帮我查报销和请假"）
- **转人工与技能任务并行**: 检测到转人工请求时，仍会执行已匹配的技能任务，结果中合并转人工提示

---

## 子智能体 (SubAgent)

子智能体是 **纯执行层**，负责加载技能、构建 Prompt、通过 LLM function calling 驱动工具调用。

### 核心职责

1. 从 SkillRegistry 加载技能的完整定义（SKILL.md body）
2. 构建子智能体 System Prompt（注入技能说明 + 已获取参数 + 保底规则）
3. 注册可用工具列表，通过 LLM function calling 驱动工具调用
4. 执行工具调用循环（最多 5 轮工具调用迭代）
5. 返回最终文本响应

### 执行流程

```
SubAgent.execute(task)
  │
  ├─ 加载技能 (skillRegistry.loadFullSkill)
  │
  ├─ 构建 System Prompt
  │   ├─ SUB_AGENT_BASE_PROMPT（基础指令）
  │   ├─ 技能说明 body（从 SKILL.md 加载）
  │   ├─ 技能根目录路径
  │   ├─ 已获取参数（从 task.params 传入）
  │   └─ 保底规则（从 config/fallback.md 加载）
  │
  ├─ 注册工具列表（10 个工具）
  │   ├─ context-get / context-set / context-get-all
  │   ├─ conversation-get
  │   ├─ bash / read / write / edit / glob / grep
  │   └─ vision-analyze
  │
  └─ LLM 工具调用循环 (generateWithTools, maxIterations=5)
      ├─ LLM 返回 content → 直接返回
      └─ LLM 返回 tool_calls → 执行工具 → 将结果回传 LLM → 继续循环
```

### 参数获取优先级

子智能体 Prompt 中定义了严格的参数获取优先级，避免重复询问用户：

```
1. 检查「已获取参数」(task.params) → 主智能体已提取的参数
2. 调用 context-get → 会话上下文中缓存的参数
3. 调用 conversation-get → 从对话历史中提取
4. 最后才询问用户
```

---

## 任务调度 (TaskQueue)

TaskQueue 是系统的 **调度引擎**，实现 DAG 依赖管理与并发控制。

### 核心特性

| 特性 | 说明 |
|------|------|
| **DAG 依赖管理** | 支持任务间的依赖关系，使用 DFS 检测循环依赖 |
| **并发控制** | 最大 5 个并发子智能体（`MAX_CONCURRENT_SUBAGENTS = 5`） |
| **任务状态机** | `pending → running → completed / failed` |
| **超时处理** | 每个任务有独立超时（默认 400s），使用 AbortController 中止 |
| **失败传播** | 父任务失败时，级联标记所有依赖任务为失败 |
| **自动清理** | 每 5 分钟清理已完成/失败超过 1 小时的任务 |
| **结果大小限制** | 单个任务结果最大 1MB，超出则截断 |

### 调度流程

```
addTask(task)
  │
  ├─ 校验：队列未满（max 100）、无循环依赖
  │
  ├─ 记录依赖关系（dependencies / dependents 双向关联）
  │
  └─ processQueue()
      │
      ├─ findReadyTasks() — 找出所有依赖已完成的 pending 任务
      │   └─ 跳过无 skillName 的任务（仅跟踪任务）
      │
      ├─ 按创建时间排序（FIFO）
      │
      └─ 对每个就绪任务（不超过并发上限）
          └─ executeTask(task)
              ├─ 设置 AbortController 超时
              ├─ 调用 executor（即 SubAgent.execute）
              ├─ 成功 → completeTask → notifyDependents
              └─ 失败 → failTask → failDependents（级联失败）
```

### 与 MainAgent 的交互模式

采用 **推-拉结合** 模式：

- **推**: MainAgent 将任务推入 TaskQueue（`submitPlanTasks`）
- **拉**: MainAgent 轮询 TaskQueue 中任务状态（`waitForCompletion`，指数退避 100ms→1s）

---

## 意图路由 (IntentRouter)

IntentRouter 负责对用户输入进行意图分类，采用 **快速路径 + LLM 综合判断** 的双层策略。

### 多层信号收集

在分类前收集多个辅助信号，辅助 LLM 做出更准确的判断：

| 优先级 | 信号 | 置信度范围 | 说明 |
|--------|------|-----------|------|
| 0 | 用户输入的系统名 | 0.90-1.00 | 直接匹配 systemName |
| 1 | Session Context 当前技能 | 0.70-0.90 | 当前会话激活的技能（随轮次衰减） |
| 2 | 关键词命中 | 0.70-0.88 | 从技能 metadata.keywords 匹配 |
| 3 | 历史技能 | 0.60-0.75 | 上一个会话使用的技能 |
| 4 | 用户画像 | 0.50-0.65 | 统计信息，参考价值低 |

### 快速路径 vs LLM 路径

```
classify(userInput)
  │
  ├─ 收集所有信号 (collectSignals)
  │
  ├─ 决策引擎 (decide)
  │   ├─ 快速闲聊匹配 → 正则匹配 7 种闲聊模式 → 直接返回（无 LLM 调用）
  │   └─ 超出范围匹配 → 正则匹配 30+ 种超出范围模式 → 直接返回
  │
  └─ LLM 综合判断 (llmMatchSkillWithSignals)
      ├─ 构建 Prompt（包含对话历史 + 辅助信号 + 技能列表 + 保底规则）
      ├─ 调用 LLM（generateStructured，Zod Schema 校验）
      └─ 返回 IntentResult（intent + tasks + confidence）
```

**意图类型**: `skill_task` | `small_talk` | `confirm_system` | `out_of_scope` | `unclear`

**闲聊快速应答**: 预定义 7 种闲聊模式正则匹配（问候、同理心、身份、感谢、告别、帮助、能力查询），匹配后直接返回模板化回复，无需 LLM 调用，大幅降低延迟。

---

## 统一规划器 (UnifiedPlanner)

UnifiedPlanner 是性能优化的产物，将原来的 3-4 次 LLM 调用合并为 **1 次**：

```
优化前: IntentRouter.classify() + analyzeRequirement() + discoverSkills() + createPlan()
优化后: IntentRouter.classify() + UnifiedPlanner.plan()  （仅 2 次 LLM 调用）
```

**输出 Schema** (Zod 校验):

```typescript
const UnifiedPlanSchema = z.object({
  analysis: z.object({ summary, entities, intent }).optional(),
  skillSelection: z.any(),  // 支持数组或对象两种格式
  plan: z.object({
    needsClarification: z.boolean().optional(),
    clarificationPrompt: z.string().optional(),
    tasks: z.array(z.any()),
  }),
});
```

规划器会验证选中的技能是否存在，处理多种字段名格式（`skillName`/`skill`、`requirement`/`description`），确保健壮性。

---

## 工具体系

### 工具接口设计

所有工具实现 `Tool` 接口，继承自 `BaseTool` 抽象类：

```typescript
interface Tool {
  name: string;
  description: string;
  parameters?: ToolParameters;
  required?: string[];
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
  isConcurrencySafe(input: unknown): boolean;  // 默认 false（保守策略）
  isReadOnly(): boolean;                       // 默认 false（保守策略）
}
```

**关键设计**: `BaseTool` 采用 **保守默认策略** — `isConcurrencySafe()` 和 `isReadOnly()` 默认都返回 `false`，子类必须显式声明为安全才允许并发。

### 已注册工具一览

| 工具名 | 类型 | 并发安全 | 只读 | 用途 |
|--------|------|:--------:|:----:|------|
| `context-get` | 上下文 | ✅ | ✅ | 获取会话参数 |
| `context-get-all` | 上下文 | ✅ | ✅ | 获取所有会话参数 |
| `context-set` | 上下文 | ✅ | ❌ | 保存会话参数 |
| `conversation-get` | 上下文 | ✅ | ✅ | 获取对话历史 |
| `bash` | 文件/命令 | ❌ | ❌ | 执行 Shell 命令 |
| `read` | 文件 | ✅ | ✅ | 读取文件 |
| `write` | 文件 | ❌ | ❌ | 写入文件 |
| `edit` | 文件 | ❌ | ❌ | 编辑文件 |
| `glob` | 文件 | ✅ | ✅ | 文件模式匹配 |
| `grep` | 文件 | ✅ | ✅ | 文件内容搜索 |
| `vision-analyze` | 视觉 | ✅ | ✅ | 图片分析 |

---

## 记忆与上下文系统

### 三层记忆架构

| 层级 | 组件 | 存储 | 生命周期 | 用途 |
|------|------|------|---------|------|
| L1 | SessionContextService | 内存 (Map) | 会话级（30分钟过期） | 当前对话窗口状态、临时变量 |
| L2 | ConversationMemoryService | 文件系统 (JSON) | 持久化（滑动窗口） | 对话历史记录 |
| L3 | UserProfileService | 文件系统 (JSON) | 永久 | 用户画像（部门、常用系统、标签） |

### 四层上下文压缩

AutoCompactService 实现了递进式压缩策略，根据上下文压力自动选择最轻量的方案：

| 层级 | 触发条件 | 操作 | 成本 |
|------|---------|------|------|
| **MICRO** | 工具结果 > 5 分钟 | 替换为占位符 | 零 |
| **AUTO** | tokens > 167K | LLM 摘要压缩 | 高 |
| **SESSION** | 会话结束 | 会话级压缩 | 中 |
| **REACTIVE** | 上下文压力 | 响应式压缩 | 可变 |

**熔断器**: 连续失败 3 次后停止压缩，防止级联故障。

**Token 估算**: `字符数 / 4`，准确率约 85%。

### 动态上下文构建

DynamicContextBuilder 将用户画像和对话历史格式化为 Markdown 注入到 Prompt 中：

```markdown
## 用户上下文

### 用户画像
- **用户ID**: user123
- **部门**: 研发部
- **常用系统**: EES, GEAM
- **对话次数**: 15

### 对话历史
[最近对话摘要...]
```

---

## 技能注册表 (SkillRegistry)

### 渐进式披露设计

- **扫描阶段**: 只解析 YAML frontmatter（metadata），不加载 body
- **执行阶段**: 按需加载完整 SKILL.md 内容（`loadFullSkill`）

这避免了启动时加载大量技能文档的内存开销。

### 技能文件结构

```
skills/
├── {skill-name}/
│   ├── SKILL.md           # 技能定义（YAML frontmatter + Markdown body）
│   ├── references/        # 知识库文档
│   │   ├── permission.md
│   │   └── login.md
│   └── scripts/           # 执行脚本（可选）
```

### 技能元数据

```typescript
interface SkillMetadata {
  name: string;           // 技能名称
  description: string;    // 技能描述
  metadata?: {
    systemName: string;   // 系统名（精确匹配用）
    keywords: string[];   // 关键词（模糊匹配用）
    trigger: string;      // 触发场景
    exclude: string;      // 排除条件
  };
  allowedTools?: string[];    // 允许使用的工具
  requiredFields?: string[];  // 需要从用户对话中提取的参数
  hidden?: boolean;           // 是否隐藏
}
```

---

## LLM 客户端

### 多 Provider 支持

| Provider | 默认模型 | 特性 |
|----------|---------|------|
| OpenRouter | qwen/qwen3.6-plus-preview:free | 推理 + 流式 |
| NVIDIA | minimax-m2.5 | 流式 |
| Zhipu (智谱) | glm-4.7-flash | 推理 + 流式 |
| SiliconFlow | MiniMax-M2.5 | 流式 |

### 核心方法

| 方法 | 用途 | 使用者 |
|------|------|--------|
| `generateText()` | 纯文本生成 | AutoCompactService |
| `generateStructured()` | 结构化输出（Zod Schema 校验） | IntentRouter, UnifiedPlanner, MainAgent.replan |
| `generateWithTools()` | 工具调用循环（最多 5 轮） | SubAgent |

### 可靠性机制

- **指数退避重试**: 最多 3 次，基础延迟 2s/4s/8s + 随机抖动
- **超时控制**: 默认 120s，通过 AbortController 实现
- **错误分类**: RATE_LIMIT / TIMEOUT / INVALID_KEY / API_ERROR / NETWORK_ERROR
- **推理内容捕获**: 通过 `llmEvents` 实时发射 `reasoning_content` 供前端展示

---

## 通信协议与数据流

### MainAgent ↔ SubAgent 通信

通信是 **间接的**，通过 TaskQueue 解耦。MainAgent 和 SubAgent 在同一进程内运行，通过 TaskQueue 的内存数据结构（Map）共享任务状态。

```
MainAgent                          TaskQueue                          SubAgent
   │                                  │                                  │
   ├─ submitPlanTasks(tasks) ────────>│                                  │
   │                                  ├─ executeTask(task) ────────────>│
   │                                  │                                  ├─ loadSkill()
   │                                  │                                  ├─ buildPrompt()
   │                                  │                                  ├─ LLM + Tools
   │                                  │<───────── result ───────────────┤
   │<───── poll (getTask status) ────│                                  │
```

### SubAgent ↔ 工具通信

SubAgent 通过 LLM function calling 机制与工具交互：

```
SubAgent → LLM API (带 tools 定义)
LLM API → 返回 tool_calls
SubAgent → ToolRegistry.execute(toolName, arguments, context)
ToolRegistry → 具体工具.execute(input, context)
结果 → 回传 LLM → 继续循环（最多 5 轮）
```

### 前端 ↔ API 通信 (SSE)

主要使用 **SSE (Server-Sent Events)** 流式接口：

```
POST /tasks/stream
  ├─ event: start     → 开始处理
  ├─ event: step      → 处理步骤（捕获 MainAgent/SubAgent/IntentRouter 日志）
  ├─ event: reasoning → LLM 思考过程（通过 llmEvents 事件系统）
  ├─ event: complete  → 最终结果
  └─ event: error     → 错误信息
```

### LLM 事件系统

`LLMEventEmitter` 是一个全局事件发射器，用于追踪 LLM 的推理过程：

```typescript
class LLMEventEmitter {
  setAgent(agent: 'MainAgent' | 'SubAgent'): void;  // 切换当前 Agent 标识
  emit(event: 'reasoning' | 'response', data: string): void;
  on(event, callback): void;
  off(event, callback): void;
}
```

SubAgent 在执行前设置 `llmEvents.setAgent('SubAgent')`，执行后恢复，使得 API 层可以区分推理事件来自哪个 Agent。

---

## 保底机制 (Fallback)

保底规则通过 Markdown 配置文件管理，注入到 IntentRouter 和 SubAgent 的 System Prompt 中。

**触发条件：**
- **显式转人工**: 用户说"转人工/转工程师"时直接触发
- **被动转人工**: 知识库检索 2 次无结果 / 追问超过 2 次
- **反问约束**: 最多追问 2 次，禁止跨域提问，禁止猜测
- **技能匹配规则**: 精确匹配优先，用户否定后终止猜测
- **复合场景**: 当前有技能任务时，"转人工XXX"需返回 2 个任务（转人工 + 新技能）

可通过环境变量 `FALLBACK_CONFIG` 切换不同业务的保底规则：

```bash
FALLBACK_CONFIG=fallback.md    # 运维业务（默认）
FALLBACK_CONFIG=ecommerce.md   # 电商业务
```

---

## API 接口

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | /health | 健康检查 |
| GET | /skills | 列出所有技能 |
| POST | /tasks/stream | SSE 流式任务提交 |
| GET | /tasks/:id | 任务状态 |
| GET | /tasks/:id/result | 任务结果 |
| DELETE | /tasks/:id | 取消任务 |

### 请求格式

```json
{
  "userId": "user-xxx",
  "sessionId": "session-xxx",
  "requirement": "用户需求描述"
}
```

### 响应格式

**技能任务：**
```json
{
  "results": [
    {
      "taskId": "plan-xxx-task-1",
      "skillName": "geam-qa",
      "requirement": "申请GEAM权限",
      "response": "您好！请问您要登录系统操作什么？...",
      "status": "completed"
    }
  ],
  "type": "skill_task"
}
```

**转人工：**
```json
{
  "message": "您好，我帮您转到人工这边...",
  "type": "unclear"
}
```

**确认系统：**
```json
{
  "message": "您提到的'BCC系统'，请问具体是哪个系统？",
  "type": "confirm_system"
}
```

---

## 会话管理

每个浏览器窗口独立：
- `userId`: `user-{时间戳}-{随机6位}`
- `sessionId`: `session-{时间戳}`

| 层级 | 组件 | 存储 | 生命周期 |
|------|------|------|---------|
| L1 | SessionContextService | 内存 (Map) | 会话级（30分钟过期） |
| L2 | ConversationMemoryService | 文件系统 (JSON) | 持久化（滑动窗口） |
| L3 | UserProfileService | 文件系统 (JSON) | 永久 |

---

## 配置

### 环境变量

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| ZHIPU_API_KEY | 智谱 API Key | - |
| NVIDIA_API_KEY | NVIDIA API Key | - |
| OPENROUTER_API_KEY | OpenRouter API Key | - |
| LLM_PROVIDER | LLM 提供商 | zhipu |
| LLM_MODEL | 模型名称 | glm-4.5-air |
| FALLBACK_CONFIG | 保底机制配置文件 | fallback.md |

### 系统常量

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| MAX_CONCURRENT_SUBAGENTS | 5 | 最大并发子智能体数 |
| MAX_QUEUE_SIZE | 100 | 任务队列最大容量 |
| MAX_REPLAN_ATTEMPTS | 3 | 最大重规划次数 |
| TASK_TIMEOUT_MS | 400,000 (400s) | 单任务超时 |
| TOTAL_TIMEOUT_MS | 600,000 (600s) | 总工作流超时 |
| LLM_TIMEOUT_MS | 120,000 (120s) | LLM API 超时 |
| SCRIPT_TIMEOUT_MS | 180,000 (180s) | 脚本执行超时 |
| LLM_TEMPERATURE | 0.7 | 生成温度 |
| SKILL_DIRECTORY | ./skills/ | 技能目录 |

---

## 快速开始

```bash
# 安装
bun install

# 配置环境变量
cp .env.example .env
# 编辑 .env 添加 API Key

# 启动
bun run src/index.ts

# 测试页面
open http://localhost:3000/test.html
```
