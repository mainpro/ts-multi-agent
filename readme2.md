# ts-multi-agent 项目架构与设计理念

## 一、项目概述

**ts-multi-agent** 是一个基于 TypeScript 的多智能体协作系统，定位为**企业级智能运维助手后端服务**。系统通过 LLM（大语言模型）驱动工具调用，以技能（Skill）为核心执行单元，为用户提供自然语言交互的业务操作能力（如差旅报销、考勤查询、权限管理等）。

### 技术栈

| 层面 | 技术选型 |
|------|---------|
| 语言 | TypeScript 5.3（严格模式） |
| 运行时 | Bun / Node.js >= 18 |
| Web 框架 | Express 4.18 |
| Schema 校验 | Zod 3.22 |
| LLM 接入 | OpenRouter / NVIDIA / 智谱 / SiliconFlow（多 Provider） |
| 配置格式 | YAML（技能定义）+ dotenv（环境变量） |

---

## 二、核心功能总结

### 2.1 自然语言任务处理

用户通过 HTTP API 发送自然语言请求，系统自动完成意图识别 → 技能匹配 → 任务规划 → 执行 → 结果汇总的全流程。

### 2.2 多智能体协作

- **MainAgent（主智能体）**：负责需求分析、意图路由、任务规划、调度监控、失败重规划、结果汇总——只规划不执行
- **SubAgent（子智能体）**：负责加载技能、构建 Prompt、通过 LLM Function Calling 驱动工具调用——只执行不规划

### 2.3 技能系统

- 每个技能以 `SKILL.md` 文件定义（YAML 元数据 + Markdown 正文）
- 支持渐进式披露：启动时只加载元数据，执行时才加载完整内容
- 支持热重载：文件变更后自动重新扫描（fs.watch + 60s 兜底全量扫描）
- 支持工具白名单：每个技能可声明 `allowedTools` 限制可用工具

### 2.4 统一询问机制

系统实现了三层询问的统一处理：

| 询问类型 | 层级 | 场景 | 示例 |
|---------|------|------|------|
| `system_confirm` | 主智能体 | 不确定用户要使用哪个系统 | "请问您说的是哪个系统？" |
| `skill_confirm` | 主智能体 | 不确定用户要使用哪个技能 | "您是想查询还是提交？" |
| `skill_question` | 子智能体 | 技能执行中需要用户确认 | "请选择申请人：1. 张三 2. 李四" |

### 2.5 断点续执行

子智能体在等待用户输入时保存完整的 LLM 对话上下文和已完成的工具调用记录，用户回复后从断点恢复执行，避免重复操作。

### 2.6 会话持久化

通过 `SessionStore` 实现请求级别的持久化存储，支持服务重启后恢复会话上下文。

---

## 三、项目架构

### 3.1 整体架构图

