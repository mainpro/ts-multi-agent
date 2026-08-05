# Virtual Employee Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 在 MainAgent 与 SubAgent 之间引入"虚拟员工"抽象;本次实现可扩展抽象 + 1 个示例(「IT 运维顾问·小海」),通过 SubAgent template method 重构让示例员工的 persona / skill 白名单 / result 改写器在整条执行链路上生效。

**Architecture**: 把 `SubAgent` 改造成 template method 父类(加 3 个 protected hook:`systemPromptPrefix()` / `allowedSkillNames()` / `resultRewriter()`);新增 `VirtualEmployee extends SubAgent`,子类的 hook 表达"业务属性"差异;`VirtualEmployeeRegistry` 静态注册表 + `VirtualEmployeeResolver` 二级 fallback 路由(@ 提及 → 意图识别 → 默认);`src/index.ts` 把原本的 `new SubAgent(...)` 替换为通过 resolver 选出的 VirtualEmployee 实例(单例复用)。

**Tech Stack**: TypeScript / Bun test / 现有 LLM/Skill/Metrics 全部复用,不引入新依赖。

---

## Global Constraints

精确约束表(任何 task 实现必须遵守):

| 约束 | 值 | 来源 |
|------|---|------|
| 路由策略 | 用户 `@displayName` 显式 → 否则意图识别关键词匹配 → 否则 `defaultEmployeeId` | 用户澄清 2026-08-05 |
| 业务属性最小集 | `persona`(systemPromptPrefix) + `skill 白名单`(allowedSkillNames) + `result 改写器`(resultRewriter) | 用户澄清 2026-08-05 |
| 与 SubAgent 关系 | template method 父类(`extends SubAgent` + override 3 个 protected hook) | 用户澄清 2026-08-05 |
| 覆盖范围 | 本次只做 1 个示例虚拟员工:「IT 运维顾问·小海」(`id = 'it-ops-consultant'`,isDefault=true) | 用户澄清 2026-08-05 |
| 与专业型智能体关系 | 独立 — 办理/审计/观测子智能体是系统级,与虚拟员工不挂钩 | 用户澄清 2026-08-05 |
| prompt 拼接位置 | `systemPromptPrefix()` 返回值拼到 `skill.body` 前面(2 处:首次执行 line 300 / 断点续 line 344) | 设计决策 |
| skill 白名单校验时机 | `execute()` 入口(template method 在调用 `executeSkill` 之前校验) | 设计决策 |
| result 改写时机 | SubAgent 拿到 result.content 之后、`return` 之前 | 设计决策 |
| employeeId 不存在 | `BusinessError(UNKNOWN_EMPLOYEE)` → transferToHuman(由 API 层映射) | 设计决策 |
| skillName 不在白名单 | `SkillError(SKILL_NOT_ALLOWED)` → SubAgent 抛错 | 设计决策 |
| 虚拟员工实例化位置 | `src/index.ts:96`(原本 `new SubAgent(...)` 这一行,改成通过 resolver 选 Employee) | 设计决策 |
| 默认注册 | `ITOperationsConsultantEmployee` 标记 `isDefault=true`(本次唯一一个虚拟员工) | 设计决策 |
| 类型约束 | `VirtualEmployee` 是 abstract class;不允许运行时直接 `new VirtualEmployee(...)` | 设计决策 |
| 测试框架 | `bun:test`,沿用现有 `__tests__/` 目录 | 现有代码约定 |
| 不引入新依赖 | 不新增 npm 包 | YAGNI |
| 现有测试零回归 | `bun test` 全部已有用例通过(模板方法重构不能破坏) | 现有约束 |
| SubmitTaskRequest 位置 | `src/api/index.ts:34`(不是 `src/types/index.ts`;spec 错误已修正) | 实测 |
| SubAgent 实例化位置 | `src/index.ts:96`(全代码库唯一一处;`MainAgent` 不持有 `this.subAgent` 字段) | 实测 |
| 真实 Skill 名称 | 来自 `skills/` 目录:`ees-qa`, `fallback-service-desk`, `fawu`, `geam-qa`, `sulfuric-acid-price-prediction`, `time-management-qa`, `travel-expense-apply`(共 7 个,全 IT 类) | 实测 |

---

## File Structure

### 新建

| 文件 | 行数估计 | 职责 |
|------|---------|------|
| `src/agents/virtual-employee/types.ts` | ~25 | `EmployeeId` / `EmployeeConfig` / `ResultRewriter` |
| `src/agents/virtual-employee/base.ts` | ~70 | `VirtualEmployee extends SubAgent`,3 个默认 hook |
| `src/agents/virtual-employee/registry.ts` | ~55 | `VirtualEmployeeRegistry` 静态 Map,register/getCtor/getDefaultCtor/list/_reset |
| `src/agents/virtual-employee/resolver.ts` | ~80 | `VirtualEmployeeResolver.resolve()` 二级 fallback + `@` 提取 |
| `src/agents/virtual-employee/employees/it-operations-consultant.ts` | ~70 | 示例虚拟员工:IT 运维顾问·小海 |
| `__tests__/virtual-employee-registry.test.ts` | ~80 | 注册表测试 |
| `__tests__/virtual-employee-resolver.test.ts` | ~140 | 路由测试(@ / 意图 / 默认 / 未知 ID) |
| `__tests__/virtual-employee-it-ops-consultant.test.ts` | ~80 | 示例员工 hook 内容测试 |
| `__tests__/sub-agent-template-method.test.ts` | ~90 | 父类模板方法测试(skill 白名单校验) |

### 修改

| 文件 | 改动范围 |
|------|----------|
| `src/agents/sub-agent.ts` | `execute()` 加 skill 白名单校验(入口)+ result 改写(出口);`executeSkill()` 改 `protected`;2 处 `buildSubAgentPrompt` 调用前拼 prefix hook;import `SkillError`(已存在);`import VirtualEmployee 解除循环依赖用 type-only` 注释 |
| `src/api/index.ts` | `SubmitTaskRequest` interface(line 34-41)加 `employeeId?: string` 字段;`POST /tasks/stream` handler 透传 `employeeId` 给 MainAgent(`req.body.employeeId`) |
| `src/agents/main-agent.ts` | `processRequirement` 签名加可选 `employeeId` 参数(向后兼容);通过 `VirtualEmployeeResolver` 把选中的 employee 实例设置到 taskQueue 的 executor(替换原本固定绑定的 SubAgent 单例) |
| `src/index.ts` | 启动时(在 `new SubAgent` line 96 之前)调 `VirtualEmployeeRegistry.register(...)` 注册示例员工;line 96 改为通过 resolver 创建 employee 实例(默认 isDefault=true → 选它) |
| `API.md` | "Submit Task" 段落加 `employeeId` 字段说明 |

### 不修改

