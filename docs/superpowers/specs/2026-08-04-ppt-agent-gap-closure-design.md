# PPT 差距补齐 — 5 个 Agent 能力缺口闭环设计

> 基于 `详细设计输入.pdf` (S03384 IT 服务台 2.0) 与 ts-multi-agent 现状的对比,锁定 8 个 Agent 能力缺口。本 spec 闭环其中 5 个(Prompt 注入 / 画像扩展 / 失败归因与 SLA 预警 / 观测指标 / 多模态保留),3 个(满意度评价 / 跨会话记忆 / Provider fallback)Deferred 到 v2。
>
> 关联 spec:[`2026-08-03-llm-resilience-layer-design.md`](./2026-08-03-llm-resilience-layer-design.md) 已闭环 4 个韧性机制(stool-call-repair / safe compaction / 未知工具熔断 / steer 队列),本 spec 在其上层补齐"前端防护 + 治理闭环 + 观测能力"。

---

## Context

### 背景

2026-08-03 完成 OpenClaw 韧性机制 4 个落地后,差距清单上仍有**治理与防护层**的能力缺口。这些缺口直接对应 PPT 5-4 自评项("基本满足")和里程碑 3 验收条件("指标达到上线阈值")。

### 现状缺口(8 个,按优先级)

| # | 缺口 | PPT 依据 | 优先级 |
|---|------|---------|--------|
| 1 | Prompt 注入 + 越权调用拦截 | 5-4:基本满足 / 5-2:网络及应用安全 | 🔴 高 |
| 2 | 用户/系统画像 Skill | 场景示例 1/2(辅助定位 + 主动推送) | 🔴 高 |
| 3 | 失败归因 + SLA 预警 | 治理闭环(里程碑 3) | 🟡 中 |
| 4 | 观测指标体系 | 里程碑 3 验收条件 | 🟡 中 |
| 5 | 多模态识别 | 截图报错 / 4-5 模型清单 | 🟡 中 |
| 6 | 满意度评价 | 闭环数据回流 | 🟢 低(v2 deferred) |
| 7 | 跨会话长效记忆 | 主动推送"历史问题进度" | 🟢 低(v2 deferred) |
| 8 | Provider fallback | 多 provider 部署 / 限流 | 🟢 低(v2 deferred) |

### 期望产出

- **缺口 1**:用户输入经 L1 规则引擎过滤,违规/越权调用走人工兜底,审计日志可对账
- **缺口 2**:`UserProfile` 类型扩展 `role` / `permissions` / `history` / `preferences`,已知路径(本地 JSON→未来 IAM API)稳定,Agent 逻辑零改动
- **缺口 3**:失败按 6-8 类归因(`LLM_TIMEOUT` / `LLM_RATE_LIMIT` / `SKILL_TIMEOUT` / `SKILL_PARAM` / `HOOK_FAIL` / `STEER_RACE` / `INJECT_DENY` / `UNKNOWN`),SLA 阈值在前端 hardcode,触发时静默告警 + 请求标记
- **缺口 4**:OpenTelemetry 采集最小集指标(LLM / Skill / 拦截 / SLA + 归因),`/metrics` JSON 端点暴露,后期接 Prometheus/Grafana
- **缺口 5**:保留智谱 `glm-4v-flash`,无需新增工作

### 非目标(明确不做)

- 缺口 6/7/8 全部 v2 deferred(用户拍板)
- IAM 接口接入(**当前未对接**,画像读本地 JSON;后期 IAM 接入改 `UserProfileService` 实现,Agent 零改动)
- LLM 兜底(`L2 语义审查`):PPT 4-5 提到 Qwen3-0.6B 可选,但现阶段不引,先 L1 跑稳
- 文件解析(.pdf / .docx / .xlsx)与 OCR / 多模态处理模型:现阶段不做

---

## 设计决策(用户已锁定)