```
用户请求 (HTTP/SSE)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                      API Layer (Express)                      │
│   POST /tasks/stream (SSE)  │  GET /tasks  │  GET /skills  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                     MainAgent (主智能体)                      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │RequestManager│  │ IntentRouter │  │ UnifiedPlanner   │  │
│  │ 延续判断/召回 │  │ 意图分类路由  │  │ 统一规划器       │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │MemoryService │  │UserProfile   │  │ DynamicContext   │  │
│  │ 三层记忆体系  │  │ 用户画像服务  │  │ 动态上下文构建    │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
│  Plan → Execute → Summarize (三阶段编排)                      │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                     TaskQueue (任务调度)                      │
│   DAG 依赖管理 │ 并发控制(max=5) │ 超时处理 │ 事件驱动       │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                     SubAgent (子智能体)                       │
│   加载技能 → 构建 Prompt → LLM Function Calling → 工具执行    │
│   断点续执行 │ 询问检测 │ 询问历史管理                         │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                     Tool System (工具体系)                    │
│  bash │ read │ write │ edit │ glob │ grep │ context │ vision  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                  Cross-cutting (横切关注点)                   │
│  Security (PathGuard+Sandbox) │ Observability (Log+Metrics)  │
│  Hooks (生命周期) │ AutoCompact (四层压缩) │ MCP Protocol     │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 源码模块一览

```
src/
├── index.ts                    # 应用入口（Bootstrap 初始化）
├── agents/
│   ├── main-agent.ts           # 主智能体：规划与调度中枢
│   ├── sub-agent.ts            # 子智能体：纯执行层
│   ├── request-manager.ts      # 请求生命周期管理器
│   ├── continuation-judge.ts   # 轻量延续判断器
│   └── task-recaller.ts        # 挂起任务召回器
├── api/
│   └── index.ts                # Express 路由 + SSE 流式接口
├── config/
│   └── fallback.ts             # 保底机制配置加载器
├── context/
│   ├── dynamic-context.ts      # 动态上下文构建器
│   └── claude-md-loader.ts     # CLAUDE.md 加载器
├── hooks/
│   ├── types.ts                # HookEvent 枚举 + HookContext 接口
│   └── hook-manager.ts         # 钩子管理器（全局单例）
├── llm/
│   ├── index.ts                # LLM 客户端（多 Provider + 并行工具执行）
│   ├── error-recovery.ts       # 错误恢复管理器
│   └── vision-client.ts        # 视觉模型客户端
├── mcp/
│   └── mcp-client.ts           # MCP 协议客户端（stdio + SSE）
├── memory/
│   ├── index.ts                # 统一导出
│   ├── memory-service.ts       # 统一记忆服务
│   ├── conversation-memory.ts  # 对话历史持久化
│   ├── session-context.ts      # 短期会话上下文（内存）
│   ├── session-store.ts        # 会话存储（持久化）
│   ├── auto-compact.ts         # 四层上下文压缩
│   └── token-counter.ts        # Token 精确计算
├── observability/
│   ├── logger.ts               # 结构化 JSON 日志
│   ├── log-manager.ts          # 日志管理器
│   └── metrics.ts              # Prometheus 指标采集
├── planners/
│   └── unified-planner.ts      # 统一规划器（合并分析+匹配+规划）
├── prompts/
│   ├── main-agent.ts           # 主智能体/匹配器/规划器 Prompt
│   ├── sub-agent.ts            # 子智能体 Prompt
│   ├── prompt-builder.ts       # Prompt 缓存构建器
│   └── session-context-prompt.ts # 会话上下文 Prompt
├── routers/
│   └── intent-router.ts        # 意图路由器（快速路径 + LLM 判断）
├── security/
│   ├── path-guard.ts           # 路径安全检查 + 危险命令拦截
│   └── sandbox.ts              # 沙箱隔离（bubblewrap）
├── skill-registry/
│   ├── index.ts                # 技能注册表（渐进式披露 + 热重载）
│   └── professional-skill-registry.ts # 专业技能注册表
├── task-queue/
│   └── index.ts                # 任务队列（DAG + 并发 + 事件驱动）
├── tools/
│   ├── interfaces.ts           # 工具接口定义
│   ├── base-tool.ts            # 工具抽象基类
│   ├── tool-registry.ts        # 工具注册表
│   ├── bash-tool.ts            # Shell 命令工具
│   ├── file-read-tool.ts       # 文件读取工具
│   ├── write-tool.ts           # 文件写入工具
│   ├── edit-tool.ts            # 文件编辑工具
│   ├── glob-tool.ts            # 文件模式匹配工具
│   ├── grep-tool.ts            # 文件内容搜索工具
│   ├── context-tool.ts         # 上下文管理工具
│   └── vision-analyze-tool.ts  # 视觉分析工具
├── types/
│   └── index.ts                # 核心类型定义 + CONFIG + Zod Schema
└── user-profile/
    └── index.ts                # 用户画像服务
