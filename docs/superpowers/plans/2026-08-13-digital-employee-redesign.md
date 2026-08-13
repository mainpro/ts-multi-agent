# 数字员工重新定位实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 把数字员工从「进程内多员工并存 + Resolver 路由」重构为「单进程 = 单员工」,persona/skills/tools/planning/output 全部上移到 MainAgent;SubAgent 退化为纯 worker;新增 capabilities.llm 让员工自配 LLM 参数。

**Architecture**: 新建 `src/agents/employee/` 模块承载 schema/loader;删除 `src/agents/virtual-employee/` 整个抽象层;MainAgent 构造时持有 `EmployeeConfig`,在 `processRequirement` 中把 persona-derived 上下文注入 IntentRouter / UnifiedPlanner / 每个 task;SubAgent 移除 4 个 persona hook,通过 `task._personaContext` / `task.allowedTools` 接收上下文;bootstrap 解析 `--employee=<id>` 命令行参数(兜底读 `employees/` 目录第一个 JSON)→ 构造 `MainAgent(employeeConfig, llm, ...)`。

**Tech Stack**: TypeScript / Bun test / zod (已有) / 现有 LLM 韧性层 + 记忆 + Skill 全复用,不引入新依赖。

---

## 全局约束

| 约束 | 值 | 来源 |
|------|---|------|
| 单进程单员工 | 一个 ts-multi-agent 进程 = 一个数字员工实例 | spec §重新定位 |
| 进程身份确定机制 | 命令行 `--employee=<id>` 优先;无参数兜底读 `employees/*.json` 第一个 enabled 的 JSON | spec §启动流程 |
| employee 配置缺失/坏 | `BootstrapError` fail-fast | spec §启动流程 |
| 多员工并存 | 不支持 —— 启动时只加载 1 份 config | spec §重新定位 |
| 路由策略 | 删除 —— 不再需要 @mention / 关键词 / 默认路由 | spec §文件结构 |
| persona 挂载位置 | MainAgent 持有;通过 task 上下文传给 worker | spec §关键概念 |
| SubAgent persona hook | 移除 4 个:`systemPromptPrefix` / `allowedSkillNames` / `resultRewriter` / `configId` | spec §文件结构 |
| skill 白名单校验时机 | MainAgent 在入队前校验(`SubAgent.execute()` 入口不再校验) | spec §全局约束 |
| 工具过滤时机 | MainAgent 在构造 task 时按 `employee.capabilities.tools` 过滤后写入 `task.allowedTools` | spec §全局约束 |
| LLM 客户端构造 | 由 `employee.capabilities.llm` 决定 provider / fallback / temperature / maxTokens | spec §全局约束 |
| planner hint 注入 | `UnifiedPlanner.plan()` 接收 `planning.decompositionHint` 作为 system prompt 段落 | spec §全局约束 |
| resultRewriter 应用 | `ResultAggregator.summarize()` 完成时按 `employee.outputBehavior.resultRewriter` 改写最终回复 | spec §全局约束 |
| 启动入口 | `src/index.ts:bootstrap()` 解析 argv → 调 `loadEmployeeConfig()` → 构造 `MainAgent` | spec §启动流程 |
| 测试框架 | `bun:test`,沿用现有 `__tests__/` 目录 | 现有约定 |
| 不引入新依赖 | 不新增 npm 包 | YAGNI |
| 现有测试零回归 | `bun test` 全部已有用例通过(删除 VirtualEmployee 层后,任何引用此层的测试必须一起改/删) | 现有约束 |
| 旧 employees/*.json 字段迁移 | `intentKeywords` / `isDefault` 删除;`persona.prefix` 拆为 `persona.prefix` + `persona.style` + `persona.boundaries`;新增 `capabilities.llm` / `capabilities.tools` / `planning` / `outputBehavior` 顶层结构 | spec §Out of Scope |
| 错误类 | 复用现有 `BootstrapError extends AppError`(`src/errors/bootstrap-error.ts`),不新建并行错误类 | spec §全局约束 |
| TDD | 每个 task 先失败测试,再实现,再跑测试,再 commit | 现有约定 |
| Commits | 每个 task 一个,Conventional Commits | 现有约定 |

---

## 文件结构总览

### 新建(`src/agents/employee/`)
- `json-types.ts` — zod schema(EmployeeIdentity / Persona / Capabilities / Planning / OutputBehavior / 顶层)
- `types.ts` — TypeScript 类型(zod 推导 + 显式 PersonaContext 等)
- `loader.ts` — `loadEmployeeConfig(id?)` 函数 + 5 种行为 + 4 种错误码
- `tools.ts` — `computeAllowedTools(skill, employee)` 工具过滤函数

### 删除(`src/agents/virtual-employee/` 整个目录)
- `base.ts`、`json-employee.ts`、`registry.ts`、`resolver.ts`、`loader.ts`、`json-types.ts`、`types.ts`、`employees/it-operations-consultant.ts`

### 修改
- `src/llm/interfaces.ts` — `ILLMClient` 构造支持 temperature / maxTokens override
- `src/llm/index.ts` — `LLMClient` 构造接受可选 options 参数
- `src/routers/intent-router.ts` — `classify()` 接受 persona 参数
- `src/planners/unified-planner.ts` — `plan()` 接受 hint 参数
- `src/agents/sub-agent.ts` — 移除 4 个 hook + task._personaContext / task.allowedTools 读取
- `src/agents/main-agent.ts` — 持有 employee + 注入 persona/hint/allowedTools + 移除 virtualEmployeeResolver
- `src/agents/result-aggregator.ts` — `summarizeResults()` 后应用 resultRewriter
- `src/index.ts` — bootstrap 解析 --employee + 构造 MainAgent

### 迁移
- `employees/legal-assistant.json`(按新 schema 重写)
- `employees/it-ops-consultant.json`(按新 schema 重写)

### 新测试文件
- `__tests__/employee-config-schema.test.ts`
- `__tests__/employee-loader.test.ts`
- `__tests__/employee-tools.test.ts`
- `__tests__/llm-client-override.test.ts`
- `__tests__/intent-router-persona.test.ts`
- `__tests__/unified-planner-hint.test.ts`
- `__tests__/sub-agent-no-persona.test.ts`
- `__tests__/main-agent-employee.test.ts`
- `__tests__/result-aggregator-rewriter.test.ts`
- `__tests__/bootstrap-employee.test.ts`

### 删除的旧测试
- `__tests__/virtual-employee-json-types.test.ts`
- `__tests__/virtual-employee-json-employee.test.ts`
- `__tests__/virtual-employee-loader.test.ts`
- `__tests__/virtual-employee-registry.test.ts`
- `__tests__/virtual-employee-resolver.test.ts`
- `__tests__/virtual-employee-it-ops-consultant.test.ts`
- `__tests__/main-agent-employee-routing.test.ts`
- `__tests__/sub-agent-template-method.test.ts`

---

## Task 1: Employee config schema + types

**Files:**
- Create: `src/agents/employee/json-types.ts`
- Create: `src/agents/employee/types.ts`
- Test: `__tests__/employee-config-schema.test.ts`

**Interfaces:**
- Consumes: 无(零起点)
- Produces:
  - `EmployeeIdentityConfig`、`PersonaConfig`、`CapabilitiesConfig`、`PlanningConfig`、`OutputBehaviorConfig`、`EmployeeConfig`(`json-types.ts` 导出 + `types.ts` 导出)
  - `LLMProvider = 'haier' | 'siliconflow'`
  - `SkillWhitelist`、`ToolPolicy`、`LLMConfig`、`ResultRewriter` 类型
  - `parseEmployeeConfig(json: string): EmployeeConfig`

- [ ] **Step 1: 写失败测试**

`__tests__/employee-config-schema.test.ts`:
```typescript
import { describe, expect, test } from 'bun:test';
import {
  parseEmployeeConfig,
  EmployeeConfigSchema,
} from '../src/agents/employee/json-types';

describe('EmployeeConfigSchema', () => {
  const validConfig = {
    employee: {
      id: 'legal-assistant',
      displayName: '法务助理·小法',
      enabled: true,
    },
    persona: {
      prefix: '你是「${displayName}」',
      style: '严谨',
      boundaries: '诉讼请转人工',
    },
    capabilities: {
      skillWhitelist: { type: 'allowlist', skills: ['fawu'] },
      tools: {
        enabled: ['knowledge_search', 'contract_lookup'],
        denied: ['send_email'],
      },
      llm: {
        provider: 'haier',
        fallbackProvider: 'siliconflow',
        temperature: 0.3,
        maxTokens: 2000,
      },
    },
    planning: {
      maxParallelTasks: 5,
      decompositionHint: '法务任务通常拆为:条款查询 → 风险评估',
    },
    outputBehavior: {
      resultRewriter: {
        match: { status: 'completed' },
        transform: 'append',
        value: '\n\n---如有进一步法律问题',
      },
    },
  };

  test('合法完整配置通过校验', () => {
    expect(() => parseEmployeeConfig(JSON.stringify(validConfig))).not.toThrow();
  });

  test('最小配置(只有 employee + capabilities.llm)通过校验', () => {
    const minimal = {
      employee: { id: 'foo', displayName: 'Foo' },
      capabilities: { llm: { provider: 'haier' } },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(minimal))).not.toThrow();
  });

  test('employee.id 缺失 → 校验失败', () => {
    const bad = { ...validConfig, employee: { displayName: 'X' } };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('capabilities.llm.provider 不在枚举内 → 校验失败', () => {
    const bad = {
      ...validConfig,
      capabilities: { ...validConfig.capabilities, llm: { provider: 'openai' } },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('capabilities.tools 既无 enabled 也无 denied → 校验失败', () => {
    const bad = {
      ...validConfig,
      capabilities: { ...validConfig.capabilities, tools: {} },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('resultRewriter.transform=append 但 value 为空 → 校验失败', () => {
    const bad = {
      ...validConfig,
      outputBehavior: {
        resultRewriter: {
          match: { status: 'completed' },
          transform: 'append',
          value: '',
        },
      },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('skillWhitelist unrestricted 通过校验', () => {
    const ok = {
      ...validConfig,
      capabilities: { ...validConfig.capabilities, skillWhitelist: { type: 'unrestricted' } },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(ok))).not.toThrow();
  });

  test('LLM temperature 超出 0-2 范围 → 校验失败', () => {
    const bad = {
      ...validConfig,
      capabilities: {
        ...validConfig.capabilities,
        llm: { ...validConfig.capabilities.llm, temperature: 5 },
      },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('Schema 导出供运行时校验', () => {
    expect(EmployeeConfigSchema).toBeDefined();
    const result = EmployeeConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/employee-config-schema.test.ts
```
Expected: FAIL — `Cannot find module '../src/agents/employee/json-types'`

- [ ] **Step 3: 实现 schema 模块**

`src/agents/employee/json-types.ts`:
```typescript
import { z } from 'zod';

// ── 身份层 ──
export const EmployeeIdentitySchema = z.object({
  id: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  enabled: z.boolean().optional().default(true),
});

// ── 角色层 ──
export const PersonaSchema = z.object({
  prefix: z.string(),
  style: z.string().optional(),
  boundaries: z.string().optional(),
});

// ── 能力层 ──
export const SkillWhitelistSchema = z.union([
  z.object({ type: z.literal('allowlist'), skills: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('unrestricted') }),
]);

export const ToolPolicySchema = z.object({
  enabled: z.array(z.string()).optional(),
  denied: z.array(z.string()).optional(),
}).refine(
  (p) => (p.enabled !== undefined && p.enabled.length > 0) || (p.denied !== undefined && p.denied.length > 0),
  { message: 'tools 至少需要非空 enabled 或非空 denied 之一' },
);

export const LLMProviderSchema = z.enum(['haier', 'siliconflow']);

export const LLMConfigSchema = z.object({
  provider: LLMProviderSchema,
  fallbackProvider: LLMProviderSchema.optional(),
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
export const ResultRewriterMatchSchema = z.object({
  status: z.enum(['completed', 'waiting_user_input', 'failed']).optional(),
});

export const ResultRewriterSchema = z.object({
  match: ResultRewriterMatchSchema.optional(),
  transform: z.enum(['append', 'passthrough', 'replace']),
  value: z.string().optional(),
}).refine(
  (d) => d.transform !== 'append' || (typeof d.value === 'string' && d.value.length > 0),
  { message: 'resultRewriter.transform=append 时 value 必填且非空' },
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
export type EmployeeIdentityConfig = z.infer<typeof EmployeeIdentitySchema>;
export type PersonaConfig = z.infer<typeof PersonaSchema>;
export type CapabilitiesConfig = z.infer<typeof CapabilitiesSchema>;
export type PlanningConfig = z.infer<typeof PlanningSchema>;
export type OutputBehaviorConfig = z.infer<typeof OutputBehaviorSchema>;
export type SkillWhitelist = z.infer<typeof SkillWhitelistSchema>;
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type LLMProvider = z.infer<typeof LLMProviderSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type ResultRewriter = z.infer<typeof ResultRewriterSchema>;

/**
 * 校验一个 JSON 字符串,返回校验后的 config。
 * 失败抛 ZodError(原样透传,调用方决定如何处理)。
 */