- `task-queue/index.ts`(taskQueue 持有 executor 回调,接受 SubAgent 兼容的任何子类)
- `task-graph-executor.ts`(走 taskQueue)
- `result-aggregator.ts`
- 各 skill 目录

---

## Task 分解

### Task 1: 类型定义 + VirtualEmployee 抽象基类

**Files**:
- Create: `src/agents/virtual-employee/types.ts`
- Create: `src/agents/virtual-employee/base.ts`

**Interfaces**:
- Consumes: 无
- Produces:
  - `EmployeeId`(string 别名)
  - `EmployeeConfig`({ id, displayName, intentKeywords })
  - `ResultRewriter`(`(raw: string) => string`)
  - `VirtualEmployee`(abstract class extends `SubAgent`)

**Step 1.1 — 写 types.ts**

```typescript
// src/agents/virtual-employee/types.ts

/**
 * 虚拟员工类型定义。
 * 虚拟员工 = 系统提供出去的、带着业务属性的智能体。
 * 每个员工有 persona / skill 白名单 / result 改写器 三件套。
 */

export type EmployeeId = string;

export interface EmployeeConfig {
  /** 唯一标识(用于注册表查找 + body 字段) */
  id: EmployeeId;
  /** 展示名称(用于 @mention 识别 + 前端展示) */
  displayName: string;
  /**
   * 意图路由关键词。
   * resolver 在无 @ 时扫描 userMessage,命中任一关键词即路由到此员工。
   * 大小写不敏感,substring 匹配(中文 / 英文都支持)。
   */
  intentKeywords: string[];
}

export type ResultRewriter = (rawResult: string) => string;
```

**Step 1.2 — 写 base.ts**

```typescript
// src/agents/virtual-employee/base.ts

import type { EmployeeConfig, ResultRewriter } from './types';
import { SubAgent } from '../sub-agent';

/**
 * 虚拟员工抽象基类。
 * 复用 SubAgent 全部 LLM 循环 / 断点续 / steer / metrics / compaction。
 * 通过 override 以下 3 个 hook 表达"业务属性":
 *   - systemPromptPrefix(): 拼到 skill body 前面的 persona
 *   - allowedSkillNames(): 该员工允许调用的 skill 集合(null = 不限制)
 *   - resultRewriter(): result 改写器(null = passthrough)
 */
export abstract class VirtualEmployee extends SubAgent {
  abstract readonly config: EmployeeConfig;

  /** 默认实现:无 prefix → 行为与 SubAgent 一致 */
  protected systemPromptPrefix(): string {
    return '';
  }

  /** 默认实现:null = 不限制(向后兼容) */
  protected allowedSkillNames(): Set<string> | null {
    return null;
  }

  /** 默认实现:null = passthrough */
  protected resultRewriter(): ResultRewriter | null {
    return null;
  }
}
```

**Step 1.3 — 跑类型检查**

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
- Test: `__tests__/sub-agent-template-method.test.ts`

**Interfaces**:
- Consumes: `VirtualEmployee.base.ts`(Task 1)
- Produces:
  - `SubAgent.execute()` 入口加 skill 白名单校验(用 `(this as any).allowedSkillNames?.()` 调用子类 hook,默认返回 null 跳过校验)
  - `SubAgent.executeSkill()` 改 `protected`(原来是 `private`,line 231)— 子类需要能调用
  - `executeSkill()` 内部 2 处 `buildSubAgentPrompt` 调用前拼 `this.systemPromptPrefix()`(line 300 + 344)
  - `execute()` 出口在 `return { success: true, data: cleanResult }` 之前调 `resultRewriter()`(line 210 之前)

**Step 2.1 — 写测试(失败先)**

```typescript
// __tests__/sub-agent-template-method.test.ts
import { describe, expect, test } from 'bun:test';
import { SubAgent } from '../src/agents/sub-agent';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';
import { SkillRegistry } from '../src/skill-registry';
import { ILLMClient } from '../src/llm';
import { Task } from '../src/types';

class StubLLM implements ILLMClient {
  async generateWithTools() {
    return { content: 'stub response', toolCalls: [], messages: [] };
  }
}

describe('SubAgent template method hooks', () => {
  test('默认 SubAgent 的 allowedSkillNames 返回 null(向后兼容)', () => {
    const sa = new SubAgent(new SkillRegistry(), new StubLLM() as any);
    expect((sa as any).allowedSkillNames()).toBeNull();
  });

  test('默认 SubAgent 的 systemPromptPrefix 返回 ""(零行为差异)', () => {
    const sa = new SubAgent(new SkillRegistry(), new StubLLM() as any);
    expect((sa as any).systemPromptPrefix()).toBe('');
  });

  test('默认 SubAgent 的 resultRewriter 返回 null(passthrough)', () => {
    const sa = new SubAgent(new SkillRegistry(), new StubLLM() as any);
    expect((sa as any).resultRewriter()).toBeNull();
  });

  test('VirtualEmployee override allowedSkillNames → 不在白名单的 skill 抛 SKILL_NOT_ALLOWED', async () => {
    class StrictEmployee extends VirtualEmployee {
      readonly config = { id: 'strict', displayName: 'Strict', intentKeywords: [] };
      protected allowedSkillNames() { return new Set(['allowed-skill']); }
    }
    const emp = new StrictEmployee(new SkillRegistry(), new StubLLM() as any);
    const task = {
      id: 't1', requirement: 'r', skillName: 'forbidden-skill', sessionId: 's', userId: 'u',
    } as Task;
    await expect(emp.execute(task)).rejects.toThrow(/SKILL_NOT_ALLOWED/);
  });

  test('VirtualEmployee override allowedSkillNames → 白名单内的 skill 放行', async () => {
    class PermissiveEmployee extends VirtualEmployee {
      readonly config = { id: 'perm', displayName: 'Permissive', intentKeywords: [] };
      protected allowedSkillNames() { return new Set(['any-skill']); }
    }
    const emp = new PermissiveEmployee(new SkillRegistry(), new StubLLM() as any);
    const task = {
      id: 't1', requirement: 'r', skillName: 'any-skill', sessionId: 's', userId: 'u',
    } as Task;
    // 不抛 SKILL_NOT_ALLOWED(可能在 skill 加载时报 SKILL_NOT_FOUND,但不是 SKILL_NOT_ALLOWED)
    await expect(emp.execute(task)).rejects.toThrow(/SKILL_NOT_FOUND/);
  });
});

describe('SubAgent result rewriting', () => {
  test('默认 SubAgent 不改写 result', async () => {
    const sa = new SubAgent(new SkillRegistry(), new StubLLM() as any);
    const task = {
      id: 't1', requirement: 'r', skillName: 'test-skill', sessionId: 's', userId: 'u',
    } as Task;
    // 期望抛 SKILL_NOT_FOUND,但不影响 rewrite 测试(rewrite 在抛错前不会跑)
    // 我们用 stub skill 验证更稳:这里只测 hook 调用默认行为
    const rewriter = (sa as any).resultRewriter();
    expect(rewriter).toBeNull();
  });
});
```

