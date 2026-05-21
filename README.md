# Multi-Agent Collaboration System

多智能体协作系统 —— 主智能体(MainAgent)负责需求分析、意图路由、任务规划与调度，子智能体(SubAgent)负责按技能指令执行具体任务，通过 LLM 驱动的协作完成复杂业务场景。

**技术栈**: TypeScript + Bun 运行时 + Express HTTP 框架 + Zod Schema 校验 + SSE 实时通信

---

## 目录

- [系统架构](#系统架构)
  - [整体架构图](#整体架构图)
  - [项目结构](#项目结构)
  - [核心设计原则](#核心设计原则)
- [主智能体 MainAgent](#主智能体-mainagent)
  - [核心职责](#核心职责)
  - [processRequirement 请求处理主流程](#processrequirement-请求处理主流程)
  - [processNormalRequirement 正常处理流程](#processnormalrequirement-正常处理流程)
  - [断点续传机制](#断点续传机制)
  - [关键设计决策](#关键设计决策)
- [子智能体 SubAgent](#子智能体-subagent)
  - [核心职责](#核心职责)
  - [执行流程](#执行流程)
  - [参数获取优先级](#参数获取优先级)
  - [ask_user 工具与检测逻辑](#ask_user-工具与检测逻辑)
  - [断点恢复 (Conversation Resume)](#断点恢复-conversation-resume)
- [任务调度 TaskQueue](#任务调度-taskqueue)
  - [核心特性](#核心特性)
  - [调度流程](#调度流程)
  - [指标采集](#指标采集)
- [意图路由 IntentRouter](#意图路由-intentrouter)
  - [多层信号收集 AuxiliarySignals](#多层信号收集-auxiliarysignals)
  - [决策路径](#决策路径)
  - [快速路径 Fast Paths](#快速路径-fast-paths)
  - [LLM 决策路径](#llm-决策路径)
  - [闲聊模式 SmallTalk](#闲聊模式-smalltalk)
- [统一规划器 UnifiedPlanner](#统一规划器-unifiedplanner)
- [工具体系](#工具体系)
  - [工具接口设计](#工具接口设计)
  - [已注册工具一览](#已注册工具一览)
  - [并发安全控制](#并发安全控制)
  - [安全机制](#安全机制)
- [记忆与上下文系统](#记忆与上下文系统)
  - [四层记忆架构](#四层记忆架构)
  - [四层上下文压缩](#四层上下文压缩)
  - [语义检索与嵌入](#语义检索与嵌入)
  - [共享记忆池 SharedMemoryPool](#共享记忆池-sharedmemorypool)
  - [记忆去重与重要性推断](#记忆去重与重要性推断)
  - [上下文预算管理 ContextBudget](#上下文预算管理-contextbudget)
  - [工作记忆生命周期](#工作记忆生命周期)
  - [动态上下文构建](#动态上下文构建)
- [技能注册表 SkillRegistry](#技能注册表-skillregistry)
  - [渐进式披露设计](#渐进式披露设计)
  - [技能热重载](#技能热重载)
  - [技能文件结构](#技能文件结构)
- [LLM 客户端](#llm-客户端)
  - [多 Provider 支持](#多-provider-支持)
  - [消息管理](#消息管理)
  - [结构化输出](#结构化输出)
  - [工具调用](#工具调用)
  - [可靠性机制](#可靠性机制)
  - [事件系统](#事件系统)
  - [错误恢复增强](#错误恢复增强)
- [询问系统 AskAgent](#询问系统-askagent)
  - [核心职责](#询问系统-核心职责)
  - [延续判断机制](#延续判断机制)
  - [挂起与召回](#挂起与召回)
- [请求上下文 RequestContext](#请求上下文-requestcontext)
- [会话管理](#会话管理)
  - [SessionContext 短期会话](#sessioncontext-短期会话)
  - [SessionStore 持久化会话](#sessionstore-持久化会话)
- [视觉分析 VisionClient](#视觉分析-visionclient)
- [Hooks 生命周期系统](#hooks-生命周期系统)
- [可观测性](#可观测性)
- [保底机制 Fallback](#保底机制-fallback)
- [安全体系](#安全体系)
  - [路径安全检查 PathGuard](#路径安全检查-pathguard)
  - [沙箱执行 Sandbox](#沙箱执行-sandbox)
  - [命令安全检查](#命令安全检查)
- [Prompt 构建与缓存](#prompt-构建与缓存)
- [API 接口](#api-接口)
- [技能示例](#技能示例)
- [配置](#配置)
- [测试](#测试)
- [快速开始](#快速开始)
- [架构优化记录](#架构优化记录)

---

## 系统架构

### 整体架构图

```
用户请求
  │
  ▼
┌──────────────────────────────────────────────────────────────────┐
│  API 层 (Express + SSE)                                          │
│  POST /tasks/stream → event: start/step/reasoning/complete/error │
│  POST /tasks          → 同步提交                                 │
│  GET  /tasks/:id      → 查询状态                                 │
│  GET  /tasks/:id/result → 查询结果                               │
│  GET  /skills          → 技能列表                                │
│  GET  /health          → 健康检查                                │
│  GET  /history         → 会话历史恢复                            │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  MainAgent (规划与调度中枢)                                       │
│                                                                  │
│  ① 图片分析 (VisionLLMClient)                                    │
│  ② AskAgent 输入处理 → continue / new_request                    │
│  ③ 上下文加载 (并发的 UserProfile + Memory + Session + Recall)   │
│  ④ 语义召回 + 共享记忆检索                                        │
│  ⑤ 微压缩 + 自动压缩检测                                          │
│  ⑥ 意图路由 (IntentRouter) 多信号决策                             │
│     ├── small_talk → 快速应答                                     │
│     ├── confirm_system → 反问确认                                 │
│     ├── skill_task → 继续处理                                     │
│     └── unclear → 转人工                                         │
│  ⑦ 任务规划 (UnifiedPlanner 或单任务直接规划)                     │
│  ⑧ 构建 TaskGraph → 分层并发执行                                  │
│  ⑨ 结果汇总 → LLM 汇总 / 单任务直达                              │
│  ⑩ 语义提取 + 持久化                                              │
└──────────────────────────┬───────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│ TaskQueue      │ │ SkillRegistry  │ │ IntentRouter   │
│ (DAG调度+并发)  │ │ (技能发现+热   │ │ (多信号决策)    │
│ 并发上限: 5    │ │  重载)         │ │                │
└───────┬────────┘ └────────────────┘ └────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│  SubAgent (技能执行器)                                            │
│                                                                  │
│  ① 加载技能说明 (SKILL.md)                                       │
│  ② 构建执行 Prompt                                              │
│  ③ LLM 循环: 思考 → 工具调用 → 观察 → 思考...                   │
│     ├── 8 种工具 (read/write/edit/bash/glob/grep/ask_user/conv)   │
│     ├── 并发安全控制                                              │
│     └── PathGuard + Sandbox 安全隔离                              │
│  ④ ask_user 拦截 → 等待用户输入 → 断点恢复                       │
│  ⑤ 技能执行结果返回                                              │
└──────────────────────────────────────────────────────────────────┘
```

### 项目结构

```
ts-multi-agent/
├── src/
│   ├── index.ts                      # 系统启动入口 (bootstrap)
│   ├── agents/
│   │   ├── main-agent.ts             # 主智能体 (规划调度中枢)
│   │   ├── sub-agent.ts              # 子智能体 (技能执行器)
│   │   ├── ask-agent.ts              # 询问系统智能体
│   │   └── vision-client.ts          # 视觉分析 (GLM-4V-Flash)
│   ├── api/
│   │   └── index.ts                  # Express API + SSE 服务
│   ├── config/
│   │   └── fallback.ts               # 保底配置加载
│   ├── context/
│   │   ├── dynamic-context.ts        # 动态上下文构建(用户画像+对话历史)
│   │   ├── dynamic-context.test.ts   # 测试
│   │   └── request-context.ts        # 请求级 AsyncLocalStorage
│   ├── hooks/
│   │   ├── hook-manager.ts           # Hook 管理器 (全局单例)
│   │   └── types.ts                  # HookEvent + HookContext 定义
│   ├── llm/
│   │   ├── index.ts                  # LLMClient (消息管理/结构化输出/工具调用/多Provider)
│   │   └── error-recovery.ts         # 错误恢复管理器
│   ├── memory/
│   │   ├── index.ts                  # 统一导出
│   │   ├── types.ts                  # 4层记忆类型定义
│   │   ├── memory-service.ts         # 记忆服务 (统一入口)
│   │   ├── user-memory-store.ts      # 用户级内存持久化 (JSON文件)
│   │   ├── episodic-store.ts         # 情景记忆存取
│   │   ├── session-context.ts        # 短期会话上下文 (内存)
│   │   ├── session-store.ts          # 会话持久化 (防抖写入)
│   │   ├── shared-memory-pool.ts     # 智能体间共享记忆
│   │   ├── semantic-extractor.ts     # 语义知识提取 (LLM驱动)
│   │   ├── semantic-retrieval.ts     # 语义检索 (向量+关键词)
│   │   ├── embedding-service.ts      # 嵌入服务 (带余弦相似度)
│   │   ├── importance-inferencer.ts  # 记忆重要性推断
│   │   ├── memory-dedup.ts           # 记忆去重与合并
│   │   ├── context-budget.ts         # 上下文预算管理
│   │   ├── auto-compact.ts           # 自动上下文压缩 (4层策略)
│   │   ├── token-counter.ts          # Token 计数
│   │   └── working-memory-lifecycle.ts # 工作记忆生命周期管理
│   ├── observability/
│   │   └── logger.ts                 # 结构化日志 (JSON格式)
│   ├── planners/
│   │   ├── index.ts
│   │   └── unified-planner.ts        # 统一规划器 (合并分析/匹配/规划)
│   ├── prompts/
│   │   ├── index.ts                  # 统一导出
│   │   ├── main-agent.ts             # 主智能体 SystemPrompts
│   │   ├── sub-agent.ts              # 子智能体 SystemPrompts
│   │   ├── session-context-prompt.ts # 会话状态 Prompt 构建
│   │   └── prompt-builder.ts         # Prompt 缓存构建器
│   ├── routers/
│   │   ├── index.ts
│   │   └── intent-router.ts          # 意图路由 (多信号决策)
│   ├── security/
│   │   ├── path-guard.ts             # 路径安全检查 (白名单+黑名单)
│   │   └── sandbox.ts               # 沙箱执行器 (bubblewrap)
│   ├── skill-registry/
│   │   └── index.ts                  # 技能注册表 (发现/加载/热重载)
│   ├── task-queue/
│   │   └── index.ts                  # 任务队列 (DAG+并发+超时+清理)
│   ├── tools/
│   │   ├── index.ts                  # 统一导出
│   │   ├── interfaces.ts             # Tool/ToolContext/ToolResult 接口
│   │   ├── base-tool.ts              # 抽象基类
│   │   ├── tool-registry.ts          # 工具注册表
│   │   ├── file-read-tool.ts         # read 工具
│   │   ├── write-tool.ts             # write 工具
│   │   ├── edit-tool.ts              # edit 工具
│   │   ├── bash-tool.ts              # bash 工具 (沙箱执行)
│   │   ├── glob-tool.ts              # glob 工具
│   │   ├── grep-tool.ts              # grep 工具
│   │   ├── context-tool.ts           # conversation-get 工具
│   │   └── ask-user-tool.ts          # ask_user 工具
│   ├── types/
│   │   └── index.ts                  # 全局类型定义 (Task/Skill/Session/QA 等)
│   └── user-profile/
│       └── index.ts                  # 用户画像服务
├── skills/                           # 技能目录
│   ├── templates/                    # 技能模板
│   │   ├── knowledge-qa/             # 知识问答模板
│   │   ├── system-operation/         # 系统操作模板
│   │   ├── approval-workflow/        # 审批流程模板
│   │   ├── data-query/               # 数据查询模板
│   │   └── tool-execution/           # 工具执行模板
│   ├── geam-qa/                      # GEAM 系统问答技能
│   ├── ees-qa/                       # EES 系统问答技能
│   ├── time-management-qa/           # 考勤管理问答技能
│   ├── travel-expense-apply/         # 差旅报销技能
│   ├── fawu/                         # 法务技能
│   └── sulfuric-acid-price-prediction/ # 硫酸价格预测技能
├── data/
│   ├── user-profile.json             # 用户画像数据
│   └── memory/                       # 记忆持久化存储
├── config/
│   └── fallback.md                   # 保底处理配置
├── __tests__/                        # 25 个测试文件
├── .env /.env.example                # 多 Provider 环境配置
├── package.json                      # 依赖与脚本
├── tsconfig.json                     # TypeScript 严格模式配置
├── Dockerfile / docker-compose.yml   # 容器化部署
└── DEPLOY.md                         # 部署指南
```

### 核心设计原则

1. **主从协作**: MainAgent 负责任务分解与调度，SubAgent 负责按技能执行，两者通过 TaskQueue 解耦
2. **DAG 任务图**: 任务之间通过有向无环图建模依赖关系，支持分层并发执行
3. **技能驱动**: 每个 SKILL.md 定义一项技能，SubAgent 严格基于技能文档执行，不编造不扩展
4. **渐进式技能披露**: 先解析 SKILL.md 的 YAML 元数据(轻量)，按需加载完整 body
5. **记忆分层**: Working(工作) → Episodic(情景) → Semantic(语义) → Procedural(程序) 四层递进
6. **多层防御**: 路径白名单 + 系统黑名单 + 敏感文件检查 + bubblewrap 沙箱 + 命令验证
7. **容错设计**: LLM 调用重试 → 错误分类恢复 → 上下文压缩 → 退避重试 → 保底 Fallback
8. **渐进式上下文压缩**: MICRO(5分钟清理) → AUTO(167K tokens触发LLM压缩) → SESSION → REACTIVE
9. **多信号意图路由**: 信号优先级链路：用户明确系统名 > session上下文 > 关键词 > 历史技能 > 用户画像

---

## 主智能体 (MainAgent)

**文件**: `src/agents/main-agent.ts`

### 核心职责

1. **请求处理**: 接收用户输入（文本 + 图片附件），编排整个处理流水线
2. **上下文加载**: 并行加载用户画像、记忆、会话、动态上下文
3. **记忆召回**: 语义检索相关记忆（情景/语义/程序三层）
4. **共享记忆检索**: 跨智能体共享记忆池查询
5. **意图路由**: 多信号综合决策，区分 small_talk / skill_task / confirm_system / unclear
6. **任务规划**: 单任务直接执行，多任务通过 UnifiedPlanner 统一规划
7. **分层执行**: 构建 TaskGraph 实现 DAG 分层并发执行
8. **结果汇总**: 单任务直接返回，多任务 LLM 汇总
9. **断点续传**: 用户问答后从断点层恢复任务图执行
10. **持久化**: 保存对话历史、更新用户画像、提取语义知识

### processRequirement 请求处理主流程

```
processRequirement(requirement, imageAttachment?, userId, sessionId, options?)
  │
  ├── Step 0: 恢复会话上下文 (服务重启后从持久化恢复)
  │     └── sessionContextService.restoreFromSession()
  │
  ├── Step 1: 图片分析 (如有附件)
  │     └── VisionLLMClient.analyzeImage() → 分析结果追加到 requirement
  │
  ├── Step 2: AskAgent 处理用户输入
  │     ├── handleResult.type === 'continue'
  │     │     └── continueRequest() → 断点恢复 / 重新派发
  │     └── handleResult.type === 'new_request'
  │           └── processNormalRequirement() → 正常流程
  │
  └── 整体异常捕获 → error 返回
```

### processNormalRequirement 正常处理流程

```
processNormalRequirement(requirement, userId, sessionId, request, ...)
  │
  ├── 递归深度检查 (max: 3)
  │
  ├── 并行上下文加载
  │     ├── userProfileService.loadProfile(userId)
  │     ├── memoryService.loadUserMemory(userId)
  │     ├── sessionStore.loadSession(userId, sessionId)
  │     └── dynamicContextBuilder.build(requirement, userId)
  │
  ├── 记忆召回 (并行)
  │     ├── memoryService.recall() → 语义检索相关记忆
  │     └── memoryService.retrieveShared() → 共享记忆池
  │
  ├── 检查活跃任务 (防止重复分派)
  │
  ├── 上下文压缩
  │     ├── microCompact() → 清除 5 分钟前的工具结果
  │     └── checkAndCompact() → 167K tokens 触发 LLM 压缩
  │
  ├── 上下文组装 (按优先级排序)
  │     ├── 会话上下文 (Session Prompt)
  │     ├── 动态上下文 (用户画像 + 对话历史)
  │     ├── 对话历史
  │     ├── 召回记忆 + 共享记忆
  │     └── 原始需求
  │
  ├── 意图路由
  │     ├── 收集辅助信号 (session/keyword/history/profile/procedural)
  │     ├── HOOK: before:intent_classify
  │     ├── IntentRouter.classify() → 多路径决策
  │     ├── HOOK: after:intent_classify
  │     └── 非 skill_task → handleNonSkillIntent()
  │
  ├── 任务规划
  │     ├── 单任务 → 直接构建 TaskPlan
  │     ├── 多任务 → UnifiedPlanner.plan() → LLM 统一规划
  │     └── PlanMode → 返回计划预览等待确认
  │
  ├── 任务注册 (SessionStore + WorkingMemory)
  │
  ├── HOOK: before:task_execute
  │
  ├── 分层执行
  │     ├── buildTaskGraph(plan) → DAG 分层
  │     ├── executeTaskGraph() → 逐层并发执行
  │     └── 检测等待用户输入 → 保存进度 → 返回 question
  │
  ├── HOOK: after:task_execute
  │
  ├── 结果汇总
  │     ├── 单任务 → 直接使用子智能体结果
  │     └── 多任务 → LLM summarizeResults() 汇总
  │
  ├── 更新用户画像 (conversationCount++)
  │
  └── 后处理
        ├── 保存助手回复 → Episodic Memory
        ├── 语义提取 (SemanticExtractor)
        └── 完成请求 (SessionStore.completeRequest)
```

### 断点续传机制

当任务执行过程中 SubAgent 调用 `ask_user` 工具需要用户输入时，MainAgent 会:

1. 检测 `waitingTaskId` 和 `waiting_user_input` 状态
2. 保存 QAEntry 到 SessionStore（任务级 questions）
3. 保存 `executionProgress`（当前 layer 索引 + 已完成结果）
4. 返回 `type: 'question'` 给前端等待用户回答
5. 用户回答后 `continueRequest()` 恢复执行:
   - 有 `executionProgress` → `resumeFromBreakpoint()` 从断点层继续
   - 无 progress 但 task.questionHistory 存在 → 继续当前任务
   - 仅主智能体询问 → 重新 `processNormalRequirement()`

### 关键设计决策

1. **递归深度限制**: 最大 3 层，防止无限递归
2. **单任务直接返回**: 避免不必要的 LLM 汇总调用
3. **TaskGraph 分层**: 根据依赖关系将任务分为多层，同层并行执行
4. **参数依赖解析**: `resolveParams()` 从前驱任务结果中提取参数
5. **任务去重**: 检查活跃任务列表防止重复派发
6. **并发安全**: 同一技能的任务串行执行，不同技能的任务可并行

---

## 子智能体 (SubAgent)

**文件**: `src/agents/sub-agent.ts`

### 核心职责

1. 加载技能说明 (SKILL.md)
2. 构建执行 Prompt（技能说明 + 参数 + 询问历史 + 断点上下文）
3. LLM 驱动的工具调用循环（思考 → 观察 → 行动）
4. `ask_user` 工具拦截 → 挂起任务等待用户输入
5. 断点恢复时提供完整对话上下文（conversation resume）
6. 安全工具白名单控制

### 执行流程

```
SubAgent.execute(task)
  │
  ├── 加载技能 → skillRegistry.loadFullSkill(task.skillName)
  │
  ├── 构建 SubAgent Prompt
  │     ├── SUB_AGENT_BASE_PROMPT (角色定义 + 工具说明 + 规则)
  │     ├── 技能 body (SKILL.md 内容)
  │     ├── 技能根目录路径
  │     ├── 已获取参数 (task.params)
  │     ├── 询问历史 (task.questionHistory)
  │     ├── 断点上下文 (conversationContext + completedToolCalls)
  │     └── 用户信息
  │
  ├── LLM 执行循环
  │     ├── HOOK: before:tool_call
  │     ├── LLM generateWithTools() → response + toolCalls
  │     ├── 工具调用处理
  │     │     ├── ask_user 拦截 → 返回 waiting_user_input
  │     │     ├── read/write/edit/bash/glob/grep → ToolRegistry.execute()
  │     │     └── conversation-get → SessionStore 查询对话历史
  │     ├── HOOK: after:tool_call
  │     ├── 保存对话上下文 (主动保存 + 触发保存)
  │     └── 循环直到完成或 ask_user
  │
  └── 返回 SkillExecutionResult
        ├── response: 最终回复
        ├── status: completed / waiting_user_input / failed
        ├── question: 询问信息 (ask_user 时)
        ├── conversationContext: 对话历史 (断点恢复用)
        └── completedToolCalls: 已调用的工具记录
```

### 参数获取优先级

SubAgent Prompt 明确要求按以下顺序获取参数:

1. **「已获取参数」部分**: 主智能体已传递到 task.params 中的参数
2. **「询问历史」部分**: 历史问答中的用户回复
3. **最后才询问用户**: 使用 `ask_user` 工具

`conversation-get` 工具仅在需要查看技能说明之外的对话上下文时使用，且每次调用消耗一轮执行机会。

### ask_user 工具与检测逻辑

**ask_user 工具** (`src/tools/ask-user-tool.ts`):
- 支持类型: text / choice / confirm / number / date
- 支持 paramName 自动填充
- 工具返回 `__ask_user__: true` 标记，SubAgent 拦截并返回 `waiting_user_input`

**文本询问检测** (`detectQuestion()`):
- 排除结论性语句模式（已完成、成功、结果如下）
- 正则匹配提问模式（请问、请选择、请提供等）
- 上下文判断: 如果最后工具调用是查询工具且内容含结果指示词，判定为结果展示而非提问

### 断点恢复 (Conversation Resume)

当用户回答后 SubAgent 继续执行时:
1. `conversationContext` 保存之前的完整 LLM 对话轮次
2. `completedToolCalls` 保存已成功的工具调用记录
3. `_executionProgress` 记录执行进度描述
4. 新轮次注入完整的对话上下文 + 最新回复，让 LLM 从断点继续

---

## 任务调度 (TaskQueue)

**文件**: `src/task-queue/index.ts`

### 核心特性

| 特性 | 配置 | 说明 |
|------|------|------|
| DAG 依赖管理 | 自动检测环 | 任务间依赖关系建模 |
| 并发限制 | MAX_CONCURRENT_SUBAGENTS=5 | 最多同时执行5个任务 |
| 任务超时 | TASK_TIMEOUT_MS=30000ms | 单任务超时断开 |
| 自动清理 | 定期 cleanup | 完成/失败的任务超过保留时间后清理 |
| EventEmitter | task-completed / task-failed | 事件驱动轮询 |
| 参数依赖解析 | data.params | 从前驱任务结果中提取参数 |
| 结果大小限制 | 1MB | 单个任务结果上限 |

### 调度流程

```
addTask(task) → triggerProcess() → processQueue()
  │
  ├── 检查并发限制 (running.size < MAX_CONCURRENT)
  ├── 筛选可执行任务 (pending + 依赖全部 completed)
  ├── 注册超时定时器
  ├── 执行 executor(task, signal) → SubAgent.execute(task)
  │     ├── 成功 → 标记 completed, emit task-completed
  │     ├── 失败 → 检查重试次数
  │     │     ├── 可重试 → 重置 pending
  │     │     └── 不可重试 → 标记 failed, emit task-failed
  │     └── 超时 → 标记 failed, emit task-failed
  └── 检查继续 → triggerProcess() 继续下一批
```

### 指标采集

内部维护: `tasksCompleted`, `tasksFailed`, `tasksTimedOut`, `averageExecutionTime`, `totalExecutionTime`

---

## 意图路由 (IntentRouter)

**文件**: `src/routers/intent-router.ts`

多信号融合决策系统，将传统的关键词匹配和 LLM 智能判断相结合。

### 多层信号收集 AuxiliarySignals

```
AuxiliarySignals {
  sessionContext: { skill, confidence: 0.70-0.90, turnCount } | null
  keywordMatch:   { skill, confidence: 0.70-0.88, matchedKeywords[] } | null
  historicalSkill:{ skill, confidence: 0.60-0.75, turnsAgo } | null
  userProfile:    { department?, commonSystems[], confidence: 0.50-0.65 }
  proceduralExperience?: { skill, usageCount, lastSuccess, confidence }
}
```

### 决策路径

```
classify(requirement, userProfile, recentHistory, sessionId, proceduralExperience)
  │
  ├── 1. Fast SmallTalk: 正则匹配问候/致谢/告别等 7 种闲聊模式
  ├── 2. Fast Followup: 简短输入 + 活跃 session 技能
  ├── 3. Fast Session: session 技能置信度 > 0.7
  ├── 4. Fast Keyword: 关键词命中置信度 > 0.8
  ├── 5. Multi-Signal Agree: 多信号指向同一技能
  └── 6. LLM Decision: 综合所有信号调用 LLM 判断
```

### 闲聊模式 SmallTalk

7 种内置响应模板，不调用 LLM:
- greeting / empathy / identity / thanks / goodbye / help / capability

---

## 统一规划器 (UnifiedPlanner)

**文件**: `src/planners/unified-planner.ts`

将需求分析 + 技能匹配 + 任务规划合并为一次 LLM 调用（优化前 3-4 次 → 优化后 2 次）:

```
UnifiedPlanner.plan(requirement)
  ├── 获取所有可用技能元数据
  ├── 构建 TaskPlannerPrompt (含技能列表)
  ├── LLM generateStructured() → UnifiedPlanSchema
  └── 返回 PlanResult (success / needsClarification / TaskPlan)
```

---

## 工具体系

### 工具接口设计

```typescript
interface Tool {
  name: string;                     // 唯一名称
  description: string;              // 人类可读描述
  parameters?: ToolParameters;      // JSON Schema 参数
  required?: string[];              // 必需参数
  execute(input, context): Promise<ToolResult>;
  isConcurrencySafe(input): boolean;
  isReadOnly(): boolean;
}
```

### 已注册工具一览

| 工具名 | 并发安全 | 只读 | 用途 |
|--------|----------|------|------|
| `read` | ✅ | ✅ | 读取文件内容 |
| `write` | ❌ | ❌ | 创建/写入文件 |
| `edit` | ❌ | ❌ | 精确字符串替换编辑 |
| `bash` | ❌ | ❌ | shell 命令 (沙箱隔离) |
| `glob` | ✅ | ✅ | 文件模式匹配 |
| `grep` | ✅ | ✅ | 文件内容搜索 |
| `ask_user` | ❌ | ✅ | 向用户提问 |
| `conversation-get` | ❌ | ✅ | 获取对话历史 |

### 安全机制

```
工具调用 → PathGuard 路径检查 → Sandbox 沙箱执行
              │                        │
              ├── 白名单: 工作目录内    ├── bubblewrap 隔离
              ├── 系统黑名单           ├── 无 bwrap 时降级
              ├── 项目敏感文件黑名单    │    并记录日志
              └── bash 命令验证        │
```

---

## 记忆与上下文系统

### 四层记忆架构

| 层级 | 存储 | 特点 | 内容 |
|------|------|------|------|
| **Working** | JSON + 内存 | 当前请求上下文，任务完成自动清除 | 任务状态、请求ID |
| **Episodic** | JSON 文件 | 对话历史，按时间排序持久化 | 用户/助手消息、重要性 |
| **Semantic** | JSON 文件 | 用户知识偏好，LLM 提取 | 偏好/事实/知识/规则 |
| **Procedural** | JSON 文件 | 技能执行经验 | 技能名、参数、结果、成功率 |

**存储路径**: `data/memory/{userId}.json`

### 四层上下文压缩

| 策略 | 触发条件 | 行为 |
|------|----------|------|
| MICRO | 每轮调用 | 清除 >5 分钟前的工具结果内容 |
| AUTO | >167K tokens (83.5%) | LLM 总结历史，熔断于 3 次失败 |
| SESSION | 预留 | 会话级别维护 |
| REACTIVE | 预留 | 上下文压力响应 |

### 语义检索与嵌入

- **评分公式**: `keyword(0.5) + recency(0.3) + importance(0.2)`
- **时间衰减**: 半衰期 24 小时
- **自适应检索**: 置信度低于 0.5 时用 LLM 展开查询

### 共享记忆池 SharedMemoryPool

跨智能体记忆共享: `publish()` / `retrieve()` / `subscribe()`，写锁串行化

### 记忆去重与重要性推断

- **MemoryDedupService**: 余弦相似度去重(阈值 0.85) + 合并(阈值 0.7)
- **ImportanceInferencer**: LLM 推断重要性/范围/类别，无 LLM 时启发式回退

### 上下文预算管理 ContextBudget

- 总预算: 4000 tokens
- 分层分配: Working 10% / Episodic 40% / Semantic 30% / Procedural 10% / System 10%

### 工作记忆生命周期

`pending → running → waiting → completed/failed → evict`

---

## 技能注册表 (SkillRegistry)

**文件**: `src/skill-registry/index.ts`

### 渐进式披露

1. 扫描阶段: 读取 SKILL.md 的 YAML frontmatter (metadata)
2. 执行阶段: 按需调用 `loadFullSkill()` 读取完整 body

### 技能热重载

- `startWatch()`: `fs.watch` 监听技能目录
- 200ms 防抖
- 重扫时自动清除 Prompt 缓存

### 技能文件结构

```
skills/{name}/
├── SKILL.md                  # YAML frontmatter + Markdown 主体
├── references/               # 参考文档
│   ├── api-spec.md
│   └── fields.md
└── scripts/                  # 可执行脚本
    └── predict.js
```

**当前技能**: geam-qa / ees-qa / time-management-qa / travel-expense-apply / fawu / sulfuric-acid-price-prediction (含 5 个模板)

---

## LLM 客户端

**文件**: `src/llm/index.ts`

### 多 Provider 支持

| Provider | 环境变量 | 默认模型 |
|----------|----------|----------|
| OpenRouter | `OPENROUTER_API_KEY` | qwen/qwen3.6-plus-preview:free |
| NVIDIA | `NVIDIA_API_KEY` | minimax-m2.5 |
| Zhipu AI | `ZHIPU_API_KEY` | glm-4v-flash (视觉) |
| SiliconFlow | `SILICONFLOW_API_KEY` | Pro/MiniMaxAI/MiniMax-M2.5 |

当前默认: siliconflow, Pro/MiniMaxAI/MiniMax-M2.5

### 结构化输出

`generateStructured(prompt, zodSchema, system?)`: 在 system prompt 中注入 Zod Schema JSON 约束

### 可靠性机制

| 机制 | 说明 |
|------|------|
| 重试 | 最多 3 次，指数退避 |
| 错误分类 | 8 种类型 (RATE_LIMIT / TIMEOUT / API_ERROR 等) |
| 退避重试 | RATE_LIMIT: 10s → 30s → 60s |
| 上下文压缩 | CONTEXT_TOO_LONG → autoCompact |
| 超时控制 | 可配置 |

### 错误恢复增强

ErrorRecoveryManager 按错误类型生成恢复策略: 退避重试 / 增大超时 / 压缩上下文 / Provider 切换

---

## 询问系统 (AskAgent)

**文件**: `src/agents/ask-agent.ts`

### 询问系统-核心职责

判断用户输入是对问题的回答还是新请求，管理询问生命周期。

### 延续判断机制

```
handleUserInput() → 检查等待请求 → 有等待问题 → LLM judgeContinuation()
  ├── 是回答 → answerQuestion() → return {type: 'continue'}
  └── 新请求 → suspendRequest() + createRequest() → return {type: 'new_request'}
```

### 挂起与召回

- 用户切换话题时自动挂起当前请求，创建新请求
- `recallRequest()` 可主动召回挂起请求

---

## 请求上下文 (RequestContext)

**文件**: `src/context/request-context.ts`

```
API 层: RequestContext.run({ accessToken }, handler)
  → MainAgent → TaskQueue → SubAgent → BashTool
  → 技能脚本环境变量 SKILL_ACCESS_TOKEN
```

使用 Node.js AsyncLocalStorage 实现请求级数据传递。

---

## 会话管理

### SessionContext 短期会话

内存存储，重启即消失。跟踪: currentSkill / currentSystem / turnCount / tempVariables / conversation.

### SessionStore 持久化会话

`data/memory/{userId}/{sessionId}/session.json`，100ms 防抖写入磁盘。

结构: `Session → Request[] → QAEntry[] + RequestTask[] + executionProgress`

---

## 视觉分析 (VisionClient)

**文件**: `src/agents/vision-client.ts`

- 模型: GLM-4V-Flash (智谱)
- 重试: 最多 3 次，指数退避
- 超时: 120s
- 输出: `{ system, errorType, description, suggestedAction }`
- 结果自动追加到 requirement

---

## Hooks 生命周期系统

8 个生命周期钩子: `before/after:intent_classify`, `before/after:task_execute`, `before/after:tool_call`, `on:error`, `on:fallback`

异步并行执行，单 handler 失败不影响其他。

---

## 可观测性

结构化 JSON 日志 (`src/observability/logger.ts`):

- 级别: DEBUG / INFO / WARN / ERROR
- 上下文继承: `createLogger({ module })` → `logger.child({ submodule })`
- 环境变量: `LOG_LEVEL` 控制级别

---

## 保底机制 (Fallback)

配置文件: `config/fallback.md`（路径可被 `FALLBACK_CONFIG` 环境变量覆盖）
业务自定义内容注入 MainAgent system prompt。

---

## 安全体系

### 路径安全检查 PathGuard

- **白名单**: 工作目录范围内
- **系统黑名单**: `.ssh`, `/etc/shadow`, `/proc`, `.kube` 等
- **项目黑名单**: `.env`, `credentials`, `secret`, `*.pem`, `*.key` 等

### 沙箱执行 Sandbox

- bubblewrap 文件系统/网络隔离
- 自动检测, Alpine 兼容 (`/bin/sh` 回退)
- 无 bwrap 时降级为直接执行（记录日志）

### 命令安全检查

阻止: `rm -rf /`, `mkfs`, `dd if=/dev/zero`, fork bomb 等危险命令

---

## Prompt 构建与缓存

- **静态段落**: 会话内不变内容 → 缓存
- **动态段落**: 每轮变化 → 不缓存
- **缓存边界**: `<!-- DYNAMIC_CONTEXT_START -->` 分隔
- **清除**: 技能热重载时调用 `clearCache()`

---

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/tasks/stream` | SSE 流式提交 (事件: start/step/reasoning/complete/error) |
| POST | `/tasks` | 同步提交 |
| GET | `/tasks/:id` | 查询状态 |
| GET | `/tasks/:id/result` | 查询结果 |
| GET | `/skills` | 技能列表 |
| GET | `/history` | 会话历史恢复 |
| GET | `/health` | 健康检查 |

---

## 技能示例

| 技能 | 类型 | 说明 |
|------|------|------|
| geam-qa | knowledge-qa | GEAM 系统问答 |
| ees-qa | knowledge-qa | EES 系统问答 |
| time-management-qa | knowledge-qa | 考勤管理 |
| travel-expense-apply | system-operation | 差旅报销 |
| fawu | knowledge-qa | 法务咨询 |
| sulfuric-acid-price-prediction | tool-execution | 硫酸价格预测 |
| templates/* (5个) | 模板 | 技能模板 |

---

## 配置

主要环境变量: `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, API Keys, `PORT`(默认3000), `SKILL_DIR`, `FALLBACK_CONFIG`, `LOG_LEVEL`

---

## 测试

25 个测试文件覆盖:

| 测试 | 覆盖 |
|------|------|
| `api.test.ts` | API + SSE |
| `main-agent.test.ts` | 主智能体 (10 用例) |
| `sub-agent.test.ts` | 子智能体 |
| `ask-agent.test.ts` | 询问系统 |
| `session-store.test.ts` | 会话持久化 |
| `task-graph.test.ts` | DAG 任务图 |
| `path-guard.test.ts` | 路径安全 |
| `sandbox.test.ts` | 沙箱执行 |
| `memory-*.test.ts` (14 个) | 全部记忆模块 |

运行: `bun test`

---

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env: 至少配置一个 LLM Provider 的 API Key

# 3. 启动
bun run dev    # 开发模式 (watch)
# 或
bun run build && bun start  # 生产模式

# 4. 测试
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"requirement": "你好"}'

# 5. 运行测试
bun test
```

---

## 架构优化记录

### P0: 基础架构
- P0-1: 默认安全工具白名单
- P0-2: 敏感文件保护 (PathGuard 双层防护)
- P0-3: 端口优先级配置
- P0-4: 错误恢复增强 (ErrorRecoveryManager)

### P1: 性能 & 可靠性
- P1-1: 渐进式记忆上下文 (四层记忆架构)
- P1-2: 智能并发控制 (并发安全检测 + 串行写)
- P1-3: 断点续传 (conversationContext + completedToolCalls)
- P1-4: 单技能任务直达 (跳过 LLM 汇总)
- P1-5: Prompt Cache 优化 (静态段落缓存)

### P2: 扩展性 & 可观测性
- P2-1: 结构化日志与指标
- P2-2: Hooks 生命周期 (8 个 HookEvent)
- P2-3: 技能热重载 (fs.watch + 200ms 防抖)
- P2-4: 统一规划器 (3→2 次 LLM 调用)

### P3: 高级特性
- P3-1: 沙箱隔离 (bubblewrap)
- P3-2: Plan Mode (任务计划预览 + 用户确认)
- P3-3: 共享记忆池 (智能体间通信)
- P3-4: 上下文预算管理 (4000 token 分层分配)