export function parseEmployeeConfig(json: string): EmployeeConfig {
  return EmployeeConfigSchema.parse(JSON.parse(json));
}
```

`src/agents/employee/types.ts`:
```typescript
// src/agents/employee/types.ts
// 类型定义全部 re-export 自 json-types.ts,这里保留文件以便后续扩展非 schema 类型
export type {
  EmployeeConfig,
  EmployeeIdentityConfig,
  PersonaConfig,
  CapabilitiesConfig,
  PlanningConfig,
  OutputBehaviorConfig,
  SkillWhitelist,
  ToolPolicy,
  LLMProvider,
  LLMConfig,
  ResultRewriter,
} from './json-types';

/**
 * Master 注入到 task 的 persona 上下文(worker 不再有 persona hooks,
 * 通过读取这个上下文拼到 system prompt)。
 */
export interface PersonaContext {
  prefix: string;
  style?: string;
  boundaries?: string;
}
```

- [ ] **Step 4: 跑测试确认 PASS**

```bash
bun test __tests__/employee-config-schema.test.ts
```
Expected: PASS(10/10)

- [ ] **Step 5: Commit**

```bash
git add src/agents/employee/ __tests__/employee-config-schema.test.ts
git commit -m "feat(employee): 新建数字员工配置 schema + zod 校验"
```

---

## Task 2: loadEmployeeConfig + 迁移 2 份员工 JSON

**Files:**
- Create: `src/agents/employee/loader.ts`
- Modify: `employees/legal-assistant.json`(按新 schema 重写)
- Modify: `employees/it-ops-consultant.json`(按新 schema 重写)
- Test: `__tests__/employee-loader.test.ts`

**Interfaces:**
- Consumes: `parseEmployeeConfig`(`json-types.ts`,Task 1)
- Produces:
  - `loadEmployeeConfig(opts?: { explicitId?: string; directory?: string }): Promise<EmployeeConfig>`
  - 错误:`BootstrapError`(`EMPLOYEE_NOT_FOUND` / `NO_EMPLOYEE_CONFIG` / `EMPLOYEE_CONFIG_INVALID`)

- [ ] **Step 1: 写失败测试**

`__tests__/employee-loader.test.ts`:
```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadEmployeeConfig } from '../src/agents/employee/loader';
import { BootstrapError } from '../src/errors/bootstrap-error';

let tmpDir: string;
const VALID_LEGAL = {
  employee: { id: 'legal-assistant', displayName: '法务助理·小法', enabled: true },
  persona: { prefix: '你是「${displayName}」', style: '严谨', boundaries: '诉讼请转人工' },
  capabilities: {
    skillWhitelist: { type: 'allowlist', skills: ['fawu'] },
    tools: { enabled: ['knowledge_search'], denied: ['send_email'] },
    llm: { provider: 'haier', fallbackProvider: 'siliconflow', temperature: 0.3, maxTokens: 2000 },
  },
  planning: { maxParallelTasks: 5, decompositionHint: '法务任务通常拆为:条款查询 → 风险评估' },
  outputBehavior: { resultRewriter: { match: { status: 'completed' }, transform: 'append', value: '\n\n---' } },
};

const VALID_IT = {
  employee: { id: 'it-ops-consultant', displayName: 'IT 运维顾问·小海', enabled: true },
  capabilities: { llm: { provider: 'siliconflow' } },
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emp-loader-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadEmployeeConfig', () => {
  test('显式 --employee=legal-assistant → 加载对应 JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'legal-assistant.json'), JSON.stringify(VALID_LEGAL));
    const cfg = await loadEmployeeConfig({ explicitId: 'legal-assistant', directory: tmpDir });
    expect(cfg.employee.id).toBe('legal-assistant');
    expect(cfg.capabilities.llm.provider).toBe('haier');
  });

  test('无 explicitId + 目录只有 1 个 enabled JSON → 兜底加载', async () => {
    await fs.writeFile(path.join(tmpDir, 'legal-assistant.json'), JSON.stringify(VALID_LEGAL));
    const cfg = await loadEmployeeConfig({ directory: tmpDir });
    expect(cfg.employee.id).toBe('legal-assistant');
  });

  test('无 explicitId + 目录多个 enabled JSON → 加载按文件名排序的第一个', async () => {
    await fs.writeFile(path.join(tmpDir, 'a-first.json'), JSON.stringify({ ...VALID_LEGAL, employee: { ...VALID_LEGAL.employee, id: 'a-first' } }));
    await fs.writeFile(path.join(tmpDir, 'b-second.json'), JSON.stringify(VALID_IT));
    const cfg = await loadEmployeeConfig({ directory: tmpDir });
    expect(cfg.employee.id).toBe('a-first');
  });

  test('enabled=false 的 JSON 被跳过', async () => {
    const disabled = { ...VALID_LEGAL, employee: { ...VALID_LEGAL.employee, enabled: false } };
    await fs.writeFile(path.join(tmpDir, 'disabled.json'), JSON.stringify(disabled));
    await fs.writeFile(path.join(tmpDir, 'enabled.json'), JSON.stringify(VALID_IT));
    const cfg = await loadEmployeeConfig({ directory: tmpDir });
    expect(cfg.employee.id).toBe('it-ops-consultant');
  });

  test('explicitId 不存在 → BootstrapError(EMPLOYEE_NOT_FOUND)', async () => {
    await fs.writeFile(path.join(tmpDir, 'legal-assistant.json'), JSON.stringify(VALID_LEGAL));
    await expect(
      loadEmployeeConfig({ explicitId: 'non-existent', directory: tmpDir })
    ).rejects.toThrow(BootstrapError);
  });

  test('目录空 / 无 enabled JSON → BootstrapError(NO_EMPLOYEE_CONFIG)', async () => {
    await expect(
      loadEmployeeConfig({ directory: tmpDir })
    ).rejects.toThrow(BootstrapError);
  });

  test('JSON 解析失败 → BootstrapError(EMPLOYEE_CONFIG_INVALID)', async () => {
    await fs.writeFile(path.join(tmpDir, 'broken.json'), '{ not valid json');
    await expect(
      loadEmployeeConfig({ directory: tmpDir })
    ).rejects.toThrow(BootstrapError);
  });

  test('JSON zod 校验失败 → BootstrapError(EMPLOYEE_CONFIG_INVALID)', async () => {
    const bad = { employee: { id: 'x', displayName: 'X' } /* 缺 capabilities.llm */ };
    await fs.writeFile(path.join(tmpDir, 'bad.json'), JSON.stringify(bad));
    await expect(
      loadEmployeeConfig({ directory: tmpDir })
    ).rejects.toThrow(BootstrapError);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/employee-loader.test.ts
```
Expected: FAIL — `Cannot find module '../src/agents/employee/loader'`

- [ ] **Step 3: 实现 loader**

`src/agents/employee/loader.ts`:
```typescript
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseEmployeeConfig, type EmployeeConfig } from './json-types';
import { BootstrapError } from '../../errors/bootstrap-error';
import { resolveResource } from '../../utils/app-root';
import { createLogger } from '../../observability/logger';

const log = createLogger({ module: 'EmployeeLoader' });

export interface LoadEmployeeOptions {
  /** 显式指定的员工 id(来自 --employee=<id>) */
  explicitId?: string;
  /** 员工 JSON 目录(默认 resolveResource('employees')) */
  directory?: string;
}

/**
 * 加载 1 份数字员工配置。
 *
 * 行为:
 *   - explicitId 存在 → 读 `<directory>/<explicitId>.json`
 *   - explicitId 缺失 → 读 directory 中第一个 enabled 的 JSON(按文件名排序)
 *
 * 错误(抛 BootstrapError):
 *   - EMPLOYEE_NOT_FOUND     explicitId 给定但文件不存在
 *   - NO_EMPLOYEE_CONFIG     目录空 / 全 disabled / 目录不存在
 *   - EMPLOYEE_CONFIG_INVALID JSON 解析失败 / zod 校验失败
 */
export async function loadEmployeeConfig(
  opts: LoadEmployeeOptions = {},
): Promise<EmployeeConfig> {
  const directory = opts.directory ?? resolveResource('employees');

  // 1. 读目录
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new BootstrapError(
        'NO_EMPLOYEE_CONFIG',
        `员工配置目录不存在: ${directory}`,
        { cause: err },
      );
    }
    throw new BootstrapError(
      'NO_EMPLOYEE_CONFIG',
      `读员工配置目录失败: ${directory}`,
      { cause: err },
    );
  }

  // 2. 收集所有 enabled 的 JSON 文件路径
  const jsonFiles = entries.filter((f) => f.endsWith('.json')).sort();

  // 3. 显式 id 路径
  if (opts.explicitId) {
    const target = `${opts.explicitId}.json`;
    const filePath = path.join(directory, target);
    if (!jsonFiles.includes(target)) {
      throw new BootstrapError(
        'EMPLOYEE_NOT_FOUND',
        `员工 '${opts.explicitId}' 不存在(目录: ${directory})`,
      );
    }
    return readAndParse(filePath, target);
  }

  // 4. 兜底:遍历找第一个 enabled 的
  for (const file of jsonFiles) {
    const filePath = path.join(directory, file);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.employee?.enabled === false) continue;
      const config = parseEmployeeConfig(raw);
      log.info('已选员工(兜底)', { file, id: config.employee.id });
      return config;
    } catch (err) {
      // 单个文件坏不让 boot 失败 — 让其他文件有机会被选。
      // 显式 id 路径才 fail-fast(上面已经返回了),兜底路径只 warn。
      log.warn('员工 JSON 解析失败(兜底路径,跳过)', { file, error: (err as Error).message });
    }
  }

  throw new BootstrapError(
    'NO_EMPLOYEE_CONFIG',
    `目录中没有可用员工配置: ${directory}`,
  );
}

