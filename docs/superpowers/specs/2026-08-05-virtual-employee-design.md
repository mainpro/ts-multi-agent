# Virtual Employee 设计规格(PPT 12 类角色缺口)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 在 MainAgent 与 SubAgent 之间引入"虚拟员工"抽象,系统对外提供"带着业务属性的智能体";本次实现可扩展抽象 + 1 个示例(「IT 运维顾问·小海」)。

**Architecture**: 把当前 `SubAgent` 改造成 template method 父类,新增 3 个 protected hook(`systemPromptPrefix()` / `allowedSkillNames()` / `resultRewriter()`);新建 `VirtualEmployee extends SubAgent`,子类的 hook 表达"业务属性"差异;`VirtualEmployeeRegistry` 静态注册表 + `VirtualEmployeeResolver` 二级 fallback 路由(@ → 意图识别 → 默认)。

**Tech Stack**: TypeScript / Bun test / 现有 LLM/Skill/Metrics 全部复用,不引入新依赖。

---

## Context

### 背景

PPT `详细设计输入.pdf` 第 10 行明确列出"12 类角色"(运维工程师、项目经理、产品经理、应用负责人、二线运维、运维经理、管理员、一线员工、工贸、设计人员、研发、销售人员),后续章节反复出现"虚拟员工"概念。

第 822-827 行定义了三层 Agent 架构:
- **主智能体**(全局大脑调度层): 意图识别、流程编排、策略路由、SLA 评估、Skill/RPA/办理/观测智能体调度
- **子智能体**(垂直专业执行层): 办理智能体 / 审计智能体 / 观测智能体 — 系统级能力,不挂钩用户角色
- **Skill 库**(可复用 AI 能力层): 用户画像、系统画像、知识问答、自动填单、新员工服务…

PPT 12 类角色是**用户角色**(谁会用这个系统),不是 12 个 Agent。但产品侧习惯把"接待某类员工的虚拟坐席"称为"虚拟员工",这跟"系统提供出去的、带着业务属性的智能体"语义对应:
- IT 运维顾问(对接 IT 问题)
- HR 助理(对接人事问题)
- 财务助手(对接财务问题)
- …

本次需求: **可扩展抽象 + 1 个示例虚拟员工**(IT 运维顾问),其余 11 个留到后续迭代。

### 与现有 SubAgent 的关系

- 当前 `SubAgent` 是通用执行器(`src/agents/sub-agent.ts`,782 行):接 `task.skillName`,加载 skill,跑 LLM 循环,处理断点续执行 / ask_user / steer / metrics / compaction
- 现状缺:**没有"员工角色"差异化** — 同一个 SubAgent 既接 IT 问题也接 HR 问题,prompt 是 skill 自己的,没有任何"我是谁"的人设
- 目标: 在 SubAgent 上面加一层"虚拟员工",每个虚拟员工:
  - 固定的 persona(我是谁 / 边界在哪)
  - 固定的 skill 白名单(我擅长什么)
  - 固定的 result 改写器(我说话的收尾方式)
- 复用 SubAgent 全部现有逻辑 — 这是 template method 重构,不动 LLM 循环本身

### 排除项(本次不做)

- ❌ 12 个虚拟员工全部实现(本次只做 1 个示例)
- ❌ 数据权限范围 / 升级路径 / 专属模型(留到后续)
- ❌ 三类专业型智能体(办理/审计/观测)的实现(系统级,不在虚拟员工抽象里)
- ❌ 虚拟员工的配置 UI / 后台管理(后续产品化)
- ❌ 改 SubAgent 的 compaction 策略 / 模型选择 / LLM 调用循环(本次只加 3 个 hook,不动 LLM 流)

---

## 全局约束

| 约束 | 值 | 来源 |
|------|---|------|
| 路由策略 | 用户 `@employeeId` 显式 → 否则意图识别关键词匹配 → 否则 `defaultEmployeeId` | 用户澄清 2026-08-05 |
| 业务属性最小集 | `persona` + `skill 白名单` + `result 改写器` | 用户澄清 2026-08-05 |
| 与 SubAgent 关系 | template method 父类(`extends SubAgent` + override 3 个 protected hook) | 用户澄清 2026-08-05 |
| 覆盖范围 | 本次只做 1 个示例虚拟员工:「IT 运维顾问·小海」(`it-ops-consultant`) | 用户澄清 2026-08-05 |
| 与专业型智能体关系 | 独立 — 办理/审计/观测子智能体是系统级,与虚拟员工不挂钩 | 用户澄清 2026-08-05 |
| prompt 拼接位置 | `systemPromptPrefix()` 返回值拼到 `skill.body` 前面(2 处,首次执行 + 断点续) | 设计决策 |
| skill 白名单校验时机 | `execute()` 入口(template method 在调用 `executeSkill` 之前校验) | 设计决策 |
| result 改写时机 | SubAgent 拿到 result.content 之后、`return` 之前 | 设计决策 |
| employeeId 不存在 | `BusinessError(UNKNOWN_EMPLOYEE)` → 走 transferToHuman | 设计决策 |
| skillName 不在白名单 | `SkillError(SKILL_NOT_ALLOWED)` → SubAgent 抛错,LLM 自查改口或 system 转人工 | 设计决策 |
| 注册表启动时机 | `src/index.ts` 启动入口,`VirtualEmployeeRegistry.register(...)` | 设计决策 |
| 类型约束 | 虚拟员工抽象类 `abstract`;不允许运行时动态构造(必须在 registry 注册) | 设计决策 |
| 测试框架 | `bun:test`,沿用现有 `__tests__/` 目录 | 现有代码约定 |
| 不引入新依赖 | 不新增 npm 包 | YAGNI |
| 现有测试零回归 | `bun test` 全部已有用例通过(模板方法重构不能破坏) | 现有约束 |

---

## 文件结构

### 新建