| 决策 | 选择 |
|------|------|
| 缺口 1 拦截入口 | `src/api/index.ts` API 层 |
| 缺口 1 LLM 守门 | 只 L1 规则引擎,不做 L2 |
| 缺口 1 拦截动作 | 硬规则三档:拒绝 / 改写 / 告警 |
| 缺口 1 拒绝反馈 | 走人工兜底 |
| 缺口 1 越权调用 | 读 Skill frontmatter 静态白名单 + 用户身份字段(不读 `userProfile.role`) |
| 缺口 1 `userProfile.role` 用途 | 仅数据权限(查工单/数据可见范围),不参与 Skill 权限 |
| 缺口 1 身份来源 | `UserProfileService.loadProfile(userId)` → 本地 JSON 文件 |
| 缺口 1 审计 | JSON 日志,本地落盘 |
| 缺口 2 画像形态 | 上下文注入(`DynamicContextBuilder`,已实现) |
| 缺口 2 字段扩展 | + `role` / `permissions` / `history`(topN) / `preferences`(topN) |
| 缺口 2 缓存 | 暂不加 |
| 缺口 2 系统画像 | Agent 不管 |
| 缺口 3 失败归因粒度 | 6-8 类(见 §9) |
| 缺口 3 SLA 阈值存放 | `src/types/index.ts` CONFIG 加 `SLA_*` 常量,hardcode |
| 缺口 3 SLA 预警 | 静默告警(走 audit log)+ 当次请求标记 `SLA_BREACHED` |
| 缺口 4 采集体系 | OpenTelemetry SDK(本地 meter provider) |
| 缺口 4 暴露端点 | `/metrics` JSON(自写 OTel → JSON 转换) |
| 缺口 4 字典 | 最小集(LLM / Skill / 拦截 / SLA + 归因) |
| 缺口 5 截图识别模型 | 保留智谱 `glm-4v-flash` |

### 为什么这样选

- **缺口 1 用 L1 不用 L2**:L2 引入额外 LLM 调用,延迟↑成本↑,且不一定准。L1 命中率高,审计可对账(PPT 5-2 要求"日志保留至少半年")
- **缺口 1 入口在 API 层**:用户 message 必经点,steer 路径再补一次仍走同入口
- **缺口 1 role 不参与 Skill 权限**:用户澄清 — `role` 是数据权限(查 OA 工单可见范围),不是 Agent 角色,Skill 权限走 frontmatter 白名单
- **缺口 2 topN 而非全量**:`history` / `preferences` 撑不爆 system prompt,LLM 看不到上百条历史
- **缺口 2 现状 `UserProfile` 已实现**:仅扩字段,不动现有 `loadProfile` / `saveProfile` 流程
- **缺口 3 6-8 类细归因**:粗 4 档(RETRYABLE/FATAL/USER_ERROR/SKILL_ERROR)无法回答"具体哪类失效",细分类便于治理看板
- **缺口 3 阈值 hardcode**:PPT 4-1 提到 SLA 目标由集团下发,现阶段直接写在代码里,后期可迁 Apollo
- **缺口 4 OTel + JSON 端点**:OTel 是云原生标准,后期接 Prometheus/Grafana/SkyWalking 零改动
- **缺口 5 保留智谱**:已稳定运行,无必要换;UI-TARS / qwen3-vl 等多模态处理模型现阶段不需要

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│              PPT Agent 能力差距补齐(本 spec)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────────┐    ┌──────────────────────────────┐   │
│  │ 缺口 1: Guardrail Layer   │    │ 缺口 2: UserProfile Extension │   │
│  │ (API 层入口)              │    │ (DynamicContextBuilder)       │   │
│  │                          │    │                               │   │
│  │  L1 规则引擎             │    │  UserProfile                  │   │
│  │  ├─ 关键词黑名单 → 拒绝  │    │  + role / permissions         │   │
│  │  ├─ PII 正则 → 改写脱敏  │    │  + history(topN)              │   │
│  │  └─ 可疑模式 → 告警      │    │  + preferences(topN)          │   │
│  │                          │    │                               │   │
│  │  Skill 越权检查          │    │  fields 不变,数据类型扩      │   │
│  │  (frontmatter 白名单)    │    │  Consumer 端 (IntentRouter)   │   │
│  │                          │    │  无需改                       │   │
│  └──────────┬───────────────┘    └──────────────┬───────────────┘   │
│             │                                  │                    │
│             ▼                                  ▼                    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 缺口 3: 失败归因 + SLA 预警(横切关注点)                          │   │
│  │                                                               │   │
│  │  AppError → 归因分类(6-8 类) → ErrorType 加 tag                │   │
│  │  CONFIG.SLA_* → 阈值检查 → SLA_BREACHED 标记 → 静默告警       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 缺口 4: 观测指标体系                                            │   │
│  │                                                               │   │
│  │  OpenTelemetry SDK                                             │   │
│  │  ├─ Counter: llm_calls / skill_calls / skill_attempts          │   │
│  │  ├─ Histogram: llm_latency / skill_latency                     │   │
│  │  ├─ Counter (tagged): guardrail_denied / disguised / alerted   │   │
│  │  └─ Counter: sla_breached / attribution.{LLM_TIMEOUT, ...}     │   │
│  │                                                               │   │
│  │  /metrics(JSON) ──► 后期 Prometheus/Grafana                    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────┐                                       │
│  │ 缺口 5: 多模态(保留)     │                                       │
│  │                          │                                       │
│  │  VisionLLMClient(已有)  │                                       │
│  │  glm-4v-flash 智谱         │                                       │
│  │  MainAgent 集成 已有      │                                       │
│  │  ── 无改动 ──            │                                       │
│  └──────────────────────────┘                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Task 1: Prompt 注入 + 越权调用拦截(缺口 1)