```

---

## 四、设计理念

### 4.1 Plan-Execute-Summarize 三阶段架构

这是本项目最核心的架构决策。系统没有采用 Claude Code 式的 ReAct（反应式循环）模式，而是选择了结构化的三阶段编排：

| 阶段 | 职责 | LLM 调用 |
|------|------|---------|
| **Plan（规划）** | 意图识别 + 技能匹配 + 任务图生成 | 1-2 次 |
| **Execute（执行）** | 按任务图分层执行，子智能体驱动工具调用 | 每任务 1-N 次 |
| **Summarize（汇总）** | 判断结果是否满足需求，生成最终回复 | 1 次 |

**选择此架构的原因**：

1. **场景适配**：我们的场景是技能驱动的业务助手，每个子任务是完整的业务操作（如"查询班级信息"），而非细粒度的工具调用。粗粒度任务适合预先规划。
2. **成本控制**：ReAct 模式在每一步都需要完整上下文的 LLM 调用，成本高；三阶段架构只在规划/汇总时需要 LLM，执行阶段由子智能体独立完成。
3. **可靠性**：结构化 TaskGraph 可以预计算执行顺序、支持并行优化、断点续传和进度追踪，比 LLM 每步自主决策更可控。

### 4.2 规划-执行分离（Separation of Concerns）

主智能体和子智能体有严格的职责边界：

- **MainAgent** 只做规划、调度、汇总，不直接调用工具
- **SubAgent** 只做执行，不知道全局需求，看不到其他任务的存在

这种分离带来了：
- **可测试性**：子智能体可以独立测试单个技能的执行
- **可扩展性**：可以替换规划策略或执行引擎而不影响对方
- **上下文隔离**：子智能体不会因为其他任务的上下文而干扰执行

### 4.3 渐进式披露（Progressive Disclosure）

技能系统采用两阶段加载策略：

1. **扫描阶段**：只解析 `SKILL.md` 的 YAML frontmatter（元数据），用于意图匹配和规划
2. **执行阶段**：才加载完整的 Markdown 正文，注入到子智能体的 System Prompt

**好处**：
- 启动速度快：不需要加载所有技能的完整内容
- LLM 上下文节省：规划阶段不需要将所有技能正文放入 Prompt
- 内存友好：只有正在执行的技能才占用完整内容

### 4.4 信号驱动的意图识别

意图路由器（IntentRouter）采用**多信号融合 + 决策引擎**的设计：

```
信号来源                          置信度
├── 会话上下文 (Session Context)    0.70-0.90（随轮次衰减）
├── 关键词匹配 (Keyword Match)      0.70-0.90
├── 历史技能 (Historical Skill)     0.60-0.75
├── 用户画像 (User Profile)         0.60
└── LLM 综合判断                    由模型输出
```

决策引擎根据信号强度决定是否需要 LLM 调用：
- 高置信度信号（如活跃会话上下文）→ 直接路由，零 LLM 调用
- 闲聊模式（正则匹配）→ 快速应答，零 LLM 调用
- 低置信度 → 收集所有辅助信号交给 LLM 综合判断

### 4.5 统一询问机制

系统将主智能体层面的确认（system_confirm/skill_confirm）和子智能体层面的询问（skill_question）统一为一套数据结构和处理流程，通过 `RequestManager` 管理请求的完整生命周期：

```
新请求 → 意图识别 → 任务派发 → 等待用户输入 → 用户回复 → 继续执行 → 完成
              ↕                        ↕
         挂起/召回               断点续执行
```

### 4.6 四层上下文压缩

借鉴 Claude Code 的设计，实现了递进式的上下文管理：

| 层级 | 触发条件 | 策略 |
|------|---------|------|
| **MICRO** | 每次 LLM 调用前 | 清除超过 5 分钟的旧工具结果 |
| **AUTO** | Token > 167K（83.5% 窗口） | LLM 摘要压缩 + 关键上下文重注入 |
| **SESSION** | 会话级别 | 对话历史持久化 + 加载时裁剪 |
| **REACTIVE** | 上下文压力 | 熔断器保护（连续失败 3 次停止压缩） |

### 4.7 安全纵深防御

系统实现了三层安全机制：

1. **PathGuard**：路径安全检查，拦截系统级敏感路径（如 `/etc`、`~/.ssh`），警告项目级敏感路径
2. **allowedTools**：技能级工具白名单，每个技能只能使用声明的工具
3. **Sandbox**：bubblewrap 沙箱隔离，限制 Shell 命令的文件系统和网络访问

---

## 五、关键数据流

### 5.1 请求处理完整流程

```
1. 用户发送请求 → API Layer (POST /tasks/stream)
2. MainAgent.processRequirement()
   ├── RequestManager.handleUserInput()
   │   ├── 检查是否有挂起请求可召回
   │   ├── ContinuationJudge 判断是否延续回答
   │   └── 返回: continue | new_request | recall_prompt
   ├── [新请求] processNormalRequirement()
   │   ├── 加载上下文（用户画像 + 对话历史 + Session 上下文 + 动态上下文）
   │   ├── 四层压缩（microCompact → checkAndCompact）
   │   ├── IntentRouter.classify()
   │   │   ├── 快速路径：闲聊/超出范围（正则匹配，零 LLM）
   │   │   └── LLM 路径：多信号融合 + 结构化输出
   │   ├── [非技能意图] → handleNonSkillIntent() → 直接返回
   │   ├── [单任务] → 直接构建 TaskPlan
   │   ├── [多任务] → UnifiedPlanner.plan()（1 次 LLM 调用完成分析+匹配+规划）
   │   ├── buildTaskGraph()（Kahn 算法拓扑排序分层）
   │   ├── executeTaskGraph()
   │   │   ├── Layer 0: 并行执行 → 收集结果
   │   │   ├── 参数解析（$taskId.result 引用替换）
   │   │   ├── 等待用户输入 → 保存进度 → 返回
   │   │   └── Layer N: 依赖 Layer N-1 结果 → 执行
   │   └── summarizeResults()（LLM 判断是否满足需求）
   └── 返回最终结果（SSE 流式推送）
