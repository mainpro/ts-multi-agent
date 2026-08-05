# PPT Agent 能力差距补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 闭环 5 个 PPT Agent 能力缺口(Prompt 注入拦截 / 画像扩展 / 失败归因 SLA / 观测指标 / 多模态保留),按 spec [`2026-08-04-ppt-agent-gap-closure-design.md`](../specs/2026-08-04-ppt-agent-gap-closure-design.md) 落地。

**Architecture**: 4 个独立模块(Guardrail / UserProfile 扩展 / Attribution+SLA / OpenTelemetry),缺口 5 不动。可按 Task 顺序实施,各 Task 独立可测。

**Tech Stack**: TypeScript / bun / Express / OpenTelemetry SDK / zod / vitest

---

## Global Constraints

来自 spec,所有 Task 必须遵守:

- **类型**: TypeScript strict mode,所有公开接口必须 `export` 显式类型
- **测试**: `bun test __tests__/<name>.test.ts`,TDD 流程
- **路径**: 严格按 spec 路径(`src/guardrail/` / `src/observability/`),不喜勿换
- **错误处理**: 通过 `AppError` 子类,归因到 6-8 类之一
- **审计日志**: JSONL 格式,落 `data/audit/YYYY-MM-DD.jsonl`
- **画像字段扩展**: 向后兼容,老 JSON 缺字段自动补全默认值
- **L1 规则引擎**: 仅规则,不做 L2 LLM 兜底
- **IAM 升级路径**: 改 `UserProfileService` 实现,Agent 逻辑零改动
- **不 commit**: 用户明确约束,plan 阶段不提交任何代码

---

## File Structure (锁定)

```
新建:
  src/guardrail/types.ts
  src/guardrail/keywords.ts
  src/guardrail/pii-patterns.ts
  src/guardrail/audit-logger.ts
  src/guardrail/rule-engine.ts
  src/guardrail/middleware.ts
  src/observability/attribution.ts
  src/observability/sla-watcher.ts
  src/observability/otel.ts
  src/observability/metrics.ts
  __tests__/guardrail-rule-engine.test.ts
  __tests__/guardrail-audit-logger.test.ts
  __tests__/guardrail-middleware.test.ts
  __tests__/user-profile-extension.test.ts
  __tests__/user-profile-context-builder.test.ts
  __tests__/attribution.test.ts
  __tests__/sla-watcher.test.ts
  __tests__/otel-bootstrap.test.ts
  __tests__/metrics-endpoint.test.ts

改:
  src/types/index.ts                          # UserProfile 扩展 + SLA_* 配置
  src/user-profile/index.ts                   # 缺失字段补全
  src/context/dynamic-context.ts              # 字段输出
  src/api/index.ts                            # Guardrail 入口 + /metrics 改造
  src/agents/sub-agent.ts                     # 越权归因 + skill metrics 打点
  src/agents/main-agent.ts                    # SLA 检查 + OTel 接入
  src/llm/index.ts                            # LLM 归因 + metrics 打点
  package.json                                # OpenTelemetry 依赖
```

---

## Task 1: Guardrail Foundation — 类型与 PII 库(缺口 1 基础)

**Files**:
- Create: `src/guardrail/types.ts`
- Create: `src/guardrail/pii-patterns.ts`
- Test: `__tests__/guardrail-rule-engine.test.ts`(占位,先写 types 测试)

**Interfaces**:
- Consumes: 无
- Produces: `GuardrailDecision` / `GuardrailContext` / `GuardrailAction` 类型(`src/guardrail/types.ts`)
- Produces: `PII_PATTERNS` 常量(`src/guardrail/pii-patterns.ts`)

- [ ] **Step 1.1: 写类型测试**

```typescript
// __tests__/guardrail-rule-engine.test.ts
import { describe, expect, test } from 'bun:test';
import type { GuardrailAction, GuardrailContext, GuardrailDecision } from '../src/guardrail/types';

describe('Guardrail types', () => {
  test('GuardrailAction enum values', () => {
    const actions: GuardrailAction[] = ['allow', 'rewrite', 'deny', 'alert'];
    expect(actions).toHaveLength(4);
  });

  test('GuardrailContext can be constructed', () => {
    const ctx: GuardrailContext = {
      userId: 'u-1',
      userRole: 'employee',
      userPermissions: ['oa:read'],
      sessionId: 's-1',
      isSteerEntry: false,
      source: 'user',
    };
    expect(ctx.userRole).toBe('employee');
  });

  test('GuardrailDecision default fields', () => {
    const d: GuardrailDecision = {
      action: 'allow',
      reason: 'no rule matched',
      ruleName: 'NONE',
    };
    expect(d.rewrittenContent).toBeUndefined();
  });
});
```

- [ ] **Step 1.2: 跑测试,验证失败**

Run: `bun test __tests__/guardrail-rule-engine.test.ts`
Expected: FAIL — "Cannot find module '../src/guardrail/types'"

- [ ] **Step 1.3: 实现 types.ts**

```typescript
// src/guardrail/types.ts

export type GuardrailAction = 'allow' | 'rewrite' | 'deny' | 'alert';

export interface GuardrailContext {
  userId: string;
  userRole: string;
  userPermissions: string[];
  sessionId: string;
  isSteerEntry: boolean;
  source: 'user' | 'steer' | 'tool_result';
}

export interface GuardrailDecision {
  action: GuardrailAction;
  reason: string;
  ruleName: string;
  rewrittenContent?: string;
}
```

- [ ] **Step 1.4: 实现 pii-patterns.ts**

```typescript
// src/guardrail/pii-patterns.ts

export const PII_PATTERNS = {
  /** 中国大陆身份证号(18 位,末位可 X) */
  idCard: /^\d{17}[\dXx]$/,
  /** 银行卡号(16-19 位纯数字) */
  bankCard: /^\d{16,19}$/,
  /** 中国大陆手机号(11 位,1 开头) */
  phoneCN: /^1[3-9]\d{9}$/,
} as const;

export interface PiiMatch {
  kind: keyof typeof PII_PATTERNS;
  raw: string;
  masked: string;
}

/**
 * 把检测到的 PII 片段替换为脱敏表达
 * @param text 原始文本
 * @returns 脱敏后的文本 + 命中列表
 */
export function redactPii(text: string): { redacted: string; matches: PiiMatch[] } {
  const matches: PiiMatch[] = [];
  let redacted = text;

  for (const [kind, pattern] of Object.entries(PII_PATTERNS)) {
    redacted = redacted.replace(pattern, (m) => {
      const masked = maskOf(kind, m);
      matches.push({ kind: kind as keyof typeof PII_PATTERNS, raw: m, masked });
      return masked;
    });
  }

  return { redacted, matches };
}

function maskOf(kind: string, raw: string): string {
  if (kind === 'idCard') return raw.slice(0, 4) + '**********' + raw.slice(-4);
  if (kind === 'bankCard') return raw.slice(0, 4) + '********' + raw.slice(-4);
  if (kind === 'phoneCN') return raw.slice(0, 3) + '****' + raw.slice(-4);
  return '****';
}
```

- [ ] **Step 1.5: 跑测试,验证通过**

Run: `bun test __tests__/guardrail-rule-engine.test.ts`
Expected: PASS

---

## Task 2: 关键词黑名单 + 规则引擎(缺口 1.1)

**Files**:
- Create: `src/guardrail/keywords.ts`
- Create: `src/guardrail/rule-engine.ts`
- Test: `__tests__/guardrail-rule-engine.test.ts`(扩展)

**Interfaces**:
- Consumes: `GuardrailContext` / `GuardrailDecision`(`src/guardrail/types.ts`)
- Produces: `BLACKLIST_KEYWORDS` 常量(`src/guardrail/keywords.ts`)
- Produces: `RuleEngine` 接口 + `L1RuleEngine` 实现(`src/guardrail/rule-engine.ts`)