| 文件 | 行数估计 | 职责 |
|------|---------|------|
| `src/agents/virtual-employee/types.ts` | ~30 | `EmployeeId` / `EmployeeConfig` / `IntentRouter` 接口 + `ResultRewriter` 类型 |
| `src/agents/virtual-employee/base.ts` | ~80 | `VirtualEmployee extends SubAgent`,3 个抽象 hook |
| `src/agents/virtual-employee/registry.ts` | ~50 | `VirtualEmployeeRegistry` 静态 Map,register/get/list |
| `src/agents/virtual-employee/resolver.ts` | ~70 | `VirtualEmployeeResolver.resolve()` 二级 fallback |
| `src/agents/virtual-employee/employees/it-operations-consultant.ts` | ~60 | 示例虚拟员工:IT 运维顾问·小海 |
| `__tests__/virtual-employee-registry.test.ts` | ~80 | 注册表测试 |
| `__tests__/virtual-employee-resolver.test.ts` | ~120 | 路由测试(@ / 意图 / 默认 / 未知 ID) |
| `__tests__/virtual-employee-it-ops-consultant.test.ts` | ~80 | 示例员工 hook 内容测试 |
| `__tests__/sub-agent-template-method.test.ts` | ~80 | 父类模板方法测试(skill 白名单校验) |
| `__tests__/main-agent-employee-routing.test.ts` | ~150 | 端到端 mock(带 employeeId / 带 @ / 不带) |

### 修改

| 文件 | 改动范围 |
|------|----------|
| `src/agents/sub-agent.ts` | `execute()` 改为 template method;`executeSkill()` 改 protected;2 处 `buildSubAgentPrompt` 调用前拼 prefix hook |
| `src/agents/main-agent.ts` | `processRequirement` 入口加 resolver 调用,选择 employee 实例后再跑 |
| `src/api/index.ts` | `SubmitTaskRequest` 类型加 `employeeId?: string` 字段(可选,向后兼容) |
| `src/index.ts` | 启动时注册示例虚拟员工到 `VirtualEmployeeRegistry` |
| `src/types/index.ts` | `SubmitTaskRequest` interface 加 `employeeId?: string`(沿用现有类型定义位置) |

---

## 任务分解

### Task 1: 类型定义 + VirtualEmployee 抽象基类

**Files**:
- Create: `src/agents/virtual-employee/types.ts`
- Create: `src/agents/virtual-employee/base.ts`

**Interfaces**:
- Consumes: 无
- Produces:
  - `EmployeeId` 类型(string 包装)
  - `EmployeeConfig` 接口(`id` / `displayName` / `intentKeywords`)
  - `ResultRewriter` 类型(`(raw: string) => string`)
  - `VirtualEmployee` 抽象类(extends `SubAgent`,3 个抽象 protected method)

**关键决策**:
- `EmployeeConfig.id` 用 string 而不是 enum,允许后续动态注册
- `intentKeywords` 是 string[],大小写不敏感匹配,中文 / 英文都支持
- `VirtualEmployee` 是 abstract class,不允许直接 new
- 3 个 hook 都是 protected,子类必须 override:
  - `systemPromptPrefix(): string` — 拼到 system prompt 最前面,默认实现返回 `''`(零行为差异,SubAgent 当前行为)
  - `allowedSkillNames(): Set<string>` — 员工允许调用的 skill 列表,默认实现返回 `new Set([ALL_SKILLS])` 标记(实际由 SubAgent 默认行为放行所有)
  - `resultRewriter(): ResultRewriter | null` — result 改写器,默认实现返回 `null`(passthrough)

**Step 1.1 — 写 types.ts**

```typescript
// src/agents/virtual-employee/types.ts

export type EmployeeId = string;

export interface EmployeeConfig {
  id: EmployeeId;
  displayName: string;       // 暴露给用户的名字(供 @mention 识别 + 前端展示)
  intentKeywords: string[];  // 意图路由关键词(中文 / 英文,不区分大小写,substring 匹配)
}

export type ResultRewriter = (rawResult: string) => string;
```

**Step 1.2 — 写 base.ts**

```typescript
// src/agents/virtual-employee/base.ts

import type { ResultRewriter, EmployeeConfig } from './types';
import { SubAgent } from '../sub-agent';

/**
 * 虚拟员工抽象基类。
 * 每个虚拟员工 = 一份配置 + 3 个 protected hook(persona / skill 白名单 / result 改写)。
 * 复用 SubAgent 全部 LLM 循环 / 断点续 / steer / metrics / compaction。
 */
export abstract class VirtualEmployee extends SubAgent {
  abstract readonly config: EmployeeConfig;

  /** 拼到 system prompt 最前面的人设前缀(默认空 = 零行为差异) */
  protected systemPromptPrefix(): string {
    return '';
  }

  /**
   * 允许该员工调用的 skill 列表。
   * 返回 null 表示不限制(等价于现状 SubAgent 行为)。
   */
  protected allowedSkillNames(): Set<string> | null {
    return null;
  }

  /** result 改写器。返回 null 表示 passthrough。 */
  protected resultRewriter(): ResultRewriter | null {
    return null;
  }
}
```

**Step 1.3 — 跑测试**(本任务尚无测试,先确保 `npx tsc --noEmit` 通过)

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 1.4 — Commit**

```bash
git add src/agents/virtual-employee/types.ts src/agents/virtual-employee/base.ts
git commit -m "feat(agent): VirtualEmployee 抽象基类 + types(缺口 6)"
```

---

### Task 2: SubAgent template method 重构(关键改造)

**Files**:
- Modify: `src/agents/sub-agent.ts`
  - `execute()` 改为 template method(入口加 skill 白名单校验,内部逻辑挪到 `protected executeInner()`)
  - `executeSkill()` 改 `protected`(原来是 `private`)
  - 2 处 `buildSubAgentPrompt` 调用前拼 `this.systemPromptPrefix()`(仅当子类是 `VirtualEmployee` 时;普通 SubAgent 返回 `''` 不变)