### 模块清单

| 模块 | 路径 | 状态 |
|------|------|------|
| 规则引擎 | `src/guardrail/rule-engine.ts` | 新建 |
| 关键词词表 | `src/guardrail/keywords.ts` | 新建 |
| PII 正则库 | `src/guardrail/pii-patterns.ts` | 新建 |
| 拦截中间件 | `src/guardrail/middleware.ts` | 新建 |
| 审计日志 | `src/guardrail/audit-logger.ts` | 新建 |
| 入口接入 | `src/api/index.ts` | 改 |
| 越权 Skill 调用拦截 | `src/agents/sub-agent.ts` | 改 |

### 核心接口

```typescript
// src/guardrail/types.ts
export type GuardrailAction = 'allow' | 'rewrite' | 'deny' | 'alert';

export interface GuardrailDecision {
  action: GuardrailAction;
  reason: string;          // 简要理由(记 audit)
  ruleName: string;        // 命中规则名(便于调阈值)
  rewrittenContent?: string;  // 仅 rewrite 时有
}

export interface GuardrailContext {
  userId: string;
  userRole: string;        // 来自 userProfile.role(数据权限)
  userPermissions: string[];  // 来自 userProfile.permissions
  sessionId: string;
  isSteerEntry: boolean;   // 是否 steer 队列注入
  source: 'user' | 'steer' | 'tool_result';  // 阶段 1 仅 user/steer
}

// src/guardrail/rule-engine.ts
export interface RuleEngine {
  // 阶段 1:仅 L1 规则
  evaluate(input: string, ctx: GuardrailContext): Promise<GuardrailDecision>;
}

// src/guardrail/middleware.ts (Express middleware)
export function guardrailMiddleware(): RequestHandler
```

### L1 规则集

**Action 划分**(硬规则型):

| 规则 | 触发 | Action | 用户反馈 |
|------|------|--------|---------|
| 黑名单关键字 | `DROP TABLE` / `rm -rf /` / `DAN` / `忽略之前指令` 等 | `deny` | 走人工兜底 |
| 越权 Skill 调用 | LLM 输出 `toolCall.name` 不在 Skill frontmatter `allowedTools` 列表 | `deny` | 走人工兜底 |
| PII 触发 | 身份证 / 银行卡 / 手机号 正则命中 | `rewrite` | 脱敏后继续 |
| 敏感词命中 | `机密` / `绝密` / `密码` 关键词 | `deny` | 走人工兜底 |
| 可疑模式 | 陌生可疑模式 / 不符合预期 | `alert` | 正常输出 + audit |

**关键词清单**(`src/guardrail/keywords.ts`):
```typescript
export const BLACKLIST_KEYWORDS = [
  // 注入
  'ignore previous instructions',
  '忽略之前指令',
  'DAN',
  'jailbreak',
  // 越权
  'DROP TABLE',
  'rm -rf /',
  // 敏感词
  '机密',
  '绝密',
  '密码',
];
```