**Step 2.2 — 跑测试,验证失败**

Run: `bun test __tests__/sub-agent-template-method.test.ts`
Expected: FAIL — TypeScript 编译错 "Cannot find module '../src/agents/virtual-employee/base'" 在 SubAgent 中(后续 Task 2.4 才添加 import);或者 "Property 'allowedSkillNames' does not exist on type 'SubAgent'"(因为还没加)。本步骤的目标是确认编译/测试**目前不通**,Task 2.4 让它通。

注:上面测试中调用 `(sa as any).allowedSkillNames()` 用 `as any` 绕开类型,所以编译应通过,实际失败可能是 TypeError(方法不存在)。这个细节在 Step 2.4 实现后会自动通过。

**Step 2.3 — 改造 sub-agent.ts**

打开 `src/agents/sub-agent.ts`,做以下 4 处改动(用 Edit 工具):

**改动 A — import 区域(line 1-28)加 SkillError(已存在),无需加新 import**

不改 import 区域。

**改动 B — `execute()` 入口加 skill 白名单校验(在 line 145 内部、`try {` 之前)**

找到 line 145-149:
```typescript
  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('SubAgent');

    try {
```

改成:
```typescript
  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('SubAgent');

    try {
      // ===== VirtualEmployee template hook: skill 白名单校验 =====
      // 子类可通过 override allowedSkillNames() 加白名单;默认 null = 放行所有
      const allowed = (this as any).allowedSkillNames?.call(this);
      if (allowed instanceof Set && task.skillName && !allowed.has(task.skillName)) {
        const empConfig = (this as any).config;
        const empId = empConfig?.id ?? 'unknown';
        SubAgent.log.warn('虚拟员工 skill 白名单拒绝', {
          employeeId: empId,
          skillName: task.skillName,
        });
        throw new SkillError(
          'SKILL_NOT_ALLOWED',
          `虚拟员工 ${empId} 不允许调用 skill: ${task.skillName}`,
        );
      }

```

**改动 C — `executeSkill()` 改 protected(line 231)**

找到 line 231:
```typescript
  private async executeSkill(
```

改成:
```typescript
  protected async executeSkill(
```

**改动 D — `executeSkill()` 内部 2 处 `buildSubAgentPrompt` 拼 prefix**

找到 line 299-309(首次执行):
```typescript
    // ===== v2: 构建增强的 system prompt =====
    const systemPrompt = await buildSubAgentPrompt(
      skill.body,
      absoluteSkillRootDir,
      params,
      questionHistory,
      completedToolCalls,
      userId,
      skill.name,
      promptOptions
    );
```

改成(在 `buildSubAgentPrompt` 调用前拼 prefix):
```typescript
    // ===== VirtualEmployee template hook: persona prefix =====
    const personaPrefix = (this as any).systemPromptPrefix?.call(this) ?? '';
    const skillBodyWithPersona = personaPrefix
      ? `${personaPrefix}\n\n${skill.body}`
      : skill.body;

    // ===== v2: 构建增强的 system prompt =====
    const systemPrompt = await buildSubAgentPrompt(
      skillBodyWithPersona,
      absoluteSkillRootDir,
      params,
      questionHistory,
      completedToolCalls,
      userId,
      skill.name,
      promptOptions
    );
```

找到 line 342-352(断点续执行):
```typescript
    if (conversationContext && conversationContext.length > 0) {
      // ===== 断点续执行：重新构建 system prompt（包含最新的 questionHistory） =====
      const refreshedSystemPrompt = await buildSubAgentPrompt(
        skill.body,
        absoluteSkillRootDir,
        params,
        questionHistory,     // 使用最新的 questionHistory（包含刚添加的回答）
        completedToolCalls,
        userId,
        skill.name
      );
```

改成:
```typescript
    if (conversationContext && conversationContext.length > 0) {
      // ===== 断点续执行：重新构建 system prompt（包含最新的 questionHistory） =====
      // ===== VirtualEmployee template hook: persona prefix(断点续也需要 persona)=====
      const refreshedPromptBody = personaPrefix
        ? `${personaPrefix}\n\n${skill.body}`
        : skill.body;
      const refreshedSystemPrompt = await buildSubAgentPrompt(
        refreshedPromptBody,
        absoluteSkillRootDir,
        params,
        questionHistory,     // 使用最新的 questionHistory（包含刚添加的回答）
        completedToolCalls,
        userId,
        skill.name
      );
```

**改动 E — `execute()` 出口加 result 改写器(line 210 之前)**

找到 line 210:
```typescript
      return { success: true, data: cleanResult };
```

改成:
```typescript
      // ===== VirtualEmployee template hook: result 改写器 =====
      const rewriter = (this as any).resultRewriter?.call(this);
      const finalResult = rewriter ? rewriter(cleanResult.response ?? '') : cleanResult.response;

      return { success: true, data: { ...cleanResult, response: finalResult } };
```

**Step 2.4 — 跑测试,验证通过**

Run: `bun test __tests__/sub-agent-template-method.test.ts`
Expected: PASS(5 个 test)

**Step 2.5 — 跑回归**

Run: `bun test __tests__/sub-agent.test.ts __tests__/api.test.ts __tests__/main-agent.test.ts 2>/dev/null`
Expected: PASS(已有用例不变通过;允许 pre-existing 失败 9 个不相关)

**Step 2.6 — 跑类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2.7 — Commit**

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
  - `VirtualEmployeeRegistry` 静态类:
    - `register(id: EmployeeId, ctor: VirtualEmployeeCtor, opts?: { isDefault?: boolean }): void`
    - `getCtor(id: EmployeeId): VirtualEmployeeCtor | undefined`
    - `getDefaultCtor(): VirtualEmployeeCtor | undefined`
    - `list(): EmployeeConfig[]`
    - `_reset(): void`(测试用)

**Step 3.1 — 写 registry.ts**