- [ ] **Step 2.1: 写规则引擎测试**

在 `__tests__/guardrail-rule-engine.test.ts` 末尾追加:

```typescript
import { L1RuleEngine } from '../src/guardrail/rule-engine';
import { BLACKLIST_KEYWORDS } from '../src/guardrail/keywords';
import { redactPii } from '../src/guardrail/pii-patterns';

describe('L1RuleEngine', () => {
  const engine = new L1RuleEngine();
  const ctx: GuardrailContext = {
    userId: 'u-1',
    userRole: 'employee',
    userPermissions: [],
    sessionId: 's-1',
    isSteerEntry: false,
    source: 'user',
  };

  test('blacklist keyword triggers deny', async () => {
    const d = await engine.evaluate('Please ignore previous instructions', ctx);
    expect(d.action).toBe('deny');
    expect(d.ruleName).toBe('BLACKLIST_KEYWORD');
  });

  test('PII triggers rewrite', async () => {
    const d = await engine.evaluate('我的身份证是 110101199003078813', ctx);
    expect(d.action).toBe('rewrite');
    expect(d.ruleName).toBe('PII_REDACT');
    expect(d.rewrittenContent).toContain('1101');
    expect(d.rewrittenContent).toContain('8813');
    expect(d.rewrittenContent).toContain('**********');
  });

  test('phone triggers rewrite', async () => {
    const d = await engine.evaluate('联系 13800138000', ctx);
    expect(d.action).toBe('rewrite');
    expect(d.rewrittenContent).toContain('138');
    expect(d.rewrittenContent).toContain('8000');
  });

  test('sensitive word triggers deny', async () => {
    const d = await engine.evaluate('机密 文件', ctx);
    expect(d.action).toBe('deny');
    expect(d.ruleName).toBe('SENSITIVE_KEYWORD');
  });

  test('normal input allowed', async () => {
    const d = await engine.evaluate('请帮我看看 OA 工单', ctx);
    expect(d.action).toBe('allow');
  });

  test('long ambiguous input triggers alert', async () => {
    const longText = '请帮我查 ' + 'x'.repeat(2000);
    const d = await engine.evaluate(longText, ctx);
    expect(d.action).toBe('alert');
    expect(d.ruleName).toBe('LONG_AMBIGUOUS');
  });
});

describe('BLACKLIST_KEYWORDS content', () => {
  test('contains injection keywords', () => {
    expect(BLACKLIST_KEYWORDS).toContain('ignore previous instructions');
    expect(BLACKLIST_KEYWORDS).toContain('DAN');
  });

  test('contains sensitive keywords', () => {
    expect(BLACKLIST_KEYWORDS).toContain('机密');
    expect(BLACKLIST_KEYWORDS).toContain('绝密');
  });
});
```

- [ ] **Step 2.2: 跑测试,验证失败**

Run: `bun test __tests__/guardrail-rule-engine.test.ts`
Expected: FAIL — "Cannot find module '../src/guardrail/rule-engine'"

- [ ] **Step 2.3: 实现 keywords.ts**

```typescript
// src/guardrail/keywords.ts

/**
 * 黑名单关键字。命中即 deny。
 * 维护规则:每条加注释说明来源。
 */
export const BLACKLIST_KEYWORDS: readonly string[] = [
  // ===== 注入类 =====
  'ignore previous instructions',
  '忽略之前指令',
  'DAN',
  'jailbreak',
  'developer mode',
  'do anything now',

  // ===== 越权类 =====
  'DROP TABLE',
  'rm -rf /',
  'sudo ',
  'disabling safety',

  // ===== 敏感词(PII 走 redact,这里只放机密类) =====
  '机密',
  '绝密',
  '密码',
];
```

- [ ] **Step 2.4: 实现 rule-engine.ts**

```typescript
// src/guardrail/rule-engine.ts
import type { GuardrailContext, GuardrailDecision } from './types';
import { BLACKLIST_KEYWORDS } from './keywords';
import { redactPii } from './pii-patterns';

export interface RuleEngine {
  evaluate(input: string, ctx: GuardrailContext): Promise<GuardrailDecision>;
}

/** 长文本告警阈值(超过则 alert) */
const LONG_AMBIGUOUS_THRESHOLD = 1500;

export class L1RuleEngine implements RuleEngine {
  async evaluate(input: string, ctx: GuardrailContext): Promise<GuardrailDecision> {
    // 1. 黑名单关键字
    for (const kw of BLACKLIST_KEYWORDS) {
      if (input.includes(kw)) {
        return {
          action: 'deny',
          reason: `Hit blacklist keyword: ${kw}`,
          ruleName: 'BLACKLIST_KEYWORD',
        };
      }
    }

    // 2. PII 改写
    const { redacted, matches } = redactPii(input);
    if (matches.length > 0) {
      return {
        action: 'rewrite',
        reason: `PII redacted: ${matches.map((m) => m.kind).join(',')}`,
        ruleName: 'PII_REDACT',
        rewrittenContent: redacted,
      };
    }

    // 3. 长文本告警
    if (input.length > LONG_AMBIGUOUS_THRESHOLD) {
      return {
        action: 'alert',
        reason: `Long ambiguous input: ${input.length} chars`,
        ruleName: 'LONG_AMBIGUOUS',
      };
    }

    // 4. 通过
    return {
      action: 'allow',
      reason: 'no rule matched',
      ruleName: 'NONE',
    };
  }
}
```

- [ ] **Step 2.5: 跑测试,验证通过**

Run: `bun test __tests__/guardrail-rule-engine.test.ts`
Expected: PASS(全部 8 个 test)

---

## Task 3: Audit Logger(缺口 1.2)

**Files**:
- Create: `src/guardrail/audit-logger.ts`
- Test: `__tests__/guardrail-audit-logger.test.ts`

**Interfaces**:
- Consumes: `GuardrailDecision`(`src/guardrail/types.ts`)
- Produces: `auditLogger.log()` / `auditLogger.query()`(`src/guardrail/audit-logger.ts`)

- [ ] **Step 3.1: 写 audit logger 测试**