- Test: `__tests__/sub-agent-template-method.test.ts`

**Interfaces**:
- Consumes: `VirtualEmployee.base.ts`(Task 1)
- Produces:
  - `SubAgent.execute()` 签名不变,但内部新增白名单校验
  - `SubAgent.executeSkill()` 改 protected(子类可访问)

**关键约束**:
- **向后兼容**: 不 override hook 的 SubAgent 行为必须和当前完全一致(测试断言)
- **2 处 prompt 拼接**: `executeSkill` 内第 300 行(首次执行)+ 第 344 行(断点续执行)
- **白名单校验**: 放行 `null`(不限制) + `Set.has(skillName)` 两种情况;否则抛 `SkillError(SKILL_NOT_ALLOWED)`

**Step 2.1 — 写测试**

```typescript
// __tests__/sub-agent-template-method.test.ts
import { describe, expect, test, mock } from 'bun:test';
import { SubAgent } from '../src/agents/sub-agent';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';
import { SkillRegistry } from '../src/skill-registry';
import { ILLMClient } from '../src/llm';
import { Task } from '../src/types';
import { SkillError } from '../src/errors';

class StubLLM implements ILLMClient {
  async generateWithTools(): Promise<any> {
    return { content: 'stub', toolCalls: [], messages: [] };
  }
}

describe('SubAgent template method', () => {
  test('默认 SubAgent 不限制 skill 白名单(向后兼容)', async () => {
    const sa = new SubAgent(new SkillRegistry(), new StubLLM() as any);
    const task: Task = {
      id: 't1', requirement: 'r1', skillName: 'any-skill', sessionId: 's1', userId: 'u1',
    } as any;
    // 不抛错,只 mock LLM 路径,核心校验是 allowedSkillNames() 返回 null → 放行
    expect((sa as any).allowedSkillNames?.() ?? null).toBeNull();
  });

  test('VirtualEmployee override allowedSkillNames → 不在白名单的 skill 抛错', async () => {
    class TestEmployee extends VirtualEmployee {
      readonly config = { id: 'test', displayName: 'T', intentKeywords: [] };
      protected allowedSkillNames() { return new Set(['allowed-skill']); }
    }
    const emp = new TestEmployee(new SkillRegistry(), new StubLLM() as any);
    const task: Task = {
      id: 't1', requirement: 'r1', skillName: 'forbidden-skill', sessionId: 's1', userId: 'u1',
    } as any;
    // execute() 入口校验 → SkillError
    await expect(emp.execute(task)).rejects.toThrow(/SKILL_NOT_ALLOWED/);
  });

  test('VirtualEmployee override systemPromptPrefix → 拼到 skill body 前面', async () => {
    // 通过 stub skill 验证 buildSubAgentPrompt 收到拼接后的 body
    const spy = mock();
    // ... 详细 spy buildSubAgentPrompt 后断言参数
  });
});
```

**Step 2.2 — 重构 sub-agent.ts**

```typescript
// src/agents/sub-agent.ts 关键 diff

export class SubAgent {
  // ... 现有字段不变

  /**
   * template method 入口。
   * 子类(VirtualEmployee)可通过 override `allowedSkillNames()` 加 skill 白名单。
   * 默认 null = 放行所有 skill(向后兼容现状)。
   */
  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('SubAgent');

    // ===== Task 2: VirtualEmployee skill 白名单校验 =====
    const allowed = (this as any).allowedSkillNames?.call(this);
    if (allowed instanceof Set && task.skillName && !allowed.has(task.skillName)) {
      const empConfig = (this as any).config;
      const empId = empConfig?.id ?? 'unknown';
      SubAgent.log.warn('虚拟员工 skill 白名单拒绝', { employeeId: empId, skillName: task.skillName });
      throw new SkillError('SKILL_NOT_ALLOWED',
        `虚拟员工 ${empId} 不允许调用 skill: ${task.skillName}`);
    }

    try {
      // ===== 现有逻辑挪到这里 =====
      const result = await this.executeSkill(
        task.id, task.requirement,
        await this.skillRegistry.loadFullSkill(task.skillName),
        // ... 现有参数
      );
      // ...
      // ===== Task 2: result 改写器 =====
      const rewriter = (this as any).resultRewriter?.call(this);
      const finalResult = rewriter ? rewriter(result.response ?? '') : result.response;

      return { success: true, data: { ...result, response: finalResult } };
    } catch (error) {
      throw mapSubAgentError(error);
    } finally {
      // ... 现有 finally
    }
  }

  // ===== executeSkill 改 protected =====
  protected async executeSkill(...) { ... }

  // ===== 2 处 prompt 拼接 =====
  private async executeSkill(...) {
    // ... 现有字段
    const prefix = (this as any).systemPromptPrefix?.call(this) ?? '';
    const skillBody = prefix ? `${prefix}\n\n${skill.body}` : skill.body;

    const systemPrompt = await buildSubAgentPrompt(
      skillBody,    // 拼接后的 body
      // ... 其他参数不变
    );
    // ... 第二次 buildSubAgentPrompt 同理(refreshedSystemPrompt)
  }
}
```

**Step 2.3 — 跑测试**

Run: `bun test __tests__/sub-agent-template-method.test.ts`
Expected: PASS

**Step 2.4 — 跑回归**

Run: `bun test __tests__/sub-agent.test.ts __tests__/api.test.ts`
Expected: PASS(现有测试不变通过)

**Step 2.5 — Commit**

```bash
git add src/agents/sub-agent.ts __tests__/sub-agent-template-method.test.ts
git commit -m "refactor(agent): SubAgent 改 template method + 3 个 protected hook"
```

---

### Task 3: VirtualEmployeeRegistry 注册表

**Files**:
- Create: `src/agents/virtual-employee/registry.ts`
- Test: `__tests__/virtual-employee-registry.test.ts`

