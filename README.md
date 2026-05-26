# Multi-Agent Collaboration System

多智能体协作系统 —— 基于主从协作架构的智能任务执行平台。主智能体(MainAgent)负责任求分析、意图路由、任务规划与调度；子智能体(SubAgent)负责按技能指令执行具体任务。通过 LLM 驱动的多智能体协作，完成复杂业务场景。

**技术栈**: TypeScript + Bun/Node.js + Express + Zod + SSE

---

## 系统概览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           系统架构总览                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────┐ │
│  │   API 层    │───▶│  主智能体   │───▶│  任务队列   │───▶│ 子智能体 │ │
│  │  (Express)  │    │ (MainAgent) │    │(TaskQueue)  │    │(SubAgent)│ │
│  └─────────────┘    └──────┬──────┘    └─────────────┘    └────┬─────┘ │
│                            │                                    │      │
│         ┌──────────────────┼────────────────────────────────────┘      │
│         ▼                  ▼                                           │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────┐ │
│  │  意图路由   │    │  统一规划器 │    │  记忆系统   │    │ 工具体系 │ │
│  │(IntentRouter│    │(UnifiedPlanner)│  │  (4层架构)  │    │(8种工具) │ │
│  └─────────────┘    └─────────────┘    └─────────────┘    └──────────┘ │
│                                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                 │
│  │ 技能注册表  │    │  LLM客户端  │    │  安全体系   │                 │
│  │(SkillRegistry)│   │(多Provider)│    │(PathGuard+  │                 │
│  │             │    │             │    │  Sandbox)   │                 │
│  └─────────────┘    └─────────────┘    └─────────────┘                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 目录

- [系统架构](#系统架构)
  - [大模块划分](#大模块划分)
  - [核心设计原则](#核心设计原则)
- [主智能体 MainAgent](#主智能体-mainagent)
- [子智能体 SubAgent](#子智能体-subagent)
- [任务调度 TaskQueue](#任务调度-taskqueue)
- [意图路由 IntentRouter](#意图路由-intentrouter)
- [统一规划器 UnifiedPlanner](#统一规划器-unifiedplanner)
- [工具体系](#工具体系)
- [记忆系统](#记忆系统)
- [技能注册表 SkillRegistry](#技能注册表-skillregistry)
- [LLM 客户端](#llm-客户端)
- [询问系统 AskAgent](#询问系统-askagent)
- [安全体系](#安全体系)
- [API 接口](#api-接口)
- [快速开始](#快速开始)

---

## 系统架构

### 大模块划分

| 模块 | 路径 | 职责概述 |
|------|------|----------|
| **API 层** | `src/api/` | Express HTTP 服务 + SSE 流式通信 |
| **主智能体** | `src/agents/main-agent.ts` | 需求分析、意图路由、任务规划与调度中枢 |
| **子智能体** | `src/agents/sub-agent.ts` | 按技能指令执行具体任务 |
| **询问系统** | `src/agents/ask-agent.ts` | 判断用户输入是回答还是新请求 |
| **视觉分析** | `src/agents/vision-client.ts` | 图片附件分析 (GLM-4V-Flash) |
| **意图路由** | `src/routers/intent-router.ts` | 多信号融合决策系统 |
| **统一规划器** | `src/planners/unified-planner.ts` | 需求分析+技能匹配+任务规划合并 |
| **任务队列** | `src/task-queue/` | DAG 任务调度 + 分层并发执行 |
| **工具体系** | `src/tools/` | 8 种工具实现 (read/write/edit/bash/glob/grep/ask_user/conv) |
| **记忆系统** | `src/memory/` | 四层记忆架构 (Working/Episodic/Semantic/Procedural) |
| **技能注册表** | `src/skill-registry/` | 技能发现、加载、热重载 |
| **LLM 客户端** | `src/llm/` | 多 Provider 支持 + 错误恢复 |
| **安全体系** | `src/security/` | 路径守卫 + 沙箱执行 |
| **Hooks 系统** | `src/hooks/` | 8 个生命周期钩子 |
| **可观测性** | `src/observability/` | 结构化 JSON 日志 |
| **技能目录** | `skills/` | 业务技能定义 (SKILL.md) |

### 核心设计原则

1. **主从协作**: MainAgent 负责任务分解与调度，SubAgent 负责按技能执行，两者通过 TaskQueue 解耦
2. **DAG 任务图**: 任务之间通过有向无环图建模依赖关系，支持分层并发执行（最大并发 5）
3. **技能驱动**: 每个 SKILL.md 定义一项技能，SubAgent 严格基于技能文档执行
4. **渐进式技能披露**: 先解析 SKILL.md 的 YAML 元数据，按需加载完整 body
5. **四层记忆架构**: Working → Episodic → Semantic → Procedural 递进
6. **多层安全防护**: 路径白名单 + 系统黑名单 + bubblewrap 沙箱
7. **断点续传**: ask_user 挂起后可从断点恢复任务执行
8. **多信号意图路由**: 综合 session/keyword/history/profile 信号决策

---

## 主智能体 (MainAgent)

**文件**: `src/agents/main-agent.ts`

主智能体是系统的规划与调度中枢，核心职责：

1. **请求处理**: 接收用户输入（文本 + 图片附件），编排整个处理流水线
2. **上下文加载**: 并行加载用户画像、记忆、会话、动态上下文
3. **意图路由**: 多信号综合决策（闲聊/技能任务/确认系统/ unclear）
4. **任务规划**: 单任务直接执行，多任务通过 UnifiedPlanner 统一规划
5. **分层执行**: 构建 TaskGraph 实现 DAG 分层并发执行
6. **断点续传**: 用户问答后从断点层恢复任务图执行
7. **持久化**: 保存对话历史、更新用户画像、提取语义知识

---

## 子智能体 (SubAgent)

**文件**: `src/agents/sub-agent.ts`

子智能体是技能执行器，核心职责：

1. 加载技能说明 (SKILL.md)
2. 构建执行 Prompt（技能说明 + 参数 + 询问历史 + 断点上下文）
3. LLM 驱动的工具调用循环（思考 → 观察 → 行动）
4. `ask_user` 工具拦截 → 挂起任务等待用户输入
5. 断点恢复时提供完整对话上下文

---

## 任务调度 (TaskQueue)

**文件**: `src/task-queue/index.ts`

| 特性 | 配置 |
|------|------|
| DAG 依赖管理 | 自动检测环 |
| 并发限制 | 最大 5 个任务 |
| 任务超时 | 30 秒 |
| 参数依赖解析 | 从前驱任务结果中提取 |

---

## 意图路由 (IntentRouter)

**文件**: `src/routers/intent-router.ts`

多信号融合决策系统，决策路径：

1. Fast SmallTalk: 正则匹配问候/致谢/告别等 7 种闲聊模式
2. Fast Followup: 简短输入 + 活跃 session 技能
3. Fast Session: session 技能置信度 > 0.7
4. Fast Keyword: 关键词命中置信度 > 0.8
5. Multi-Signal Agree: 多信号指向同一技能
6. LLM Decision: 综合所有信号调用 LLM 判断

---

## 统一规划器 (UnifiedPlanner)

**文件**: `src/planners/unified-planner.ts`

将需求分析 + 技能匹配 + 任务规划合并为一次 LLM 调用，减少 LLM 调用次数。

---

## 工具体系

**目录**: `src/tools/`

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

---

## 记忆系统

**目录**: `src/memory/`

### 四层记忆架构

| 层级 | 存储 | 内容 |
|------|------|------|
| **Working** | JSON + 内存 | 当前请求上下文，任务完成自动清除 |
| **Episodic** | JSON 文件 | 对话历史，按时间排序持久化 |
| **Semantic** | JSON 文件 | 用户知识偏好，LLM 提取 |
| **Procedural** | JSON 文件 | 技能执行经验 |

### 上下文压缩策略

| 策略 | 触发条件 |
|------|----------|
| MICRO | 每轮调用，清除 >5 分钟前的工具结果 |
| AUTO | >167K tokens，LLM 总结历史 |

---

## 技能注册表 (SkillRegistry)

**文件**: `src/skill-registry/index.ts`

- **渐进式披露**: 先解析 YAML 元数据，按需加载完整 body
- **技能热重载**: `fs.watch` 监听技能目录，200ms 防抖

**技能文件结构**:
```
skills/{name}/
├── SKILL.md        # YAML frontmatter + Markdown 主体
├── references/     # 参考文档
└── scripts/        # 可执行脚本
```

---

## LLM 客户端

**文件**: `src/llm/index.ts`

### 多 Provider 支持

| Provider | 环境变量 | 默认模型 |
|----------|----------|----------|
| Zhipu AI | `ZHIPU_API_KEY` | glm-4v-flash (视觉) |
| SiliconFlow | `SILICONFLOW_API_KEY` | Pro/MiniMaxAI/MiniMax-M2.5 |

### 可靠性机制

- 重试: 最多 3 次，指数退避
- 错误分类: 8 种类型 (RATE_LIMIT / TIMEOUT / API_ERROR 等)
- 上下文压缩: CONTEXT_TOO_LONG → autoCompact

---

## 询问系统 (AskAgent)

**文件**: `src/agents/ask-agent.ts`

判断用户输入是对问题的回答还是新请求：
- 是回答 → 断点恢复继续执行
- 新请求 → 挂起当前请求，创建新请求

---

## 安全体系

**目录**: `src/security/`

### 路径安全检查 (PathGuard)

- **白名单**: 工作目录范围内
- **系统黑名单**: `.ssh`, `/etc/shadow`, `/proc`, `.kube` 等
- **项目黑名单**: `.env`, `credentials`, `secret`, `*.pem`, `*.key` 等

### 沙箱执行 (Sandbox)

- bubblewrap 文件系统/网络隔离
- 无 bwrap 时降级为直接执行（记录日志）

---

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/tasks/stream` | SSE 流式提交 |
| POST | `/tasks` | 同步提交 |
| GET | `/tasks/:id` | 查询状态 |
| GET | `/skills` | 技能列表 |
| GET | `/health` | 健康检查 |

---

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env: 至少配置一个 LLM Provider 的 API Key

# 3. 启动
bun run dev    # 开发模式
# 或
bun run build && bun start  # 生产模式

# 4. 测试
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"requirement": "你好"}'

# 5. 运行测试
bun test
```

### 主要环境变量

| 变量 | 说明 |
|------|------|
| `LLM_PROVIDER` | LLM 提供商 (siliconflow/openrouter/nvidia/zhipu) |
| `LLM_API_KEY` | API 密钥 |
| `PORT` | 服务端口 (默认 3000) |
| `SKILL_DIR` | 技能目录路径 |
| `LOG_LEVEL` | 日志级别 (DEBUG/INFO/WARN/ERROR) |