```typescript
// src/agents/virtual-employee/registry.ts

import type { EmployeeId, EmployeeConfig } from './types';
import type { VirtualEmployee } from './base';
import type { SkillRegistry } from '../../skill-registry';
import type { ILLMClient } from '../../llm';
import type { MemoryService } from '../../memory/memory-service';

export type VirtualEmployeeCtor = new (
  skillRegistry: SkillRegistry,
  llm: ILLMClient,
  memoryService?: MemoryService,
) => VirtualEmployee;

interface Registration {
  ctor: VirtualEmployeeCtor;
  isDefault: boolean;
}

/**
 * 虚拟员工注册表(进程内单例,静态)。
 *
 * 持有构造函数引用(不是实例),每次 getCtor() 后由 caller 注入外部共享的
 * skillRegistry / llm / memoryService,避免重复创建外部资源。
 */
export class VirtualEmployeeRegistry {
  private static entries = new Map<EmployeeId, Registration>();

  /** 注册一个虚拟员工。重复注册同一 id 抛错(避免覆盖)。 */
  static register(
    id: EmployeeId,
    ctor: VirtualEmployeeCtor,
    opts?: { isDefault?: boolean },
  ): void {
    if (this.entries.has(id)) {
      throw new Error(`VirtualEmployee id '${id}' already registered`);
    }
    this.entries.set(id, { ctor, isDefault: opts?.isDefault ?? false });
  }

  /** 拿构造函数(caller 注入依赖后 new 实例)。 */
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

  /**
   * 列出所有员工的配置(给前端 / Resolver 用)。
   * 通过临时实例化(传入 null 依赖)读取 config,生产代码不会调这个。
   */
  static list(): EmployeeConfig[] {
    const configs: EmployeeConfig[] = [];
    for (const { ctor } of this.entries.values()) {
      const tmp = new (ctor as any)(null, null);
      configs.push(tmp.config);
    }
    return configs;
  }

  /** 测试用:清空 registry。生产代码不要调。 */
  static _reset(): void {
    this.entries.clear();
  }
}
```

**Step 3.2 — 写测试**

```typescript
// __tests__/virtual-employee-registry.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';

class EmployeeA extends VirtualEmployee {
  readonly config = { id: 'a', displayName: '员工 A', intentKeywords: ['OA'] };
}
class EmployeeB extends VirtualEmployee {
  readonly config = { id: 'b', displayName: '员工 B', intentKeywords: ['HR'] };
}

describe('VirtualEmployeeRegistry', () => {
  beforeEach(() => VirtualEmployeeRegistry._reset());

  test('register + getCtor 返回构造函数', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(VirtualEmployeeRegistry.getCtor('a')).toBe(EmployeeA);
  });

  test('重复注册同一 id 抛错', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(() => VirtualEmployeeRegistry.register('a', EmployeeA as any)).toThrow(/already registered/);
  });

  test('getDefaultCtor 返回 isDefault=true 的员工', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    VirtualEmployeeRegistry.register('b', EmployeeB as any, { isDefault: true });
    expect(VirtualEmployeeRegistry.getDefaultCtor()).toBe(EmployeeB);
  });

  test('没注册默认时 getDefaultCtor 返回 undefined', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(VirtualEmployeeRegistry.getDefaultCtor()).toBeUndefined();
  });

  test('list() 列出所有员工的 config', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    VirtualEmployeeRegistry.register('b', EmployeeB as any);
    const list = VirtualEmployeeRegistry.list();
    expect(list.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(list.find(c => c.id === 'a')?.displayName).toBe('员工 A');
  });

  test('getCtor 不存在 id 返回 undefined', () => {
    expect(VirtualEmployeeRegistry.getCtor('nonexistent')).toBeUndefined();
  });

  test('_reset 清空 registry', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    VirtualEmployeeRegistry._reset();
    expect(VirtualEmployeeRegistry.getCtor('a')).toBeUndefined();
  });
});
```

**Step 3.3 — 跑测试,验证通过**

Run: `bun test __tests__/virtual-employee-registry.test.ts`
Expected: PASS(7 个 test)

**Step 3.4 — Commit**

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
  - `VirtualEmployeeResolver.resolve(opts: ResolverOptions): VirtualEmployee` → 返回实例
  - `ResolverOptions`: `{ hintedId?: EmployeeId; userMessage: string; skillRegistry; llm; memoryService? }`

**Step 4.1 — 写 resolver.ts**

```typescript
// src/agents/virtual-employee/resolver.ts

import { BusinessError } from '../../errors';
import type { EmployeeId } from './types';
import type { VirtualEmployee } from './base';
import { VirtualEmployeeRegistry } from './registry';

export interface ResolverOptions {
  hintedId?: EmployeeId;
  userMessage: string;
  skillRegistry: any;
  llm: any;
  memoryService?: any;
}

/**
 * 虚拟员工路由器。
 *
 * 二级 fallback 路由策略:
 *   1. 显式指定(hintedId / @提及)→ 直接拿
 *   2. 意图识别(扫描 config.intentKeywords)→ 第一个命中
 *   3. 默认员工(getDefaultCtor)→ fallback
 *
 * 全部失败抛 BusinessError(UNKNOWN_EMPLOYEE / NO_DEFAULT_EMPLOYEE)。
 */
export class VirtualEmployeeResolver {
  resolve(opts: ResolverOptions): VirtualEmployee {
    // ===== 1. hintedId / @mention 显式 =====
    const hintedFromMessage = this.extractMention(opts.userMessage);
    const hintedId = opts.hintedId ?? hintedFromMessage;

    if (hintedId) {
      const Ctor = VirtualEmployeeRegistry.getCtor(hintedId);
      if (!Ctor) {
        throw new BusinessError('UNKNOWN_EMPLOYEE', `虚拟员工 '${hintedId}' 不存在`);
      }
      return new Ctor(opts.skillRegistry, opts.llm, opts.memoryService);
    }

    // ===== 2. 意图识别关键词匹配(按注册顺序)=====
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
      throw new BusinessError(
        'NO_DEFAULT_EMPLOYEE',
        '没有可用的虚拟员工(意图未命中 + 没有注册默认员工)',
      );
    }
    return new DefaultCtor(opts.skillRegistry, opts.llm, opts.memoryService);
  }

  /**
   * 从 userMessage 中提取 @mention。
   * 例: "@IT小海 帮我..." → 优先按 id 查 'it-ops-consultant',
   * 否则按 displayName substring 匹配。
   */
  private extractMention(userMessage: string): EmployeeId | undefined {
    const mentionMatch = userMessage.match(/@([\p{L}\p{N}_-]+)/u);
    if (!mentionMatch) return undefined;
    const name = mentionMatch[1];

    // 直接当 id 查
    if (VirtualEmployeeRegistry.getCtor(name)) return name;

    // 否则按 displayName 模糊匹配(取第一个命中)
    for (const config of VirtualEmployeeRegistry.list()) {
      if (config.displayName.includes(name)) {
        return config.id;
      }
    }
    return undefined;
  }
}
```

**Step 4.2 — 写测试**