**Interfaces**:
- Consumes: `VirtualEmployee.base.ts` + `types.ts`(Task 1)
- Produces:
  - `VirtualEmployeeRegistry` 静态类
    - `register(ctor: new (...args: any[]) => VirtualEmployee): void`
    - `get(id: EmployeeId): VirtualEmployee | undefined`
    - `list(): EmployeeConfig[]`
    - `getDefaultCtor(): new (...args: any[]) => VirtualEmployee | undefined`

**关键决策**:
- **构造时机**: registry 持有的是 `new (...args: any[]) => VirtualEmployee`(构造函数引用),不是实例。每次 `get(id)` 才 `new` 实例,避免 singleton 状态污染
- **构造参数**: 虚拟员工构造参数应和 SubAgent 一致 `(skillRegistry, llm, memoryService?)`。在 `get()` 时从外部注入依赖
- **defaultEmployeeId**: 启动时通过 `register(id, ctor, isDefault=true)` 标记,作为 Resolver 的兜底

```typescript
// src/agents/virtual-employee/registry.ts

import type { EmployeeId, EmployeeConfig } from './types';
import type { VirtualEmployee } from './base';

type VirtualEmployeeCtor = new (
  skillRegistry: any,
  llm: any,
  memoryService?: any,
) => VirtualEmployee;

interface Registration {
  ctor: VirtualEmployeeCtor;
  isDefault: boolean;
}

export class VirtualEmployeeRegistry {
  private static entries = new Map<EmployeeId, Registration>();

  /** 注册一个虚拟员工。重复注册同一 id 抛错(避免覆盖)。 */
  static register(id: EmployeeId, ctor: VirtualEmployeeCtor, opts?: { isDefault?: boolean }): void {
    if (this.entries.has(id)) {
      throw new Error(`VirtualEmployee id '${id}' already registered`);
    }
    this.entries.set(id, { ctor, isDefault: opts?.isDefault ?? false });
  }

  /** 拿构造函数(由 caller 注入依赖后 new 实例)。 */
  static getCtor(id: EmployeeId): VirtualEmployeeCtor | undefined {
    return this.entries.get(id)?.ctor;
  }

  /** 拿默认员工的构造函数(注册时标记 isDefault=true)。 */
  static getDefaultCtor(): VirtualEmployeeCtor | undefined {
    for (const reg of this.entries.values()) {
      if (reg.isDefault) return reg.ctor;
    }
    return undefined;
  }

  /** 列出所有员工的配置(给前端 / Resolver 用)。 */
  static list(): EmployeeConfig[] {
    const configs: EmployeeConfig[] = [];
    for (const { ctor } of this.entries.values()) {
      // 实例化一份只为读 config(避免每次都 new 真实依赖)
      configs.push(new (ctor as any)(null, null).config);
    }
    return configs;
  }

  /** 测试用:清空 registry。生产代码不要调。 */
  static _reset(): void {
    this.entries.clear();
  }
}
```

**测试**(`__tests__/virtual-employee-registry.test.ts`):

```typescript
import { describe, expect, test, beforeEach } from 'bun:test';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';
import { SkillRegistry } from '../src/skill-registry';
import { ILLMClient } from '../src/llm';

class StubLLM implements ILLMClient {
  async generateWithTools() { return { content: '', toolCalls: [], messages: [] }; }
}

class EmployeeA extends VirtualEmployee {
  readonly config = { id: 'a', displayName: '员工 A', intentKeywords: ['OA'] };
}
class EmployeeB extends VirtualEmployee {
  readonly config = { id: 'b', displayName: '员工 B', intentKeywords: ['HR'], } as any;
}

describe('VirtualEmployeeRegistry', () => {
  beforeEach(() => VirtualEmployeeRegistry._reset());

  test('register + getCtor', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(VirtualEmployeeRegistry.getCtor('a')).toBe(EmployeeA);
  });

  test('重复注册同一 id 抛错', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(() => VirtualEmployeeRegistry.register('a', EmployeeA as any)).toThrow(/already registered/);
  });

  test('getDefaultCtor 拿 isDefault 标记的员工', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    VirtualEmployeeRegistry.register('b', EmployeeB as any, { isDefault: true });
    expect(VirtualEmployeeRegistry.getDefaultCtor()).toBe(EmployeeB);
  });

  test('list() 列出所有配置', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    VirtualEmployeeRegistry.register('b', EmployeeB as any);
    const list = VirtualEmployeeRegistry.list();
    expect(list.map(c => c.id).sort()).toEqual(['a', 'b']);
  });

  test('getCtor 不存在返回 undefined', () => {
    expect(VirtualEmployeeRegistry.getCtor('nonexistent')).toBeUndefined();
  });
});
```

**Step 3.1 — 写 registry + 测试 → 跑测试 → commit**

```bash
git add src/agents/virtual-employee/registry.ts __tests__/virtual-employee-registry.test.ts
git commit -m "feat(agent): VirtualEmployeeRegistry 注册表"
```

---

### Task 4: VirtualEmployeeResolver 二级 fallback 路由

**Files**:
- Create: `src/agents/virtual-employee/resolver.ts`
- Test: `__tests__/virtual-employee-resolver.test.ts`

**Interfaces**:
- Consumes: `VirtualEmployeeRegistry`(Task 3) + `types.ts`(Task 1)
- Produces:
  - `VirtualEmployeeResolver.resolve(opts)` → 返回 `VirtualEmployee` 实例
  - `ResolverOptions`: `{ hintedId?: EmployeeId; userMessage: string; skillRegistry; llm; memoryService? }`

**关键决策**:
- **@mention 解析**: 在 `userMessage` 中找 `@员工名`(substring 匹配 config.displayName),提取出来作为 `hintedId`。displayName 含空格时取最长匹配。
- **意图识别 fallback**: 扫所有注册员工的 `config.intentKeywords`,找到第一个命中关键词的员工。多个命中按注册顺序取第一个。
- **默认 fallback**: 都没命中 → 用 `getDefaultCtor()`。如果没有默认员工 → 抛 `BusinessError(NO_DEFAULT_EMPLOYEE)`。

