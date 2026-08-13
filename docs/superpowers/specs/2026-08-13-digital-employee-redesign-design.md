# 数字员工重新定位设计规格(单进程 = 单员工)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 把数字员工从「进程内多员工并存 + Resolver 路由」重构为「单进程 = 单员工」,persona/skills/tools/planning/output 全部上移到 MainAgent;SubAgent 退化为纯 worker;新增 capabilities.llm 让员工自配 LLM 参数。

**Architecture**: 删除 `VirtualEmployee` / `JsonVirtualEmployee` / `VirtualEmployeeRegistry` / `VirtualEmployeeResolver` / `FileEmployeeConfigProvider` 整个抽象层,persona-related state 收归 `MainAgent`;SubAgent 移除 4 个 persona hook,改为通过 task 上下文接收 persona-derived prompt;bootstrap 解析 `--employee=<id>` 命令行参数(兜底读 `employees/` 目录第一个 JSON)→ 构造 `MainAgent(employeeConfig, llm, ...)` → 一个进程就是一个员工。

**Tech Stack**: TypeScript / Bun test / zod (已有) / 现有 LLM 韧性层 + 记忆 + Skill 全复用,不引入新依赖。

---

## Context

### 背景

2026-08-05 spec(`virtual-employee-design.md`)首次引入「虚拟员工」抽象:在 MainAgent 与 SubAgent 之间加一层 `VirtualEmployee extends SubAgent`,persona hook 落在子类上,`VirtualEmployeeRegistry` 在启动时加载 `employees/*.json` 目录所有 enabled 员工,`VirtualEmployeeResolver` 按 @mention / 关键词 / 默认三级 fallback 路由。

实践中暴露 3 个真实问题(2026-08-13 用户反馈):

1. **产品承诺与实现不匹配**: PPT 讲「我有 N 个员工」,但代码里 N 个员工共享一个进程、无独立 SLA 指标,严格意义上是「N 个员工配置模板」而非「N 个员工」。
2. **同员工并发派任务反数字员工直觉**: 2 个法务请求进来,实际派 2 个临时 worker 实例,不是「同一个法务员工接客」。
3. **架构层级倒挂**: 「我是谁」(persona)挂在 SubAgent 子类上,但实际上「我」是 MainAgent(负责规划/调度/汇总的整体),SubAgent 只是它雇的 worker。

### 重新定位

按单一职责原则重新定义:

| 实体 | 职责 | 数量 |
|------|------|------|
| **进程**(Process) | 一个数字员工的运行时容器 | = 1 个员工实例 |
| **数字员工**(Digital Employee) | 持有 persona / skills / tools / planning / LLM / 输出策略的整体智能体 | 1 个进程 = 1 个员工 |
| **Master / MainAgent** | 数字员工本身 —— 负责意图识别、任务规划、调度、汇总 | 1 个 |
| **Worker / SubAgent** | 纯执行器 —— 接 task → 调 LLM + 工具 → 返回结果 | N 个(任务图并发数) |

部署形态: `bun start --employee=legal-assistant` → 进程启动 → 加载 `employees/legal-assistant.json` → 这个进程就是「法务助理·小法」这个数字员工。

### 与现有架构的关系

- **删除**:`VirtualEmployee` / `JsonVirtualEmployee` / `VirtualEmployeeRegistry` / `VirtualEmployeeResolver` / `FileEmployeeConfigProvider`(5 个文件)
- **改写**:`MainAgent`(持有 employee config,persona 上移到这里)、`SubAgent`(移除 4 个 hook,改为接收 task 上下文中已注入的 persona)
- **不动**:`TaskQueue` / `TaskGraph` / `UnifiedPlanner` / `IntentRouter` 的核心算法;LLM 韧性层 / 记忆系统 / Skill 注册 / 工具注册(`ToolRegistry`)全部作为进程级基础设施跟随员工

### 排除项(本次不做)

- ❌ 进程间跨员工协作(留到分布式主控 spec)
- ❌ 多员工并存路由(单员工进程不需要)
- ❌ 员工配置热更新(boot 时一次性加载,后续 spec)
- ❌ 员工配置 UI / 后台管理(产品化)
- ❌ 远程员工配置 provider(`RemoteEmployeeConfigProvider` 已在 `loader.ts` 占位 stub,本次同步删除)
- ❌ 12 类虚拟员工全部实现(本次只迁 2 个示例:法务助理 / IT 运维顾问)
- ❌ 改 LLM 韧性层 / 记忆系统 / Skill 注册 / 工具注册的归属(默认跟随员工进程)

