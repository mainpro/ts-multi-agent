# PRD - 数字员工协作系统

> **版本**: v1.0  
> **文档定位**: 产品需求文档(基于当前代码真实实现)  
> **配套文档**: `详细设计.md`(架构/模块设计),`分析报告.md`(风险/优化建议)

---

## 1. 文档目的

本文档描述 `ts-multi-agent` 项目的**产品需求**: 系统是什么、为谁服务、解决什么问题、提供哪些能力、不做什么。文档基于仓库当前代码(截至 2026-08-14)的事实,确保"实现的每一行都对得上 PRD 的需求"。

读者:
- 产品/业务方: 理解产品形态、能力边界
- 工程方: 理解每条需求的代码落地位置(标注 `代码:` 文件:行号)

---

## 2. 项目背景与定位

### 2.1 背景

海尔集团内部有 7 类典型员工支持系统(EES / GEAM / 法务 / 时间管理 / 差旅 / 硫酸价格预测 / 兜底服务台),员工在日常工作中需要:
1. 查询系统操作方法("GEAM 怎么导出报表?")
2. 提交跨系统流程("帮我起草一份合同并提交审批")
3. 排查偶发问题("考勤打卡没打上怎么办")

传统做法是为每个系统做单独的 Web 前端 + 帮助文档 + 客服。问题:
- 系统孤岛: 跨系统操作必须人工记忆流程
- 学习成本: 员工需要了解每个系统的入口、操作
- 运维响应: 偶发问题需要找值班工程师

### 2.2 定位

**数字员工协作系统**: 一个 LLM 驱动的统一入口,接收员工自然语言请求,自动:
- 识别意图 + 派发到合适的技能
- 按技能文档驱动工具调用
- 处理跨系统任务编排(DAG 分层执行)
- 支持断点续执行(参数追问 / 系统重启后恢复)

**单进程 = 一个数字员工**(`employees/*.json` 描述身份),多进程部署即可横向扩展员工团队。

---

## 3. 目标用户与场景

### 3.1 目标用户

| 用户角色 | 典型诉求 |
|---|---|
| **集团普通员工** | 查询系统操作、自助办理流程、提交跨系统请求 |
| **系统值班工程师** | 接收升级工单(数字员工识别为 unclear / 转人工) |
| **业务运营** | 维护员工配置(新增/调整技能,新增数字员工配置) |
| **运维 / SRE** | 监控数字员工健康度,SLA 审计,事故复盘 |

### 3.2 典型业务场景

#### 场景 A: 协助用户自助办理问题(`__tests__/it-desk-self-service.test.ts`)

```
员工: "我的 MDM 客户端登不上去了"
数字员工: 识别为 IT 服务台任务
   ↓
   调用 MDM 状态查询工具
   ↓
   "MDM 服务正常,可能是您本地客户端版本问题,请尝试: 1) 重启客户端 ..."
```

#### 场景 B: 问题进度主动推送 + 新问题提报(`__tests__/it-desk-progress-push.test.ts`)

```
员工: "考勤打卡没打上"
数字员工: 检测到 session 有 2 个历史任务
   ↓
   主动推送历史任务进度("工单 #123 处理中 / 工单 #456 已完成")
   ↓
   启动新任务排查考勤问题
   ↓
   两条线并行,各自完成
```

#### 场景 C: 用户中途改口(steer)

```
员工: "查一下我的合同"
数字员工: 启动合同查询任务
   ↓
   (执行中)
员工: "算了,改成查报销单"
数字员工: 在工具调用循环的下一个 turn 注入新消息
   ↓
   合同查询任务被取消/合并,改为报销单查询
```

#### 场景 D: 参数追问(ask_user)

```
员工: "我要请假"
数字员工: 识别为请假流程 → 调用 ask_user 工具
   ↓
   "请问请假类型?(年假/事假/病假)"
员工: "年假"
数字员工: 继续执行,自动填充参数
```

#### 场景 E: 服务重启后断点续传

```
员工: "查 EES 能耗"(会话进行中 → 数字员工在 LLM 调用,提问类型)
   ↓ 服务重启
   ↓
员工: "5"(回答之前提问)
数字员工: 从 L4 历史恢复会话,重建 SubAgent 任务(参数 + LLM 上下文),
         从断点继续执行
```

---

## 4. 核心能力清单

按代码事实归纳,所有能力 100% 在代码中有对应实现。

### 4.1 智能路由与编排