```typescript
// src/agents/virtual-employee/resolver.ts

import type { EmployeeId } from './types';
import { VirtualEmployeeRegistry } from './registry';
import type { VirtualEmployee } from './base';
import { BusinessError } from '../../errors';

export interface ResolverOptions {
  hintedId?: EmployeeId;
  userMessage: string;
  skillRegistry: any;
  llm: any;
  memoryService?: any;
}

export class VirtualEmployeeResolver {
  resolve(opts: ResolverOptions): VirtualEmployee {
    // ===== 1. @mention / hintedId 显式 =====
    const hintedFromMessage = this.extractMention(opts.userMessage);
    const hintedId = opts.hintedId ?? hintedFromMessage;

    if (hintedId) {
      const Ctor = VirtualEmployeeRegistry.getCtor(hintedId);
      if (!Ctor) {
        throw new BusinessError('UNKNOWN_EMPLOYEE',
          `虚拟员工 '${hintedId}' 不存在`);
      }
      return new Ctor(opts.skillRegistry, opts.llm, opts.memoryService);
    }

    // ===== 2. 意图识别关键词匹配 =====
    const lowered = opts.userMessage.toLowerCase();
    for (const config of VirtualEmployeeRegistry.list()) {
      for (const kw of config.intentKeywords) {
        if (lowered.includes(kw.toLowerCase())) {
          const Ctor = VirtualEmployeeRegistry.getCtor(config.id)!;
          return new Ctor(opts.skillRegistry, opts.llm, opts.memoryService);
        }
      }
    }

    // ===== 3. 默认 fallback =====
    const DefaultCtor = VirtualEmployeeRegistry.getDefaultCtor();
    if (!DefaultCtor) {
      throw new BusinessError('NO_DEFAULT_EMPLOYEE',
        '没有可用的虚拟员工(意图未命中 + 没有注册默认员工)');
    }
    return new DefaultCtor(opts.skillRegistry, opts.llm, opts.memoryService);
  }

  /** 从 userMessage 中提取 @mention。例如 "@IT小海 帮我..." → 'it-ops-consultant'。 */
  private extractMention(userMessage: string): EmployeeId | undefined {
    const mentionMatch = userMessage.match(/@([\p{L}\p{N}_-]+)/u);
    if (!mentionMatch) return undefined;
    const name = mentionMatch[1];

    // 直接当 id 查
    if (VirtualEmployeeRegistry.getCtor(name)) return name;

    // 否则按 displayName 模糊匹配
    for (const config of VirtualEmployeeRegistry.list()) {
      if (config.displayName.includes(name)) {
        return config.id;
      }
    }
    return undefined;
  }
}
```

**测试**(`__tests__/virtual-employee-resolver.test.ts`):

```typescript
describe('VirtualEmployeeResolver', () => {
  beforeEach(() => VirtualEmployeeRegistry._reset());

  test('hintedId 命中 → 直接返回该员工实例', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    const emp = new VirtualEmployeeResolver().resolve({
      hintedId: 'a',
      userMessage: '随便',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('a');
  });

  test('@IT小海 → 命中 displayName', () => {
    class ITConsultant extends VirtualEmployee {
      readonly config = { id: 'it-ops-consultant', displayName: 'IT 运维顾问·小海', intentKeywords: [] };
    }
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any);
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '@IT小海 我的 OA 登录不上',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('it-ops-consultant');
  });

  test('@ 提到不存在的员工 → 抛 UNKNOWN_EMPLOYEE', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(() => new VirtualEmployeeResolver().resolve({
      userMessage: '@ghost 帮我',
      skillRegistry: null, llm: null,
    })).toThrow(/UNKNOWN_EMPLOYEE/);
  });

  test('无 @ + 意图关键词命中 → 派给对应员工', () => {
    class ITConsultant extends VirtualEmployee {
      readonly config = { id: 'it', displayName: 'IT 小海', intentKeywords: ['OA', 'VPN'] };
    }
    VirtualEmployeeRegistry.register('it', ITConsultant as any);
    VirtualEmployeeRegistry.register('a', EmployeeA as any, { isDefault: true });
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '我的 OA 登录不上了',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('it');
  });

  test('无 @ + 没命中意图 → 走默认员工', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any, { isDefault: true });
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '随便问点什么',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('a');
  });

  test('没注册默认 + 没命中意图 → 抛 NO_DEFAULT_EMPLOYEE', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(() => new VirtualEmployeeResolver().resolve({
      userMessage: '随便',
      skillRegistry: null, llm: null,
    })).toThrow(/NO_DEFAULT_EMPLOYEE/);
  });
});
```

**Step 4.1 — 写 resolver + 测试 → 跑测试 → commit**

```bash
git add src/agents/virtual-employee/resolver.ts __tests__/virtual-employee-resolver.test.ts
git commit -m "feat(agent): VirtualEmployeeResolver 二级 fallback 路由"
```

---

### Task 5: 示例虚拟员工 — IT 运维顾问·小海

**Files**:
- Create: `src/agents/virtual-employee/employees/it-operations-consultant.ts`
- Test: `__tests__/virtual-employee-it-ops-consultant.test.ts`

**关键决策**:
- **persona**: 自我介绍 + 职责 + 风格 + 边界
- **skill 白名单**: 当前 `skills/` 目录下的 skill 名称(取自现有 registry,具体名字以当前代码为准,下面用占位符)
- **result 改写器**: 在 result 末尾追加"您还可以尝试... / 转人工"提示
- **intentKeywords**: 覆盖 IT 类问题的高频关键词

