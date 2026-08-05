# Virtual Employee(虚拟员工)

## 是什么

虚拟员工 = 由系统提供出去的、**自带业务属性**的智能体。每个虚拟员工继承 `VirtualEmployee`,在共享的 `SubAgent` 执行循环(LLM 调用 / 断点续 / steer / metrics / compaction)之上,通过 4 个模板方法注入业务表达:

- `systemPromptPrefix()` — 拼到 skill body 前面的 persona(职责 / 风格 / 边界)
- `allowedSkillNames()` — 该员工允许调用的 skill 集合(`null` = 不限制)
- `resultRewriter()` — 对返回 result 做后处理(如追加"转人工/评价"尾注;仅在 `status: 'completed'` 时生效,**避免给 `waiting_user_input` 的提问文本追加尾注**)
- `configId()` — 员工标识(默认 `'unknown'`,子类 override 返回 `config.id`,用于日志/错误消息)

意图是把"业务方需要的差异"集中在一个文件里,而不污染通用 SubAgent 通道。

## 为什么需要这一层

背景:产品规划里有 12 类业务角色(IT 运维 / HR / 财务 / 销售 / 法务 / ...),都共享同一套 SubAgent 基础能力(LLM 循环 / 断点续 / 观测 / steer)。如果没有"虚拟员工"这一层,差异化(人设 / 技能白名单 / 文案风格)只能散落在:

- `ResultAggregator` 里的字符串拼接
- `buildSubAgentPrompt` 里的 if-else 分支
- 各 skill 的 `body` 字段里硬编码

每加一个角色,都要改 3-5 个文件,且没有"角色"这个抽象来聚合业务属性。

抽到 `VirtualEmployee` 后:

- **新增一个员工 = 新建一个 TS 文件**(继承 + override 4 hooks),SubAgent / MainAgent / API 不动
- **业务属性集中在一个文件**(reviewer 看一眼就知道这个员工做什么)
- **路由逻辑独立**(`VirtualEmployeeResolver` 处理 @mention / 关键词 / 默认 fallback),不污染 MainAgent 主流程

代价:多一层间接 + 4 个 hook 设计需要稳定下来。当前规模(1 个示例员工)看,收益 > 成本;扩展到 12 个员工时,这一层抽象是必要的前提。

## 当前状态

已注册 1 个示例 + 标记为默认 fallback:

- **IT 运维顾问·小海**(`id: 'it-ops-consultant'`)— 集团 IT 服务台,负责系统报错 / 桌面运维 / 网络 / 工单 / 门禁类问题。覆盖本系统当前全部 7 个 skill,带"转人工 / 评价"尾注。注册时 `isDefault: true`,无 @mention 又未命中关键词时兜底。

文件:
- `src/agents/virtual-employee/employees/it-operations-consultant.ts`

## 路由策略(3 级 fallback)

`VirtualEmployeeResolver.resolve()`(`src/agents/virtual-employee/resolver.ts`)按以下顺序选员工:

1. **显式 hint** — 调用方传 `hintedId`,或在消息中检测到 `@<id|displayName>` 前缀。直接命中。
2. **意图关键词** — 把 `userMessage` toLowerCase,对注册表按顺序扫 `config.intentKeywords`,第一个 substring 命中的员工返回。
3. **默认员工** — 注册表中 `isDefault=true` 的一项。

三级全部失败时:
- 消息里有 `@` 前缀 → `BusinessError('UNKNOWN_EMPLOYEE')`
- 没有 `@` 前缀 → `BusinessError('NO_DEFAULT_EMPLOYEE')`

## 后续改进项(Task 7+ 已知限制)

- **并发 race**:当前 `MainAgent.taskQueue.executor` 被 `setExecutor` 替换为本请求的 `selectedEmployee.execute`,单 MainAgent 进程下多并发请求共享同一个 executor 字段。race 是已知限制,需要按 request/planId 隔离(executor-as-map)或在 TaskQueue 层做 per-request 包装。
- **数据权限 scope**:当前虚拟员工共享同一 `MemoryService`,所有员工的 recall 都看到全局用户画像 + 全部会话记忆。需要按员工加 scope 过滤(允许查 / 写入哪些 userId / sessionId / memory namespace)。
- **escalation routes**:示例员工声明"销售/产品 → 转接"是用 prompt 字面表达的,没有实际的"转接"通道(没有工单系统回写、没有值班工程师通知、没有 IM 群转移)。需要把边界声明 → 真实路由打通。
- **员工热加载**:目前 `VirtualEmployeeRegistry` 是进程内静态 `Map`,新增员工必须改代码 + 重启。需要支持运行时注册(例如配置文件 + watch)。
- **前端员工选择器**:当前 API 接受 `hintedId`,但前端没有列出可选员工的 UI;员工注册后 `GET /virtual-employees` 之类枚举 API 尚未实现。

## 相关文件

- 类型与基类:
  - `src/agents/virtual-employee/types.ts`
  - `src/agents/virtual-employee/base.ts`
- 注册表:
  - `src/agents/virtual-employee/registry.ts`
- 路由器:
  - `src/agents/virtual-employee/resolver.ts`
- 示例员工:
  - `src/agents/virtual-employee/employees/it-operations-consultant.ts`
- SubAgent 模板方法:
  - `src/agents/sub-agent.ts`(`systemPromptPrefix` / `allowedSkillNames` / `resultRewriter`)