| 能力 | 描述 | 代码 |
|---|---|---|
| **多信号意图识别** | 基于 LLM 的统一意图分类(small_talk / skill_task / confirm_system / unclear) | `src/routers/intent-router.ts:73-118` |
| **技能匹配 + 任务规划合并** | 一次 LLM 调用完成需求分析 + 技能选择 + DAG 规划 | `src/planners/unified-planner.ts:77-171` |
| **DAG 分层执行** | 拓扑排序分层 + 同层并发(默认 5) | `src/agents/task-graph-executor.ts:107-165` |
| **Task 失败有限重试** | LLM 临时错自动重试(base 2s, max 60s, ±1s jitter, 默认 maxRetries=2, 每员工可配) | `src/task-queue/index.ts:executeTask + shouldRetry` |
| **部分失败汇总** | 部分 task 失败时进入汇总阶段,告知用户哪些成功哪些失败,Request.partialFailure=true | `src/agents/task-graph-executor.ts:478-510` + `src/agents/main-agent.ts` |
| **跨任务合并** | R1 执行中用户发新消息 → checkpoint 让位 → R2 合并内容重新规划 | `src/agents/main-agent.ts:703-832` |
| **继续 / 挂起判定** | LLM 判断用户输入是回答还是新请求 | `src/agents/ask-agent.ts:116-150` |
| **Steer 注入** | 用户中途改口消息注入到工具调用循环 | `src/memory/steering-buffer.ts` + `src/agents/sub-agent.ts:651-675` |

### 4.2 数字员工身份

| 能力 | 描述 | 代码 |
|---|---|---|
| **JSON 驱动员工配置** | `employees/*.json` 描述身份/人设/能力/规划/输出加工 | `src/agents/employee/json-types.ts` |
| **启动时加载** | `--employee=<id>` 或 fallback 到目录第一个 enabled | `src/index.ts:156-162` + `src/agents/employee/loader.ts` |
| **Persona 注入** | 人设前缀拼到 IntentRouter + SubAgent 的 system prompt | `src/routers/intent-router.ts:124-132` + `src/agents/sub-agent.ts:326-334` |
| **Skill 白名单** | 员工只能调用白名单内技能,派单前校验 | `src/agents/main-agent.ts:1137-1150` |
| **工具 3 段过滤** | skill.allowedTools ∩ employee.tools.enabled − employee.tools.denied | `src/agents/employee/tools.ts:32-57` |
| **结果改写** | 完成后追加"转人工"尾注(可配) | `src/agents/result-aggregator.ts:54-63,241-250` |

### 4.3 记忆与上下文

| 能力 | 描述 | 代码 |
|---|---|---|
| **4 层记忆架构** | L1 RAM 临时 + L2 用户档案 JSON + L3 摘要+embedding + L4 历史 JSON | `src/memory/memory-service.ts:56-91` |
| **请求级摘要** | 请求完成时异步生成 L3 摘要,失败不阻塞 | `src/memory/memory-service.ts:225-235` |
| **语义召回** | L3 embedding 相似度检索相关记忆 | `src/memory/memory-service.ts:264-276` |
| **用户画像** | 部门、常用系统、权限、对话历史 | `src/user-profile/` |
| **进程退出 flush** | gracefulShutdown 时刷 L4 pending 写入 | `src/index.ts:208-240` |

### 4.4 会话与状态

| 能力 | 描述 | 代码 |
|---|---|---|
| **会话持久化** | 100ms 防抖写盘 + waiting 状态立即刷盘 | `src/memory/session-store.ts:76-108` |
| **断点续传** | 任务级 LLM 对话上下文 + 已完成工具调用持久化 | `src/types/index.ts:294-309` + `src/agents/task-graph-executor.ts:505-663` |
| **崩溃恢复** | 启动时清理 stale processing request | `src/memory/session-store.ts:485-536` |
| **陈旧 active 检测** | active request 超 5 分钟无更新按 fresh 处理 | `src/agents/session-gate.ts:35-85` |
| **Pending 队列** | session 内最多 10 条待合并请求 | `src/agents/session-gate.ts:25,89-95` |

### 4.5 LLM 可靠性