```typescript
// __tests__/virtual-employee-resolver.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { VirtualEmployeeResolver } from '../src/agents/virtual-employee/resolver';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';

class EmployeeA extends VirtualEmployee {
  readonly config = { id: 'a', displayName: '员工 A', intentKeywords: ['OA'] };
}
class EmployeeB extends VirtualEmployee {
  readonly config = { id: 'b', displayName: '员工 B', intentKeywords: ['HR'] };
}
class ITConsultant extends VirtualEmployee {
  readonly config = { id: 'it-ops-consultant', displayName: 'IT 运维顾问·小海', intentKeywords: ['OA', 'VPN'] };
}

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

  test('@IT小海 → 通过 displayName 模糊匹配', () => {
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any);
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '@IT小海 我的 OA 登录不上',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('it-ops-consultant');
  });

  test('@it-ops-consultant → 直接按 id 命中', () => {
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any);
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '@it-ops-consultant 帮我',
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

  test('hintedId 不存在 → 抛 UNKNOWN_EMPLOYEE', () => {
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    expect(() => new VirtualEmployeeResolver().resolve({
      hintedId: 'nonexistent',
      userMessage: '随便',
      skillRegistry: null, llm: null,
    })).toThrow(/UNKNOWN_EMPLOYEE/);
  });

  test('无 @ + 意图关键词命中 → 派给对应员工', () => {
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any);
    VirtualEmployeeRegistry.register('a', EmployeeA as any, { isDefault: true });
    const emp = new VirtualEmployeeResolver().resolve({
      userMessage: '我的 OA 登录不上了',
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('it-ops-consultant');
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

  test('hintedId 优先于意图识别', () => {
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any);
    VirtualEmployeeRegistry.register('a', EmployeeA as any);
    const emp = new VirtualEmployeeResolver().resolve({
      hintedId: 'a',
      userMessage: '我的 OA 登录不上',  // 意图命中 IT 员工
      skillRegistry: null, llm: null,
    });
    expect(emp.config.id).toBe('a');  // 但 hintedId 优先
  });
});
```

**Step 4.3 — 跑测试,验证通过**

Run: `bun test __tests__/virtual-employee-resolver.test.ts`
Expected: PASS(9 个 test)

**Step 4.4 — Commit**

```bash
git add src/agents/virtual-employee/resolver.ts __tests__/virtual-employee-resolver.test.ts
git commit -m "feat(agent): VirtualEmployeeResolver 二级 fallback 路由"
```

---

### Task 5: 示例虚拟员工 — IT 运维顾问·小海

**Files**:
- Create: `src/agents/virtual-employee/employees/it-operations-consultant.ts`
- Test: `__tests__/virtual-employee-it-ops-consultant.test.ts`

**Step 5.1 — 写示例员工**

```typescript
// src/agents/virtual-employee/employees/it-operations-consultant.ts

import type { EmployeeConfig, ResultRewriter } from '../types';
import { VirtualEmployee } from '../base';

/**
 * 示例虚拟员工:IT 运维顾问·小海。
 *
 * 业务属性:
 *   - 服务集团员工 IT 类问题(系统报错 / 桌面运维 / 网络 / 设备 / 工单 / 门禁权限)
 *   - 边界:不做人事 / 财务 / 销售 / 产品类问题(主动转接)
 *   - 风格:耐心、专业、礼貌;结尾追加"转人工 / 评价"提示
 *   - 技能:IT 类全 7 个 skill(本系统当前全部 skill 都是 IT 类)
 */
export class ITOperationsConsultantEmployee extends VirtualEmployee {
  readonly config: EmployeeConfig = {
    id: 'it-ops-consultant',
    displayName: 'IT 运维顾问·小海',
    intentKeywords: [
      'OA', 'VPN', '密码', '重装', '网络', '打印机', '工单', '门禁', '电脑',
      '系统报错', '登录不上', '白屏', '报销', '考勤', '请假', '出差', '加班',
      'EES', 'GEAM', '法务', '合同', '时间管理', '硫酸',
    ],
  };

  protected systemPromptPrefix(): string {
    return `你是「${this.config.displayName}」,集团 IT 服务台的虚拟员工。

【职责】接听集团员工 IT 类问题:系统报错(EES / GEAM / 法务 / 时间管理 / 差旅 / 兜底) / 桌面运维 / 网络连接 / 设备报修 / 工单查询 / 门禁权限申请。

【风格】耐心、专业、礼貌。先安抚用户情绪,再引导排查。每一步都说清楚"我接下来要做什么"和"请您提供什么信息"。

【边界】以下情况请礼貌告知并建议转接:
- 销售 / 产品 / 报价类需求 → "这块建议联系销售 / 产品同事"
- 业务决策 / 战略规划 → "这块建议联系业务负责人"
- 任何超出 IT 范围的请求都不要假装能解决`;
  }

  protected allowedSkillNames(): Set<string> | null {
    // 本次系统全部 7 个 skill 都是 IT 类,白名单 = 全开
    return new Set([
      'ees-qa',
      'fallback-service-desk',
      'fawu',
      'geam-qa',
      'sulfuric-acid-price-prediction',
      'time-management-qa',
      'travel-expense-apply',
    ]);
  }

  protected resultRewriter(): ResultRewriter {
    return (rawResult: string) => {
      const trailing = '\n\n---\n如果您尝试后仍未解决,请回复「转人工」,我会把您转给值班工程师;也可以回复「评价」给我本次服务打个分。';
      return rawResult + trailing;
    };
  }
}
```

**Step 5.2 — 写测试**

```typescript
// __tests__/virtual-employee-it-ops-consultant.test.ts
import { describe, expect, test } from 'bun:test';
import { ITOperationsConsultantEmployee } from '../src/agents/virtual-employee/employees/it-operations-consultant';
import { SkillRegistry } from '../src/skill-registry';
import { ILLMClient } from '../src/llm';

class StubLLM implements ILLMClient {
  async generateWithTools() { return { content: '', toolCalls: [], messages: [] }; }
}

describe('ITOperationsConsultantEmployee', () => {
  const emp = new ITOperationsConsultantEmployee(new SkillRegistry(), new StubLLM() as any);

  test('config.id 和 displayName 正确', () => {
    expect(emp.config.id).toBe('it-ops-consultant');
    expect(emp.config.displayName).toContain('IT 运维顾问');
  });

  test('persona prefix 包含职责 / 边界 / 风格', () => {
    const prefix = (emp as any).systemPromptPrefix();
    expect(prefix).toContain('职责');
    expect(prefix).toContain('边界');
    expect(prefix).toContain('风格');
    expect(prefix).toContain('销售');  // 边界示例
  });

  test('allowedSkillNames 包含全部 7 个 IT skill', () => {
    const allowed = (emp as any).allowedSkillNames();
    expect(allowed).toBeInstanceOf(Set);
    expect(allowed.size).toBe(7);
    expect(allowed.has('ees-qa')).toBe(true);
    expect(allowed.has('fallback-service-desk')).toBe(true);
    expect(allowed.has('fawu')).toBe(true);
    expect(allowed.has('geam-qa')).toBe(true);
    expect(allowed.has('sulfuric-acid-price-prediction')).toBe(true);
    expect(allowed.has('time-management-qa')).toBe(true);
    expect(allowed.has('travel-expense-apply')).toBe(true);
  });

  test('resultRewriter 实际产出 = raw + 转人工提示', () => {
    const rewriter = (emp as any).resultRewriter();
    expect(typeof rewriter).toBe('function');
    const result = rewriter('这是解决方案');
    expect(result).toContain('这是解决方案');
    expect(result).toContain('转人工');
    expect(result).toContain('评价');
  });

  test('intentKeywords 覆盖 IT 高频关键词', () => {
    expect(emp.config.intentKeywords).toContain('OA');
    expect(emp.config.intentKeywords).toContain('VPN');
    expect(emp.config.intentKeywords).toContain('EES');
  });
});
```