**PII 正则**(`src/guardrail/pii-patterns.ts`):
```typescript
export const PII_PATTERNS = {
  idCard: /^\d{17}[\dXx]$/,
  bankCard: /^\d{16,19}$/,
  phoneCN: /^1[3-9]\d{9}$/,
};
```

### 拦截入口(API 层)

`src/api/index.ts` 在 `POST /tasks/stream` 入口处:

```typescript
app.post('/tasks/stream', async (req, res) => {
  const { userId, sessionId, content } = req.body;
  
  // 1. 加载用户画像
  const profile = await userProfileService.loadProfile(userId);
  
  // 2. L1 规则评估
  const decision = await ruleEngine.evaluate(content, {
    userId,
    userRole: profile.role,
    userPermissions: profile.permissions ?? [],
    sessionId,
    isSteerEntry: false,  // 后续 steer 路径另走一个 hook
    source: 'user',
  });
  
  // 3. 按 decision 处理
  switch (decision.action) {
    case 'deny':
      await auditLogger.log({ userId, content, decision, profile });
      // 走人工兜底(复用现有 path)
      return transferToHuman(userId, content, decision.reason);
    case 'rewrite':
      await auditLogger.log({ userId, content, decision });
      req.body.content = decision.rewrittenContent;
      break;
    case 'alert':
      await auditLogger.log({ userId, content, decision, alert: true });
      break;
    case 'allow':
      // pass through
      break;
  }
  
  // 4. 原有 processRequirement 流程
  // ...
});
```

### 越权 Skill 调用拦截

`src/agents/sub-agent.ts` 已经在 `allowedToolNames.has(toolCall.name)` 校验,**扩字段**:当不在白名单时,同步触发归因 `INJECT_DENY`(如果 LLM 之前已被 L1 放过,但仍调了非白名单工具,标归因到 `INJECT_DENY`):

```typescript
if (!allowedToolNames.has(toolCall.name)) {
  // 现有逻辑:熔断 / "工具不存在"
  // 新增:打归因点
  attributionCounter.inc({ rule: 'INJECT_DENY', tool: toolCall.name });
  // ...
}
```

### 审计日志

`src/guardrail/audit-logger.ts`:
```typescript
export interface AuditLogEntry {
  timestamp: string;
  traceId: string;
  userId: string;
  action: GuardrailAction;
  ruleName: string;
  reason: string;
  contentPreview: string;  // 不全文,前 200 字
  profile: { role: string; permissions: string[] };
  decision: GuardrailDecision;
}

export const auditLogger = {
  async log(entry: Omit<AuditLogEntry, 'timestamp' | 'traceId'>): Promise<void> {
    // 写入 JSON 文件:data/audit/YYYY-MM-DD.jsonl
  },
};
```

### 测试 `__tests__/guardrail.test.ts`

| Case | 行为 | 期望 |
|------|------|------|
| 黑名单命中 | `content = "ignore previous instructions..."` | `decision.action = 'deny'`,`ruleName = 'BLACKLIST_KEYWORD'` |
| PII 改写 | `content = "身份证 110101199003078813"` | `decision.action = 'rewrite'`,`rewrittenContent` 脱敏 |
| 越权 Skill | `toolCall.name = 'admin_reset'`(不在 allowedTools) | `toolCall` 被拒绝,归因 `INJECT_DENY` |
| 告警 | 不命中黑名单 / PII,但可疑较长 | `decision.action = 'alert'` |
| 拒绝走人工 | `action = 'deny'` | API 返回"转人工"路径 |
| 审计被记录 | 任意 `action != 'allow'` | `auditLogger.log()` 被调用,JSON 文件落盘 |

---

## Task 2: 用户画像字段扩展(缺口 2)

### 模块清单

| 模块 | 路径 | 状态 |
|------|------|------|
| `UserProfile` 类型 | `src/types/index.ts` | 改 |
| `UserProfileService` 兼容 | `src/user-profile/index.ts` | 改(向后兼容) |
| `DynamicContextBuilder` 字段输出 | `src/context/dynamic-context.ts` | 改 |

### 类型扩展