```typescript
// __tests__/guardrail-audit-logger.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { auditLogger } from '../src/guardrail/audit-logger';

describe('AuditLogger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-'));
    auditLogger.configure({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  test('writes JSONL to dated file', async () => {
    await auditLogger.log({
      userId: 'u-1',
      action: 'deny',
      ruleName: 'BLACKLIST_KEYWORD',
      reason: 'hit "DROP TABLE"',
      contentPreview: 'DROP TABLE foo',
      profile: { role: 'employee', permissions: [] },
      decision: { action: 'deny', reason: 'hit', ruleName: 'BLACKLIST_KEYWORD' },
    });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, 'audit', `${today}.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.userId).toBe('u-1');
    expect(entry.action).toBe('deny');
    expect(entry.timestamp).toBeDefined();
    expect(entry.traceId).toBeDefined();
  });

  test('appends to same file across multiple calls', async () => {
    for (let i = 0; i < 3; i++) {
      await auditLogger.log({
        userId: `u-${i}`,
        action: 'alert',
        ruleName: 'LONG_AMBIGUOUS',
        reason: 'too long',
        contentPreview: 'x'.repeat(100),
        profile: { role: 'employee', permissions: [] },
        decision: { action: 'alert', reason: 'long', ruleName: 'LONG_AMBIGUOUS' },
      });
    }
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, 'audit', `${today}.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(3);
  });

  test('contentPreview truncated to 200 chars', async () => {
    const longContent = 'A'.repeat(500);
    await auditLogger.log({
      userId: 'u-1',
      action: 'alert',
      ruleName: 'LONG_AMBIGUOUS',
      reason: 'long',
      contentPreview: longContent,
      profile: { role: 'employee', permissions: [] },
      decision: { action: 'alert', reason: 'long', ruleName: 'LONG_AMBIGUOUS' },
    });
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, 'audit', `${today}.jsonl`);
    const entry = JSON.parse((await fs.readFile(filePath, 'utf-8')).trim().split('\n')[0]);
    expect(entry.contentPreview.length).toBe(200);
  });
});
```

- [ ] **Step 3.2: 跑测试,验证失败**

Run: `bun test __tests__/guardrail-audit-logger.test.ts`
Expected: FAIL — "Cannot find module '../src/guardrail/audit-logger'"

- [ ] **Step 3.3: 实现 audit-logger.ts**

```typescript
// src/guardrail/audit-logger.ts
import { promises as fs } from 'fs';
import * as path from 'path';
import { createLogger } from '../observability/logger';
import type { GuardrailDecision } from './types';

const log = createLogger({ module: 'GuardrailAudit' });

export interface AuditLogEntry {
  userId: string;
  action: 'allow' | 'rewrite' | 'deny' | 'alert';
  ruleName: string;
  reason: string;
  contentPreview: string;
  profile: { role: string; permissions: string[] };
  decision: GuardrailDecision;
}

export interface AuditLogConfig {
  dataDir: string;
}

const PREVIEW_MAX = 200;
const DEFAULT_DATA_DIR = 'data';

class AuditLogger {
  private config: AuditLogConfig = { dataDir: DEFAULT_DATA_DIR };
  private writeQueue: Promise<void> = Promise.resolve();

  configure(config: Partial<AuditLogConfig>): void {
    if (config.dataDir) this.config.dataDir = config.dataDir;
  }

  async log(entry: AuditLogEntry): Promise<void> {
    const record = {
      timestamp: new Date().toISOString(),
      traceId: this.generateTraceId(),
      ...entry,
      contentPreview: entry.contentPreview.slice(0, PREVIEW_MAX),
    };
    const line = JSON.stringify(record) + '\n';
    const filePath = this.datedFilePath();

    // 串行化写,避免并发漏写
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, line, 'utf-8');
      } catch (err) {
        log.error('audit log write failed', { filePath, error: err });
      }
    });
    await this.writeQueue;
  }

  async query(opts: { date?: string; userId?: string }): Promise<unknown[]> {
    const filePath = this.datedFilePath(opts.date);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const entries = lines.map((line) => JSON.parse(line));
      if (opts.userId) return entries.filter((e: any) => e.userId === opts.userId);
      return entries;
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  private datedFilePath(date?: string): string {
    const d = date ?? new Date().toISOString().slice(0, 10);
    return path.join(this.config.dataDir, 'audit', `${d}.jsonl`);
  }

  private generateTraceId(): string {
    return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export const auditLogger = new AuditLogger();
```

- [ ] **Step 3.4: 跑测试,验证通过**

Run: `bun test __tests__/guardrail-audit-logger.test.ts`
Expected: PASS(全部 3 个 test)

---

## Task 4: Guardrail Middleware + API 入口接入(缺口 1.3)

**Files**:
- Create: `src/guardrail/middleware.ts`
- Modify: `src/api/index.ts`(在 `POST /tasks/stream` 入口处插入 middleware)
- Test: `__tests__/guardrail-middleware.test.ts`

**Interfaces**:
- Consumes: `GuardrailContext` / `GuardrailDecision`(`src/guardrail/types.ts`)
- Consumes: `L1RuleEngine`(`src/guardrail/rule-engine.ts`)
- Consumes: `auditLogger`(`src/guardrail/audit-logger.ts`)
- Produces: `guardrailMiddleware()`(`src/guardrail/middleware.ts`)

- [ ] **Step 4.1: 写 middleware 测试**

```typescript
// __tests__/guardrail-middleware.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import { guardrailMiddleware } from '../src/guardrail/middleware';
import { auditLogger } from '../src/guardrail/audit-logger';
import type { UserProfile } from '../src/types';

// Mock UserProfileService
import { mockUserProfileService } from './helpers/mock-profile-service';

describe('guardrailMiddleware', () => {
  let app: any;
  let server: any;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-mw-'));
    auditLogger.configure({ dataDir: tmpDir });
    app = express();
    app.use(express.json());
    app.use(mockUserProfileService());
    app.post('/tasks/stream', guardrailMiddleware(), (req: any, res: any) => {
      res.json({ received: req.body.content });
    });
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true });
  });

  test('allow passes through', async () => {
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-1', sessionId: 's-1', content: '请帮我看看 OA' }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.received).toBe('请帮我看看 OA');
  });

  test('rewrite replaces content in body', async () => {
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-1', sessionId: 's-1', content: '身份证 110101199003078813' }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.received).toContain('**********');
    expect(json.received).not.toContain('110101199003078813');
  });

  test('deny returns 200 with transferToHuman flag', async () => {
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-1', sessionId: 's-1', content: 'DROP TABLE users' }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.transferToHuman).toBe(true);
    expect(json.reason).toContain('BLACKLIST_KEYWORD');
  });

  test('alert passes through but audit log has alert=true', async () => {
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-1', sessionId: 's-1', content: 'A'.repeat(2000) }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.received).toBe('A'.repeat(2000));
    const today = new Date().toISOString().slice(0, 10);
    const entries = await auditLogger.query({ date: today });
    expect(entries.some((e: any) => e.ruleName === 'LONG_AMBIGUOUS')).toBe(true);
  });
});
```

- [ ] **Step 4.2: 写 mock helper**

```typescript
// __tests__/helpers/mock-profile-service.ts
import type { RequestHandler } from 'express';
import type { UserProfile } from '../../src/types';

export function mockUserProfileService(): RequestHandler {
  return (req: any, res: any, next: any) => {
    const userId = req.body.userId ?? 'u-1';
    req.profile = {
      userId,
      department: '财务部',
      commonSystems: [],
      tags: [],
      conversationCount: 0,
      lastActiveAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      role: 'employee',
      permissions: [],
      history: [],
      preferences: [],
    };
    next();
  };
}
```

- [ ] **Step 4.3: 跑测试,验证失败**

Run: `bun test __tests__/guardrail-middleware.test.ts`
Expected: FAIL — "Cannot find module '../src/guardrail/middleware'"

- [ ] **Step 4.4: 实现 middleware.ts**

```typescript
// src/guardrail/middleware.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { L1RuleEngine } from './rule-engine';
import { auditLogger } from './audit-logger';
import type { GuardrailContext } from './types';

const engine = new L1RuleEngine();

export function guardrailMiddleware(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { userId, sessionId, content } = req.body ?? {};
    if (!content || typeof content !== 'string') {
      return next();  // 缺字段交给上层
    }

    const profile = (req as any).profile ?? {
      role: 'employee',
      permissions: [],
    };

    const ctx: GuardrailContext = {
      userId: userId ?? 'anonymous',
      userRole: profile.role,
      userPermissions: profile.permissions ?? [],
      sessionId: sessionId ?? 'unknown',
      isSteerEntry: false,
      source: 'user',
    };

    const decision = await engine.evaluate(content, ctx);

    if (decision.action === 'deny' || decision.action === 'alert' || decision.action === 'rewrite') {
      await auditLogger.log({
        userId: ctx.userId,
        action: decision.action,
        ruleName: decision.ruleName,
        reason: decision.reason,
        contentPreview: content,
        profile: { role: ctx.userRole, permissions: ctx.userPermissions },
        decision,
      });
    }

    switch (decision.action) {
      case 'deny':
        // 走人工兜底:返回 200 + transferToHuman flag,由上层路由处理
        return res.json({
          transferToHuman: true,
          reason: decision.reason,
          ruleName: decision.ruleName,
        });
      case 'rewrite':
        req.body.content = decision.rewrittenContent;
        return next();
      case 'alert':
      case 'allow':
      default:
        return next();
    }
  };
}
```

- [ ] **Step 4.5: 跑测试,验证通过**

Run: `bun test __tests__/guardrail-middleware.test.ts`
Expected: PASS(全部 4 个 test)

- [ ] **Step 4.6: 接入到 `src/api/index.ts`**

修改 `src/api/index.ts` 中 `POST /tasks/stream` 路由:

```typescript
// 在 express 应用初始化时,添加 guardrail middleware
import { guardrailMiddleware } from '../guardrail/middleware';
import { mockUserProfileService as _unused } from '../guardrail/__unused__'; // 实际用真实 UserProfileService

// 找到 app.post('/tasks/stream', ...) 这一行
// 在 handler 之前插入:
app.post('/tasks/stream',
  async (req, res, next) => {
    // 加载 profile 挂到 req.profile
    req.profile = await userProfileService.loadProfile(req.body.userId);
    next();
  },
  guardrailMiddleware(),
  async (req, res) => {
    // 原 handler 逻辑
  }
);
```

**注意**:具体位置需根据 `src/api/index.ts` 现有代码调整。这里只示意插入点。

- [ ] **Step 4.7: 跑 API 集成测试,验证不破**

Run: `bun test __tests__/api.test.ts`
Expected: PASS(原 SSE 事件不变)

---

## Task 5: 越权 Skill 调用归因(缺口 1.4)

> **Dependency**: 必须在 Task 8 完成后再执行,因为 `attributionCounter` 来自 Task 8。**实际实施顺序**: Task 1-4 → Task 6-7 → Task 8 → **Task 5** → Task 9-12 → Task 13。

**Files**:
- Modify: `src/agents/sub-agent.ts:421-433`(在 `allowedToolNames.has(toolCall.name)` 失败处)

**Interfaces**:
- Consumes: `attributionCounter`(`src/observability/attribution.ts`,Task 8 产物)
- Produces: 越权时增 `INJECT_DENY` 归因

- [ ] **Step 5.1: 在 sub-agent.ts 顶部 import attributionCounter**

(Task 8 已完成,产物存在)

```typescript
// src/agents/sub-agent.ts 顶部添加
import { attributionCounter } from '../observability/attribution';
```

- [ ] **Step 5.2: 修改 sub-agent.ts 第 423 行**

```typescript
// 修改前:
if (!allowedToolNames.has(toolCall.name)) {
  const rewrite = unknownToolGuard.check(toolCall.name);
  if (rewrite) {
    SubAgent.log.warn('未知工具熔断触发', { toolName: toolCall.name, count: '>3' });
    return rewrite;
  }
  return `工具执行失败: 工具 '${toolCall.name}' 不在允许列表中,可用工具: ${Array.from(allowedToolNames).join(', ')}`;
}

// 修改后:
if (!allowedToolNames.has(toolCall.name)) {
  // 归因缺口 1 拦截
  attributionCounter.inc({ rule: 'INJECT_DENY', tool: toolCall.name });
  
  const rewrite = unknownToolGuard.check(toolCall.name);
  if (rewrite) {
    SubAgent.log.warn('未知工具熔断触发', { toolName: toolCall.name, count: '>3' });
    return rewrite;
  }
  return `工具执行失败: 工具 '${toolCall.name}' 不在允许列表中,可用工具: ${Array.from(allowedToolNames).join(', ')}`;
}
```

- [ ] **Step 5.3: 跑现有韧性测试,验证不破**

Run: `bun test __tests__/resilience-e2e.test.ts __tests__/unknown-tool-guard-e2e.test.ts`
Expected: PASS

---

## Task 6: UserProfile 字段扩展(缺口 2)

**Files**:
- Modify: `src/types/index.ts`(`UserProfile` 接口加 4 字段)
- Modify: `src/user-profile/index.ts`(`loadProfile` 补全缺失字段)
- Test: `__tests__/user-profile-extension.test.ts`

**Interfaces**:
- Consumes: 现有 `UserProfile` 类型
- Produces: 扩展 `UserProfile` + `loadProfile` 向后兼容

- [ ] **Step 6.1: 写 type 扩展测试**

```typescript
// __tests__/user-profile-extension.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UserProfileService } from '../src/user-profile';

describe('UserProfile extension', () => {
  let tmpDir: string;
  let service: UserProfileService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-'));
    service = new UserProfileService(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  test('loadProfile fills missing fields with defaults', async () => {
    // 写老格式 JSON
    const oldJson = {
      'u-1': {
        userId: 'u-1',
        department: '财务部',
        commonSystems: ['OA'],
        tags: [],
        conversationCount: 5,
        lastActiveAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        // 缺 role / permissions / history / preferences
      },
    };
    await fs.writeFile(
      path.join(tmpDir, 'user-profile.json'),
      JSON.stringify(oldJson),
      'utf-8'
    );

    const profile = await service.loadProfile('u-1');
    expect(profile.role).toBe('employee');
    expect(profile.permissions).toEqual([]);
    expect(profile.history).toEqual([]);
    expect(profile.preferences).toEqual([]);
  });

  test('updateProfile preserves new fields', async () => {
    await service.updateProfile('u-1', {
      role: 'admin',
      permissions: ['oa:read', 'finance:read'],
      history: [{ topic: '报销', summary: '跨部门报销', lastOccurredAt: '2026-08-01', occurrences: 2 }],
      preferences: [{ key: 'response_style', value: 'concise', confidence: 0.8 }],
    });

    const profile = await service.loadProfile('u-1');
    expect(profile.role).toBe('admin');
    expect(profile.permissions).toEqual(['oa:read', 'finance:read']);
    expect(profile.history).toHaveLength(1);
    expect(profile.preferences).toHaveLength(1);
  });

  test('createDefaultProfile includes new fields', async () => {
    const profile = await service.createUserProfile('u-new');
    expect(profile.role).toBe('employee');
    expect(profile.permissions).toEqual([]);
    expect(profile.history).toEqual([]);
    expect(profile.preferences).toEqual([]);
  });
});
```

- [ ] **Step 6.2: 跑测试,验证失败**

Run: `bun test __tests__/user-profile-extension.test.ts`
Expected: FAIL — TypeScript error: `UserProfile` 缺 `role` 字段

- [ ] **Step 6.3: 扩展 `src/types/index.ts` 中的 `UserProfile`**

```typescript
// src/types/index.ts 中 UserProfile 接口扩展
export interface UserProfile {
  userId: string;
  department: string;
  commonSystems: string[];
  tags: string[];
  conversationCount: number;
  lastActiveAt: string;
  createdAt: string;
  updatedAt: string;
  
  // ===== 新增字段(本 spec 引入) =====
  role: string;
  permissions: string[];
  history: ProfileHistoryItem[];
  preferences: ProfilePreference[];
}

export interface ProfileHistoryItem {
  topic: string;
  summary: string;
  lastOccurredAt: string;
  occurrences: number;
}

export interface ProfilePreference {
  key: string;
  value: string;
  confidence: number;
}
```

- [ ] **Step 6.4: 修改 `src/user-profile/index.ts` `loadProfile`**

```typescript
// 修改 createDefaultProfile (第 63-75 行)
private createDefaultProfile(userId: string): UserProfile {
  const now = new Date().toISOString();
  return {
    userId,
    department: '财务部',
    commonSystems: [],
    tags: [],
    conversationCount: 0,
    lastActiveAt: now,
    createdAt: now,
    updatedAt: now,
    role: 'employee',
    permissions: [],
    history: [],
    preferences: [],
  };
}

// 修改 createUserProfile (第 111-126 行)
async createUserProfile(userId: string, initialData?: Partial<UserProfile>): Promise<UserProfile> {
  const now = new Date().toISOString();
  const profile: UserProfile = {
    userId,
    department: initialData?.department || '财务部',
    commonSystems: initialData?.commonSystems || [],
    tags: initialData?.tags || [],
    conversationCount: 0,
    lastActiveAt: now,
    createdAt: now,
    updatedAt: now,
    role: initialData?.role || 'employee',
    permissions: initialData?.permissions || [],
    history: initialData?.history || [],
    preferences: initialData?.preferences || [],
  };
  await this.saveProfile(profile);
  return profile;
}

// 修改 loadProfile (第 77-109 行) 末尾的 profiles[userId] 返回处
if (profiles[userId]) {
  // 缺失字段补全(向后兼容)
  return {
    ...profiles[userId],
    role: profiles[userId].role ?? 'employee',
    permissions: profiles[userId].permissions ?? [],
    history: profiles[userId].history ?? [],
    preferences: profiles[userId].preferences ?? [],
  };
}
```

- [ ] **Step 6.5: 跑测试,验证通过**

Run: `bun test __tests__/user-profile-extension.test.ts`
Expected: PASS(全部 3 个 test)

---

## Task 7: DynamicContextBuilder 新字段输出(缺口 2.2)

**Files**:
- Modify: `src/context/dynamic-context.ts`(`formatMemorySection` 增加 history / preferences 输出)
- Test: `__tests__/user-profile-context-builder.test.ts`

**Interfaces**:
- Consumes: 扩展 `UserProfile`(`src/types/index.ts`)
- Produces: `formatMemorySection` 输出 `## 用户上下文` 包含 history / preferences

- [ ] **Step 7.1: 写 context builder 测试**

```typescript
// __tests__/user-profile-context-builder.test.ts
import { describe, expect, test } from 'bun:test';
import { DynamicContextBuilder } from '../src/context/dynamic-context';
import type { UserMemory } from '../src/memory/memory-service';

describe('DynamicContextBuilder extended fields', () => {
  function makeMemory(profile: any): UserMemory {
    return { profile, episodicEntries: [] };
  }

  test('formats role and department', async () => {
    const builder = new DynamicContextBuilder({} as any);
    const memory = makeMemory({
      userId: 'u-1',
      role: 'admin',
      department: '财务部',
      commonSystems: ['OA'],
      tags: [],
      conversationCount: 5,
    });
    
    const out = (builder as any).formatMemorySection(memory, 'test');
    expect(out).toContain('用户ID: u-1');
    expect(out).toContain('角色: admin');
  });

  test('formats history top-10', async () => {
    const builder = new DynamicContextBuilder({} as any);
    const memory = makeMemory({
      userId: 'u-1',
      role: 'employee',
      department: '财务部',
      commonSystems: [],
      tags: [],
      conversationCount: 0,
      history: Array.from({ length: 15 }, (_, i) => ({
        topic: `topic-${i}`,
        summary: `summary-${i}`,
        lastOccurredAt: '2026-08-01',
        occurrences: 1,
      })),
    });

    const out = (builder as any).formatMemorySection(memory, 'test');
    expect(out).toContain('历史问题');
    const lineCount = (out.match(/topic-/g) || []).length;
    expect(lineCount).toBe(10);  // topN=10
  });

  test('formats preferences top-10', async () => {
    const builder = new DynamicContextBuilder({} as any);
    const memory = makeMemory({
      userId: 'u-1',
      role: 'employee',
      department: '财务部',
      commonSystems: [],
      tags: [],
      conversationCount: 0,
      preferences: [
        { key: 'response_style', value: 'concise', confidence: 0.8 },
      ],
    });

    const out = (builder as any).formatMemorySection(memory, 'test');
    expect(out).toContain('偏好');
    expect(out).toContain('response_style');
  });

  test('omits history when empty', async () => {
    const builder = new DynamicContextBuilder({} as any);
    const memory = makeMemory({
      userId: 'u-1',
      role: 'employee',
      department: '财务部',
      commonSystems: [],
      tags: [],
      conversationCount: 0,
    });

    const out = (builder as any).formatMemorySection(memory, 'test');
    expect(out).not.toContain('历史问题');
  });
});
```

- [ ] **Step 7.2: 跑测试,验证失败**

Run: `bun test __tests__/user-profile-context-builder.test.ts`
Expected: FAIL(因为 `formatMemorySection` 暂不输出 role/history/preferences)

- [ ] **Step 7.3: 修改 `src/context/dynamic-context.ts`**

```typescript
// src/context/dynamic-context.ts 中 formatMemorySection 替换
private formatMemorySection(memory: UserMemory, _userInput: string): string {
  const lines: string[] = ['## 用户上下文'];

  if (memory.profile) {
    lines.push('\n### 用户画像');
    lines.push(`- **用户ID**: ${memory.profile.userId}`);

    if (memory.profile.role) {
      lines.push(`- **角色**: ${memory.profile.role}`);
    }

    if (memory.profile.department) {
      lines.push(`- **部门**: ${memory.profile.department}`);
    }

    if (memory.profile.commonSystems && memory.profile.commonSystems.length > 0) {
      lines.push(`- **常用系统**: ${memory.profile.commonSystems.join(', ')}`);
    }

    if (memory.profile.tags && memory.profile.tags.length > 0) {
      lines.push(`- **标签**: ${memory.profile.tags.join(', ')}`);
    }

    lines.push(`- **对话次数**: ${memory.profile.conversationCount}`);

    // 新增:历史(topN=10)
    if (memory.profile.history && memory.profile.history.length > 0) {
      lines.push('\n### 历史问题(top10)');
      for (const h of memory.profile.history.slice(0, 10)) {
        lines.push(`- ${h.topic}: ${h.summary} (×${h.occurrences})`);
      }
    }

    // 新增:偏好(topN=10)
    if (memory.profile.preferences && memory.profile.preferences.length > 0) {
      lines.push('\n### 偏好(top10)');
      for (const p of memory.profile.preferences.slice(0, 10)) {
        lines.push(`- ${p.key}: ${p.value}`);
      }
    }
  }

  if (memory.episodicEntries && memory.episodicEntries.length > 0) {
    lines.push('\n### 对话历史');
    const historyContext = this.memoryService.buildContextPrompt(memory);
    if (historyContext) {
      lines.push(historyContext);
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 7.4: 跑测试,验证通过**

Run: `bun test __tests__/user-profile-context-builder.test.ts`
Expected: PASS(全部 4 个 test)

---

## Task 8: 归因分类常量(缺口 3.1)

**Files**:
- Create: `src/observability/attribution.ts`
- Test: `__tests__/attribution.test.ts`

**Interfaces**:
- Consumes: 无
- Produces: `Attribution` 常量 + `attributionCounter` 桩(`src/observability/attribution.ts`)

- [ ] **Step 8.1: 写归因测试**

```typescript
// __tests__/attribution.test.ts
import { describe, expect, test } from 'bun:test';
import { Attribution, attributionCounter } from '../src/observability/attribution';

describe('Attribution classification', () => {
  test('has 8 categories', () => {
    const categories = Object.values(Attribution);
    expect(categories).toHaveLength(8);
  });

  test('LLM-related categories', () => {
    expect(Attribution.LLM_TIMEOUT).toBe('LLM_TIMEOUT');
    expect(Attribution.LLM_RATE_LIMIT).toBe('LLM_RATE_LIMIT');
  });

  test('Skill-related categories', () => {
    expect(Attribution.SKILL_TIMEOUT).toBe('SKILL_TIMEOUT');
    expect(Attribution.SKILL_PARAM).toBe('SKILL_PARAM');
  });

  test('System categories', () => {
    expect(Attribution.HOOK_FAIL).toBe('HOOK_FAIL');
    expect(Attribution.STEER_RACE).toBe('STEER_RACE');
    expect(Attribution.INJECT_DENY).toBe('INJECT_DENY');
    expect(Attribution.UNKNOWN).toBe('UNKNOWN');
  });

  test('attributionCounter increments count', () => {
    attributionCounter.reset();
    attributionCounter.inc({ kind: 'LLM_TIMEOUT' });
    attributionCounter.inc({ kind: 'LLM_TIMEOUT' });
    attributionCounter.inc({ kind: 'SKILL_TIMEOUT' });
    const counts = attributionCounter.snapshot();
    expect(counts).toEqual({ LLM_TIMEOUT: 2, SKILL_TIMEOUT: 1 });
  });
});
```

- [ ] **Step 8.2: 跑测试,验证失败**

Run: `bun test __tests__/attribution.test.ts`
Expected: FAIL — "Cannot find module '../src/observability/attribution'"

- [ ] **Step 8.3: 实现 attribution.ts**

```typescript
// src/observability/attribution.ts
import { meter } from './otel';  // 桩实现,Task 10 替换

export const Attribution = {
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_RATE_LIMIT: 'LLM_RATE_LIMIT',
  SKILL_TIMEOUT: 'SKILL_TIMEOUT',
  SKILL_PARAM: 'SKILL_PARAM',
  HOOK_FAIL: 'HOOK_FAIL',
  STEER_RACE: 'STEER_RACE',
  INJECT_DENY: 'INJECT_DENY',
  UNKNOWN: 'UNKNOWN',
} as const;

export type AttributionType = typeof Attribution[keyof typeof Attribution];

interface Counter {
  inc(tags: Record<string, string>): void;
  reset(): void;
  snapshot(): Record<string, number>;
  dump(): Array<{ tags: Record<string, string>; count: number }>;
}

/**
 * 归因计数器(全局单例)
 * 阶段 1: 桩实现,内存计数
 * 阶段 2(Task 10): 由 OTel Counter 替换
 */
class AttributionCounter implements Counter {
  private counts = new Map<string, number>();

  inc(tags: Record<string, string>): void {
    const key = AttributionKey.from(tags);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  reset(): void {
    this.counts.clear();
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  dump(): Array<{ tags: Record<string, string>; count: number }> {
    return Array.from(this.counts.entries()).map(([key, count]) => ({
      tags: AttributionKey.parse(key),
      count,
    }));
  }
}

class AttributionKey {
  static from(tags: Record<string, string>): string {
    return Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  }
  static parse(key: string): Record<string, string> {
    return Object.fromEntries(key.split('&').map((kv) => kv.split('=') as [string, string]));
  }
}

export const attributionCounter = new AttributionCounter();
```

- [ ] **Step 8.4: 跑测试,验证通过**

Run: `bun test __tests__/attribution.test.ts`
Expected: PASS(全部 5 个 test)

---

## Task 9: SLA Watcher(缺口 3.2)

**Files**:
- Modify: `src/types/index.ts`(CONFIG 加 `SLA_*` 常量)
- Create: `src/observability/sla-watcher.ts`
- Test: `__tests__/sla-watcher.test.ts`

**Interfaces**:
- Consumes: `Attribution` / `attributionCounter`(`src/observability/attribution.ts`)
- Produces: `slaTracker`(`src/observability/sla-watcher.ts`)

- [ ] **Step 9.1: 写 SLA watcher 测试**

```typescript
// __tests__/sla-watcher.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { slaTracker, reportSlaBreach } from '../src/observability/sla-watcher';
import { attributionCounter } from '../src/observability/attribution';

describe('SlaTracker', () => {
  beforeEach(() => {
    attributionCounter.reset();
  });

  test('start/end records elapsed', () => {
    slaTracker.start('r-1', 1000);
    const check = slaTracker.check('r-1');
    expect(check.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(check.slaMs).toBe(1000);
  });

  test('check returns breached when over budget', async () => {
    slaTracker.start('r-2', 0);  // SLA=0 立即触发
    await new Promise((r) => setTimeout(r, 1));
    const check = slaTracker.check('r-2');
    expect(check.breached).toBe(true);
  });

  test('reportSlaBreach increments attribution counter', () => {
    reportSlaBreach('r-3', 'LLM', 5000, 3000);
    const counts = attributionCounter.snapshot();
    expect(counts).toHaveProperty('LLM_TIMEOUT');  // 复用 attribution 路径
  });

  test('unknown request returns no-records', () => {
    const check = slaTracker.check('not-started');
    expect(check.breached).toBe(false);
  });
});
```

- [ ] **Step 9.2: 跑测试,验证失败**

Run: `bun test __tests__/sla-watcher.test.ts`
Expected: FAIL

- [ ] **Step 9.3: 加 SLA 配置到 `src/types/index.ts`**

```typescript
// src/types/index.ts 中 CONFIG 加 SLA_*
export const CONFIG = {
  // ... existing
  
  // ===== SLA 阈值(本 spec 引入) =====
  SLA_SINGLE_TASK_MS: 30000,
  SLA_REQUEST_MS: 60000,
  SLA_RECOVERY_MS: 5000,
  SLA_LLM_CALL_MS: 30000,
  SLA_SKILL_CALL_MS: 15000,
  SLA_STEER_DRAIN_MS: 2000,
};
```

- [ ] **Step 9.4: 实现 sla-watcher.ts**

```typescript
// src/observability/sla-watcher.ts
import { attributionCounter } from './attribution';
import { auditLogger } from '../guardrail/audit-logger';

interface SlaRecord {
  startMs: number;
  slaMs: number;
}

export class SlaTracker {
  private records = new Map<string, SlaRecord>();

  start(requestId: string, slaMs: number): void {
    this.records.set(requestId, { startMs: Date.now(), slaMs });
  }

  check(requestId: string): { breached: boolean; elapsedMs: number; slaMs: number } {
    const r = this.records.get(requestId);
    if (!r) return { breached: false, elapsedMs: 0, slaMs: 0 };
    const elapsedMs = Date.now() - r.startMs;
    return { breached: elapsedMs > r.slaMs, elapsedMs, slaMs: r.slaMs };
  }

  mark(requestId: string, breached: boolean): void {
    const r = this.records.get(requestId);
    if (!r) return;
    this.records.delete(requestId);
    if (breached) {
      reportSlaBreach(requestId, 'GENERIC', Date.now() - r.startMs, r.slaMs);
    }
  }

  clear(requestId: string): void {
    this.records.delete(requestId);
  }
}

export const slaTracker = new SlaTracker();

/**
 * 静默告警:走 audit log + 归因计数器。
 * 阶段 1:占位 SlaBreachType。
 * 阶段 2(Task 10):replace with OTel counter.
 */
export type SlaBreachType = 'GENERIC' | 'LLM' | 'SKILL' | 'REQUEST' | 'STEER_DRAIN';

export function reportSlaBreach(requestId: string, kind: SlaBreachType, elapsedMs: number, slaMs: number): void {
  // 1. 归因
  attributionCounter.inc({ kind: 'SLA_BREACH', type: kind });
  // 2. 审计
  auditLogger.log({
    userId: 'system',
    action: 'alert',
    ruleName: `SLA_BREACH_${kind}`,
    reason: `${kind} SLA breached: ${elapsedMs}ms > ${slaMs}ms for ${requestId}`,
    contentPreview: `${kind} ${elapsedMs}/${slaMs}ms`,
    profile: { role: 'system', permissions: [] },
    decision: { action: 'alert', reason: `${kind} exceeded ${slaMs}ms`, ruleName: `SLA_BREACH_${kind}` },
  });
}
```

- [ ] **Step 9.5: 跑测试,验证通过**

Run: `bun test __tests__/sla-watcher.test.ts`
Expected: PASS(全部 4 个 test)

- [ ] **Step 9.6: 在 MainAgent processRequirement 处接入 SLA**

修改 `src/agents/main-agent.ts` 入口:

```typescript
import { slaTracker } from '../observability/sla-watcher';
import { CONFIG } from '../types';

async processRequirement(...) {
  slaTracker.start(req.requestId, CONFIG.SLA_REQUEST_MS);
  try {
    // ... existing logic
  } finally {
    const check = slaTracker.check(req.requestId);
    if (check.breached) {
      slaTracker.mark(req.requestId, true);
    } else {
      slaTracker.clear(req.requestId);
    }
  }
}
```

- [ ] **Step 9.7: 在 src/llm/index.ts 接入 LLM SLA**

```typescript
// src/llm/index.ts 的 makeToolRequestStream 入口
import { slaTracker, reportSlaBreach } from '../observability/sla-watcher';
import { CONFIG } from '../types';

async makeToolRequestStream(req: any, ...) {
  const slaId = `llm-${req.id ?? Date.now()}`;
  slaTracker.start(slaId, CONFIG.SLA_LLM_CALL_MS);
  try {
    // ... existing logic
  } catch (e) {
    const check = slaTracker.check(slaId);
    if (check.breached) {
      reportSlaBreach(slaId, 'LLM', check.elapsedMs, check.slaMs);
    }
    throw e;
  }
}
```

---

## Task 10: OpenTelemetry Bootstrap + 指标字典(缺口 4.1)

**Files**:
- Modify: `package.json`(加 OTel 依赖)
- Create: `src/observability/otel.ts`
- Create: `src/observability/metrics.ts`
- Test: `__tests__/otel-bootstrap.test.ts`

**Interfaces**:
- Consumes: OTel API
- Produces: `initOtel()` / `meter`(`src/observability/otel.ts`)
- Produces: 9 个 metric 实例(`src/observability/metrics.ts`)

- [ ] **Step 10.1: 加依赖**

```bash
cd /Users/dipu/exercise/ts-multi-agent
bun add @opentelemetry/api@^1.4.0 @opentelemetry/sdk-metrics@^1.13.0 @opentelemetry/exporter-prometheus@^0.40.0
```

- [ ] **Step 10.2: 写 OTel bootstrap 测试**

```typescript
// __tests__/otel-bootstrap.test.ts
import { describe, expect, test, beforeAll } from 'bun:test';
import { initOtel, meter } from '../src/observability/otel';

describe('OpenTelemetry bootstrap', () => {
  beforeAll(() => {
    initOtel();
  });

  test('meter is initialized', () => {
    expect(meter).toBeDefined();
  });

  test('can create counter', async () => {
    const counter = meter.createCounter('test.bootstrap.counter');
    expect(counter).toBeDefined();
    counter.add(1);
  });
});
```

- [ ] **Step 10.3: 跑测试,验证失败**

Run: `bun test __tests__/otel-bootstrap.test.ts`
Expected: FAIL

- [ ] **Step 10.4: 实现 otel.ts**

```typescript
// src/observability/otel.ts
import { metrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

let initialized = false;

export function initOtel(): void {
  if (initialized) return;
  
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider();
  provider.addMetricReader(exporter);
  metrics.setGlobalMeterProvider(provider);
  
  initialized = true;
}

export const meter = metrics.getMeter('ts-multi-agent', '1.0.0');

/**
 * 收集所有 metric 累积值,返回 JSON 友好结构。
 * 阶段 1:仅支持 counter / histogram(简单实现)。
 */
export async function collectOtelMetrics(): Promise<Record<string, any>> {
  // OTel SDK 的 collectorMetricReader.collect() 返回 MetricData
  // 阶段 1:从全局 meter 的所有 metrics 提取
  // 注:OTel 1.13 暂未提供直接 Json 序列化,使用内部 API
  // 实际生产环境推荐 Prometheus exporter /metrics endpoint
  return {};  // 占位
}
```

- [ ] **Step 10.5: 实现 metrics.ts**

```typescript
// src/observability/metrics.ts
import { meter } from './otel';

// LLM 维度
export const llmCalls = meter.createCounter('llm.calls', { description: 'LLM 调用次数' });
export const llmLatency = meter.createHistogram('llm.latency', { description: 'LLM 延迟', unit: 'ms' });
export const llmErrors = meter.createCounter('llm.errors', { description: 'LLM 错误次数' });

// Skill 维度
export const skillCalls = meter.createCounter('skill.calls', { description: 'Skill 调用次数' });
export const skillLatency = meter.createHistogram('skill.latency', { description: 'Skill 延迟', unit: 'ms' });
export const skillErrors = meter.createCounter('skill.errors', { description: 'Skill 错误次数' });

// 缺口 1 拦截(3 档)
export const guardrailDenied = meter.createCounter('guardrail.denied', { description: '拒绝次数' });
export const guardrailRewritten = meter.createCounter('guardrail.rewritten', { description: '改写次数' });
export const guardrailAlerted = meter.createCounter('guardrail.alerted', { description: '告警次数' });

// 缺口 3 归因 + SLA
export const slaBreached = meter.createCounter('sla.breached', { description: 'SLA 触发次数' });
```

- [ ] **Step 10.6: 跑测试,验证通过**

Run: `bun test __tests__/otel-bootstrap.test.ts`
Expected: PASS

---

## Task 11: `/metrics` 端点改造(缺口 4.2)

**Files**:
- Modify: `src/api/index.ts`(改造 `/metrics` 端点)
- Test: `__tests__/metrics-endpoint.test.ts`

**Interfaces**:
- Consumes: 现有 `taskQueue.getMetrics()` + `collectOtelMetrics()`
- Produces: `/metrics` 返回 `{ timestamp, task, otel }`

- [ ] **Step 11.1: 写 metrics 端点测试**

```typescript
// __tests__/metrics-endpoint.test.ts
import { describe, expect, test, beforeAll } from 'bun:test';
import { createApp } from '../src/api/index';
import { initOtel } from '../src/observability/otel';
import { llmCalls, guardrailDenied } from '../src/observability/metrics';

describe('/metrics endpoint', () => {
  beforeAll(() => {
    initOtel();
    llmCalls.add(3);
    guardrailDenied.add(2);
  });

  test('returns combined metrics', async () => {
    const app = await createApp();
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const res = await fetch(`http://localhost:${port}/metrics`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.timestamp).toBeDefined();
      expect(json.task).toBeDefined();
      expect(json.otel).toBeDefined();
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 11.2: 跑测试,验证失败**

Run: `bun test __tests__/metrics-endpoint.test.ts`
Expected: FAIL(`createApp` 未导出)

- [ ] **Step 11.3: 修改 `src/api/index.ts` `/metrics` 端点**

找到现有的:

```typescript
app.get('/metrics', (_req: Request, res: Response) => {
  const metrics = taskQueue.getMetrics();
  res.json({
    tasksCompleted: metrics.tasksCompleted,
    tasksFailed: metrics.tasksFailed,
    tasksTimedOut: metrics.tasksTimedOut,
    averageExecutionTime: Math.round(metrics.averageExecutionTime),
    totalExecutionTime: Math.round(metrics.totalExecutionTime),
  });
});
```

替换为:

```typescript
import { initOtel, collectOtelMetrics } from '../observability/otel';

// On app startup
initOtel();

app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const taskMetrics = taskQueue.getMetrics();
    const otelMetrics = await collectOtelMetrics();
    res.json({
      timestamp: new Date().toISOString(),
      task: {
        tasksCompleted: taskMetrics.tasksCompleted,
        tasksFailed: taskMetrics.tasksFailed,
        tasksTimedOut: taskMetrics.tasksTimedOut,
        averageExecutionTime: Math.round(taskMetrics.averageExecutionTime),
        totalExecutionTime: Math.round(taskMetrics.totalExecutionTime),
      },
      otel: otelMetrics,
    });
  } catch (err) {
    res.status(500).json({ error: 'metrics collection failed' });
  }
});
```

- [ ] **Step 11.4: 跑测试,验证通过**

Run: `bun test __tests__/metrics-endpoint.test.ts`
Expected: PASS

---

## Task 12: LLM / Skill Metrics 打点接入(缺口 4.3)

**Files**:
- Modify: `src/llm/index.ts`
- Modify: `src/agents/sub-agent.ts`

**Interfaces**:
- Consumes: `llmCalls` / `llmLatency` / `llmErrors` / `skillCalls` / `skillLatency` / `skillErrors`(`src/observability/metrics.ts`)
- Produces: 调用处增加 metrics 打点

- [ ] **Step 12.1: LLM 打点**

```typescript
// src/llm/index.ts 中 makeToolRequestStream 入口
import { llmCalls, llmLatency, llmErrors } from '../observability/metrics';

async makeToolRequestStream(req: any, ...) {
  const start = Date.now();
  const skillName = (req as any).skillName ?? 'unknown';
  try {
    // ... existing logic
    llmCalls.add(1, { skill: skillName });
    llmLatency.record(Date.now() - start, { skill: skillName });
    // ... return result
  } catch (e) {
    llmErrors.add(1, { kind: (e instanceof LLMError) ? e.type : 'UNKNOWN' });
    llmLatency.record(Date.now() - start, { skill: skillName });
    throw e;
  }
}
```

- [ ] **Step 12.2: Skill 打点**

```typescript
// src/agents/sub-agent.ts 中 toolExecutor
import { skillCalls, skillLatency, skillErrors } from '../observability/metrics';

const toolExecutor = async (toolCall: ...) => {
  const start = Date.now();
  skillCalls.add(1, { skill: skill.name, tool: toolCall.name });
  try {
    // ... existing tool execution
    skillLatency.record(Date.now() - start, { skill: skill.name, tool: toolCall.name });
  } catch (e) {
    skillErrors.add(1, { skill: skill.name, tool: toolCall.name });
    throw e;
  }
};
```

- [ ] **Step 12.3: 在 middlewares 中接入缺口 1 metrics**

```typescript
// src/guardrail/middleware.ts
import { guardrailDenied, guardrailRewritten, guardrailAlerted } from '../observability/metrics';

switch (decision.action) {
  case 'deny':
    guardrailDenied.add(1, { rule: decision.ruleName });
    // ...
    break;
  case 'rewrite':
    guardrailRewritten.add(1, { rule: decision.ruleName });
    // ...
    break;
  case 'alert':
    guardrailAlerted.add(1, { rule: decision.ruleName });
    // ...
    break;
}
```

- [ ] **Step 12.4: 跑 metrics 端点测试,验证字段出现**

Run: `bun test __tests__/metrics-endpoint.test.ts`
Expected: PASS(如果 collectOtelMetrics 已实现)

---

## Task 13: 回归测试 + 文档更新

**Files**:
- Test: 跑全部测试
- (可选)后续更新 `API.md`

- [ ] **Step 13.1: 跑全部测试**

Run: `bun test`
Expected: 全部 PASS

- [ ] **Step 13.2: 跑现有 e2e**

Run: `bun test __tests__/resilience-e2e.test.ts __tests__/api.test.ts`
Expected: PASS(上层韧性不破)

- [ ] **Step 13.3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错

---

## 验证方法(汇总)

1. **单元测试**:
   - `bun test __tests__/guardrail-*.test.ts` (Task 1-4)
   - `bun test __tests__/user-profile-*.test.ts` (Task 6-7)
   - `bun test __tests__/attribution.test.ts __tests__/sla-watcher.test.ts` (Task 8-9)
   - `bun test __tests__/otel-*.test.ts __tests__/metrics-*.test.ts` (Task 10-12)
   - 全部 PASS

2. **集成测试**:
   - `bun test __tests__/api.test.ts` 仍通过
   - `bun test __tests__/resilience-e2e.test.ts` 仍通过

3. **类型检查**:
   - `npx tsc --noEmit` 无错

4. **运行时手动验证**:
   - 启 dev server,发 `DROP TABLE users` → 返回 `transferToHuman: true`
   - 发 `身份证 110101199003078813` → 文本脱敏
   - LLM 调越权工具 → `/metrics` 中 `guardrail.denied` 增 1
   - 长时间任务(SLA 触发) → audit log 有 `SLA_BREACH_*` 记录
   - 访问 `/metrics` → 返回 `{ timestamp, task, otel }`

---

## Task 依赖关系

**实际推荐实施顺序**(考虑 Task 跨缺口依赖):

```
Task 1 (types + PII)            ← 缺口 1 基础
  ↓
Task 2 (keywords + rule-engine) ← 缺口 1.1
  ↓
Task 3 (audit-logger)           ← 缺口 1.2
  ↓
Task 6 (UserProfile 扩展)       ← 缺口 2(无跨依赖)
  ↓
Task 7 (ContextBuilder 输出)    ← 缺口 2.2(依赖 Task 6)
  ↓
Task 8 (归因常量 + 计数器)      ← 缺口 3.1
  ↓
Task 5 (越权 Skill 归因)        ← 缺口 1.4(依赖 Task 8)
  ↓
Task 4 (middleware + API 接入)  ← 缺口 1.3(依赖 Task 1/2/3 + Task 5)
  ↓
Task 9 (SLA watcher)            ← 缺口 3.2(依赖 Task 3 + Task 8)
  ↓
Task 10 (OTel bootstrap)        ← 缺口 4.1
  ↓
Task 11 (/metrics 端点)         ← 缺口 4.2(依赖 Task 10)
  ↓
Task 12 (LLM / Skill 打点)      ← 缺口 4.3(依赖 Task 10)
  ↓
Task 13 (回归测试)
```

**关键依赖**:
- **Task 5 跨缺口依赖 Task 8**:必须先 Task 8 才有 `attributionCounter`
- Task 9 依赖 Task 3 + Task 8(`reportSlaBreach` 用 `auditLogger` + `attributionCounter`)
- Task 12 依赖 Task 10(metrics 实例)
- Task 11 依赖 Task 10(metrics + `initOtel`)

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| OpenTelemetry 引入依赖安装失败 | 准备 fallback: 阶段 1 用 `prom-client` 自实现,接口同 |
| `UserProfile` 字段扩展破坏存量 JSON | 缺失字段补全(老 JSON 缺字段自动填默认) |
| Long ambiguous alert 误判 | 阈值 1500 字符,可调;后续可上 L2 兜底 |
| PII 误改写(同名巧合) | 正则严格匹配独立数字段,边界明确 |
| SLA 静默告警不易察觉 | 走 audit log + 指标,运维看板后期接 |
| metrics JSON 端点格式非标准 | 同时暴露 Prometheus exporter 自带 `/metrics/prom` |
| 缺口 1 拒绝走人工后无理由透出 | 记 audit + 返回 `transferToHuman: true, reason: ...` |
| OTel `collectOtelMetrics()` 阶段 1 实现简陋 | 阶段 2 优化,先保证接口稳定 |

---

## 备注

- **不 commit**: 用户明确约束,所有 Task 末尾的 `git commit` 步骤实际执行时**跳过**。
- **缺口 5 不动**: Task 列表中**没有 Task 5**,`vision-client.ts` 不修改。
- **缺口 6/7/8 v2 deferred**: 任何需求重新触发时,需要重新过 brainstorming。
- **IAM 接入**: 改 `UserProfileService` 构造函数参数 / 实现,Agent 零改动。