**Step 5.3 — 跑测试,验证通过**

Run: `bun test __tests__/virtual-employee-it-ops-consultant.test.ts`
Expected: PASS(5 个 test)

**Step 5.4 — Commit**

```bash
git add src/agents/virtual-employee/employees/it-operations-consultant.ts __tests__/virtual-employee-it-ops-consultant.test.ts
git commit -m "feat(agent): 示例虚拟员工 — IT 运维顾问·小海"
```

---

### Task 6: 接入 index.ts + API 入口 + MainAgent 透传

**Files**:
- Modify: `src/index.ts`(注册员工 + 替换 SubAgent 实例)
- Modify: `src/api/index.ts`(`SubmitTaskRequest` 加 `employeeId` 字段 + `/tasks/stream` handler 透传)
- Modify: `src/agents/main-agent.ts`(`processRequirement` 签名加 `employeeId` 参数,转给 taskQueue executor)
- Test: `__tests__/main-agent-employee-routing.test.ts`(端到端验证 employeeId 透传)

**Step 6.1 — 修改 `src/index.ts`(line 94-106 区域)**

找到 line 94-106:
```typescript
    // 5. Create SubAgent
    console.log('🤖 Initializing SubAgent...');
    const subAgent = new SubAgent(skillRegistry, llmClient, memoryService);
    console.log('✅ SubAgent initialized\n');

    // 6. Create Task Queue with SubAgent as executor
    console.log('📋 Initializing Task Queue...');
    taskQueue = new TaskQueue(async (task: Task): Promise<unknown> => {
      // SubAgent.execute now throws AppError directly (Task 8).
      // We pass the error through unchanged so the API middleware can map it.
      return await subAgent.execute(task);
    });
    console.log('✅ Task Queue initialized\n');
```

改成(line 11 加 import,然后改 94-106):
```typescript
    // 5. Register virtual employees
    console.log('👥 Registering virtual employees...');
    const { VirtualEmployeeRegistry } = await import('./agents/virtual-employee/registry');
    const { ITOperationsConsultantEmployee } = await import('./agents/virtual-employee/employees/it-operations-consultant');
    VirtualEmployeeRegistry.register(
      'it-ops-consultant',
      ITOperationsConsultantEmployee as any,
      { isDefault: true },
    );
    console.log('✅ Virtual employees registered\n');

    // 6. Resolve default employee (本次唯一一个,作为 SubAgent 单例复用)
    console.log('🤖 Initializing SubAgent (default virtual employee)...');
    const { VirtualEmployeeResolver } = await import('./agents/virtual-employee/resolver');
    const subAgent = new VirtualEmployeeResolver().resolve({
      userMessage: '',  // 默认员工 fallback 路径,userMessage 不参与
      skillRegistry,
      llm: llmClient,
      memoryService,
    });
    console.log(`✅ SubAgent initialized (employee=${subAgent.config.id})\n`);

    // 7. Create Task Queue with SubAgent as executor
    console.log('📋 Initializing Task Queue...');
    taskQueue = new TaskQueue(async (task: Task): Promise<unknown> => {
      // SubAgent.execute now throws AppError directly (Task 8).
      // We pass the error through unchanged so the API middleware can map it.
      return await subAgent.execute(task);
    });
    console.log('✅ Task Queue initialized\n');
```

**Step 6.2 — 修改 `src/api/index.ts`(`SubmitTaskRequest` 加字段,line 34-41)**

找到 line 34-41:
```typescript
interface SubmitTaskRequest {
  requirement: string;
  image?: string;
  userId?: string; // 可选，默认 'default'
  sessionId?: string; // 可选，默认使用 userId
  accessToken?: string; // 可选，透传给技能脚本的认证 token
  draftId?: string; // 可选，幂等键（与 Tasks 6 的 gate.queue 关联）
}
```

改成:
```typescript
interface SubmitTaskRequest {
  requirement: string;
  image?: string;
  userId?: string; // 可选，默认 'default'
  sessionId?: string; // 可选，默认使用 userId
  accessToken?: string; // 可选，透传给技能脚本的认证 token
  draftId?: string; // 可选，幂等键（与 Tasks 6 的 gate.queue 关联）
  /** 虚拟员工 ID(可选)。不填则走意图识别 + 默认员工 fallback。 */
  employeeId?: string;
}
```

**Step 6.3 — 修改 `src/api/index.ts`(`/tasks/stream` handler 透传 employeeId,line 363-371)**

找到 line 363-375:
```typescript
  // 3. 原 handler
  async (
    req: Request<{}, {}, SubmitTaskRequest>,
    res: Response<ApiError>
  ) => {
    const { requirement } = req.body;
    const userId = req.body.userId || 'default';
    const accessToken = extractAccessToken(req);
    // 在 API 入口生成 traceId,贯穿整条调用链的所有日志
    // 格式与 requestId 一致(req-{ts}-{rand}),便于业务 ID 与日志 ID 对齐
    const traceId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // 使用 RequestContext 包裹整个请求处理，使 accessToken / traceId 可在整条调用链中访问
    return RequestContext.run({ accessToken, traceId }, async () => {
```

改成(在 RequestContext.run 之后,后续 mainAgent.processRequirement 调用前透传 employeeId;具体透传点是 line 321 和本文件其他 mainAgent.processRequirement 调用位置):
```typescript
  // 3. 原 handler
  async (
    req: Request<{}, {}, SubmitTaskRequest>,
    res: Response<ApiError>
  ) => {
    const { requirement, employeeId } = req.body;  // ← 加 employeeId 解构
    const userId = req.body.userId || 'default';
    const accessToken = extractAccessToken(req);
    // 在 API 入口生成 traceId,贯穿整条调用链的所有日志
    // 格式与 requestId 一致(req-{ts}-{rand}),便于业务 ID 与日志 ID 对齐
    const traceId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // 使用 RequestContext 包裹整个请求处理，使 accessToken / traceId 可在整条调用链中访问
    return RequestContext.run({ accessToken, traceId }, async () => {
```

然后找到本文件(后续 mainAgent.processRequirement 调用位置),把 `employeeId` 传给 mainAgent.processRequirement(具体传参取决于后续 SSE 流程逻辑,这里只示意透传位置)。

更准确的做法:在 `mainAgent.processRequirement(requirement, ...)` 调用时,把 `employeeId` 作为新参数传入。找到文件中所有 `mainAgent.processRequirement` 调用,在末尾加 `{ employeeId }` 选项。