```typescript
// src/agents/virtual-employee/employees/it-operations-consultant.ts

import type { EmployeeConfig, ResultRewriter } from '../types';
import { VirtualEmployee } from '../base';

export class ITOperationsConsultantEmployee extends VirtualEmployee {
  readonly config: EmployeeConfig = {
    id: 'it-ops-consultant',
    displayName: 'IT 运维顾问·小海',
    intentKeywords: [
      'OA', 'VPN', '密码', '重装', '网络', '打印机', '工单', '门禁', '电脑', '系统报错', '登录不上', '白屏',
    ],
  };

  protected systemPromptPrefix(): string {
    return `你是「${this.config.displayName}」,集团 IT 服务台的虚拟员工。

【职责】接听集团员工 IT 类问题:系统报错 / 桌面运维(电脑重装、硬件故障)/ 网络连接 / 设备报修 / 工单查询 / 门禁权限申请。

【风格】耐心、专业、礼貌。先安抚用户情绪,再引导排查。每一步都说清楚"我接下来要做什么"和"请您提供什么信息"。

【边界】以下问题请礼貌告知并建议转接:
- 人事/HR 问题(考勤、薪资、社保、招聘)→ "这块建议联系 HR 同事,我帮您转过去"
- 财务问题(报销、付款、发票)→ "财务问题请联系财务同事"
- 销售/产品问题 → "这块建议联系对应的销售/产品同事"
- 任何超出 IT 范围的请求都不要假装能解决`;
  }

  protected allowedSkillNames(): Set<string> | null {
    // 当前 skills/ 目录下的真实 skill 名以实际为准,这里按设计给出占位集合
    return new Set([
      'oa-ticket-query',
      'vpn-reset',
      'password-reset',
      'network-diagnostics',
      'asset-repair-request',
      'access-request',
      // 后续可加: 'knowledge-search', 'conversation-get' 等只读类工具
    ]);
  }

  protected resultRewriter(): ResultRewriter {
    return (rawResult: string) => {
      // 在 result 末尾追加"转人工 / 反馈"提示(虚拟员工专属)
      const trailing = '\n\n---\n如果您尝试后仍未解决,请回复「转人工」,我会把您转给值班工程师;也可以回复「评价」给我本次服务打个分。';
      return rawResult + trailing;
    };
  }
}
```

**测试**(`__tests__/virtual-employee-it-ops-consultant.test.ts`):

```typescript
describe('ITOperationsConsultantEmployee', () => {
  test('config.id 和 displayName 正确', () => {
    const emp = new ITOperationsConsultantEmployee(new SkillRegistry(), new StubLLM() as any);
    expect(emp.config.id).toBe('it-ops-consultant');
    expect(emp.config.displayName).toContain('IT 运维顾问');
  });

  test('persona 包含职责 + 边界 + 风格', () => {
    const emp = new ITOperationsConsultantEmployee(new SkillRegistry(), new StubLLM() as any);
    const prefix = (emp as any).systemPromptPrefix();
    expect(prefix).toContain('职责');
    expect(prefix).toContain('边界');
    expect(prefix).toContain('风格');
    expect(prefix).toContain('人事');  // 边界示例
  });

  test('allowedSkillNames 不为空且包含至少一个 IT 类 skill', () => {
    const emp = new ITOperationsConsultantEmployee(new SkillRegistry(), new StubLLM() as any);
    const allowed = (emp as any).allowedSkillNames();
    expect(allowed).toBeInstanceOf(Set);
    expect(allowed.size).toBeGreaterThan(0);
    expect(allowed.has('oa-ticket-query')).toBe(true);
  });

  test('resultRewriter 实际产出 = raw + trailing', () => {
    const emp = new ITOperationsConsultantEmployee(new SkillRegistry(), new StubLLM() as any);
    const rewriter = (emp as any).resultRewriter();
    const result = rewriter('这是解决方案');
    expect(result).toContain('这是解决方案');
    expect(result).toContain('转人工');
  });

  test('intentKeywords 覆盖 IT 高频关键词', () => {
    const emp = new ITOperationsConsultantEmployee(new SkillRegistry(), new StubLLM() as any);
    expect(emp.config.intentKeywords).toContain('OA');
    expect(emp.config.intentKeywords).toContain('VPN');
  });
});
```

**Step 5.1 — 写示例员工 + 测试 → 跑测试 → commit**

```bash
git add src/agents/virtual-employee/employees/it-operations-consultant.ts __tests__/virtual-employee-it-ops-consultant.test.ts
git commit -m "feat(agent): 示例虚拟员工 — IT 运维顾问·小海"
```

---

### Task 6: MainAgent 接入 + API 入口

**Files**:
- Modify: `src/agents/main-agent.ts` — `processRequirement` 入口加 resolver 调用
- Modify: `src/api/index.ts` — `SubmitTaskRequest` 类型加 `employeeId?: string` 字段
- Modify: `src/types/index.ts` — `SubmitTaskRequest` interface 加 `employeeId?: string`(保持和 `api/index.ts` 一致)
- Modify: `src/index.ts` — 启动时注册示例虚拟员工
- Test: `__tests__/main-agent-employee-routing.test.ts`

**关键决策**:
- **MainAgent 入口改法**: 在 `processRequirement` 接收 `employeeId?` 参数(从上游 HTTP body 透传),通过 `VirtualEmployeeResolver` 拿到 employee 实例。**不**修改现有 TaskGraphExecutor / TaskQueue 路径 — 它们继续接收 `Task`,但每个 Task 都会带上 employee 实例信息(可选)
- **向后兼容**: 现有 HTTP 请求不带 `employeeId` 时,resolver 自动走"意图识别 → 默认员工"路径,前端无感
- **失败转移**: 选不到任何员工时(`BusinessError(NO_DEFAULT_EMPLOYEE)`),return transferToHuman 而不是崩
- **TaskGraphExecutor 行为**: 维持现状 — Task 里只放 `skillName` / `requirement` / `params`,employee 实例信息在 SubAgent 内已经天然持有(因为 SubAgent = employee 实例)