| 能力 | 描述 | 代码 |
|---|---|---|
| **Provider 故障转移** | config 链按 priority 切换,cooldown TTL 标记不可用 | `src/llm/fallback-client.ts` + `src/llm/cooldown-cache.ts` |
| **指数退避重试** | RATE_LIMIT/TIMEOUT/NETWORK_ERROR 最多 3 次 | `src/llm/index.ts:572-667` |
| **流式响应** | SSE 实时推送 reasoning(LLM 思考过程) | `src/llm/index.ts:678-767` |
| **并发限流** | 信号量(默认 20 并发 + 50 排队) | `src/llm/index.ts:262-360` |
| **JSON 修复** | LLM 输出未转义引号自愈 | `src/llm/index.ts:32-78` |
| **Tool-call 修复** | LLM 把 tool call 写在 content 里时反向提升 | `src/llm/tool-call-repair.ts` |
| **CONTEXT_TOO_LONG 压缩** | safe compaction 压缩 messages 重试 1 次 | `src/llm/compaction.ts` + `src/agents/sub-agent.ts:677-716` |

### 4.6 工具体系

| 工具 | 用途 | 并发安全 | 代码 |
|---|---|---|---|
| `read` | 读文件 | ✅ | `src/tools/file-read-tool.ts` |
| `write` | 写文件 | ❌ | `src/tools/write-tool.ts` |
| `edit` | 精确字符串替换 | ❌ | `src/tools/edit-tool.ts` |
| `bash` | shell 命令(白名单 + 沙箱) | ❌ | `src/tools/bash-tool.ts` |
| `glob` | 文件模式匹配 | ✅ | `src/tools/glob-tool.ts` |
| `grep` | 文件内容搜索 | ✅ | `src/tools/grep-tool.ts` |
| `ask_user` | 向用户提问(挂起任务) | ❌ | `src/tools/ask-user-tool.ts` |
| `conversation-get` | 获取对话历史 | ❌ | `src/tools/context-tool.ts` |
| `append_improvement` | 记录技能执行问题(SubAgent 自我审查) | ❌ | `src/tools/append-improvement-tool.ts` |

### 4.7 安全

| 能力 | 描述 | 代码 |
|---|---|---|
| **路径白名单** | 工具调用工作目录必须 ≤ skill root | `src/security/path-guard.ts:48-91` |
| **路径黑名单** | 系统/项目敏感路径拦截(.env, .ssh, .aws, .pem 等) | `src/security/path-guard.ts:18-43` |
| **Bash 白名单** | 只允许已知安全命令前缀(node scripts/, npm, ls, cat 等) | `src/security/path-guard.ts:99-124` |
| **Bash 危险模式黑名单** | sudo/eval/反引号/rm -rf 等二次兜底 | `src/security/path-guard.ts:151-163` |
| **未知工具熔断** | 同一工具名调用 >3 次自动重写为友好提示 | `src/agents/unknown-tool-guard.ts` |
| **Guardrail 中间件** | deny/rewrite/alert 三档策略(关键词 + PII + 用户权限) | `src/guardrail/` |
| **审计日志** | guardrail / SLA breach 落 JSONL | `src/guardrail/audit-logger.ts` |

### 4.8 可观测性

| 能力 | 描述 | 代码 |
|---|---|---|
| **结构化 JSON 日志** | 全模块 `createLogger({module})` 单行 JSON | `src/observability/logger.ts` |
| **OTel 指标** | LLM calls/latency/errors + Skill calls + SLA breached | `src/observability/metrics.ts` |
| **SLA Watcher** | request(60s) / LLM(30s) / skill(15s) 超阈值归因 | `src/observability/sla-watcher.ts` |
| **归因计数器** | SLA_BREACH / INJECT_DENY 等多 tag 计数 | `src/observability/attribution.ts` |
| **Metrics 端点** | `/metrics` 暴露 task + otel 实时数据 | `src/api/index.ts:201-222` |
| **traceId 贯穿** | req-{ts}-{rand} 在所有日志携带 | `src/observability/logger.ts` + `src/index.ts:374` |

### 4.9 运维

| 能力 | 描述 | 代码 |
|---|---|---|
| **技能热重载** | fs.watch + 500ms 防抖 + 单技能重载 | `src/skill-registry/index.ts:292-347` |
| **会话恢复** | 进程重启后从 L4 恢复历史 + 重建任务 | `src/memory/session-store.ts` |
| **优雅关闭** | SIGTERM/uncaughtException → flush L4 → exit | `src/index.ts:236-256` |
| **Docker 部署** | docker-compose + Dockerfile 已就绪 | `DEPLOY.md` |

---

## 5. API 能力

`src/api/index.ts` 暴露的 HTTP 接口:

| 方法 | 路径 | 能力 |
|---|---|---|
| `POST` | `/tasks` | 异步提交任务(立即 202,后台执行) |
| `POST` | `/tasks/stream` | SSE 流式提交(实时 reasoning + task 进度) |
| `GET` | `/tasks/:id` | 查询任务状态 |
| `GET` | `/tasks/:id/result` | 获取任务结果 |
| `DELETE` | `/tasks/:id` | 取消任务 |
| `GET` | `/tasks` | 列出任务(可按状态过滤) |
| `GET` | `/skills` | 列出可用技能 |
| `GET` | `/sessions/:sessionId/history` | 恢复对话历史 |
| `GET` | `/metrics` | 监控指标 |
| `GET` | `/health` | 健康检查 |
| `POST` | `/tasks/execute` | Plan Mode 确认执行 |

详细见 `API.md`。

---

## 6. 已交付的 7 个员工 / 技能配置

仓库实际配置 2 个数字员工 + 7 个技能(只读,从 `employees/` 和 `skills/` 目录事实提取):

### 6.1 数字员工(2 个)

| 员工 ID | displayName | 启用技能数 | 启用工具数 | 拒绝工具 | 温度 | maxTokens | 并发 |
|---|---|---|---|---|---|---|---|
| `legal-assistant` | 法务助理·小法 | 1 (fawu) | 4 | send_email, external_api | 0.3 | 2000 | 5 |
| `it-ops-consultant` | IT 运维顾问·小海 | 7 (全部) | 7 | send_email_external | 0.5 | 4000 | 8 |

`小法` 只处理法务(严谨,低温度,低并发);`小海` 是大堂经理(灵活,涵盖全部 7 个技能,可执行 shell)。

### 6.2 业务技能(7 个,从 `skills/` 目录事实)

| Skill | description | 简述 |
|---|---|---|
| `ees-qa` | EES 系统问答 | 能源管理系统 |
| `geam-qa` | GEAM 系统问答 | 设备资产管理 |
| `fawu` | 海尔集团法务系统 | 合同/审批/查询 |
| `time-management-qa` | 时间管理问答 | 考勤/请假 |
| `travel-expense-apply` | 差旅报销申请 | 差旅流程 |
| `sulfuric-acid-price-prediction` | 硫酸价格预测 | 业务数据查询 |
| `fallback-service-desk` | 兜底服务台 | 未匹配技能时降级 |

每个 Skill 是 1 份 `skills/{name}/SKILL.md`,含 YAML frontmatter(元数据 + `allowedTools`)+ Markdown 主体(操作流程 / 错误处理)。

---

## 7. 非目标(Out of Scope)

明确**不**做的事情(避免范围蔓延):

| 项 | 原因 |
|---|---|
| **跨进程员工协作** | 当前架构 = 单进程 = 单员工,跨进程协作需独立设计(留待分布式部署) |
| **员工配置热更新** | 当前需重启进程加载新配置(留待未来需求) |
| **员工配置 UI / 后台管理** | 当前 JSON 文件手动编辑(运维直接改) |
| **远程员工配置 provider** | 当前只读本地 `employees/`(不接 config server) |
| **12 个员工全部实现** | 当前只迁 2 个示例(legal-assistant, it-ops-consultant) |
| **LLM 韧性层 / 记忆系统 / Skill 注册的工具归属重定义** | 已用当前实现,不在本项目重构范围 |
| **PPT / 讲稿的名称统一** | "虚拟员工" → "数字员工" 的历史命名统一(其他文档已采用) |
| **员工运行指标看板** | SLA Watcher 已埋点,但无可视化看板(留待 BI 集成) |
| **LLM provider/temperature 强制按员工 override** | 当前 LLMClient 已支持 options,但 bootstrap 集成仅打 log,完整集成留待 follow-up |

---

## 8. 验收标准

每条核心能力对应至少 1 个测试用例,可由 `bun test` 验证:

| 类别 | 数量 | 路径 |
|---|---|---|
| 单元测试 | ~60 个 | `__tests__/*.test.ts` |
| E2E 测试 | ~5 个 | `__tests__/it-desk-*.test.ts`, `error-propagation-e2e.test.ts` |
| 当前状态 | 47 个 test file 全部通过 + 6 个 pre-existing 失败(与本项目无关) |

具体跑法:
```bash
bun test                    # 跑全部
bun test __tests__/api.test.ts  # 单文件
bunx tsc --noEmit           # 类型检查
```

---

## 9. 文档对应关系

| 读者 | 应读 |
|---|---|
| 产品 / 业务 | `PRD.md`(本文档) |
| 工程(架构) | `详细设计.md` |
| 工程(风险 / 优化) | `分析报告.md` |
| 集成方 | `API.md` + `DEPLOY.md` |
| Agent 操作规范 | `AGENTS.md`(项目内强制规则) |