```typescript
// src/types/index.ts 扩展 UserProfile
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
  role: string;                    // 数据权限角色,如 'employee' / 'admin'
  permissions: string[];           // 数据权限列表,如 ['oa:read', 'finance:read']
  history: ProfileHistoryItem[];   // topN,默认 N=10
  preferences: ProfilePreference[]; // topN,默认 N=10
}

export interface ProfileHistoryItem {
  topic: string;
  summary: string;
  lastOccurredAt: string;  // ISO
  occurrences: number;     // 累计次数
}

export interface ProfilePreference {
  key: string;
  value: string;
  confidence: number;  // 0-1,多次确认后提升
}
```

### DynamicContextBuilder 字段输出

`src/context/dynamic-context.ts` `formatMemorySection` 调整:

```typescript
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
    
    // ... existing fields ...
    
    // 新增:历史(topN)
    if (memory.profile.history && memory.profile.history.length > 0) {
      lines.push('\n### 历史问题(topN)');
      for (const h of memory.profile.history.slice(0, 10)) {
        lines.push(`- ${h.topic}: ${h.summary} (×${h.occurrences})`);
      }
    }
    
    // 新增:偏好(topN)
    if (memory.profile.preferences && memory.profile.preferences.length > 0) {
      lines.push('\n### 偏好(topN)');
      for (const p of memory.profile.preferences.slice(0, 10)) {
        lines.push(`- ${p.key}: ${p.value}`);
      }
    }
  }

  // ... rest unchanged
}
```

### UserProfileService 兼容

新字段默为空 / 0,`loadProfile` 读 JSON 时做缺失字段补全:

```typescript
async loadProfile(userId: string): Promise<UserProfile> {
  // ... existing logic ...
  
  const profile = profiles[userId];
  
  // 缺失字段补全(向后兼容老 JSON)
  return {
    ...profile,
    role: profile.role ?? 'employee',
    permissions: profile.permissions ?? [],
    history: profile.history ?? [],
    preferences: profile.preferences ?? [],
  };
}
```

### 测试 `__tests__/user-profile-extension.test.ts`

| Case | 行为 | 期望 |
|------|------|------|
| 老 JSON 加载 | JSON 缺 `role` 字段 | 返回值 `role = 'employee'`(补全) |
| 新字段写入 | `updateProfile({ role: 'admin', permissions: ['finance:read'] })` | 保存到 JSON |
| DynamicContext 输出新字段 | `role = 'admin'`, `history = [{...}]` | 拼到 `## 用户上下文` 包含"角色"和"历史问题" |
| topN 截断 | `history.length = 20` | 输出只取前 10 |

---

## Task 3: 失败归因 + SLA 预警(缺口 3)

### 模块清单

| 模块 | 路径 | 状态 |
|------|------|------|
| 归因分类常量 | `src/observability/attribution.ts` | 新建 |
| SLA 阈值配置 | `src/types/index.ts` | 改 |
| SLA 检查中间件 | `src/observability/sla-watcher.ts` | 新建 |
| 归因打点接入 | `src/agents/sub-agent.ts` / `src/llm/index.ts` | 改 |

### 归因分类(6-8 类)

```typescript
// src/observability/attribution.ts
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
```

**归因映射规则**:

| 触发点 | 归因 |
|--------|------|
| `LLMError` `type === 'TIMEOUT'` | `LLM_TIMEOUT` |
| `LLMError` `type === 'RATE_LIMIT'` | `LLM_RATE_LIMIT` |
| Skill 执行超时(> `SKILL_TIMEOUT_MS`) | `SKILL_TIMEOUT` |
| Skill 参数 Zod 校验失败 | `SKILL_PARAM` |
| Hook 抛错 | `HOOK_FAIL` |
| 缺口 1 拒绝 / 越权 | `INJECT_DENY` |
| Steer 队列竞态(同 session 并发) | `STEER_RACE` |
| 其他未分类 | `UNKNOWN` |

### SLA 阈值配置

`src/types/index.ts` CONFIG 加:

```typescript
// SLA 阈值(本 spec 引入,hardcode)
SLA_SINGLE_TASK_MS: number;       // 单任务 SLA,默认 30000
SLA_REQUEST_MS: number;           // 单请求 SLA,默认 60000
SLA_RECOVERY_MS: number;          // 恢复 SLA(失败后重试),默认 5000
SLA_LLM_CALL_MS: number;          // LLM 调用 SLA,默认 30000
SLA_SKILL_CALL_MS: number;        // Skill 调用 SLA,默认 15000
SLA_STEER_DRAIN_MS: number;       // Steer 队列 drain SLA,默认 2000
```

### SLA Watcher

```typescript
// src/observability/sla-watcher.ts
export interface SlaTracker {
  start(requestId: string, slaMs: number): void;
  check(requestId: string): { breached: boolean; elapsedMs: number; slaMs: number };
  mark(requestId: string, breached: boolean): void;  // 终态,触发 audit
}

export const slaTracker = new SlaTracker();

// 静默告警:audit log + 指标,无前端提示
export function reportSlaBreach(requestId: string, kind: string, elapsedMs: number, slaMs: number): void {
  // 1. 写 audit log
  auditLogger.log({
    userId: 'system',
    action: 'alert',
    ruleName: `SLA_BREACH_${kind}`,
    reason: `${kind} SLA breached: ${elapsedMs}ms > ${slaMs}ms`,
    // ...
  });
  // 2. 归因计数器
  attributionCounter.inc({ kind: 'SLA_BREACH', type: kind });
}
```

### 接入点

**LLM 调用**(`src/llm/index.ts`):
```typescript
async makeToolRequestStream(...) {
  const start = Date.now();
  try {
    // ... existing logic
  } catch (e) {
    if (e instanceof LLMError) {
      const attr = e.type === 'TIMEOUT' ? 'LLM_TIMEOUT'
                 : e.type === 'RATE_LIMIT' ? 'LLM_RATE_LIMIT'
                 : 'UNKNOWN';
      attributionCounter.inc({ kind: 'LLM', type: attr });
      if (Date.now() - start > CONFIG.SLA_LLM_CALL_MS) {
        reportSlaBreach(req.id, 'LLM', Date.now() - start, CONFIG.SLA_LLM_CALL_MS);
      }
    }
    throw e;
  }
}
```

**Skill 调用**(`src/agents/sub-agent.ts` 类似)

**MainAgent 请求层**:
```typescript
async processRequirement(...) {
  const start = Date.now();
  // ... existing logic
  if (Date.now() - start > CONFIG.SLA_REQUEST_MS) {
    reportSlaBreach(req.requestId, 'REQUEST', Date.now() - start, CONFIG.SLA_REQUEST_MS);
  }
}
```

### 测试 `__tests__/attribution-sla.test.ts`

| Case | 行为 | 期望 |
|------|------|------|
| LLM 超时归因 | `LLMError('TIMEOUT')` | `attributionCounter` 增 `LLM_TIMEOUT` |
| LLM 限流归因 | `LLMError('RATE_LIMIT')` | 增 `LLM_RATE_LIMIT` |
| Skill 超时归因 | Skill 执行 16s(SLA 15s) | 增 `SKILL_TIMEOUT` + `reportSlaBreach` |
| 越权归因 | LLM 调 `admin_reset` 不在白名单 | 增 `INJECT_DENY`(任务 1 联动) |
| SLA 触发表 | `reportSlaBreach()` | audit log + counter 各增 1 |
| SLA 未触发 | 10s 完成(SLA 15s) | 不触发 |

---

## Task 4: 观测指标体系(缺口 4)

### 模块清单

| 模块 | 路径 | 状态 |
|------|------|------|
| OpenTelemetry 引导 | `src/observability/otel.ts` | 新建 |
| 指标字典 | `src/observability/metrics.ts` | 新建 |
| `/metrics` 端点 | `src/api/index.ts` | 改 |

### 引入依赖

```json
// package.json (新增)
{
  "@opentelemetry/api": "^1.4.0",
  "@opentelemetry/exporter-prometheus": "^0.40.0",
  "@opentelemetry/sdk-metrics": "^1.13.0"
}
```

### OTel 引导

```typescript
// src/observability/otel.ts
import { metrics } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

export function initOtel(): void {
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider();
  provider.addMetricReader(exporter);
  metrics.setGlobalMeterProvider(provider);
}

export const meter = metrics.getMeter('ts-multi-agent');
```