```typescript
// src/agents/main-agent.ts 关键 diff

export class MainAgent {
  // ... 现有字段

  async processRequirement(task: Task, opts?: { employeeId?: string }): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('MainAgent');

    try {
      // ===== Task 6: 选虚拟员工 =====
      const resolver = new VirtualEmployeeResolver();
      let employee: VirtualEmployee;
      try {
        employee = resolver.resolve({
          hintedId: opts?.employeeId,
          userMessage: task.requirement ?? '',
          skillRegistry: this.skillRegistry,
          llm: this.llm,
          memoryService: this.memoryService,
        });
      } catch (err) {
        if (err instanceof BusinessError && (err.code === 'UNKNOWN_EMPLOYEE' || err.code === 'NO_DEFAULT_EMPLOYEE')) {
          MainAgent.log.warn('虚拟员工路由失败 → 转人工', { error: err.message });
          return {
            success: true,
            data: {
              response: '抱歉,目前没有可用的服务人员,已为您转接人工客服。',
              status: 'transferToHuman',
              transferReason: err.code,
            },
          };
        }
        throw err;
      }

      MainAgent.log.info('已选虚拟员工', { employeeId: employee.config.id, taskId: task.id });

      // ===== 把 SubAgent 替换成 employee 实例 =====
      // 后续 TaskQueue / TaskGraphExecutor 应该用 employee 而不是 this.subAgent
      // (本任务范围内:把 this.subAgent 临时换成 employee,后续再彻底替换)
      const originalSubAgent = this.subAgent;
      (this as any).subAgent = employee;
      try {
        // ===== 现有 processRequirement 逻辑 =====
        const result = await this.processRequirementInner(task);
        return result;
      } finally {
        (this as any).subAgent = originalSubAgent;
      }
    } finally {
      llmEvents.setAgent(previousAgent);
    }
  }

  // 把现有 processRequirement 拆成 _processRequirementInner(沿用 Task 8 命名)
  private async processRequirementInner(task: Task): Promise<TaskResult> {
    // ... 现有所有逻辑不变
  }
}
```

```typescript
// src/types/index.ts 改动

export interface SubmitTaskRequest {
  userId: string;
  sessionId: string;
  requirement: string;
  /** 虚拟员工 ID(可选)。不填则走意图识别 + 默认员工 fallback */
  employeeId?: string;
  // ... 现有其他字段
}
```

```typescript
// src/api/index.ts 关键 diff(从 body 透传 employeeId)

app.post('/tasks/stream',
  async (req, res, next) => {
    req.profile = await userProfileService.loadProfile(req.body.userId);
    next();
  },
  guardrailMiddleware(),
  async (req, res) => {
    const employeeId = (req.body as any).employeeId as string | undefined;
    const result = await mainAgent.processRequirement(task, { employeeId });
    // ... 现有 SSE 推送逻辑
  }
);
```

```typescript
// src/index.ts 启动时注册(只注册示例员工)

import { VirtualEmployeeRegistry } from './agents/virtual-employee/registry';
import { ITOperationsConsultantEmployee } from './agents/virtual-employee/employees/it-operations-consultant';

// 启动时注册(IT 运维顾问作为示例 + 默认员工)
VirtualEmployeeRegistry.register(
  'it-ops-consultant',
  ITOperationsConsultantEmployee as any,
  { isDefault: true },
);
```

**端到端测试**(`__tests__/main-agent-employee-routing.test.ts`):

```typescript
describe('MainAgent 虚拟员工路由', () => {
  beforeEach(() => VirtualEmployeeRegistry._reset());

  test('请求带 employeeId → 选对应员工', async () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    // ... mock mainAgent 调用 resolver
    const result = await mainAgent.processRequirement(task, { employeeId: 'a' });
    expect(result.success).toBe(true);
  });

  test('请求不带 employeeId + 意图命中 → 自动选 IT 员工', async () => {
    class ITConsultant extends VirtualEmployee {
      readonly config = { id: 'it', displayName: 'IT', intentKeywords: ['OA'] };
    }
    VirtualEmployeeRegistry.register('it', ITConsultant as any, { isDefault: true });
    // ... mock task.requirement = '我的 OA 登录不上'
    // 验证走的 ITConsultant 实例
  });

  test('employeeId 不存在 → 返回 transferToHuman', async () => {
    // ... mock 返回 { status: 'transferToHuman', transferReason: 'UNKNOWN_EMPLOYEE' }
  });
});
```

**Step 6.1 — 修改 MainAgent / types / api / index + 写测试 → 跑测试 → commit**

```bash
git add src/agents/main-agent.ts src/types/index.ts src/api/index.ts src/index.ts __tests__/main-agent-employee-routing.test.ts
git commit -m "feat(agent): MainAgent 接入虚拟员工路由 + API 入口"
```

---

### Task 7: 回归 + 类型检查 + 文档

**Files**:
- Modify: `API.md` — 在 "Submit Task" 段落加 `employeeId` 字段说明
- Modify: `README.md` 或新建 `docs/virtual-employee.md` — 简要介绍虚拟员工概念(选其一,YAGNI 优先 README)

**Step 7.1 — 跑全量回归**

```bash
bun test
npx tsc --noEmit
```

Expected:
- 全量测试通过(已有 9 个 pre-existing fail 跟本次无关,本次零回归)
- `tsc --noEmit` 0 errors

**Step 7.2 — 更新 API.md**

在 `SubmitTaskRequest` 章节加:

```markdown
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ... | ... | ... | ... |
| employeeId | string | 否 | 虚拟员工 ID。不填则走意图识别 + 默认员工 fallback。示例: `'it-ops-consultant'` |
```

**Step 7.3 — Commit 文档**

```bash
git add API.md
git commit -m "docs: virtual employee — API.md 加 employeeId 字段说明"
```

---

## 关键决策总结(防回顾偏差)