---

## 全局约束

| 约束 | 值 | 来源 |
|------|---|------|
| 单进程单员工 | 一个 ts-multi-agent 进程 = 一个数字员工实例 | 用户澄清 2026-08-13 |
| 进程身份确定机制 | 命令行 `--employee=<id>` 优先;无参数兜底读 `employees/*.json` 第一个 | 用户澄清 2026-08-13 |
| employee 配置缺失/坏 | `BootstrapError('EMPLOYEE_CONFIG_INVALID', ...)` fail-fast | 设计决策 |
| 多员工并存 | 不支持 —— 启动时只加载 1 份 config | 设计决策 |
| 路由策略 | 删除 —— 不再需要 @mention / 关键词 / 默认路由 | 设计决策 |
| persona 挂载位置 | MainAgent 持有;通过 task 上下文传给 worker | 用户澄清 2026-08-13 |
| SubAgent persona hook | 移除 4 个:`systemPromptPrefix` / `allowedSkillNames` / `resultRewriter` / `configId` | 用户澄清 2026-08-13 |
| skill 白名单校验时机 | MainAgent 在入队前校验(`SubAgent.execute()` 入口不再校验) | 设计决策 |
| 工具过滤时机 | MainAgent 在构造 task 时按 `employee.capabilities.tools` 过滤后写入 `task.allowedTools` | 设计决策 |
| LLM 客户端构造 | 由 `employee.capabilities.llm` 决定 provider / fallback / temperature / maxTokens | 用户澄清 2026-08-13 |
| planner hint 注入 | `UnifiedPlanner.plan()` 接收 `planning.decompositionHint` 作为 system prompt 段落 | 用户澄清 2026-08-13 |
| resultRewriter 应用 | `ResultAggregator.summarize()` 完成时按 `employee.outputBehavior.resultRewriter` 改写最终回复 | 设计决策 |
| 启动入口 | `src/index.ts:bootstrap()` 解析 argv → 调 `loadEmployeeConfig()` → 构造 `MainAgent` | 设计决策 |
| 测试框架 | `bun:test`,沿用现有 `__tests__/` 目录 | 现有约定 |
| 不引入新依赖 | 不新增 npm 包 | YAGNI |
| 现有测试零回归 | `bun test` 全部已有用例通过(删除 VirtualEmployee 层后,任何引用此层的测试必须一起改) | 现有约束 |
| 旧 employees/*.json 字段迁移 | `intentKeywords` / `isDefault` 删除;`persona.prefix` 拆为 `persona.prefix` + `persona.style` + `persona.boundaries`;新增 `capabilities.llm` / `capabilities.tools` / `planning` / `outputBehavior` 顶层结构 | 设计决策 |
| 错误类 | 复用现有 `BootstrapError extends AppError`(`src/errors/bootstrap-error.ts`),不新建并行错误类 | 现有约定 |

---

## 关键概念

### 数字员工(Digital Employee)

**定义**: 一个部署实例 = 一个数字员工。它是一个完整、可独立运行、有自己业务属性的智能体。

**业务属性**(配置决定):
- **身份**(employee): id / displayName
- **人设**(persona): prefix / style / boundaries
- **能力**(capabilities): skillWhitelist / tools / llm
- **规划偏好**(planning): maxParallelTasks / decompositionHint
- **输出行为**(outputBehavior): resultRewriter

### Master / Worker 关系

```
Master (MainAgent) = 数字员工本体
  持有 employee 配置 + 所有 persona-related state
  ↓ 构造 task 时,把 persona/tools 注入到 task 上下文
Worker (SubAgent) = 数字员工雇的执行者
  纯 executor,无 hooks
  读 task 上下文,按指令执行
```

**关键**: Master 和 Worker 在**同一个进程**内,但**职责严格分离**。Master 决定「做什么」(拆任务、定依赖、过滤工具、注入人设),Worker 决定「怎么做」(调 LLM + 工具循环)。

---

## 配置文件 schema(`employees/*.json`)

### 完整 schema(zod 定义)

```typescript
// src/agents/employee/json-types.ts
import { z } from 'zod';

// ── 身份层 ──
export const EmployeeIdentitySchema = z.object({
  id: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  enabled: z.boolean().optional().default(true),
});

// ── 角色层 ──
export const PersonaSchema = z.object({
  prefix: z.string(),       // 模板,支持 ${displayName}
  style: z.string().optional(),     // 风格描述
  boundaries: z.string().optional(), // 边界规则
});

// ── 能力层 ──
export const SkillWhitelistSchema = z.union([
  z.object({ type: z.literal('allowlist'), skills: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('unrestricted') }),
]);

export const ToolPolicySchema = z.object({
  enabled: z.array(z.string()).optional(),  // 白名单(可选)
  denied: z.array(z.string()).optional(),   // 黑名单(可选)
}).refine(
  (p) => p.enabled !== undefined || p.denied !== undefined,
  { message: 'tools 至少需要 enabled 或 denied 之一' },
);

export const LLMConfigSchema = z.object({
  provider: z.enum(['haier', 'siliconflow']),  // 当前支持的两家
  fallbackProvider: z.enum(['haier', 'siliconflow']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const CapabilitiesSchema = z.object({
  skillWhitelist: SkillWhitelistSchema.optional(),
  tools: ToolPolicySchema.optional(),
  llm: LLMConfigSchema,
});

// ── 规划层 ──
export const PlanningSchema = z.object({
  maxParallelTasks: z.number().int().positive().max(50).optional().default(5),
  decompositionHint: z.string().optional(),
});

// ── 输出行为层 ──
export const ResultRewriterSchema = z.object({
  match: z.object({ status: z.enum(['completed', 'waiting_user_input', 'failed']).optional() }).optional(),
  transform: z.enum(['append', 'passthrough', 'replace']),
  value: z.string().optional(),
}).refine(
  (d) => d.transform !== 'append' || (typeof d.value === 'string' && d.value.length > 0),
  { message: 'transform=append 时 value 必填且非空' },
);

export const OutputBehaviorSchema = z.object({
  resultRewriter: ResultRewriterSchema.optional(),
});

// ── 顶层 ──
export const EmployeeConfigSchema = z.object({
  employee: EmployeeIdentitySchema,
  persona: PersonaSchema.optional(),
  capabilities: CapabilitiesSchema,
  planning: PlanningSchema.optional(),
  outputBehavior: OutputBehaviorSchema.optional(),
});

export type EmployeeConfig = z.infer<typeof EmployeeConfigSchema>;
```

### 示例:`employees/legal-assistant.json`

```json
{
  "employee": {
    "id": "legal-assistant",
    "displayName": "法务助理·小法",
    "enabled": true
  },
  "persona": {
    "prefix": "你是「${displayName}」,集团法务部门的数字员工。",
    "style": "严谨、准确、引用具体条款编号。",
    "boundaries": "诉讼/合规等专业议题请转人工。"
  },
  "capabilities": {
    "skillWhitelist": { "type": "allowlist", "skills": ["fawu"] },
    "tools": {
      "enabled": ["knowledge_search", "contract_lookup"],
      "denied": ["send_email", "external_api"]
    },
    "llm": {
      "provider": "haier",
      "fallbackProvider": "siliconflow",
      "temperature": 0.3,
      "maxTokens": 2000
    }
  },
  "planning": {
    "maxParallelTasks": 5,
    "decompositionHint": "法务任务通常拆为:条款查询 → 风险评估 → 文档生成"
  },
  "outputBehavior": {
    "resultRewriter": {
      "match": { "status": "completed" },
      "transform": "append",
      "value": "\n\n---如有进一步法律问题,请回复「转人工」..."
    }
  }
}
```

---

## 启动流程(`src/index.ts`)

```typescript
// 启动序列(伪代码)
async function bootstrap() {
  // 1. 解析员工身份
  const explicitId = parseEmployeeArg(process.argv); // --employee=xxx
  const config = await loadEmployeeConfig(explicitId); // 校验 + fail-fast
  // ↑ 显式 id 找不到 → BootstrapError('EMPLOYEE_NOT_FOUND', id)
  // ↑ 无显式 id → 读 employees/ 目录第一个 enabled 的 JSON
  // ↑ employees/ 空 → BootstrapError('NO_EMPLOYEE_CONFIG', ...)
  // ↑ JSON 坏 → BootstrapError('EMPLOYEE_CONFIG_INVALID', file, err)

  // 2. 构造 LLM 客户端(用 employee.capabilities.llm)
  const llm = await buildLLMClient({
    provider: config.capabilities.llm.provider,
    fallbackProvider: config.capabilities.llm.fallbackProvider,
    temperature: config.capabilities.llm.temperature,
    maxTokens: config.capabilities.llm.maxTokens,
  });

  // 3. 构造 MainAgent(持有 employee + llm)
  const mainAgent = new MainAgent(
    { llm, skillRegistry, ... },  // 现有依赖
    { employee: config },          // ★ 新增:员工配置
  );

  // 4. 启动 HTTP 服务
  app.listen(PORT);
  log.info('数字员工已上线', { id: config.employee.id, displayName: config.employee.displayName });
}
```

### `loadEmployeeConfig()` 行为

| 输入 | 行为 |
|------|------|
| `--employee=legal-assistant` 有效 | 读 `employees/legal-assistant.json`,校验,返回 |
| `--employee=legal-assistant` 不存在 | `BootstrapError('EMPLOYEE_NOT_FOUND', id)` |
| 无 `--employee` 参数 | `fs.readdir('employees/')` → 取第一个 enabled 的 `.json` |
| `employees/` 空 / 全 disabled | `BootstrapError('NO_EMPLOYEE_CONFIG', dir)` |
| JSON 解析失败 / zod 校验失败 | `BootstrapError('EMPLOYEE_CONFIG_INVALID', file, err)` |

---

## 运行时数据流

### Master 内部流程

```
用户请求
   ↓
MainAgent.processRequirement(requirement)
   │
   ├─ 加载上下文(userProfile / memory / session / dynamicContext)
   │
   ├─ IntentRouter.classify(requirement, persona=employee.persona)
   │    system prompt = basePrompt + persona.prefix + persona.style
   │    → { intent, tasks }
   │
   ├─ UnifiedPlanner.plan(requirement, hint=employee.planning.decompositionHint)
   │    system prompt = basePrompt + planning.decompositionHint
   │    → { tasks: [{ skillName, requirement, dependencies }] }
   │
   ├─ 构造 TaskGraph
   │    对每个 task 节点:
   │      - 校验 task.skillName 在 employee.capabilities.skillWhitelist
   │      - 计算 allowedTools = skill.allowedTools ∩ tools.enabled − tools.denied
   │      - 写入 task._personaContext = { prefix, style, boundaries }
   │      - 写入 task.allowedTools = 计算结果
   │
   ├─ TaskGraphExecutor.executeTaskGraph(graph, executorFactory)
   │    executorFactory(task) = (task, signal) => new SubAgent(...).execute(task, signal)
   │    SubAgent 内部:
   │      - 不再调 persona hook
   │      - systemPrompt = skill.body + task._personaContext.prefix
   │      - 工具过滤用 task.allowedTools
   │      - 调 LLM + 工具循环
   │      - 返回 result
   │
   └─ ResultAggregator.summarize(results)
        finalResponse = summary
        if (employee.outputBehavior.resultRewriter) {
          finalResponse = applyRewriter(finalResponse, resultRewriter)
        }
        返回用户
```

### task 上下文结构(注入到 Task 对象)

```typescript
interface Task {
  // 原有字段
  id: string;
  skillName: string;
  requirement: string;
  params?: Record<string, unknown>;
  dependencies: string[];

  // 新增字段(Master 在构造时填充)
  _personaContext?: {
    prefix: string;        // 拼到 skill.body 前
    style?: string;        // 拼到 system prompt 风格段落
    boundaries?: string;   // 拼到 system prompt 边界段落
  };
  allowedTools?: string[]; // 过滤后的工具列表(已应用 employee + skill 双重过滤)
}
```

### 工具过滤规则

```typescript
// 伪代码(在 MainAgent 构造 task 时执行)
function computeAllowedTools(
  skillAllowedTools: string[] | undefined,
  employeeTools: ToolPolicy | undefined,
): Set<string> {
  // 1. 基础集:skill 限定 OR DEFAULT_SAFE_TOOLS 兜底
  let base: Set<string>;
  if (skillAllowedTools && skillAllowedTools.length > 0) {
    base = new Set(skillAllowedTools);
  } else {
    base = new Set(DEFAULT_SAFE_TOOLS); // conversation-get / read / glob / grep / ask_user
  }

  // 2. 员工白名单(若定义):交集
  if (employeeTools?.enabled && employeeTools.enabled.length > 0) {
    const enabledSet = new Set(employeeTools.enabled);
    base = new Set([...base].filter(t => enabledSet.has(t)));
  }

  // 3. 员工黑名单(若定义):差集
  if (employeeTools?.denied && employeeTools.denied.length > 0) {
    const deniedSet = new Set(employeeTools.denied);
    base = new Set([...base].filter(t => !deniedSet.has(t)));
  }

  return base;
}
```

**关键规则**:
- skill.allowedTools 与 DEFAULT_SAFE_TOOLS 二选一(不叠加)
- 员工白名单是交集(更严格)
- 员工黑名单是差集(更严格)
- 黑名单优先级最高(即使 skill 允许 + 白名单放行,黑名单也拒绝)

---

## 文件结构

### 删除

| 文件 | 原因 |
|------|------|
| `src/agents/virtual-employee/base.ts` | VirtualEmployee 类不再需要 |
| `src/agents/virtual-employee/json-employee.ts` | JsonVirtualEmployee 退场 |
| `src/agents/virtual-employee/registry.ts` | VirtualEmployeeRegistry 退场 |
| `src/agents/virtual-employee/resolver.ts` | VirtualEmployeeResolver 退场 |
| `src/agents/virtual-employee/employees/it-operations-consultant.ts` | 删除:旧 TS 类扩展实现的虚拟员工(已被 JSON 配置取代) |

### 移动 + 改写

| 文件 | 改动 |
|------|------|
| `src/agents/virtual-employee/loader.ts` → `src/agents/employee/loader.ts` | FileEmployeeConfigProvider 改写为 `loadEmployeeConfig(id?)`,返回 `EmployeeConfig` |
| `src/agents/virtual-employee/json-types.ts` → `src/agents/employee/json-types.ts` | schema 全面更新(见 §配置文件 schema) |
| `src/agents/virtual-employee/types.ts` → `src/agents/employee/types.ts` | 类型定义更新为 `EmployeeConfig` / `PersonaConfig` 等 |

**注**:目录从 `virtual-employee/` 改名为 `employee/`,因为现在「虚拟员工」就是「数字员工」(简称「员工」),概念统一。

### 修改

| 文件 | 改动 |
|------|------|
| `src/agents/main-agent.ts` | 大改:构造接受 `employee: EmployeeConfig`;`processRequirement` / `processNormalRequirement` / `executeTaskGraph` 全部用 employee;移除 `virtualEmployeeResolver` 全局变量 |
| `src/agents/sub-agent.ts` | 移除 4 个 hook:`systemPromptPrefix()` / `allowedSkillNames()` / `resultRewriter()` / `configId()`;execute() 入口不再校验 skill 白名单;persona 通过 `task._personaContext` 传入 |
| `src/planners/unified-planner.ts` | `plan()` 接收可选 `hint: string` 参数,注入到 system prompt 段落 |
| `src/routers/intent-router.ts` | `classify()` 接收可选 `persona: PersonaConfig` 参数,影响 system prompt 拼装 |
| `src/agents/result-aggregator.ts` | `summarizeResults()` 返回结果后,可选应用 `resultRewriter` |
| `src/task-queue/index.ts` | `TaskExecutor` 签名不变(继续接 `(task, signal)`);透传 task 上的 `_personaContext` / `allowedTools` |
| `src/llm/index.ts` | `buildLLMClient(config)` 接受 `{ provider, fallbackProvider, temperature, maxTokens }`,构造 ILLMClient |
| `src/index.ts` | bootstrap 解析 `--employee=<id>`;构造 `MainAgent(deps, { employee })`;移除 `loadAndRegister(FileEmployeeConfigProvider(...))` 调用 |
| `employees/legal-assistant.json` | 按新 schema 重写 |
| `employees/it-ops-consultant.json` | 按新 schema 重写 |

### 测试文件

| 文件 | 改动 |
|------|------|
| `__tests__/employee-loader.test.ts` | 新建:测试 `loadEmployeeConfig()` 的 5 种行为(显式 / 兜底 / 缺 / 坏 / 找不到) |
| `__tests__/employee-config-schema.test.ts` | 新建:zod schema 边界测试(每个字段合法/非法用例) |
| `__tests__/main-agent-persona.test.ts` | 新建:测试 MainAgent 持有 employee + persona 正确注入到 IntentRouter / UnifiedPlanner / SubAgent |
| `__tests__/sub-agent-no-persona.test.ts` | 新建:测试 SubAgent 不再有 persona hook,完全靠 task 上下文 |
| `__tests__/task-graph-tools-filter.test.ts` | 新建:测试 task 构造时的工具过滤逻辑 |
| `__tests__/bootstrap-employee.test.ts` | 新建:测试 bootstrap 流程中 employee 加载失败的 5 种错误码 |
| 现有引用 `VirtualEmployee` / `VirtualEmployeeResolver` 的测试 | 同步迁移或删除(以实际 `grep -r "VirtualEmployee" __tests__/` 结果为准) |

---

## 测试策略

### 单元测试覆盖矩阵

| 模块 | 测试文件 | 覆盖范围 |
|------|---------|---------|
| Employee config 加载 | `employee-loader.test.ts` | 5 种 load 行为 + 5 种错误码 |
| Employee schema | `employee-config-schema.test.ts` | 每个字段合法/非法 + 全文档边界 |
| MainAgent persona 持有 | `main-agent-persona.test.ts` | 构造时持有;IntentRouter/UnifiedPlanner/SubAgent 注入路径 |
| SubAgent 纯 worker | `sub-agent-no-persona.test.ts` | 无 hook;task 上下文正确读取 |
| 工具过滤 | `task-graph-tools-filter.test.ts` | 4 种过滤规则组合 + DEFAULT_SAFE_TOOLS 兜底 |
| Bootstrap 流程 | `bootstrap-employee.test.ts` | 5 种启动失败场景 + 正常启动 |

### 集成测试

保留现有 `__tests__/it-desk-self-service.test.ts` / `it-desk-progress-push.test.ts` / `multi-task-observability.test.ts` 等 e2e 测试 —— 它们不直接引用 VirtualEmployee,预期不破坏。**实际跑一次确认无回归**。

### 测试运行验证

```bash
bun test                                              # 全部测试
bun test __tests__/employee-*.test.ts                  # 新增测试
bun test __tests__/main-agent-persona.test.ts          # MainAgent 改造
bun test __tests__/task-queue.test.ts                  # 任务队列(回归)
bun test __tests__/result-aggregator.test.ts           # ResultAggregator 改造
```

预期:全部 pass,无回归。

---

## 迁移路径

### 阶段 1: 准备(不动运行时代码)
1. 新建 `src/agents/employee/` 目录
2. 写入新 `json-types.ts` / `types.ts` / `loader.ts`(独立模块,不影响现有)
3. 新建 `__tests__/employee-loader.test.ts` + `employee-config-schema.test.ts`(测试新模块)
4. 验证测试 pass(并行运行)

### 阶段 2: 字段迁移(数据层)
1. 按新 schema 重写 `employees/legal-assistant.json`
2. 按新 schema 重写 `employees/it-ops-consultant.json`
3. 新增 `__tests__/employees-configs.test.ts`(验证 2 份新 JSON 通过新 schema)

### 阶段 3: 代码改造(运行时代码)
1. `src/llm/index.ts`:扩展 `buildLLMClient()` 支持 employee-level config
2. `src/routers/intent-router.ts`:接受 `persona` 参数
3. `src/planners/unified-planner.ts`:接受 `hint` 参数
4. `src/agents/sub-agent.ts`:移除 4 个 hook
5. `src/agents/main-agent.ts`:持有 employee,改造 processRequirement
6. `src/task-queue/index.ts`:透传 task._personaContext
7. `src/agents/result-aggregator.ts`:应用 resultRewriter
8. `src/index.ts`:bootstrap 解析 --employee,构造 MainAgent

### 阶段 4: 清理
1. 删除 `src/agents/virtual-employee/` 整个目录
2. 删除引用旧 VirtualEmployee 的所有测试
3. 全套 `bun test` 验证零回归

### 阶段 5: 端到端验证
1. 启动 `bun start --employee=legal-assistant`,验证进程身份日志
2. 启动 `bun start`(无参数),验证兜底读取首个 JSON
3. 启动 `bun start --employee=non-existent`,验证 BootstrapError
4. 跑 `bun test` 全部测试
5. 跑 `bunx tsc --noEmit` 类型检查

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 大量文件被删除/重写,改动面广 | 中 | 严格 TDD(每步先写测试再改代码);阶段 1-4 顺序执行,每阶段验证 |
| IntentRouter / UnifiedPlanner 接收新参数可能影响 LLM 行为 | 中 | persona prefix / hint 可选;空时不注入,向后兼容 |
| employee.capabilities.llm 改变后 LLM 构造时机改变 | 中 | boot 阶段 fail-fast;坏 config 立即 BootstrapError,不让进程带病启动 |
| 测试套件(87+ 测试)可能引用 VirtualEmployee | 高 | 阶段 1 一次性 `grep -r "VirtualEmployee" __tests__/` 列清单;阶段 4 一并迁移 |
| `task._personaContext` 等新增字段污染 Task 类型 | 低 | 用 `_` 前缀标明"内部字段";Task 类型扩展有限,影响面可控 |
| 现有 PPT/讲稿描述「虚拟员工」概念,与新「数字员工」名称不一致 | 低 | 文档侧后续单独对齐(本次不改 PPT) |
| 单进程单员工后,无法在同进程测试多个员工 | 低 | 测试用 mock config;真实多员工场景用多进程启动验证 |
| 启动时若 `employees/` 目录有多个 enabled JSON,无 --employee 参数兜底选第一个 | 中 | 文档明确说明;CLI 启动日志打印选中的员工 id,避免歧义 |

---

## Out of Scope(本次不做,留到后续 spec)

1. **进程间跨员工协作 / 外部主控路由**: 未来分布式场景,需要外部主控协调多个员工实例。本次保留单进程模型。
2. **员工配置热更新**: 本次 boot 时一次性加载。后续可加 `RemoteEmployeeConfigProvider` 实现热更新。
3. **员工配置 UI / 后台管理**: 产品化工作。
4. **远程员工配置 provider**: stub 已删除;后续单独 spec。
5. **12 个员工全部实现**: 本次只迁 2 个示例。
6. **LLM 韧性层 / 记忆系统 / Skill 注册 / 工具注册的归属重定义**: 当前跟随员工进程,后续如需抽象为「基础设施层」(多员工共享),单独 spec。
7. **PPT / 讲稿的「虚拟员工」→「数字员工」名称统一**: 文档侧工作,本次不影响代码。
8. **员工运行指标(SLA / 接待量 / 平均时长)**: 本次只持有 config,不暴露员工视角的可观测性,后续 spec。

---

## 验证清单(End-to-End)

阶段 5 完成后,逐项验证:

- [ ] `bun test` 全部 pass
- [ ] `bunx tsc --noEmit` 无类型错误
- [ ] `bun start --employee=legal-assistant` 启动成功,日志输出 `id=legal-assistant displayName=法务助理·小法`
- [ ] `bun start --employee=non-existent` 启动失败,BootstrapError `EMPLOYEE_NOT_FOUND`
- [ ] `bun start`(无参数)启动成功,日志输出兜底选中的员工 id
- [ ] `employees/` 空目录启动失败,BootstrapError `NO_EMPLOYEE_CONFIG`
- [ ] 故意破坏 1 份 employees JSON(zod 校验失败),启动失败,BootstrapError `EMPLOYEE_CONFIG_INVALID`
- [ ] 发送请求到当前进程,验证 IntentRouter system prompt 包含 persona.prefix
- [ ] 发送请求,验证 task.allowedTools 按 employee.capabilities.tools 过滤
- [ ] 发送请求,验证最终响应经过 resultRewriter 改写(若配置)
- [ ] `git grep "VirtualEmployee"` 仅在 `docs/` 历史 spec / commit message 中存在,代码中无残留