### 指标字典(最小集)

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
export const attributionCounter = meter.createCounter('attribution', { description: '失败归因计数' });
export const slaBreached = meter.createCounter('sla.breached', { description: 'SLA 触发次数' });
```

### `/metrics` 端点

现有 `src/api/index.ts:187` 已有 `/metrics` JSON 端点,改造为:

```typescript
app.get('/metrics', async (_req, res) => {
  // 1. 现有 TaskQueue 指标(保留)
  const taskMetrics = taskQueue.getMetrics();
  
  // 2. OTel 指标(转换)
  const otelMetrics = await collectOtelMetrics();
  
  res.json({
    timestamp: new Date().toISOString(),
    task: taskMetrics,
    otel: otelMetrics,
  });
});
```

`collectOtelMetrics()` 通过 `meter` 累积器读取,自定义转换函数(OTel SDK 的 JSON 序列化非标准)。

> **Backwards-compat(2026-08-05 补,Final Review fix #4)**:顶层 `queueSize` / `runningCount` 字段保留至 v2,旧探针可继续工作;后续在 SemVer 主版本允许下迁入 `task.{size,running}`。

### 接入点

**LLM 调用**(`src/llm/index.ts`):
```typescript
const start = Date.now();
try {
  // ... existing
  llmCalls.add(1, { skill: skillName });
  llmLatency.record(Date.now() - start, { skill: skillName });
} catch (e) {
  llmErrors.add(1, { kind: e.type });
  throw e;
}
```

**Skill 调用**(`src/agents/sub-agent.ts`):
```typescript
skillCalls.add(1, { skill: skill.name, tool: toolName });
// tool call 后:
skillLatency.record(Date.now() - start, { skill: skill.name });
```

**缺口 1 拦截**(`src/guardrail/middleware.ts`):
```typescript
switch (decision.action) {
  case 'deny': guardrailDenied.add(1, { rule: decision.ruleName }); break;
  case 'rewrite': guardrailRewritten.add(1, { rule: decision.ruleName }); break;
  case 'alert': guardrailAlerted.add(1, { rule: decision.ruleName }); break;
}
```

### 测试 `__tests__/metrics.test.ts`

| Case | 行为 | 期望 |
|------|------|------|
| LLM counter 累加 | `llmCalls.add(1)` × 3 | `/metrics` 中 `otel.llm.calls = 3` |
| Skill histogram 记录 | `skillLatency.record(100)` × 5 | histogram 累计 5 个 sample |
| 拦截分档 | `deny` × 2, `rewrite` × 1, `alert` × 1 | `guardrail.denied = 2`, `rewritten = 1`, `alerted = 1` |
| 归因分类型 | `LLM_TIMEOUT` × 1, `SKILL_TIMEOUT` × 1 | `attribution{LLM_TIMEOUT}` 和 `{SKILL_TIMEOUT}` 各 1 |
| SLA 触发 | `slaBreached.add(1, { type: 'LLM' })` | `sla.breached = 1` |

---

## Task 5: 多模态识别 — 保留现状(缺口 5)

### 决定

**不动**。已有 `src/agents/vision-client.ts` 289 行已实现,集成点 `MainAgent.processRequirement` 步骤 1 已就绪。

### 当前现状(留作参考)

- 模型:智谱 `glm-4v-flash`
- 集成:`MainAgent.processRequirement` 步骤 1,image attachment → vision 分析 → 拼到 requirement
- 已有:重试 / 超时 / Zod 校验

### 后续触发

- 当 PPT 4-5 模型清单的多模态处理模型需接入时(UI-TARS / qwen3-vl-30b)
- 当需要 .pdf / .docx / .xlsx 文件解析时
- 当集团 OCR 服务接入时

任一触发,再起 spec。

---

## v2 跟踪项(缺口 6/7/8)

| 缺口 | 触发条件 | 大概方案 |
|------|---------|---------|
| 6 满意度评价 | K2 评价 KPI 落地 / M3 上线前 | user message UI 加 5 星 + 标签接口;聚合存储 |
| 7 跨会话长效记忆 | 场景示例 2 "历史问题进度" 落地 | 记忆衰减策略 / 跨会话检索 / 隐私边界 |
| 8 Provider fallback | 多 provider 部署 / 限流事故 | FailoverError + 候选链路 + cooldown 缓存 |

**不在本 spec 闭环**,等业务触发。

---

## 关键文件路径速查(本 spec 涉及)

### 新建

```
src/guardrail/rule-engine.ts       # 缺口 1
src/guardrail/keywords.ts          # 缺口 1
src/guardrail/pii-patterns.ts      # 缺口 1
src/guardrail/middleware.ts        # 缺口 1
src/guardrail/audit-logger.ts      # 缺口 1
src/guardrail/types.ts             # 缺口 1
src/observability/attribution.ts   # 缺口 3
src/observability/sla-watcher.ts   # 缺口 3
src/observability/otel.ts          # 缺口 4
src/observability/metrics.ts       # 缺口 4
__tests__/guardrail.test.ts        # 缺口 1
__tests__/user-profile-extension.test.ts  # 缺口 2
__tests__/attribution-sla.test.ts  # 缺口 3
__tests__/metrics.test.ts          # 缺口 4
```

### 改

```
src/api/index.ts                   # 入口接入 + /metrics 改造
src/agents/sub-agent.ts            # 越权归因 + skill metrics
src/agents/main-agent.ts           # SLA 检查 + OTel 接入
src/llm/index.ts                   # LLM 归因 + metrics
src/types/index.ts                 # UserProfile 扩展 + SLA_* 配置
src/user-profile/index.ts          # 缺失字段补全
src/context/dynamic-context.ts     # 字段输出
src/events/request-lifecycle.ts    # 联动(本 spec 不直接改,可能被缺口 1 接入)
package.json                       # OTel 依赖
```

### 不动

```
src/agents/vision-client.ts        # 缺口 5(已满足)
```

---

## 验证方法

1. **单元测试**:`bun test __tests__/guardrail.test.ts` / `user-profile-extension.test.ts` / `attribution-sla.test.ts` / `metrics.test.ts` 通过
2. **集成测试**:`bun test __tests__/resilience-e2e.test.ts` 仍通过(上层韧性不破)
3. **类型检查**:`npx tsc --noEmit` 无错
4. **运行时手动验证**:
   - 启 dev server,发黑名单输入 → 应转人工
   - 发含身份证号输入 → 应脱敏返回
   - LLM 调越权工具 → 应记录 INJECT_DENY 归因
   - 长时间运行任务 → 触发 SLA 告警 + audit log
   - 访问 `/metrics` → 应返回 JSON 包含 LLM / Skill / 拦截 / 归因 / SLA 计数

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| L1 规则误杀正常输入 | 关键词列表迭代维护,定期 audit 反馈调整 |
| 拦截 audit log 体积膨胀 | 按天 JSONL 分割,后期可拆 TTL |
| OTel 引入新依赖导致安装失败 | 准备 fallback(用 prom-client 自实现) |
| `UserProfile` 字段扩展破坏存量 JSON | 后向兼容补全(老 JSON 缺新字段自动填默认值) |
| SLA 阈值 hardcode 后续难迁 | 写成 `CONFIG.SLA_*`,与 LLM_TIMEOUT_MS 同款,便于切换中心 |
| metrics JSON 端点格式非标准 | 暴露两套:`/metrics` (自定义 JSON) + 标准 Prometheus 端点由 exporter 自带(`/metrics/prom` 路径) |
| 缺口 2 history/preferences 字段膨胀 | topN 限制默认 10,LLM 看到不上百条 |
| 缺口 1 拒绝走人工后无理由透出 | 记 audit + 返回前端时显示"原因已记录" |

---

## 待用户 review

- [ ] 整体设计是否符合预期?
- [ ] 5 个缺口的边界是否准确?
- [ ] 关键模块路径是否合理?(`src/guardrail/` / `src/observability/`)
- [ ] 指标字典最小集是否够用?
- [ ] SLA 阈值默认值(SingleTask=30s, Request=60s, LLM=30s, Skill=15s, SteerDrain=2s)是否合理?
- [ ] 是否有未覆盖的需求?