| 决策 | 选择 | 否决方案 |
|------|------|----------|
| 与 SubAgent 关系 | **template method + 3 个 protected hook** | 配置对象 + 装饰器(方案 A) |
| 路由策略 | **@ 显式 → 意图识别 → 默认** | 只做默认 / 只做 @ / 按部门路由 |
| 业务属性最小集 | **persona + skill 白名单 + result 改写** | + 数据权限范围 / + 升级路径(后续) |
| persona 拼接位置 | **拼到 `skill.body` 前面(2 处:首次执行 + 断点续)** | 独立 system message / 后置改写 |
| skill 白名单校验时机 | **`execute()` 入口 template method 校验** | 在 `executeSkill` 内部 / 延后到 LLM 输出后 |
| result 改写时机 | **SubAgent return 前** | LLM 调用前 / 改 SubAgent 内部 messages |
| 注册表设计 | **静态 Map + 构造函数引用 + isDefault 标记** | 实例缓存 / DI 容器 / 配置中心 |
| Resolver 构造时机 | **每次 `resolve()` 才 new 实例** | registry 持单例 |
| 路由失败处理 | **BusinessError → MainAgent catch → 返回 transferToHuman** | 抛错崩服务 / 静默走 SubAgent 现状 |
| 覆盖范围 | **1 个示例(「IT 运维顾问·小海」)** | 12 个一次性 / 3 个示例 |
| employeeId 在 body | **`SubmitTaskRequest.employeeId?: string` 可选** | 必填 / URL 参数 / Header |
| 测试框架 | **沿用 `bun:test`** | jest / vitest |
| 新依赖 | **零** | OTel / class-validator(都不需要) |

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| SubAgent template method 重构破坏现有 700+ 行逻辑 | Task 2 步骤强制要求"默认 SubAgent 行为不变" + 跑 `sub-agent.test.ts` 回归 |
| VirtualEmployee new 实例每次都新建,LLM 客户端重复创建 | registry 持 ctor,caller 注入外部共享的 llm / skillRegistry(单例) |
| intentKeywords 命中冲突(两个员工都匹配) | 按注册顺序取第一个;后续可加"权重"或"负向关键词" |
| @IT小海 用了简写但 config.displayName 是"IT 运维顾问·小海" | resolver 的 `extractMention` 先按 id 查 → 失败按 displayName substring 匹配 |
| MainAgent 入口改造可能影响其他路径(steer / checkpoint) | Task 6 用 `try/finally` 恢复 `this.subAgent`,只覆盖 `processRequirement` 单次调用 |
| 虚拟员工的 system prompt prefix 改变 LLM 行为 → 现有 skill 测试失败 | Task 2 测试断言"默认 prefix = ''" + Task 6 回归测试覆盖 `main-agent.test.ts` |
| Skill 真实名称 vs 设计占位不符 | Task 5 用占位 skill 名,实施时以 `skills/` 目录下真实名为准;允许后期增删 |

---

## 验收方法

1. **单元测试**: `bun test __tests__/virtual-employee-*.test.ts` 全部通过
2. **回归测试**: `bun test __tests__/sub-agent*.test.ts __tests__/main-agent*.test.ts __tests__/api*.test.ts` 全部通过(零回归)
3. **类型检查**: `npx tsc --noEmit` 0 errors
4. **运行时手动验证**:
   - 启 dev server,打开 `public/test.html`
   - 发送 `我的 OA 登录不上`(不带 @)→ 自动派给「IT 运维顾问·小海」
   - 发送 `@IT小海 帮我查工单` → 显式派给小海
   - 发送 `帮我看看考勤`(不在 IT 关键词里) → 走默认员工,提示"边界外,请联系 HR"
   - 发送 `@ghost 帮我` → 返回 transferToHuman
   - 查看响应:result 末尾追加了 "转人工" 提示

---

## 与未来工作的衔接

后续要做的事(本次不做,留接口):

1. **更多虚拟员工**: HR 助理、财务助手、销售支持、设计助理… 各自实现 `VirtualEmployee` 子类 + 注册
2. **数据权限范围**: 在 `VirtualEmployee` 基类加 `dataPermissionScope(): { systems: string[]; actions: string[] }` hook,SubAgent 在 tool 调用时校验
3. **升级路径**: 加 `escalationRoute(): { onUncertain: 'human' | 'specialist'; specialistId?: string }` hook,SubAgent 在 confidence < 阈值时触发
4. **专属模型**: 改造 SubAgent 构造签名,允许 employee 注入自己的 LLM 客户端(用于不同员工用不同模型)
5. **配置中心**: 把 `VirtualEmployee` 配置从代码里抽到 JSON / 数据库,支持后台动态注册
6. **前端 @ 提示**: 在 chat 输入框加员工下拉菜单 + 自动补全,基于 `VirtualEmployeeRegistry.list()`

---

## Spec 自检

**1. Placeholder scan**: ✅ 无 TBD / TODO;Task 5 中 `oa-ticket-query` 等 skill 名标注"以实际为准",实施时以 `skills/` 目录为准。

**2. Internal consistency**: ✅ Task 2 改 SubAgent + Task 6 用 employee 实例替代 SubAgent,顺序合理;Task 6 MainAgent 改造依赖 Task 1-5 全部完成。

**3. Scope check**: ✅ 单 plan 可完成 — 7 个 task,总 ~700 行代码 + ~600 行测试,在一个 sprint 内可完成。

**4. Ambiguity check**:
- ✅ "allowedSkillNames 返回 null"含义明确(等于现状,放行所有)
- ✅ "result 改写器在 return 前"位置明确(在 execute() 主路径 return 前)
- ✅ "未命中意图 + 没默认员工"行为明确(BusinessError → transferToHuman)
- ✅ "@提及解析规则"明确(先 id 查 → 后 displayName substring 匹配)
- ⚠️ Task 5 中示例虚拟员工的 `intentKeywords` 和 `allowedSkillNames` 用占位,实施时需要根据 `skills/` 实际目录调整 — 已在 Task 5 Step 5.1 备注中说明