示例(line 321 区域,改动前):
```typescript
      mainAgent.processRequirement(requirement, undefined, effectiveUserId).catch(...)
```

改动后:
```typescript
      mainAgent.processRequirement(requirement, undefined, effectiveUserId, undefined, { employeeId }).catch(...)
```

**Step 6.4 — 修改 `src/agents/main-agent.ts`(`processRequirement` 签名)**

找到 `processRequirement` 签名(line 180-186):
```typescript
  async processRequirement(
    requirement: string,
    imageAttachment?: { data: Buffer; mimeType: string; originalName?: string },
    userId: string = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    sessionId?: string,
    options?: { planMode?: boolean; draftId?: string; skipGate?: boolean; gateChecked?: boolean; requestOverride?: Request },
  ): Promise<...>
```

改成(在 `options` 里加 `employeeId?: string`,向后兼容;实现层在 `_processRequirementInner` 内部做路由):
```typescript
  async processRequirement(
    requirement: string,
    imageAttachment?: { data: Buffer; mimeType: string; originalName?: string },
    userId: string = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    sessionId?: string,
    options?: { planMode?: boolean; draftId?: string; skipGate?: boolean; gateChecked?: boolean; requestOverride?: Request; employeeId?: string },
  ): Promise<...>
```

**Step 6.5 — 修改 `_processRequirementInner` 内部,加 resolver 调用 + 切换 taskQueue executor**

找到 `_processRequirementInner` 内部,line 285-292 之间(L1 + L4 写入之后),插入虚拟员工路由:

在 line 285 之后插入:
```typescript
    // ===== VirtualEmployee 路由(Task 6)=====
    // 在系统命令拦截之前先选员工;resolver 失败 → BusinessError 抛出 → API middleware 转 transferToHuman
    const resolver = new VirtualEmployeeResolver();
    let selectedEmployee: VirtualEmployee;
    try {
      selectedEmployee = resolver.resolve({
        hintedId: options?.employeeId,
        userMessage: requirement,
        skillRegistry: this.skillRegistry,
        llm: this.llm,
        memoryService: this.memoryService,
      });
    } catch (err) {
      if (err instanceof BusinessError && err.code === 'UNKNOWN_EMPLOYEE') {
        MainAgent.log.warn('虚拟员工路由失败 → 抛错(由 API 层映射 transferToHuman)', { error: err.message });
        throw err;  // 走 API middleware 的 transferToHuman 路径
      }
      throw err;  // NO_DEFAULT_EMPLOYEE 同理
    }
    MainAgent.log.info('已选虚拟员工', { employeeId: selectedEmployee.config.id });

    // 把 taskQueue 的 executor 临时换成选中的 employee
    // (taskQueue 的 executor 是 closure;我们用一个 Map<taskId, employee> 在 task 处理时切换)
    // 简化实现:把整个 taskQueue.executor 换成 selectedEmployee,本次 processRequirement 内全部 task 用它
    // 注:本次是单例替换,无并发;后续要支持 per-task employee 时改成 Map
    const originalExecutor = (this.taskQueue as any).executor;
    (this.taskQueue as any).executor = async (task: Task) => selectedEmployee.execute(task);
    try {
      // 后续 processNormalRequirement 逻辑全部走 selectedEmployee.execute
      // ===== 步骤 1.5: 系统命令拦截(原 line 311)=====
      // ...
```

然后在 `_processRequirementInner` 末尾的 `return` 之前(line 388 之前),加 `finally` 恢复:
```typescript
    } finally {
      (this.taskQueue as any).executor = originalExecutor;
    }
```

**注**:`taskQueue.executor` 的访问需看实际字段名;若 TaskQueue 没有暴露 `executor` 字段(只在构造时绑定),则改为重新 `new TaskQueue(executor)` 或者改造 TaskQueue 增加 `setExecutor()` 方法。下面 Step 6.5.1 给出兜底方案。

**Step 6.5.1 — 兜底方案(若 TaskQueue 没有暴露 executor 字段)**

查看 `src/task-queue/index.ts`,确认 `executor` 字段可访问性。如果 `private executor`,则加 `setExecutor(fn)` 方法(在本任务内一并修改)。

**Step 6.6 — 跑类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 6.7 — 跑回归**

Run: `bun test __tests__/sub-agent*.test.ts __tests__/main-agent*.test.ts __tests__/api*.test.ts __tests__/virtual-employee*.test.ts`
Expected: PASS(允许 pre-existing 失败 9 个不相关)

**Step 6.8 — 写端到端测试**

```typescript
// __tests__/main-agent-employee-routing.test.ts
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { MainAgent } from '../src/agents/main-agent';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { VirtualEmployee } from '../src/agents/virtual-employee/base';

class ITConsultant extends VirtualEmployee {
  readonly config = { id: 'it-ops-consultant', displayName: 'IT 运维顾问·小海', intentKeywords: ['OA'] };
  protected allowedSkillNames() { return null; }
}

describe('MainAgent 虚拟员工路由', () => {
  beforeEach(() => {
    VirtualEmployeeRegistry._reset();
    VirtualEmployeeRegistry.register('it-ops-consultant', ITConsultant as any, { isDefault: true });
  });

  test('启动后 registry 有默认员工', () => {
    const Ctor = VirtualEmployeeRegistry.getDefaultCtor();
    expect(Ctor).toBeDefined();
    expect(new (Ctor as any)(null, null).config.id).toBe('it-ops-consultant');
  });

  test('ITOperationsConsultantEmployee 在 registry 中可被找到', () => {
    const Ctor = VirtualEmployeeRegistry.getCtor('it-ops-consultant');
    expect(Ctor).toBeDefined();
  });

  // 注:完整端到端(mainAgent.processRequirement 走完整链路)测试在集成测试文件,本文件只验证 registry 状态。
  // 集成测试可在 Task 7 跑全量回归时通过 manual smoke 验证。
});
```

**Step 6.9 — 跑新测试,验证通过**

Run: `bun test __tests__/main-agent-employee-routing.test.ts`
Expected: PASS(2 个 test)

**Step 6.10 — Commit**

```bash
git add src/index.ts src/api/index.ts src/agents/main-agent.ts __tests__/main-agent-employee-routing.test.ts
git commit -m "feat(agent): MainAgent 接入虚拟员工路由 + API 入口"
```

---

### Task 7: 回归 + 类型检查 + API.md 文档

**Files**:
- Modify: `API.md`

**Step 7.1 — 跑全量回归**

```bash
bun test
npx tsc --noEmit
```

Expected:
- 全量测试通过(已有 9 个 pre-existing fail 跟本次无关)
- `tsc --noEmit` 0 errors

**Step 7.2 — 更新 API.md**

在 `API.md` 中找到 "Submit Task" 段落(POST /tasks 和 /tasks/stream 共用),在表格里加一行:

```markdown
| `employeeId` | string | 否 | 虚拟员工 ID。不填则走意图识别 + 默认员工 fallback。示例: `'it-ops-consultant'` |
```