```

### 5.2 断点续执行流程

```
子智能体执行中 → 检测到需要用户输入
    │
    ├── 保存 LLM 对话上下文 (conversationContext)
    ├── 保存已完成的工具调用 (completedToolCalls)
    ├── 保存执行进度 (executionProgress)
    └── 返回 waiting_user_input 状态
         │
         ▼
用户回复 → RequestManager 识别为延续回答
    │
    ├── SubAgent 恢复对话上下文
    ├── 替换 System Prompt（包含最新询问历史）
    ├── 追加用户最新回复
    └── 继续执行（不重复已完成的工具调用）
```

---

## 六、工具体系

系统提供 11 个工具，分为只读和读写两类：

| 工具名 | 功能 | 并发安全 | 类型 |
|--------|------|:--------:|:----:|
| `read` | 文件读取 | ✅ | 只读 |
| `glob` | 文件模式匹配 | ✅ | 只读 |
| `grep` | 文件内容搜索 | ✅ | 只读 |
| `conversation-get` | 获取对话历史 | ✅ | 只读 |
| `context-get` | 获取上下文变量 | ✅ | 只读 |
| `context-get-all` | 获取所有上下文 | ✅ | 只读 |
| `bash` | Shell 命令执行 | ❌ | 读写 |
| `write` | 文件写入 | ❌ | 读写 |
| `edit` | 文件编辑 | ❌ | 读写 |
| `context-set` | 设置上下文变量 | ✅ | 读写 |
| `vision-analyze` | 图片视觉分析 | ✅ | 只读 |

**并发安全机制**：LLM 返回多个工具调用时，系统自动将只读工具并行执行，读写工具串行执行，避免竞态条件。

---

## 七、可观测性

### 7.1 日志系统

- 结构化 JSON 日志（`logger.ts`）
- 日志管理器支持按模块配置日志级别（`log-manager.ts`）

### 7.2 指标采集

- Prometheus 格式指标端点（`GET /metrics`）
- 内置指标：任务完成数、失败数、超时数、平均执行时间

### 7.3 生命周期钩子

8 种 Hook 事件覆盖完整请求生命周期：

| 事件 | 触发时机 |
|------|---------|
| `BEFORE_INTENT_CLASSIFY` | 意图分类前 |
| `AFTER_INTENT_CLASSIFY` | 意图分类后 |
| `BEFORE_TASK_EXECUTE` | 任务执行前 |
| `AFTER_TASK_EXECUTE` | 任务执行后 |
| `BEFORE_TOOL_CALL` | 工具调用前 |
| `AFTER_TOOL_CALL` | 工具调用后 |
| `ON_ERROR` | 错误发生时 |
| `ON_FALLBACK` | 保底机制触发时 |

### 7.4 SSE 实时推送

通过 Server-Sent Events 向前端实时推送：
- `step` 事件：处理步骤进度
- `reasoning` 事件：LLM 推理过程
- `complete` 事件：最终结果
- `error` 事件：错误信息

---

## 八、架构优化记录

项目经历了 4 个优先级共 18 项架构优化：

| 优先级 | 方向 | 代表性优化 |
|--------|------|-----------|
| **P0** | 安全加固 | 工具白名单（allowedTools）、默认安全工具集、PathGuard 增强 |
| **P1** | 性能优化 | 并行工具调用（safe/unsafe 分组）、统一规划器（3→2 次 LLM 调用）、压缩后上下文重注入 |
| **P2** | 可观测性 | Prometheus 指标、Hook 生命周期系统、技能热重载 |
| **P3** | 架构演进 | 弱依赖支持、错误记忆、执行路径追踪 |

---

## 九、设计决策记录

### 9.1 为什么选择 Plan-Execute-Summarize 而非 ReAct？

| 维度 | ReAct（Claude Code 模式） | Plan-Execute-Summarize（本项目） |
|------|--------------------------|-------------------------------|
| 适用场景 | 通用编码助手（工具调用密集） | 业务技能驱动（技能调用稀疏但结果重要） |
| 任务粒度 | 细粒度（读文件、写文件、运行命令） | 粗粒度（一个技能调用 = 一个完整业务操作） |
| 结果重要性 | 过程重要（用户看代码变更过程） | 结果重要（用户只关心最终答案） |
| 上下文消耗 | 高（每步都要完整上下文） | 低（只在规划/汇总时需要 LLM） |
| 成本 | 高（多次 LLM 调用） | 低（规划 1 次 + 汇总 1 次 + 每任务 1 次） |

### 9.2 为什么结果汇总由主智能体做？

- 子智能体只负责执行单个技能，不知道全局需求
- 主智能体持有用户原始需求，能判断结果是否满足需求
- 子智能体是隔离的（看不到父 Agent 上下文），必须由主智能体做汇总

### 9.3 为什么用结构化 TaskGraph 而非 LLM 自主决策？

- LLM 自主决策在每一步都需要完整上下文，成本高
- 结构化 TaskGraph 可以预计算执行顺序，支持并行优化
- 结构化数据更容易做断点续传和进度追踪
- 业务场景中任务间依赖通常是确定性的（先查数据再计算），不需要 LLM 每步重新判断

---

## 十、API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/skills` | 获取所有技能列表 |
| GET | `/tasks` | 获取任务列表（支持状态过滤） |
| POST | `/tasks` | 提交新任务（异步） |
| POST | `/tasks/stream` | 提交新任务（SSE 流式） |
| GET | `/tasks/:id` | 获取任务状态 |
| GET | `/tasks/:id/result` | 获取任务结果 |
| DELETE | `/tasks/:id` | 取消任务 |
| GET | `/sessions/:sessionId/history` | 获取会话历史 |
| GET | `/metrics` | Prometheus 指标 |