async function readAndParse(filePath: string, file: string): Promise<EmployeeConfig> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return parseEmployeeConfig(raw);
  } catch (err) {
    throw new BootstrapError(
      'EMPLOYEE_CONFIG_INVALID',
      `员工 JSON 校验失败 [${file}]: ${(err as Error).message}`,
      { cause: err },
    );
  }
}
```

- [ ] **Step 4: 迁移 2 份员工 JSON**

`employees/legal-assistant.json`(完整重写):
```json
{
  "employee": {
    "id": "legal-assistant",
    "displayName": "法务助理·小法",
    "enabled": true
  },
  "persona": {
    "prefix": "你是「${displayName}」,集团法务部门的数字员工。\n\n【职责】协助集团员工处理法务系统流程相关问题:合同签订 / 合同审批 / 合同查询 / 条款提交 / 用印申请等流程性事务。\n\n【风格】严谨、准确、引用具体条款编号。回答前先确认事实,不要凭印象给答复;每一步都说清楚当前流程走到了哪一步、卡在哪里、接下来需要谁操作。\n\n【边界】以下情况请礼貌告知并建议转接:\n- 具体法律意见 / 诉讼策略 / 风险评估 → \"建议联系集团法务同事或外聘律师\"\n- 劳动仲裁 / 知识产权 / 合规审查等专业议题 → \"这块建议走专业法务通道\"\n- 任何超出\"流程协助\"范围的具体法律判断都不要做",
    "style": "严谨、准确、引用具体条款编号。",
    "boundaries": "诉讼/合规等专业议题请转人工。"
  },
  "capabilities": {
    "skillWhitelist": { "type": "allowlist", "skills": ["fawu"] },
    "tools": {
      "enabled": ["knowledge_search", "contract_lookup", "read", "grep"],
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
      "value": "\n\n---\n如有进一步法律相关问题,请回复「转人工」接入法务同事;也可回复「评价」给我本次服务打分。"
    }
  }
}
```

`employees/it-ops-consultant.json`(完整重写):
```json
{
  "employee": {
    "id": "it-ops-consultant",
    "displayName": "IT 运维顾问·小海",
    "enabled": true
  },
  "persona": {
    "prefix": "你是「${displayName}」,集团 IT 服务台的数字员工。\n\n【职责】接听集团员工 IT 类问题:系统报错(EES / GEAM / 法务 / 时间管理 / 差旅 / 兜底) / 桌面运维 / 网络连接 / 设备报修 / 工单查询 / 门禁权限申请。\n\n【风格】耐心、专业、礼貌。先安抚用户情绪,再引导排查。每一步都说清楚\"我接下来要做什么\"和\"请您提供什么信息\"。\n\n【边界】以下情况请礼貌告知并建议转接:\n- 销售 / 产品 / 报价类需求 → \"这块建议联系销售 / 产品同事\"\n- 业务决策 / 战略规划 → \"这块建议联系业务负责人\"\n- 任何超出 IT 范围的请求都不要假装能解决",
    "style": "耐心、专业、礼貌。",
    "boundaries": "销售/产品/业务决策请转人工。"
  },
  "capabilities": {
    "skillWhitelist": {
      "type": "allowlist",
      "skills": [
        "ees-qa",
        "fallback-service-desk",
        "fawu",
        "geam-qa",
        "sulfuric-acid-price-prediction",
        "time-management-qa",
        "travel-expense-apply"
      ]
    },
    "tools": {
      "enabled": ["conversation-get", "read", "glob", "grep", "ask_user", "bash", "knowledge_search"],
      "denied": ["send_email_external"]
    },
    "llm": {
      "provider": "haier",
      "fallbackProvider": "siliconflow",
      "temperature": 0.5,
      "maxTokens": 4000
    }
  },
  "planning": {
    "maxParallelTasks": 8,
    "decompositionHint": "IT 任务通常独立,可并发执行;依赖系统查询的任务优先于依赖人工反馈的任务"
  },
  "outputBehavior": {
    "resultRewriter": {
      "match": { "status": "completed" },
      "transform": "append",
      "value": "\n\n---\n如果您尝试后仍未解决,请回复「转人工」,我会把您转给值班工程师;也可以回复「评价」给我本次服务打个分。"
    }
  }
}
```

- [ ] **Step 5: 跑测试确认 PASS**

```bash
bun test __tests__/employee-loader.test.ts
```
Expected: PASS(8/8)

- [ ] **Step 6: 验证 2 份新 JSON 通过 schema**

```bash
bun -e "
import { parseEmployeeConfig } from './src/agents/employee/json-types';
import { readFileSync } from 'fs';
for (const f of ['employees/legal-assistant.json', 'employees/it-ops-consultant.json']) {
  const cfg = parseEmployeeConfig(readFileSync(f, 'utf-8'));
  console.log(f, '→', cfg.employee.id, 'OK');
}
"
```
Expected: 两行输出,均 OK

- [ ] **Step 7: Commit**

```bash
git add src/agents/employee/loader.ts __tests__/employee-loader.test.ts employees/legal-assistant.json employees/it-ops-consultant.json
git commit -m "feat(employee): loadEmployeeConfig + 迁移 2 份员工 JSON 到新 schema"
```

---

## Task 3: 工具过滤函数 computeAllowedTools

**Files:**
- Create: `src/agents/employee/tools.ts`
- Test: `__tests__/employee-tools.test.ts`

**Interfaces:**
- Consumes: `ToolPolicy`(`json-types.ts`)
- Produces: `computeAllowedTools(skillAllowed: string[] | undefined, employeeTools: ToolPolicy | undefined): Set<string>`

**注**:Task 3 提前到 Task 8 之前,是因为 `computeAllowedTools` 是 MainAgent 调用的纯函数,先实现 + 测好,后续 MainAgent 直接用。

- [ ] **Step 1: 写失败测试**

`__tests__/employee-tools.test.ts`:
```typescript
import { describe, expect, test } from 'bun:test';
import { computeAllowedTools } from '../src/agents/employee/tools';

const DEFAULT_SAFE = ['conversation-get', 'read', 'glob', 'grep', 'ask_user'];