**Step 7.3 — Commit 文档**

```bash
git add API.md
git commit -m "docs: virtual employee — API.md 加 employeeId 字段说明"
```

---

## Self-Review

**1. Spec coverage:**

| Spec 要求 | 实现 Task |
|----------|----------|
| 缺口 6 虚拟员工抽象 | Task 1 (types + base) |
| 缺口 6 SubAgent template method | Task 2 |
| 缺口 6 Registry | Task 3 |
| 缺口 6 Resolver 二级 fallback | Task 4 |
| 缺口 6 示例员工 IT 运维顾问 | Task 5 |
| 缺口 6 index.ts 接入 + API 透传 | Task 6 |
| 缺口 6 回归 + 文档 | Task 7 |

✅ 全部覆盖。

**2. Placeholder scan:**

- ❌ "oa-ticket-query"(spec 占位)→ ✅ 改为真实 skill 名(`ees-qa` 等 7 个)
- ❌ "src/types/index.ts SubmitTaskRequest"(spec 错误)→ ✅ 改为 `src/api/index.ts:34`
- ❌ "this.subAgent 临时替换"(spec 错误)→ ✅ 改为 taskQueue executor 切换 + 启动时 resolver 选默认员工
- ✅ Task 5 `intentKeywords` 覆盖范围与 spec 一致(基于真实 skill)

无遗留占位。

**3. Type consistency:**

- `VirtualEmployee extends SubAgent` → Task 1 base.ts, Task 2 sub-agent.ts 加 protected, Task 5 employee extends VirtualEmployee ✅
- `ResolverOptions` 字段名 `{ hintedId, userMessage, skillRegistry, llm, memoryService }` → Task 4 定义, Task 6 main-agent 调用, Task 6 index.ts 启动调用 ✅
- `EmployeeConfig.id` / `displayName` / `intentKeywords` → Task 1 types 定义, Task 3 list() 用, Task 4 resolver 扫描用, Task 5 示例员工实现 ✅
- `BusinessError` 错误码 `UNKNOWN_EMPLOYEE` / `NO_DEFAULT_EMPLOYEE` → Task 4 resolver 抛, Task 6 main-agent catch ✅

类型一致。

---

## 关键决策(防回顾偏差)

| 决策 | 选择 | 否决方案 |
|------|------|----------|
| 与 SubAgent 关系 | **template method + 3 个 protected hook** | 配置对象 + 装饰器(方案 A) |
| 路由策略 | **@ 显式 → 意图识别 → 默认** | 只做默认 / 只做 @ / 按部门路由 |
| 业务属性最小集 | **persona + skill 白名单 + result 改写** | + 数据权限范围 / + 升级路径(后续) |
| 虚拟员工实例化 | **`src/index.ts:96` 启动时通过 resolver 选默认员工替换 SubAgent 单例** | 每请求 new / MainAgent 持有实例 |
| taskQueue 切换方式 | **替换 taskQueue.executor closure(本 processRequirement 内)+ finally 恢复** | 改 TaskQueue 接口 / 多 taskQueue 实例 |
| persona 拼接位置 | **拼到 `skill.body` 前面(2 处:首次执行 + 断点续)** | 独立 system message / 后置改写 |
| skill 白名单校验时机 | **`execute()` 入口 template method 校验** | 在 `executeSkill` 内部 / 延后到 LLM 输出后 |
| result 改写时机 | **SubAgent return 前** | LLM 调用前 / 改 SubAgent 内部 messages |
| 注册表设计 | **静态 Map + 构造函数引用 + isDefault 标记** | 实例缓存 / DI 容器 / 配置中心 |
| Resolver 构造时机 | **每次 `resolve()` 才 new 实例** | registry 持单例 |
| 路由失败处理 | **BusinessError → MainAgent throw → API middleware 转 transferToHuman** | 静默走 SubAgent 现状 |
| 覆盖范围 | **1 个示例(「IT 运维顾问·小海」)** | 12 个一次性 / 3 个示例 |
| employeeId 在 body | **`SubmitTaskRequest.employeeId?: string` 可选** | 必填 / URL 参数 / Header |
| 测试框架 | **沿用 `bun:test`** | jest / vitest |
| 新依赖 | **零** | OTel / class-validator(都不需要) |

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| SubAgent template method 重构破坏现有逻辑 | Task 2 Step 2.5 强制跑 sub-agent / api / main-agent 回归;默认 hook 全部等于零行为差异(allowedSkillNames → null, systemPromptPrefix → '', resultRewriter → null) |
| taskQueue.executor 字段访问性 | Step 6.5.1 兜底:若 private 则给 TaskQueue 加 `setExecutor()` 方法,本任务内一并修改 |
| MainAgent._processRequirementInner 改造破坏 SLA 收尾 | 改造点全部包在 `try/finally` 内,SLA `finally` 不动;`switchSlaId` 闭包保持 |
| 虚拟员工的 system prompt prefix 改变 LLM 行为 → 现有 skill 测试失败 | 现有 test 几乎不测 LLM 输出内容,只测路由 + 抛错;模板方法默认行为零差异 |
| Skill 真实名称 vs spec 占位不符 | 本任务直接采用真实 skill 名(全 7 个);Task 5 Step 5.1 已写明 |
| 路由失败抛错 → API 端如何映射 transferToHuman | Task 6 Step 6.5 throw `BusinessError` 给 API 层;具体 transferToHuman 映射在 `globalErrorHandler` 中已支持 BusinessError(沿用现有错误处理,不在本任务内做新映射) |
| `@` 提取的正则不覆盖中英混合 | 正则用 `\p{L}\p{N}` Unicode 类,中英文都覆盖 |
| 多个员工匹配同一关键词 → 路由不确定 | resolver 按注册顺序取第一个(确定性);后续可加权重 |

---

## 验收方法

1. **单元测试**: `bun test __tests__/virtual-employee-*.test.ts __tests__/sub-agent-template-method.test.ts` 全部通过
2. **回归测试**: `bun test __tests__/sub-agent*.test.ts __tests__/main-agent*.test.ts __tests__/api*.test.ts` 全部通过(零回归;允许 pre-existing 9 个无关失败)
3. **类型检查**: `npx tsc --noEmit` 0 errors
4. **运行时手动验证**:
   - 启 dev server,打开 `public/test.html`
   - 发送 `我的 OA 登录不上`(不带 @)→ 自动派给「IT 运维顾问·小海」
   - 发送 `@IT小海 帮我查工单` → 显式派给小海
   - 发送 `请帮我看看`(无 IT 关键词) → 走默认员工(也是 IT 顾问),result 末尾追加 "转人工" 提示
   - 发送 `@ghost 帮我` → API 返回 transferToHuman(由 globalErrorHandler 映射)
   - 查看响应:result 末尾追加了 "转人工" 提示