---

## 十一、测试

项目包含 9 个测试文件，覆盖核心模块：

- `main-agent.test.ts` — 主智能体核心流程
- `sub-agent.test.ts` / `sub-agent-unit.test.ts` — 子智能体执行与断点续执行
- `task-graph.test.ts` — 任务图构建与分层执行
- `intent-router` 相关测试 — 意图路由快速路径与 LLM 路径
- `request-manager.test.ts` — 请求生命周期管理
- `session-store.test.ts` / `session-context-prompt.test.ts` — 会话持久化
- `api.test.ts` — API 端点测试

---

## 十二、总结

ts-multi-agent 是一个**架构清晰、职责分明、可扩展性强**的多智能体系统。其核心设计理念可以概括为：

1. **结构化优于自由度**：用 TaskGraph 约束执行路径，用 Zod Schema 约束数据格式，在灵活性和可靠性之间取得平衡
2. **分层解耦**：规划与执行分离、主智能体与子智能体隔离、工具体系独立于业务逻辑
3. **渐进式增强**：从快速路径到 LLM 判断、从元数据到完整内容、从单任务到多任务图，按需使用资源
4. **用户体验优先**：断点续执行避免重复操作、SSE 实时推送处理进度、统一询问机制简化交互
5. **安全与可观测性内置**：不是事后补丁，而是从设计之初就融入架构的横切关注点