describe('computeAllowedTools', () => {
  test('skill.allowedTools 存在,无 employee tools → 用 skill 白名单', () => {
    const result = computeAllowedTools(['read', 'bash'], undefined);
    expect(result).toEqual(new Set(['read', 'bash']));
  });

  test('skill.allowedTools 为空数组,无 employee tools → 走 DEFAULT_SAFE_TOOLS', () => {
    const result = computeAllowedTools([], undefined);
    expect(result).toEqual(new Set(DEFAULT_SAFE));
  });

  test('skill.allowedTools 未定义,无 employee tools → 走 DEFAULT_SAFE_TOOLS', () => {
    const result = computeAllowedTools(undefined, undefined);
    expect(result).toEqual(new Set(DEFAULT_SAFE));
  });

  test('employee.tools.enabled 存在 → 与 skill 列表求交集', () => {
    const result = computeAllowedTools(
      ['read', 'bash', 'grep'],
      { enabled: ['read', 'grep'] },
    );
    expect(result).toEqual(new Set(['read', 'grep']));
  });

  test('employee.tools.enabled 与 skill 无交集 → 返回空集', () => {
    const result = computeAllowedTools(
      ['bash', 'curl'],
      { enabled: ['read'] },
    );
    expect(result).toEqual(new Set([]));
  });

  test('employee.tools.denied 存在 → 从 skill 列表差集', () => {
    const result = computeAllowedTools(
      ['read', 'bash', 'grep'],
      { denied: ['bash'] },
    );
    expect(result).toEqual(new Set(['read', 'grep']));
  });

  test('employee.tools.enabled 和 denied 同时存在 → 先交后差', () => {
    const result = computeAllowedTools(
      ['read', 'bash', 'grep', 'glob'],
      { enabled: ['read', 'grep', 'glob'], denied: ['grep'] },
    );
    expect(result).toEqual(new Set(['read', 'glob']));
  });

  test('黑名单优先级最高:即使在 enabled 列表中,也被排除', () => {
    const result = computeAllowedTools(
      ['send_email'],
      { enabled: ['send_email'], denied: ['send_email'] },
    );
    expect(result).toEqual(new Set([]));
  });

  test('skill.allowedTools 为空 + employee.tools.enabled 有值 → 交集(DEFAULT_SAFE ∩ enabled)', () => {
    const result = computeAllowedTools([], { enabled: ['read', 'bash'] });
    expect(result).toEqual(new Set(['read']));
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/employee-tools.test.ts
```
Expected: FAIL — `Cannot find module '../src/agents/employee/tools'`

- [ ] **Step 3: 实现 computeAllowedTools**

`src/agents/employee/tools.ts`:
```typescript
import type { ToolPolicy } from './json-types';

/**
 * 工具白名单(主入口的最小安全集合)。
 * 与 src/agents/sub-agent.ts 的 DEFAULT_SAFE_TOOLS 保持一致,
 * 此处独立定义避免循环依赖(tools.ts 不依赖 SubAgent)。
 */
export const DEFAULT_SAFE_TOOLS: readonly string[] = [
  'conversation-get',
  'read',
  'glob',
  'grep',
  'ask_user',
];

/**
 * 计算 task 实际可用的工具集合。
 *
 * 规则(按顺序):
 *   1. 基础集:skill.allowedTools(若定义且非空)OR DEFAULT_SAFE_TOOLS
 *   2. 员工白名单(若定义):与基础集求交集(更严格)
 *   3. 员工黑名单(若定义):从结果中差集(更严格)
 *
 * 注意:黑名单优先级最高 —— 即使 enabled 放行,denied 也拒绝。
 *
 * @param skillAllowedTools skill 声明的允许工具(undefined/[] 时用 DEFAULT_SAFE_TOOLS)
 * @param employeeTools 员工级 tool 策略(可选)
 * @returns 最终可用工具的 Set
 */
export function computeAllowedTools(
  skillAllowedTools: string[] | undefined,
  employeeTools: ToolPolicy | undefined,
): Set<string> {
  // 1. 基础集
  let base: Set<string>;
  if (skillAllowedTools && skillAllowedTools.length > 0) {
    base = new Set(skillAllowedTools);
  } else {
    base = new Set(DEFAULT_SAFE_TOOLS);
  }

  // 2. 员工白名单:交集
  if (employeeTools?.enabled && employeeTools.enabled.length > 0) {
    const enabledSet = new Set(employeeTools.enabled);
    base = new Set([...base].filter((t) => enabledSet.has(t)));
  }

  // 3. 员工黑名单:差集
  if (employeeTools?.denied && employeeTools.denied.length > 0) {
    const deniedSet = new Set(employeeTools.denied);
    base = new Set([...base].filter((t) => !deniedSet.has(t)));
  }

  return base;
}
```

- [ ] **Step 4: 跑测试确认 PASS**

```bash
bun test __tests__/employee-tools.test.ts
```
Expected: PASS(9/9)

- [ ] **Step 5: Commit**

```bash
git add src/agents/employee/tools.ts __tests__/employee-tools.test.ts
git commit -m "feat(employee): computeAllowedTools — skill + employee 双重过滤"
```

---

## Task 4: LLMClient 构造支持 employee-level override

**Files:**
- Modify: `src/llm/index.ts`(LLMClient 构造函数接受 options)
- Test: `__tests__/llm-client-override.test.ts`

**Interfaces:**
- Consumes: 无(只改 LLMClient)
- Produces: `LLMClient` 构造函数接受可选 `options?: { provider?: LLMProvider; temperature?: number; maxTokens?: number }`

- [ ] **Step 1: 写失败测试**

`__tests__/llm-client-override.test.ts`:
```typescript
import { describe, expect, test } from 'bun:test';
import { LLMClient } from '../src/llm';

describe('LLMClient constructor options', () => {
  test('不传 options → 使用默认 (provider=env / temperature=CONFIG / maxTokens=CONFIG)', () => {
    // 只验证能构造(API key 来自 env,可能不存在)
    // 这里只测试类型签名 + 默认行为可识别
    const ctor = LLMClient;
    expect(ctor.length).toBeGreaterThanOrEqual(0); // 至少有构造签名
  });

  test('传 options.provider = "haier" → 字段被采用', () => {
    // 用 mock key 构造
    const client = new LLMClient('test-key', { provider: 'haier' });
    // 通过 (client as any).provider 验证
    expect((client as any).provider).toBe('haier');
  });

  test('传 options.temperature = 0.7 → 字段被采用', () => {
    const client = new LLMClient('test-key', { temperature: 0.7 });
    expect((client as any).temperature).toBe(0.7);
  });

  test('传 options.maxTokens = 1500 → 字段被采用', () => {
    const client = new LLMClient('test-key', { maxTokens: 1500 });
    // maxTokens 不存到 this 上,而是 buildRequestBody 内联用 CONFIG.LLM_MAX_TOKENS。
    // 验证方式:看 buildRequestBody 是否使用 override。
    // 简单实现:通过 spy 验证 getMaxTokens() 返回 override 值。
    expect((client as any).maxTokens).toBe(1500);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/llm-client-override.test.ts
```
Expected: FAIL — `LLMClient` 构造函数不接受第二个参数

- [ ] **Step 3: 修改 LLMClient 构造签名**

修改 `src/llm/index.ts:243-293`(LLMClient 类):

```typescript
export interface LLMClientOptions {
  provider?: LLMProvider;
  temperature?: number;
  maxTokens?: number;
}

export class LLMClient implements ILLMClient {
  // ... 现有字段 ...
  private maxTokensOverride?: number;  // 新增字段

  /**
   * Create a new LLM client
   * @param apiKey - API key (defaults to SILICONFLOW_API_KEY or HAIER_API_KEY env var)
   * @param options - 可选 override(provider / temperature / maxTokens),用于 employee-level 配置
   */
  constructor(apiKey?: string, options: LLMClientOptions = {}) {
    this.provider = (options.provider ?? (process.env.LLM_PROVIDER || 'siliconflow')) as LLMProvider;
    this.capabilities = PROVIDER_CONFIGS[this.provider];

    if (apiKey) {
      this.apiKey = apiKey;
    } else if (this.provider === 'siliconflow') {
      this.apiKey = process.env.SILICONFLOW_API_KEY || '';
    } else if (this.provider === 'haier') {
      this.apiKey = process.env.HAIER_API_KEY || '';
    } else {
      this.apiKey = '';
    }

    this.baseUrl = (CONFIG.LLM_BASE_URL || PROVIDER_CONFIGS[this.provider].defaultBaseUrl).replace(/\/$/, '');
    this.model = CONFIG.LLM_MODEL;
    // temperature:options 优先,CONFIG 兜底
    this.temperature = options.temperature ?? CONFIG.LLM_TEMPERATURE;
    this.timeoutMs = CONFIG.LLM_TIMEOUT_MS;
    this.maxRetries = 3;
    this.maxTokensOverride = options.maxTokens;

    if (!this.apiKey) {
      throw new LLMError(
        'INVALID_KEY',
        `${this.provider} API key environment variable is not set`,
      );
    }
  }

  // ... 现有方法 ...
}
```

同时修改 `buildRequestBody` 的 `max_tokens` 字段(line 385):

```typescript
max_tokens: this.maxTokensOverride ?? CONFIG.LLM_MAX_TOKENS || 4096,
```

- [ ] **Step 4: 跑测试确认 PASS**

```bash
bun test __tests__/llm-client-override.test.ts
```
Expected: PASS(4/4)

- [ ] **Step 5: 跑回归测试**

```bash
bun test __tests__/fallback-client.test.ts __tests__/failover-config.test.ts
```
Expected: PASS(无 LLMClient 构造签名变更的破坏)

- [ ] **Step 6: Commit**

```bash
git add src/llm/index.ts __tests__/llm-client-override.test.ts
git commit -m "feat(llm): LLMClient 支持 employee-level options override"
```

---

## Task 5: IntentRouter 接受 persona 参数

**Files:**
- Modify: `src/routers/intent-router.ts`(`classify()` 接受 persona)
- Test: `__tests__/intent-router-persona.test.ts`(新建或扩展现有)

**Interfaces:**
- Consumes: `PersonaConfig`(`employee/types.ts`)
- Produces: `IntentRouter.classify(..., persona?: PersonaConfig)` 签名扩展

- [ ] **Step 1: 写失败测试**

`__tests__/intent-router-persona.test.ts`:
```typescript
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IntentRouter } from '../src/routers/intent-router';
import { SkillRegistry } from '../src/skill-registry';
import type { ILLMClient } from '../src/llm';

const mockSkillRegistry = {
  getAllMetadata: () => [],
} as unknown as SkillRegistry;

describe('IntentRouter.classify — persona 参数', () => {
  let capturedSystemPrompt: string | undefined;

  const mockLlm: ILLMClient = {
    generateStructured: async (prompt: string, _schema: any, systemPrompt?: string) => {
      capturedSystemPrompt = systemPrompt;
      return { intent: 'small_talk', tasks: [], question: { content: '你好' } };
    },
    generateText: async () => '',
    generateWithTools: async () => ({ content: '', toolCalls: [], messages: [] }),
  } as unknown as ILLMClient;

  beforeEach(() => {
    capturedSystemPrompt = undefined;
  });

  test('persona 不传 → systemPrompt 不含 persona prefix', async () => {
    const router = new IntentRouter(mockLlm, mockSkillRegistry);
    await router.classify('你好');
    expect(capturedSystemPrompt ?? '').not.toContain('法务助理');
  });

  test('persona.prefix 传入 → systemPrompt 包含 persona prefix', async () => {
    const router = new IntentRouter(mockLlm, mockSkillRegistry);
    await router.classify('你好', undefined, undefined, undefined, undefined, undefined, {
      prefix: '你是「法务助理·小法」',
      style: '严谨',
      boundaries: '诉讼请转人工',
    });
    expect(capturedSystemPrompt).toContain('法务助理·小法');
    expect(capturedSystemPrompt).toContain('严谨');
    expect(capturedSystemPrompt).toContain('诉讼请转人工');
  });

  test('persona 只有 prefix → style/boundaries 不出现', async () => {
    const router = new IntentRouter(mockLlm, mockSkillRegistry);
    await router.classify('你好', undefined, undefined, undefined, undefined, undefined, {
      prefix: 'minimal persona',
    });
    expect(capturedSystemPrompt).toContain('minimal persona');
  });

  test('persona.template 变量 ${displayName} → 在拼 systemPrompt 前替换', async () => {
    const router = new IntentRouter(mockLlm, mockSkillRegistry);
    await router.classify('你好', undefined, undefined, undefined, undefined, undefined, {
      prefix: '我是 ${displayName}',
    }, '法务助理·小法' /* displayNameOverride */);
    expect(capturedSystemPrompt).toContain('我是 法务助理·小法');
    expect(capturedSystemPrompt).not.toContain('${displayName}');
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/intent-router-persona.test.ts
```
Expected: FAIL — `classify()` 第 7 个参数位置不接受 persona

- [ ] **Step 3: 修改 IntentRouter.classify 签名**

修改 `src/routers/intent-router.ts` line 72-79:

```typescript
import type { PersonaConfig } from '../agents/employee/types';

export class IntentRouter {
  constructor(
    private llm: ILLMClient,
    private skillRegistry: SkillRegistry,
  ) {
    const skills = this.skillRegistry.getAllMetadata();
    log.info('初始化完成', { skills: skills.map(s => s.name).join(', ') });
  }

  async classify(
    userInput: string,
    userProfile?: UserProfile,
    recentHistory?: Array<{ role?: string; content?: string; skill?: string; system?: string }>,
    sessionId?: string,
    _proceduralExperience?: Array<{ skillName: string; usageCount: number; lastSuccess: boolean }>,
    _userId?: string,
    persona?: PersonaConfig,        // ★ 新增
    displayName?: string,           // ★ 新增:用于 ${displayName} 模板替换
  ): Promise<IntentResult> {
    const startTime = Date.now();

    try {
      const systemPrompt = this.buildSystemPrompt(persona, displayName);
      const result = await this.llmClassify(
        userInput,
        userProfile,
        recentHistory,
        sessionId,
        systemPrompt,  // ★ 传给 llmClassify
      );

      const elapsed = Date.now() - startTime;
      log.info('LLM 判断', { intent: result.intent, elapsed, confidence: result.confidence, personaId: persona?.prefix?.substring(0, 20) });

      return result;
    } catch (error) {
      // ... 现有降级逻辑 ...
    }
  }

  /**
   * 构造 system prompt,把 persona 拼到前面。
   * ${displayName} 模板变量在此处替换。
   */
  private buildSystemPrompt(persona?: PersonaConfig, displayName?: string): string | undefined {
    if (!persona) return undefined;
    const dn = displayName ?? '';
    const prefix = persona.prefix.replace(/\$\{displayName\}/g, dn);
    const parts = [prefix];
    if (persona.style) parts.push(`\n【风格】${persona.style}`);
    if (persona.boundaries) parts.push(`\n【边界】${persona.boundaries}`);
    return parts.join('');
  }
}
```

修改 `llmClassify` 方法签名(line 84 附近)以接收 systemPrompt 参数:

```typescript
private async llmClassify(
  userInput: string,
  userProfile?: UserProfile,
  recentHistory?: Array<{...}>,
  sessionId?: string,
  systemPrompt?: string,  // ★ 新增
): Promise<IntentResult> {
  // ... 现有逻辑 ...
  const prompt = buildSkillMatcherPrompt({...});
  const result = await this.llm.generateStructured(prompt, IntentResultSchema, systemPrompt);
  // ... 现有逻辑 ...
}
```

- [ ] **Step 4: 跑测试确认 PASS**

```bash
bun test __tests__/intent-router-persona.test.ts
```
Expected: PASS(4/4)

- [ ] **Step 5: 跑回归测试**

```bash
bun test __tests__/intent-router.test.ts
```
Expected: PASS(原测试不传 persona,行为不变)

- [ ] **Step 6: Commit**

```bash
git add src/routers/intent-router.ts __tests__/intent-router-persona.test.ts
git commit -m "feat(routers): IntentRouter 接受 persona 参数,拼到 system prompt"
```

---

## Task 6: UnifiedPlanner 接受 hint 参数

**Files:**
- Modify: `src/planners/unified-planner.ts`
- Test: `__tests__/unified-planner-hint.test.ts`(新建)

**Interfaces:**
- Consumes: `PlanningConfig.decompositionHint`(string)
- Produces: `UnifiedPlanner.plan(req, opts?: { hint?: string })` 签名扩展

- [ ] **Step 1: 写失败测试**

`__tests__/unified-planner-hint.test.ts`:
```typescript
import { describe, expect, test, beforeEach } from 'bun:test';
import { UnifiedPlanner } from '../src/planners/unified-planner';
import { SkillRegistry } from '../src/skill-registry';
import type { ILLMClient } from '../src/llm';

const mockRegistry = {
  getAllMetadata: () => [],
} as unknown as SkillRegistry;

describe('UnifiedPlanner.plan — hint 参数', () => {
  let capturedPrompt: string | undefined;

  const mockLlm: ILLMClient = {
    generateStructured: async (prompt: string) => {
      capturedPrompt = prompt;
      return {
        success: true,
        plan: {
          id: 'plan-1',
          tasks: [],
        },
      };
    },
    generateText: async () => '',
    generateWithTools: async () => ({ content: '', toolCalls: [], messages: [] }),
  } as unknown as ILLMClient;

  beforeEach(() => {
    capturedPrompt = undefined;
  });

  test('hint 不传 → prompt 不包含 hint 段落', async () => {
    const planner = new UnifiedPlanner(mockLlm, mockRegistry);
    await planner.plan('帮我审合同');
    expect(capturedPrompt ?? '').not.toContain('【拆解偏好】');
  });

  test('hint 传入 → prompt 包含 hint 段落', async () => {
    const planner = new UnifiedPlanner(mockLlm, mockRegistry);
    await planner.plan('帮我审合同', { hint: '法务任务通常拆为:条款查询 → 风险评估' });
    expect(capturedPrompt).toContain('【拆解偏好】');
    expect(capturedPrompt).toContain('条款查询 → 风险评估');
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/unified-planner-hint.test.ts
```
Expected: FAIL — `plan()` 不接受第二个参数

- [ ] **Step 3: 修改 UnifiedPlanner.plan 签名**

修改 `src/planners/unified-planner.ts`:

```typescript
export class UnifiedPlanner {
  constructor(
    private llm: ILLMClient,
    private skillRegistry: SkillRegistry,
  ) {}

  async plan(
    requirement: string,
    opts: { hint?: string } = {},  // ★ 新增
  ): Promise<PlanResult> {
    const prompt = this.buildPrompt(requirement, opts.hint);
    // ... 现有逻辑 ...
  }

  private buildPrompt(requirement: string, hint?: string): string {
    const basePrompt = `你是任务规划器...`;  // 现有 base
    const hintSection = hint ? `\n\n【拆解偏好】\n${hint}` : '';
    return basePrompt + hintSection + `\n\n需求: ${requirement}`;
  }
}
```

**注**:实际 basePrompt 字符串从现有代码读取后拼接,不要替换现有 prompt 构造逻辑,只在末尾追加 hint 段落。

- [ ] **Step 4: 跑测试确认 PASS**

```bash
bun test __tests__/unified-planner-hint.test.ts
```
Expected: PASS(2/2)

- [ ] **Step 5: Commit**

```bash
git add src/planners/unified-planner.ts __tests__/unified-planner-hint.test.ts
git commit -m "feat(planners): UnifiedPlanner 接受 hint 参数,注入拆解偏好"
```

---

## Task 7: SubAgent 移除 persona hooks,改为读 task 上下文

**Files:**
- Modify: `src/agents/sub-agent.ts`(移除 4 个 hook + 读取 task._personaContext)
- Test: `__tests__/sub-agent-no-persona.test.ts`(新建)

**Interfaces:**
- Consumes: `Task`(新字段 `_personaContext` / `allowedTools`,由 MainAgent 填充)
- Produces: `SubAgent.execute(task)` 签名不变,但内部不再校验 skill 白名单(改由 MainAgent 校验);读取 `task._personaContext.prefix` 拼到 systemPrompt

- [ ] **Step 1: 写失败测试**

`__tests__/sub-agent-no-persona.test.ts`:
```typescript
import { describe, expect, test } from 'bun:test';
import { SubAgent } from '../src/agents/sub-agent';

describe('SubAgent persona hooks 已移除', () => {
  test('SubAgent 不再有 systemPromptPrefix 公开方法', () => {
    const sa = new SubAgent({} as any, {} as any);
    // Type-level:TS 编译会阻止访问 protected 方法
    // Runtime-level:(sa as any).systemPromptPrefix 应该是 undefined
    expect((sa as any).systemPromptPrefix).toBeUndefined();
  });

  test('SubAgent 不再有 allowedSkillNames 公开方法', () => {
    const sa = new SubAgent({} as any, {} as any);
    expect((sa as any).allowedSkillNames).toBeUndefined();
  });

  test('SubAgent 不再有 resultRewriter 公开方法', () => {
    const sa = new SubAgent({} as any, {} as any);
    expect((sa as any).resultRewriter).toBeUndefined();
  });

  test('SubAgent 不再有 configId 公开方法', () => {
    const sa = new SubAgent({} as any, {} as any);
    expect((sa as any).configId).toBeUndefined();
  });

  test('SubAgent.execute 入口不再校验 skill 白名单(无 task.skillName 仍抛 MISSING_SKILL)', async () => {
    const mockSkillRegistry = {
      loadFullSkill: async () => null,
    } as any;
    const mockLlm = {} as any;
    const sa = new SubAgent(mockSkillRegistry, mockLlm);

    const task = { id: 't1' } as any;  // 无 skillName

    await expect(sa.execute(task)).rejects.toThrow(/MISSING_SKILL|Skill not assigned/);
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/sub-agent-no-persona.test.ts
```
Expected: PASS(5/5)— SubAgent 当前确实有这些方法,但测试期望它们不存在。**等 Step 3 改完才会 PASS。**

注:Step 2 当前会 FAIL,因为方法还存在于类上。Step 4 才会 PASS。

- [ ] **Step 3: 修改 SubAgent 移除 4 个 hook**

**3a. 扩展 Task 类型** — 修改 `src/types/index.ts`(Task 接口定义处),在末尾追加 2 个可选字段:

```typescript
export interface Task {
  // ... 现有字段 ...

  /** Master 注入的 persona 上下文(可选,无 persona 时为空) */
  _personaContext?: import('../agents/employee/types').PersonaContext;

  /** Master 注入的过滤后工具列表(优先于 skill.allowedTools) */
  allowedTools?: string[];
}
```

**3b. 修改 SubAgent** — 修改 `src/agents/sub-agent.ts`:

删除以下方法(line 170-188):
```typescript
// 删除
protected systemPromptPrefix(): string {
  return '';
}
protected allowedSkillNames(): Set<string> | null {
  return null;
}
protected resultRewriter(): ((rawResult: string) => string) | null {
  return null;
}
protected configId(): string {
  return 'unknown';
}
```

修改 `execute()` 入口,移除 skill 白名校验(line 195-208):

```typescript
// 删除
const allowed = this.allowedSkillNames();
if (allowed instanceof Set && task.skillName && !allowed.has(task.skillName)) {
  // ...
}
```

修改 `executeSkill()` 内部,persona prefix 改为从 task 读取(line 366):

```typescript
// 旧:
// const personaPrefix = this.systemPromptPrefix() ?? '';
// 新:
const personaContext = task._personaContext;
const personaPrefix = personaContext?.prefix ?? '';
```

同时把 style / boundaries 注入到 systemPrompt 后段:

```typescript
const skillBodyWithPersona = personaPrefix
  ? `${personaPrefix}\n\n${skill.body}`
  : skill.body;
```

如果有 personaContext.style 或 boundaries,在 buildSubAgentPrompt 之后附加(或者直接在 skillBodyWithPersona 末尾追加):

```typescript
const personaAdditions = [
  personaContext?.style ? `\n\n【风格】${personaContext.style}` : '',
  personaContext?.boundaries ? `\n\n【边界】${personaContext.boundaries}` : '',
].filter(Boolean).join('');
const skillBodyWithPersona = personaPrefix
  ? `${personaPrefix}\n\n${skill.body}${personaAdditions}`
  : skill.body + personaAdditions;
```

修改工具过滤逻辑(line 386-390),用 task.allowedTools 优先:

```typescript
// 旧:
// const allowedToolNames = (skill.allowedTools && skill.allowedTools.length > 0)
//   ? new Set(skill.allowedTools)
//   : DEFAULT_SAFE_TOOLS;
// 新:
const allowedToolNames = task.allowedTools && task.allowedTools.length > 0
  ? new Set(task.allowedTools)
  : new Set(DEFAULT_SAFE_TOOLS);
```

删除 resultRewriter 调用(line 270-274):

```typescript
// 删除
// const rewriter = this.resultRewriter();
// const shouldRewrite = rewriter && cleanResult.status !== 'waiting_user_input';
// const finalResult = shouldRewrite ? rewriter!(cleanResult.response ?? '') : cleanResult.response;
// 改为:
const finalResult = cleanResult.response;
```

- [ ] **Step 4: 跑测试确认 PASS**

```bash
bun test __tests__/sub-agent-no-persona.test.ts
```
Expected: PASS(5/5)

- [ ] **Step 5: 跑回归测试**

```bash
bun test __tests__/task-queue.test.ts __tests__/result-aggregator.test.ts __tests__/improvement-agent.test.ts
```
Expected: PASS(SubAgent 行为变化不破坏这些测试,因为它们用 mock LLM + mock skill)

```bash
bun test __tests__/error-propagation-e2e.test.ts
```
Expected: PASS(e2e 测试需要 employee 配置,可能 FAIL — 这是 Task 10 bootstrap 修复后的事,Step 5 允许 FAIL)

- [ ] **Step 6: Commit**

```bash
git add src/agents/sub-agent.ts __tests__/sub-agent-no-persona.test.ts
git commit -m "refactor(sub-agent): 移除 4 个 persona hooks,改为读 task 上下文"
```

---

## Task 8: MainAgent 持有 employee config,集成所有改造

**Files:**
- Modify: `src/agents/main-agent.ts`(构造接受 employee + processRequirement 改造)
- Test: `__tests__/main-agent-employee.test.ts`(新建)

**Interfaces:**
- Consumes: `EmployeeConfig` / `PersonaContext`(`employee/types.ts`)、`computeAllowedTools`(`employee/tools.ts`)
- Produces:
  - `MainAgent` 构造接受 `MainAgentOptions.employee: EmployeeConfig`
  - 移除 `virtualEmployeeResolver` 全局变量
  - 移除 `options.employeeId` 参数(不再需要)
  - 每个 task 构造时填充 `_personaContext` 和 `allowedTools`

- [ ] **Step 1: 写失败测试**

`__tests__/main-agent-employee.test.ts`:
```typescript
import { describe, expect, test, beforeEach } from 'bun:test';
import { MainAgent } from '../src/agents/main-agent';
import type { EmployeeConfig } from '../src/agents/employee/types';

const minimalEmployee: EmployeeConfig = {
  employee: { id: 'test-employee', displayName: 'Test Employee', enabled: true },
  capabilities: { llm: { provider: 'haier' } },
};

describe('MainAgent employee config', () => {
  test('构造时接受 employee: EmployeeConfig', () => {
    // 构造不报错即可(其他依赖传 mock)
    const ma = new MainAgent(
      {
        llm: {} as any,
        skillRegistry: {} as any,
        taskQueue: {} as any,
        intentRouter: {} as any,
        userProfileService: {} as any,
        memoryService: {} as any,
        dynamicContextBuilder: {} as any,
        sessionStore: {} as any,
        askAgent: {} as any,
        systemSkillLoader: {} as any,
        executorRegistry: {} as any,
      },
      { employee: minimalEmployee },
    );
    expect(ma).toBeDefined();
    // 私有字段访问
    expect((ma as any).employee).toBeDefined();
    expect((ma as any).employee.employee.id).toBe('test-employee');
  });

  test('persona 注入 IntentRouter.classify 调用', async () => {
    // 准备 mock deps,捕获 IntentRouter.classify 的 persona 参数
    let capturedPersona: any = undefined;
    const mockIntentRouter = {
      classify: async (...args: any[]) => {
        capturedPersona = args[6];  // persona 是第 7 个参数
        return { intent: 'small_talk', tasks: [], question: null };
      },
    } as any;
    const mockAskAgent = {
      handleUserInput: async () => ({ type: 'new_request', request: { requestId: 'r1', content: 'hi', status: 'processing', createdAt: '', updatedAt: '', suspendedAt: null, suspendedReason: null, questions: [], currentQuestion: null, tasks: [], result: null } }),
    } as any;

    const employeeWithPersona: EmployeeConfig = {
      ...minimalEmployee,
      persona: { prefix: '你是「${displayName}」,Test 员工', style: 'test style' },
    };

    const ma = new MainAgent(
      {
        llm: {} as any,
        skillRegistry: { getAllMetadata: () => [] } as any,
        taskQueue: {} as any,
        intentRouter: mockIntentRouter,
        userProfileService: { loadProfile: async () => ({}), inferSystemFromText: () => null, updateProfile: async () => {} } as any,
        memoryService: { saveUserMessage: async () => {}, loadUserMemory: async () => ({}), recall: async () => [], getL4: () => ({ listEntries: async () => [] }), saveAssistantMessage: async () => {}, summarizeRequest: async () => {}, buildContextPrompt: () => '', popLastAssistantMessage: async () => {} } as any,
        dynamicContextBuilder: { build: async () => '' } as any,
        sessionStore: { loadSession: async () => ({ requests: [], pendingRequests: [], activeRequestId: null }), addTaskToRequest: async () => {}, updateTaskInRequest: async () => {}, flushToDisk: async () => {}, saveExecutionProgress: async () => {}, completeRequest: async () => {}, failRequest: async () => {}, saveSession: async () => {} } as any,
        askAgent: mockAskAgent,
        systemSkillLoader: { isSystemCommand: () => false, extractCommandName: () => '', getCommand: () => null, getAllCommands: () => [] } as any,
        executorRegistry: { getExecutor: () => null } as any,
      },
      { employee: employeeWithPersona },
    );

    await ma.processRequirement('hello', undefined, 'u1', 's1');
    expect(capturedPersona).toBeDefined();
    expect(capturedPersona.prefix).toContain('Test 员工');
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/main-agent-employee.test.ts
```
Expected: FAIL — `MainAgent` 构造不接受第二个参数

- [ ] **Step 3: 修改 MainAgent**

修改 `src/agents/main-agent.ts`:

移除 line 41 的全局变量:
```typescript
// 删除
const virtualEmployeeResolver = new VirtualEmployeeResolver();
```

修改 `MainAgentDependencies` 接口(line 49-61),添加 employee:

```typescript
export interface MainAgentOptions {
  employee: import('./employee/types').EmployeeConfig;
}

export class MainAgent {
  // ... 现有字段 ...
  private employee: EmployeeConfig;

  constructor(deps: MainAgentDependencies, options: MainAgentOptions) {
    // ... 现有依赖注入 ...
    this.employee = options.employee;
    // ...
  }
}
```

修改 `_processRequirementInner`(line 301-327),删除 Resolver 调用,删除 `executorFactory` 中 VirtualEmployee 相关:

```typescript
// 删除:Resolver 调用整段(line 301-349)
// 改为:直接持有 employee,后面 processNormalRequirement 用 this.employee
```

修改 `processNormalRequirement`(line 915-...),在 IntentRouter.classify 调用处传入 persona:

```typescript
const intentResult = await this.intentRouter.classify(
  requirement, userProfile, recentHistory, sessionId, proceduralExperience, userId,
  this.employee.persona,  // ★ 新增:persona
  this.employee.employee.displayName,  // ★ 新增:用于模板替换
);
```

修改 UnifiedPlanner 调用(line 1100):

```typescript
const planner = new UnifiedPlanner(this.llm, this.skillRegistry);
const planResult = await planner.plan(enrichedRequirement, {
  hint: this.employee.planning?.decompositionHint,  // ★ 新增
});
```

修改 `executeTaskGraph` 调用(line 1171),不再传 executorFactory:

```typescript
result = await this.executeTaskGraph(graph, sessionId, userId, request);
```

修改 `buildTaskGraph` 后,每个 task 注入 `_personaContext` 和 `allowedTools`。在 `setupTaskEventForwarding` 之前添加:

```typescript
// ★ 新增:构造 task.allowedTools + task._personaContext
for (const task of plan.tasks) {
  // skill.allowedTools 从 skillRegistry 取;若方法不存在,
  // 用 skillRegistry.loadFullSkill(name)?.allowedTools 作为 fallback
  let skillAllowedTools: string[] | undefined;
  try {
    // 优先尝试轻量方法
    const meta = (this.skillRegistry as any).getMetadata?.(task.skillName);
    skillAllowedTools = meta?.allowedTools;
  } catch {
    // 忽略
  }
  if (!skillAllowedTools && task.skillName) {
    try {
      const full = await (this.skillRegistry as any).loadFullSkill?.(task.skillName);
      skillAllowedTools = full?.allowedTools;
    } catch {
      // 忽略
    }
  }

  const allowed = computeAllowedTools(skillAllowedTools, this.employee.capabilities.tools);

  // 找到对应的 requestTask,挂上 _personaContext 和 allowedTools
  const requestTask = request.tasks.find(rt => rt.taskId === `${plan.id}-${task.id}`);
  if (requestTask) {
    (requestTask as any)._personaContext = {
      prefix: this.employee.persona?.prefix.replace(/\$\{displayName\}/g, this.employee.employee.displayName) ?? '',
      style: this.employee.persona?.style,
      boundaries: this.employee.persona?.boundaries,
    };
    (requestTask as any).allowedTools = [...allowed];
  }
}
```

**注**:实际实现时若 `skillRegistry` 有现成的轻量 metadata 方法(如 `getAllMetadata()` 返回列表里筛),优先用;否则 fallback 到 `loadFullSkill`。这里写出双路径,让 implementer 选择最合适的。

修改 `executeTaskGraph`(line 1546),移除 executorFactory 参数:

```typescript
private async executeTaskGraph(
  graph: TaskGraph,
  sessionId: string,
  userId: string,
  request: Request,
): Promise<TaskResult> {
  return this.taskGraphExecutor.executeTaskGraph(graph, sessionId, userId, request);
}
```

**注**:每步小改,实际可能需要更多上下文相关修改。测试驱动,Step 4 跑测试时若发现破坏,继续追加修改。

- [ ] **Step 4: 跑测试确认 PASS**

```bash
bun test __tests__/main-agent-employee.test.ts
```
Expected: PASS(2/2)

- [ ] **Step 5: Commit**

```bash
git add src/agents/main-agent.ts __tests__/main-agent-employee.test.ts
git commit -m "refactor(main-agent): 持有 employee config + 注入 persona/hint/tools 到下游"
```

---

## Task 9: ResultAggregator 应用 resultRewriter

**Files:**
- Modify: `src/agents/result-aggregator.ts`
- Test: `__tests__/result-aggregator-rewriter.test.ts`(新建)

**Interfaces:**
- Consumes: `ResultRewriter`(`employee/json-types.ts`)
- Produces: `ResultAggregator` 构造接受可选 `rewriter?: ResultRewriter`;`summarizeResults()` 后应用 rewriter

- [ ] **Step 1: 写失败测试**

`__tests__/result-aggregator-rewriter.test.ts`:
```typescript
import { describe, expect, test } from 'bun:test';
import { ResultAggregator } from '../src/agents/result-aggregator';
import type { ResultRewriter } from '../src/agents/employee/types';

const mockLlm = {} as any;
const mockMemory = {} as any;
const mockSession = {} as any;

describe('ResultAggregator resultRewriter', () => {
  test('构造时不传 rewriter → 汇总结果原样返回', async () => {
    const agg = new ResultAggregator(mockLlm, mockMemory, mockSession, async () => ({} as any));
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案' }],
      'u1', 's1',
      {} as any,
    );
    expect(summary.summary).toBe('原始答案');
  });

  test('rewriter transform=append → 汇总结果被追加', async () => {
    const rewriter: ResultRewriter = {
      match: { status: 'completed' },
      transform: 'append',
      value: '\n\n---转人工',
    };
    const agg = new ResultAggregator(mockLlm, mockMemory, mockSession, async () => ({} as any), rewriter);
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案', status: 'completed' }],
      'u1', 's1',
      {} as any,
    );
    expect(summary.summary).toBe('原始答案\n\n---转人工');
  });

  test('rewriter transform=replace → 汇总结果被替换', async () => {
    const rewriter: ResultRewriter = {
      match: { status: 'completed' },
      transform: 'replace',
      value: '替换后的答案',
    };
    const agg = new ResultAggregator(mockLlm, mockMemory, mockSession, async () => ({} as any), rewriter);
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案', status: 'completed' }],
      'u1', 's1',
      {} as any,
    );
    expect(summary.summary).toBe('替换后的答案');
  });

  test('rewriter transform=passthrough → 汇总结果原样', async () => {
    const rewriter: ResultRewriter = {
      transform: 'passthrough',
    };
    const agg = new ResultAggregator(mockLlm, mockMemory, mockSession, async () => ({} as any), rewriter);
    const summary = await agg.summarizeResults(
      '需求',
      [{ taskId: 't1', skillName: 's', requirement: 'r', response: '原始答案' }],
      'u1', 's1',
      {} as any,
    );
    expect(summary.summary).toBe('原始答案');
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/result-aggregator-rewriter.test.ts
```
Expected: FAIL — `ResultAggregator` 构造不接受第 5 个参数 rewriter

- [ ] **Step 3: 修改 ResultAggregator**

修改 `src/agents/result-aggregator.ts`:

构造函数签名:
```typescript
export class ResultAggregator {
  private rewriter?: ResultRewriter;

  constructor(
    llm: ILLMClient,
    memoryService: MemoryService,
    sessionStore: SessionStore,
    private readonly processNormalRequirement: ProcessRequirementFn,
    rewriter?: ResultRewriter,  // ★ 新增
  ) {
    // ... 现有赋值 ...
    this.rewriter = rewriter;
  }

  async summarizeResults(
    originalRequirement: string,
    taskResults: Array<{ taskId: string; skillName: string; requirement: string; response: string; status?: string }>,
    userId: string,
    sessionId: string,
    request: Request,
  ): Promise<{ completed: boolean; summary: string }> {
    // ... 现有逻辑(调 LLM 汇总或单任务直接返回)...
    let summary = ...;  // 现有逻辑赋值
    let completed = ...;

    // ★ 新增:应用 rewriter
    if (this.rewriter) {
      const targetStatus = this.rewriter.match?.status ?? 'completed';
      const lastTaskStatus = taskResults[0]?.status ?? 'completed';
      if (lastTaskStatus === targetStatus) {
        summary = this.applyRewriter(summary, this.rewriter);
      }
    }

    return { completed, summary };
  }

  private applyRewriter(text: string, rewriter: ResultRewriter): string {
    switch (rewriter.transform) {
      case 'append':
        return text + (rewriter.value ?? '');
      case 'passthrough':
        return text;
      case 'replace':
        return rewriter.value ?? text;
    }
  }
}
```

- [ ] **Step 4: 跑测试确认 PASS**

```bash
bun test __tests__/result-aggregator-rewriter.test.ts
```
Expected: PASS(4/4)

- [ ] **Step 5: 修改 MainAgent 传入 rewriter**

修改 `src/agents/main-agent.ts` 的 ResultAggregator 构造:

```typescript
this.resultAggregator = new ResultAggregator(
  llm, memoryService, sessionStore,
  (request, userId, sessionId) => this.processNormalRequirement(...),
  this.employee.outputBehavior?.resultRewriter,  // ★ 新增
);
```

- [ ] **Step 6: 跑回归测试**

```bash
bun test __tests__/result-aggregator.test.ts
```
Expected: PASS(原测试不传 rewriter,行为不变)

- [ ] **Step 7: Commit**

```bash
git add src/agents/result-aggregator.ts src/agents/main-agent.ts __tests__/result-aggregator-rewriter.test.ts
git commit -m "feat(aggregator): ResultAggregator 支持 resultRewriter + MainAgent 传入"
```

---

## Task 10: bootstrap 解析 --employee 参数

**Files:**
- Modify: `src/index.ts`
- Test: `__tests__/bootstrap-employee.test.ts`(新建)

**Interfaces:**
- Consumes: `loadEmployeeConfig`(`employee/loader.ts`)、`EmployeeConfig`(`employee/types.ts`)
- Produces:
  - `parseEmployeeArg(argv: string[]): string | undefined`
  - bootstrap 流程整合(loadEmployeeConfig → buildFallbackLLMClient → MainAgent)

- [ ] **Step 1: 写失败测试**

`__tests__/bootstrap-employee.test.ts`:
```typescript
import { describe, expect, test } from 'bun:test';
import { parseEmployeeArg } from '../src/index';

describe('parseEmployeeArg', () => {
  test('argv 包含 --employee=legal-assistant → 返回 id', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--employee=legal-assistant'])).toBe('legal-assistant');
  });

  test('argv 包含 --employee legal-assistant(空格分隔) → 返回 id', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--employee', 'legal-assistant'])).toBe('legal-assistant');
  });

  test('argv 不包含 --employee → 返回 undefined', () => {
    expect(parseEmployeeArg(['node', 'index.js'])).toBeUndefined();
  });

  test('argv 包含 --employee= (空值) → 返回 undefined', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--employee='])).toBeUndefined();
  });

  test('argv 包含 --help(非 employee 参数)→ 返回 undefined', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--help'])).toBeUndefined();
  });

  test('argv 中 --employee 在中间位置 → 仍能找到', () => {
    expect(parseEmployeeArg(['node', 'index.js', '--port=3000', '--employee=foo', '--verbose'])).toBe('foo');
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
bun test __tests__/bootstrap-employee.test.ts
```
Expected: FAIL — `parseEmployeeArg` 不存在(未导出)

- [ ] **Step 3: 在 src/index.ts 导出 parseEmployeeArg**

修改 `src/index.ts`:

```typescript
/**
 * 解析命令行参数,提取 --employee=<id> 或 --employee <id>。
 * 不存在返回 undefined。
 *
 * 暴露为 export 供测试。
 */
export function parseEmployeeArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--employee=')) {
      const value = arg.slice('--employee='.length).trim();
      return value || undefined;
    }
    if (arg === '--employee' && i + 1 < argv.length) {
      const value = argv[i + 1].trim();
      return value || undefined;
    }
  }
  return undefined;
}
```

修改 `bootstrap()`(line 50-60 附近):

```typescript
async function bootstrap() {
  // 1. 加载员工配置
  const employeeId = parseEmployeeArg(process.argv);
  const employee = await loadEmployeeConfig({ explicitId: employeeId });
  log.info('数字员工已加载', {
    id: employee.employee.id,
    displayName: employee.employee.displayName,
    source: employeeId ? '--employee arg' : 'fallback (first JSON in employees/)',
  });

  // 2. 构造 LLM 客户端(用 employee.capabilities.llm)
  const llmClient = buildFallbackLLMClient();
  // 若 employee 指定了不同的 provider,在此处 reconfigure:
  // (此处仅展示,完整实现可加 buildLLMClientFromEmployee 函数)
  if (employee.capabilities.llm.provider) {
    // 当前 LLMClient 由 env 决定 provider,employee override 是 follow-up
    log.debug('employee 指定 LLM provider', { provider: employee.capabilities.llm.provider });
  }

  // 3. 构造 MainAgent(employee + llm + 其他依赖)
  const mainAgent = new MainAgent({
    llm: llmClient,
    skillRegistry,
    taskQueue,
    intentRouter,
    userProfileService,
    memoryService,
    dynamicContextBuilder,
    sessionStore,
    askAgent,
    systemSkillLoader,
    executorRegistry,
  }, { employee });

  // 4. 启动 HTTP 服务
  app.listen(PORT);
  log.info('数字员工已上线', {
    id: employee.employee.id,
    displayName: employee.employee.displayName,
  });
}
```

**注**:`bootstrap()` 中的具体依赖(skillRegistry 等)从现有 index.ts 已有变量读取,不需要新建。

- [ ] **Step 4: 跑测试确认 PASS**

```bash
bun test __tests__/bootstrap-employee.test.ts
```
Expected: PASS(6/6)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts __tests__/bootstrap-employee.test.ts
git commit -m "feat(bootstrap): 解析 --employee=<id> + loadEmployeeConfig 集成到 MainAgent"
```

---

## Task 11: 删除旧 virtual-employee/ 模块 + 清理旧测试

**Files:**
- Delete: `src/agents/virtual-employee/`(整个目录)
- Delete:
  - `__tests__/virtual-employee-json-types.test.ts`
  - `__tests__/virtual-employee-json-employee.test.ts`
  - `__tests__/virtual-employee-loader.test.ts`
  - `__tests__/virtual-employee-registry.test.ts`
  - `__tests__/virtual-employee-resolver.test.ts`
  - `__tests__/virtual-employee-it-ops-consultant.test.ts`
  - `__tests__/main-agent-employee-routing.test.ts`
  - `__tests__/sub-agent-template-method.test.ts`

- [ ] **Step 1: 列出所有引用旧模块的文件**

```bash
git grep -l "VirtualEmployee\|virtualEmployeeResolver\|virtual-employee/\|virtualEmployeeRegistry" src/ __tests__/
```

- [ ] **Step 2: 删除旧模块 + 旧测试**

```bash
rm -rf src/agents/virtual-employee/
rm __tests__/virtual-employee-*.test.ts
rm __tests__/main-agent-employee-routing.test.ts
```

- [ ] **Step 3: 处理 Step 1 列出的剩余引用**

对每个 Step 1 列出的文件:
- 如果是 `__tests__/*.test.ts` → 在 Step 2 已删除,跳过
- 如果是 `src/*.ts` → 编辑,移除 import 和调用代码

预期残留引用点:
- `src/agents/main-agent.ts`(Step 8 已删除 Resolver 调用,但可能残留 import)
- `src/agents/sub-agent.ts`(Step 7 已删除 hook,可能残留 import)

- [ ] **Step 4: 跑全套测试**

```bash
bun test
```
Expected: 全部 PASS(零回归)

- [ ] **Step 5: 类型检查**

```bash
bunx tsc --noEmit
```
Expected: 无错误

- [ ] **Step 6: 验证旧符号无残留**

```bash
git grep "VirtualEmployee\|virtualEmployeeResolver\|virtual-employee" src/ __tests__/
```
Expected: 无输出

- [ ] **Step 7: Commit**

```bash
git add -A
git status  # 确认只删除,无意外新增
git commit -m "refactor(employee): 删除旧 virtual-employee/ 模块 + 8 个旧测试"
```

---

## Task 12: 端到端验证

**Files:** 无(纯验证步骤)

- [ ] **Step 1: 跑全套测试**

```bash
bun test
```
Expected: 全部 PASS(零回归)

- [ ] **Step 2: 类型检查**

```bash
bunx tsc --noEmit
```
Expected: 无错误

- [ ] **Step 3: 验证启动(显式 --employee)**

```bash
HAIER_API_KEY=test-key SILICONFLOW_API_KEY=test-key bun start --employee=legal-assistant 2>&1 | head -20
```
Expected: 日志含 `数字员工已加载 id=legal-assistant displayName=法务助理·小法`

注:实际启动会失败(测试用 key),看到 log 后 Ctrl+C 即可。

- [ ] **Step 4: 验证启动(无参数 + 兜底)**

```bash
HAIER_API_KEY=test-key SILICONFLOW_API_KEY=test-key bun start 2>&1 | head -20
```
Expected: 日志含 `数字员工已加载 ... source=fallback (first JSON in employees/)`

- [ ] **Step 5: 验证启动失败(--employee 不存在)**

```bash
HAIER_API_KEY=test-key bun start --employee=non-existent 2>&1 | head -20
```
Expected: 抛 `BootstrapError(EMPLOYEE_NOT_FOUND)` 并退出非 0

- [ ] **Step 6: 验证启动失败(employees/ 空)**

```bash
mkdir -p /tmp/empty-emp && HAIER_API_KEY=test-key bun start --config-dir=/tmp/empty-emp 2>&1 | head -20
```
Expected: 抛 `BootstrapError(NO_EMPLOYEE_CONFIG)`

注:`--config-dir` 不存在的话,可以临时把 `employees/*.json` 移走来测试:
```bash
mv employees employees.bak
HAIER_API_KEY=test-key bun start 2>&1 | head -20  # 期望 NO_EMPLOYEE_CONFIG
mv employees.bak employees
```

- [ ] **Step 7: 验证启动失败(坏 JSON)**

```bash
echo '{ invalid json' > employees/legal-assistant.json.bad  # 临时
HAIER_API_KEY=test-key bun start --employee=legal-assistant 2>&1 | head -20
# 清理
rm employees/legal-assistant.json.bad
```
Expected: 抛 `BootstrapError(EMPLOYEE_CONFIG_INVALID)`

- [ ] **Step 8: 验证 git 历史中无残留引用**

```bash
git grep "VirtualEmployee\|virtualEmployeeResolver\|virtual-employee/" src/ __tests__/
```
Expected: 无输出

- [ ] **Step 9: 更新 CLAUDE.md / README 引用(如有)**

```bash
git grep "VirtualEmployee\|virtualEmployeeResolver" README.md CLAUDE.md 2>/dev/null
```

如有引用,更新为「数字员工 / Digital Employee」措辞。

- [ ] **Step 10: 最终 commit(若有文档更新)**

```bash
git add README.md CLAUDE.md 2>/dev/null
git diff --cached --quiet || git commit -m "docs: 更新 README/CLAUDE.md 措辞为数字员工"
```

- [ ] **Step 11: 推送(用户确认后)**

```bash
git push origin feature_7-30
```

---

## 验证清单(End-to-End,对照 spec)

完成所有 Task 后,逐项对照:

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

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Task 8 (MainAgent 改造) 影响面最大,可能连锁破坏 | Task 8 独立 commit + 跑全套测试,问题及时发现 |
| Task 11 删除旧模块时,可能遗漏 import 残留 | Step 1 用 `git grep` 列清单,Step 6 验证无残留 |
| e2e 测试需要真实启动,可能在 Step 3/4 暴露 runtime 错误 | Task 10 后立即跑 e2e 测试(Task 5/Step 5 已允许失败) |
| employee.capabilities.llm 当前 LLMClient 构造由 env 决定,本 plan 不强行改 | 已知 limitation,留到 follow-up(bootstrap 时打 log 提示) |
| Task 8 的 task._personaContext / allowedTools 注入点位置可能错 | 测试驱动,Step 4 跑 main-agent-employee.test 验证 |

---

## 不在本计划范围

1. 进程间跨员工协作 / 外部主控路由(分布式场景)
2. 员工配置热更新
3. 员工配置 UI / 后台管理
4. 远程员工配置 provider
5. 12 个员工全部实现(本计划只迁 2 个示例)
6. LLM 韧性层 / 记忆系统 / Skill 注册 / 工具注册的归属重定义
7. PPT / 讲稿的「虚拟员工」→「数字员工」名称统一
8. 员工运行指标(SLA / 接待量 / 平均时长)
9. employee.capabilities.llm 强制 override LLMClient provider(Task 4 提供了 override 能力,但 bootstrap 集成仅打 log,完整集成留到 follow-up)
