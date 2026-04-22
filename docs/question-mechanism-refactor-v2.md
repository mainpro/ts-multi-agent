# 询问机制重构设计方案 v2

## 一、现有问题诊断

### 1.1 架构层面

| # | 问题 | 位置 | 严重度 |
|---|------|------|--------|
| P1 | 主智能体判断"是否延续回答"使用完整 LLM 意图分类，过于重量级 | `handleWaitingQuestion` L151 | 🔴 高 |
| P2 | 子智能体"继续执行"实际是整个任务重新执行，`requirement` 被覆盖为用户回复 | `continueTask` L1112 | 🔴 高 |
| P3 | `handleWaitingQuestion` 和 `handleSuspendedTasks` 存在大量重复的轮询等待逻辑 | main-agent.ts L247-298, L1136-1204 | 🟡 中 |
| P4 | `waitingQuestions` 用 `Map<string, any>` 存储，缺乏类型安全 | main-agent.ts L31 | 🟡 中 |
| P5 | 挂起任务召回判断逻辑不够精确，依赖"不是新技能任务就恢复"的排除法 | `handleSuspendedTasks` L220 | 🟡 中 |
| P6 | `detectQuestion` 使用正则匹配，误判率高（任何包含"请选择"的文本都会被拦截） | sub-agent.ts L21-50 | 🟡 中 |

### 1.2 数据流层面

**当前流程（问题流程）：**
```
用户回复 → handleWaitingQuestion
  → LLM 完整意图分类（慢，~3-5s）
    → 判断为新任务 → 挂起
    → 判断为延续 → continueTask
      → requirement = userAnswer（原始需求丢失！）
      → status = pending（从头执行）
      → 子智能体看到 questionHistory（文本提示，不可靠）
        → LLM 自行决定跳过哪些步骤（不可控）
```

**期望流程：**
```
用户回复 → 轻量判断（快，~1s）
  → 延续回答 → 注入 answer 到子智能体上下文 → 子智能体从断点继续
  → 新意图 → 挂起当前任务 → 新意图识别 → 新任务
```

### 1.3 核心矛盾

当前设计的根本矛盾是：**子智能体是无状态的**。每次执行都是全新的 LLM 调用，只能通过 prompt 中的文本提示来"恢复"上下文。这导致：

1. 无法真正从断点继续 — LLM 可能重复已完成的步骤
2. `requirement` 被覆盖 — 原始需求信息丢失
3. `questionHistory` 只是文本 — 子智能体需要自己"理解"并跳过步骤

---

## 二、重构目标

### 2.1 核心原则

1. **子智能体决定是否询问** — 主智能体不干预
2. **主智能体轻量判断** — 用户回复后，快速判断是延续还是新意图
3. **子智能体从断点继续** — 不是从头执行，而是带着上下文继续
4. **挂起任务优先召回** — 用户几轮对话后再提起，能优先恢复
5. **类型安全** — 所有数据结构有明确类型定义

### 2.2 目标流程

```
用户 → 主智能体
  ├── 有 waitingQuestion?
  │     ├── 轻量判断 isContinuation(question, answer)  [~1s, 简短 prompt]
  │     │     ├── YES → continueTask(answer) → 子智能体继续执行
  │     │     └── NO  → suspendTask() → 新意图识别 → 新任务
  │     └── ...
  ├── 有 suspendedTasks?
  │     ├── 轻量判断 shouldRecall(task, userInput)  [~1s]
  │     │     ├── YES → resumeTask(task, userInput)
  │     │     └── NO  → 正常流程
  │     └── ...
  └── 正常流程 → 意图识别 → 任务规划 → 子智能体执行
        ├── 不需要询问 → 返回结果 → 完成
        └── 需要询问 → 返回 question → 标记 waiting → 等待用户
```

---

## 三、详细设计

### 3.1 新增类型定义

```typescript
// src/types/index.ts

// ========== 询问相关类型 ==========

/** 询问类型枚举 */
export type QuestionType = 'skill_question' | 'system_confirm' | 'skill_confirm';

/** 询问结构（类型安全） */
export interface Question {
  type: QuestionType;
  content: string;
  /** 技能自定义元数据 */
  metadata?: Record<string, unknown>;
  /** 产生此询问的任务 ID */
  taskId: string;
  /** 产生此询问的技能名 */
  skillName?: string;
}

/** 会话等待状态 */
export interface WaitingState {
  /** 等待中的问题 */
  question: Question;
  /** 关联的任务 ID */
  taskId: string;
  /** 关联的技能名 */
  skillName?: string;
  /** 等待开始时间 */
  waitedSince: Date;
  /** 原始需求（不被覆盖） */
  originalRequirement: string;
}

/** 延续判断结果 */
export type ContinuationResult =
  | { isContinuation: true; confidence: number }
  | { isContinuation: false; confidence: number; reason: string };

/** 任务状态扩展 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'suspended'
  | 'waiting';  // 新增：等待用户输入

/** Task 扩展字段 */
export interface Task {
  // ... 现有字段保持不变 ...

  // ===== 重构：增强询问历史 =====
  questionHistory?: QuestionHistoryEntry[];

  // ===== 重构：新增断点上下文 =====
  /** 子智能体的 LLM 对话上下文（用于断点续执行） */
  conversationContext?: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }>;

  /** 子智能体已完成的工具调用记录 */
  completedToolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result: string;
    timestamp: Date;
  }>;

  /** 子智能体的执行进度描述（自然语言，由子智能体自己维护） */
  executionProgress?: string;
}

/** 询问历史条目 */
export interface QuestionHistoryEntry {
  question: Question;
  answer: string;
  timestamp: Date;
}
```

### 3.2 新增：轻量延续判断器

**核心思想**：不使用完整的意图分类（需要加载技能列表、用户画像、历史记忆等），而是用一个极简的 prompt 让 LLM 快速判断。

```typescript
// src/agents/continuation-judge.ts

import { LLMClient } from '../llm';
import { Question, ContinuationResult } from '../types';

const CONTINUATION_JUDGE_PROMPT = `你是一个意图判断助手。你的唯一任务是判断用户最新的回复是否是对上一个问题的回答。

## 上一个问题
{questionContent}

## 用户最新回复
{userAnswer}

## 判断规则
1. 如果用户回复是在回答/回应上面的问题 → isContinuation: true
2. 如果用户回复是在提出新的问题/请求/话题 → isContinuation: false
3. 如果无法确定 → isContinuation: true（倾向于继续当前任务）

## 输出格式（JSON）
{"isContinuation": boolean, "confidence": 0.0-1.0, "reason": "简要理由"}`;

export class ContinuationJudge {
  constructor(private llm: LLMClient) {}

  /**
   * 轻量判断用户回复是否是对上一个问题的延续回答
   * 设计目标：快速（<1s）、低成本（短 prompt）
   */
  async judge(question: Question, userAnswer: string): Promise<ContinuationResult> {
    const prompt = CONTINUATION_JUDGE_PROMPT
      .replace('{questionContent}', question.content)
      .replace('{userAnswer}', userAnswer);

    try {
      const response = await this.llm.generateText(prompt);

      // 解析 JSON 响应
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed as ContinuationResult;
      }
    } catch (error) {
      console.warn('[ContinuationJudge] 判断失败，默认为延续:', error);
    }

    // 容错：判断失败时默认为延续（保守策略）
    return { isContinuation: true, confidence: 0.5 };
  }
}
```

### 3.3 新增：挂起任务召回器

```typescript
// src/agents/task-recaller.ts

import { LLMClient } from '../llm';
import { Task } from '../types';

const TASK_RECALL_PROMPT = `你是一个任务召回判断助手。判断用户的新消息是否与某个挂起的任务相关。

## 挂起的任务
任务描述: {taskRequirement}
技能: {skillName}
挂起时间: {suspendedAt}

## 用户最新消息
{userMessage}

## 判断规则
1. 用户消息提到与任务相关的关键词/系统/操作 → 应该召回
2. 用户消息明显是全新话题 → 不召回
3. 用户消息模糊但可能相关 → 倾向于召回

## 输出格式（JSON）
{"shouldRecall": boolean, "confidence": 0.0-1.0, "reason": "简要理由"}`;

export class TaskRecaller {
  constructor(private llm: LLMClient) {}

  /**
   * 判断用户消息是否应该触发挂起任务的召回
   */
  async shouldRecall(task: Task, userMessage: string): Promise<{
    shouldRecall: boolean;
    confidence: number;
    reason: string;
  }> {
    const prompt = TASK_RECALL_PROMPT
      .replace('{taskRequirement}', task.requirement)
      .replace('{skillName}', task.skillName || '未知')
      .replace('{suspendedAt}', task.startedAt?.toISOString() || '未知')
      .replace('{userMessage}', userMessage);

    try {
      const response = await this.llm.generateText(prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.warn('[TaskRecaller] 召回判断失败:', error);
    }

    return { shouldRecall: false, confidence: 0.3, reason: '判断失败' };
  }
}
```

### 3.4 重构：主智能体 (MainAgent)

#### 3.4.1 替换 `waitingQuestions` 为类型安全的 `WaitingState`

```typescript
// 之前
private waitingQuestions: Map<string, any> = new Map();

// 之后
private waitingStates: Map<string, WaitingState> = new Map();
```

#### 3.4.2 重写 `handleWaitingQuestion`

**核心变化**：
- 使用 `ContinuationJudge` 替代完整 LLM 意图分类
- 不再覆盖 `requirement`，保留原始需求
- 将用户回复作为 `latestUserAnswer` 传递

```typescript
private async handleWaitingQuestion(
  sessionId: string,
  waitingState: WaitingState,
  userAnswer: string,
  userId: string,
  imageAttachment?: { data: Buffer; mimeType: string; originalName?: string },
  options?: { planMode?: boolean }
): Promise<TaskResult> {
  console.log(`[MainAgent] 🔄 检测到等待的问题: ${waitingState.question.type}`);

  // ===== 核心变化：轻量延续判断 =====
  const judgeResult = await this.continuationJudge.judge(
    waitingState.question,
    userAnswer
  );

  console.log(
    `[MainAgent] 🎯 延续判断: ${judgeResult.isContinuation} ` +
    `(置信度: ${judgeResult.confidence})`
  );

  if (!judgeResult.isContinuation) {
    // ===== 用户切换了话题 → 挂起当前任务 =====
    console.log(`[MainAgent] 📌 用户切换话题，挂起当前任务`);

    const currentTask = this.taskQueue.getTask(waitingState.taskId);
    if (currentTask) {
      currentTask.status = 'suspended';
    }

    // 清除等待状态
    this.waitingStates.delete(sessionId);

    // 清除会话上下文
    sessionContextService.updateContext(sessionId, {
      currentSkill: undefined,
      currentSystem: undefined,
      currentTopic: undefined,
      tempVariables: new Map(),
    } as any);

    // 走正常流程
    return this.processNormalRequirement(
      userAnswer, imageAttachment, userId, sessionId, options
    );
  }

  // ===== 延续回答 → 继续执行当前任务 =====
  console.log(`[MainAgent] ✅ 延续回答，继续执行任务`);
  return this.continueTask(sessionId, waitingState, userAnswer, userId);
}
```

#### 3.4.3 重写 `continueTask`（核心重构）

**核心变化**：
1. **不覆盖 `requirement`** — 保留原始需求
2. **传递 `latestUserAnswer`** — 作为新字段让子智能体知道最新回复
3. **保留 `conversationContext`** — 子智能体的 LLM 对话历史不丢失
4. **提取公共轮询逻辑** — 消除重复代码

```typescript
/**
 * 继续执行任务（处理用户对询问的回复）
 *
 * 核心设计：
 * - 不覆盖 requirement（保留原始需求）
 * - 将用户回复作为 latestUserAnswer 传递
 * - 保留 conversationContext（子智能体的 LLM 对话历史）
 */
private async continueTask(
  sessionId: string,
  waitingState: WaitingState,
  userAnswer: string,
  _userId: string
): Promise<TaskResult> {
  console.log(`[MainAgent] 🔄 继续执行任务，用户回复: "${userAnswer}"`);

  const previousTask = this.taskQueue.getTask(waitingState.taskId);

  if (!previousTask) {
    return {
      success: false,
      error: {
        type: 'FATAL',
        message: '任务不存在',
        code: 'TASK_NOT_FOUND',
      },
    };
  }

  // ===== 核心变化 1：添加询问历史（不覆盖 requirement） =====
  previousTask.questionHistory = previousTask.questionHistory || [];
  previousTask.questionHistory.push({
    question: waitingState.question,
    answer: userAnswer,
    timestamp: new Date(),
  });

  // ===== 核心变化 2：保留原始 requirement，用 params 传递最新回复 =====
  // previousTask.requirement 保持不变！
  previousTask.params = previousTask.params || {};
  previousTask.params.latestUserAnswer = userAnswer;

  // ===== 核心变化 3：保留 conversationContext（不断点重置） =====
  // conversationContext 在子智能体执行时会被更新，这里不清除

  // 清除等待状态
  this.waitingStates.delete(sessionId);

  // 重置任务状态为 pending
  previousTask.status = 'pending';
  previousTask.result = undefined;
  previousTask.error = undefined;

  // 保存 taskId 到 SessionContext
  sessionContextService.updateContext(sessionId, {
    tempVariables: { taskId: waitingState.taskId },
  } as any);

  console.log(
    `[MainAgent] 📝 任务已准备继续执行: ${waitingState.taskId} ` +
    `(原始需求保留, 询问历史: ${previousTask.questionHistory.length}条)`
  );

  // 触发 TaskQueue 处理
  this.taskQueue.triggerProcess();

  // 使用公共轮询方法
  return this.pollTaskCompletion(waitingState.taskId, sessionId, _userId);
}
```

#### 3.4.4 提取公共轮询逻辑

```typescript
/**
 * 公共任务完成轮询逻辑
 * 消除 continueTask 和 handleSuspendedTasks 中的重复代码
 */
private async pollTaskCompletion(
  taskId: string,
  sessionId: string,
  _userId: string
): Promise<TaskResult> {
  const maxWaitTime = 60000;
  const pollInterval = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const task = this.taskQueue.getTask(taskId);

    if (!task) {
      return {
        success: false,
        error: { type: 'FATAL', message: '任务丢失', code: 'TASK_LOST' },
      };
    }

    if (task.status === 'completed') {
      return this.handleTaskCompletion(task, sessionId, _userId);
    }

    if (task.status === 'failed') {
      return {
        success: false,
        error: task.error || {
          type: 'FATAL',
          message: '任务执行失败',
          code: 'TASK_FAILED',
        },
      };
    }

    await this.sleep(pollInterval);
  }

  return {
    success: false,
    error: { type: 'FATAL', message: '任务执行超时', code: 'TASK_TIMEOUT' },
  };
}

/**
 * 处理任务完成后的结果检查
 * 统一处理：新询问、意图重分类、正常完成
 */
private handleTaskCompletion(
  task: Task,
  sessionId: string,
  _userId: string
): TaskResult {
  const taskResult = task.result || { success: true, data: {} };
  const skillData = (taskResult as { data?: SkillExecutionResult }).data;

  // 检查是否又产生了新的询问
  if (skillData?.status === 'waiting_user_input' && skillData.question) {
    const question: Question = {
      type: skillData.question.type || 'skill_question',
      content: skillData.question.content,
      metadata: skillData.question.metadata,
      taskId: task.id,
      skillName: task.skillName,
    };

    this.waitingStates.set(sessionId, {
      question,
      taskId: task.id,
      skillName: task.skillName,
      waitedSince: new Date(),
      originalRequirement: task.requirement,
    });

    sessionContextService.updateContext(sessionId, {
      tempVariables: { taskId: task.id },
    } as any);

    sessionContextService.addAssistantMessage(sessionId, question.content);

    return {
      success: true,
      data: {
        message: question.content,
        type: 'question',
        question,
      },
    };
  }

  // 检查是否需要意图重分类
  if (skillData?.status === 'needs_intent_reclassification') {
    sessionContextService.updateContext(sessionId, {
      currentSkill: undefined,
      currentSystem: undefined,
      currentTopic: undefined,
      tempVariables: new Map(),
    } as any);

    // 注意：这里需要传入原始 requirement 而非用户回复
    return this.processNormalRequirement(
      task.requirement, undefined, _userId, sessionId
    );
  }

  return taskResult;
}
```

#### 3.4.5 重写 `handleSuspendedTasks`

**核心变化**：
- 使用 `TaskRecaller` 替代完整 LLM 意图分类
- 支持多个挂起任务的优先级排序
- 使用公共轮询逻辑

```typescript
private async handleSuspendedTasks(
  sessionId: string,
  suspendedTasks: Task[],
  requirement: string,
  userId: string
): Promise<TaskResult | undefined> {
  console.log(`[MainAgent] 🔄 检测到挂起的任务: ${suspendedTasks.length} 个`);

  // ===== 核心变化：逐个判断是否应该召回 =====
  // 按挂起时间倒序排列（最近的优先）
  const sortedTasks = [...suspendedTasks].sort((a, b) =>
    (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)
  );

  for (const task of sortedTasks) {
    const recallResult = await this.taskRecaller.shouldRecall(task, requirement);

    console.log(
      `[MainAgent] 📊 召回判断: 任务 ${task.id} → ` +
      `${recallResult.shouldRecall} (置信度: ${recallResult.confidence})`
    );

    if (recallResult.shouldRecall && recallResult.confidence >= 0.6) {
      console.log(`[MainAgent] 📌 召回任务 ${task.id}`);

      // 恢复任务状态
      task.status = 'pending';

      // 将用户消息作为最新回复注入
      task.params = task.params || {};
      task.params.latestUserAnswer = requirement;

      // 保存到 SessionContext
      sessionContextService.updateContext(sessionId, {
        tempVariables: { taskId: task.id },
        currentSkill: task.skillName,
      } as any);

      // 触发执行
      this.taskQueue.triggerProcess();

      // 轮询等待
      return this.pollTaskCompletion(task.id, sessionId, userId);
    }
  }

  console.log(`[MainAgent] 🔄 无任务需要召回，继续正常流程`);
  return undefined;
}
```

#### 3.4.6 更新 `processRequirement` 入口

```typescript
async processRequirement(
  requirement: string,
  imageAttachment?: { data: Buffer; mimeType: string; originalName?: string },
  userId: string = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  sessionId?: string,
  options?: { planMode?: boolean }
): Promise<TaskResult> {
  const effectiveSessionId = sessionId || userId;

  try {
    console.log(`[MainAgent] 📥 收到用户请求: "${requirement}"`);
    sessionContextService.addUserMessage(effectiveSessionId, requirement);

    // 图片分析（保持不变）
    // ...

    // ========== 步骤 1.5: 检查等待状态 ==========
    const waitingState = this.waitingStates.get(effectiveSessionId);

    if (waitingState) {
      return this.handleWaitingQuestion(
        effectiveSessionId, waitingState, requirement, userId, imageAttachment, options
      );
    }

    // ========== 步骤 1.6: 检查挂起任务 ==========
    const suspendedTasks = this.taskQueue.getAllTasks().filter(task =>
      task.status === 'suspended' && task.sessionId === effectiveSessionId
    );

    if (suspendedTasks.length > 0) {
      const result = await this.handleSuspendedTasks(
        effectiveSessionId, suspendedTasks, requirement, userId
      );
      if (result) {
        return result;
      }
    }

    // ========== 正常流程 ==========
    return this.processNormalRequirement(
      requirement, imageAttachment, userId, effectiveSessionId, options
    );
  } catch (error) {
    // ...
  }
}
```

#### 3.4.7 更新 `processNormalRequirement` 中的等待状态保存

```typescript
// 在 processNormalRequirement 中，检查子任务结果的等待状态

if (skillResult?.status === 'waiting_user_input' && skillResult.question) {
  console.log(`[MainAgent] 🔄 检测到子任务 ${tr.taskId} 需要用户输入`);

  // ===== 核心变化：使用 WaitingState 替代裸 question =====
  const question: Question = {
    type: skillResult.question.type || 'skill_question',
    content: skillResult.question.content,
    metadata: skillResult.question.metadata,
    taskId: tr.taskId,
    skillName: tr.skillName,
  };

  this.waitingStates.set(sessionId, {
    question,
    taskId: tr.taskId,
    skillName: tr.skillName,
    waitedSince: new Date(),
    originalRequirement: tr.requirement || requirement,
  });

  sessionContextService.updateContext(sessionId, {
    tempVariables: { taskId: tr.taskId },
  } as any);

  sessionContextService.addAssistantMessage(sessionId, question.content);

  return {
    success: true,
    data: {
      message: question.content,
      type: 'question',
      question,
    },
  };
}
```

### 3.5 重构：子智能体 (SubAgent)

#### 3.5.1 核心变化：支持断点续执行

**设计思路**：子智能体在执行过程中，将 LLM 的对话上下文（messages）保存到 `task.conversationContext`。当任务需要继续执行时，这些上下文会被恢复，LLM 可以从断点处继续。

```typescript
// src/agents/sub-agent.ts

export class SubAgent {
  // ... 现有字段 ...

  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('SubAgent');

    try {
      // ... 现有的 skill 加载逻辑保持不变 ...

      const result = await this.executeSkill(
        task.requirement,
        skill,
        task.params,
        task.sessionId,
        task.userId,
        task.questionHistory,
        task.conversationContext,  // 新增：传入保存的对话上下文
        task.completedToolCalls,   // 新增：传入已完成的工具调用
        signal
      );

      // ===== 核心变化：保存对话上下文到任务 =====
      if (result._conversationContext) {
        task.conversationContext = result._conversationContext;
      }
      if (result._completedToolCalls) {
        task.completedToolCalls = result._completedToolCalls;
      }
      if (result._executionProgress) {
        task.executionProgress = result._executionProgress;
      }

      // 清理内部字段，不暴露给外部
      const { _conversationContext, _completedToolCalls, _executionProgress, ...cleanResult } = result;

      return { success: true, data: cleanResult };
    } catch (error) {
      return { success: false, error: this.classifyError(error) };
    } finally {
      llmEvents.setAgent(previousAgent);
    }
  }

  private async executeSkill(
    requirement: string,
    skill: Skill,
    params?: Record<string, unknown>,
    sessionId?: string,
    userId?: string,
    questionHistory?: QuestionHistoryEntry[],
    conversationContext?: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: any[] }>,  // 新增
    completedToolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result: string; timestamp: Date }>,  // 新增
    signal?: AbortSignal
  ): Promise<SkillExecutionResult & {
    _conversationContext?: any[];
    _completedToolCalls?: any[];
    _executionProgress?: string;
  }> {
    const skillRootDir = './skills/' + skill.name;
    const absoluteSkillRootDir = require('path').resolve(skillRootDir);

    // ===== 核心变化：构建增强的 system prompt =====
    const systemPrompt = this.buildEnhancedPrompt(
      skill.body,
      absoluteSkillRootDir,
      params,
      questionHistory,
      completedToolCalls,
      userId
    );

    const allTools = this.toolRegistry.list();
    // ... 工具过滤逻辑保持不变 ...

    // ===== 核心变化：恢复或初始化对话上下文 =====
    let messages: Message[];

    if (conversationContext && conversationContext.length > 0) {
      // 断点续执行：恢复之前的对话上下文
      messages = conversationContext.map(msg => ({
        role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
        content: msg.content,
        tool_call_id: msg.tool_call_id,
        tool_calls: msg.tool_calls,
      }));

      // 追加用户最新回复（从 params 中获取）
      const latestAnswer = params?.latestUserAnswer as string | undefined;
      if (latestAnswer) {
        messages.push({
          role: 'user',
          content: `[用户回复] ${latestAnswer}\n\n请根据以上对话上下文和用户的最新回复，继续执行任务。不要重复已经完成的步骤。`,
        });
      }

      console.log(
        `[SubAgent] 🔄 断点续执行: 恢复 ${messages.length} 条对话上下文` +
        (latestAnswer ? `，最新回复: "${latestAnswer.substring(0, 50)}..."` : '')
      );
    } else {
      // 首次执行：使用标准流程
      messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: requirement });
    }

    // ===== 核心变化：跟踪工具调用和对话上下文 =====
    const trackedToolCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
      result: string;
      timestamp: Date;
    }> = [...(completedToolCalls || [])];

    const result = await this.llm.generateWithToolsTracked(
      messages,
      tools,
      async (toolCall) => {
        // ... 工具执行逻辑保持不变 ...

        // 记录工具调用
        trackedToolCalls.push({
          name: toolCall.name,
          arguments: toolCall.arguments,
          result: toolResult,
          timestamp: new Date(),
        });

        return toolResult;
      },
      signal,
      concurrencyChecker
    );

    const response = result.content;

    // 检测询问
    const question = detectQuestion(response);
    if (question) {
      return {
        response,
        status: 'waiting_user_input',
        question: {
          type: 'skill_question',
          content: question.content,
          metadata: question.metadata,
        },
        // 保存上下文用于断点续执行
        _conversationContext: result.messages,
        _completedToolCalls: trackedToolCalls,
        _executionProgress: response,
      };
    }

    return {
      response,
      // 正常完成时也保存上下文（以防后续需要）
      _conversationContext: result.messages,
      _completedToolCalls: trackedToolCalls,
      _executionProgress: response,
    };
  }

  /**
   * 构建增强的系统提示
   */
  private buildEnhancedPrompt(
    skillBody: string,
    skillRootDir: string,
    params?: Record<string, unknown>,
    questionHistory?: QuestionHistoryEntry[],
    completedToolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result: string; timestamp: Date }>,
    userId?: string
  ): string {
    // 使用现有的 buildSubAgentPrompt 作为基础
    let prompt = buildSubAgentPrompt(skillBody, skillRootDir, params, questionHistory, userId);

    // 如果有已完成的工具调用，添加摘要
    if (completedToolCalls && completedToolCalls.length > 0) {
      const summary = completedToolCalls
        .map((tc, i) => `### 已完成步骤 ${i + 1}\n- 工具: ${tc.name}\n- 参数: ${JSON.stringify(tc.arguments)}\n- 结果: ${tc.result.substring(0, 200)}${tc.result.length > 200 ? '...' : ''}`)
        .join('\n\n');

      prompt += `\n\n## 已完成的执行步骤\n以下是之前已经执行过的步骤，请勿重复执行：\n${summary}`;
    }

    return prompt;
  }
}
```

#### 3.5.2 LLM 客户端扩展：跟踪对话上下文

需要在 `LLMClient` 中新增一个方法，返回完整的 messages 数组（而不仅仅是最终 content）：

```typescript
// src/llm/index.ts - 新增方法

/**
 * generateWithTools 的变体，返回完整的 messages 数组用于上下文恢复
 */
async generateWithToolsTracked(
  prompt: string,
  tools: ToolDefinition[],
  toolExecutor: (toolCall: { name: string; arguments: Record<string, unknown> }) => Promise<string>,
  systemPrompt?: string,
  signal?: AbortSignal,
  concurrencyChecker?: (toolName: string, toolArgs: Record<string, unknown>) => boolean
): Promise<{ content: string; toolCalls: ToolCallResult[]; messages: Message[] }> {
  const messages: Message[] = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  messages.push({ role: 'user', content: prompt });

  const toolCallsResults: ToolCallResult[] = [];
  let maxIterations = 10;

  while (maxIterations-- > 0) {
    const result = await this.makeToolRequestStream(messages, tools, signal);

    if (!result.message) {
      throw new LLMError('API_ERROR', 'No message in response');
    }

    const message = result.message;

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return {
        content: message.content || '',
        toolCalls: toolCallsResults,
        messages,  // 返回完整的 messages
      };
    }

    // 添加 assistant 消息（含 tool_calls）
    messages.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: message.tool_calls?.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    } as Message);

    // 执行工具（与现有 generateWithTools 逻辑相同）
    // ... 并行/串行执行逻辑 ...

    // 添加 tool 消息
    for (const tcResult of toolCallsResults) {
      messages.push({
        role: 'tool',
        content: tcResult.result,
        tool_call_id: tcResult.id,
      });
    }
  }

  throw new LLMError('API_ERROR', 'Max tool call iterations reached');
}
```

> **注意**：`generateWithToolsTracked` 的核心逻辑与 `generateWithTools` 几乎相同，唯一区别是返回值中包含 `messages`。可以考虑重构为 `generateWithTools` 增加一个 `options.trackMessages` 参数，避免代码重复。

### 3.6 重构：detectQuestion 优化

**问题**：当前的正则匹配过于激进，任何包含"请选择"的文本都会被拦截，包括技能文档中的示例文本。

**方案**：改为 LLM 判断 + 正则预过滤的组合策略。

```typescript
// src/agents/sub-agent.ts

/**
 * 检测 LLM 输出是否包含向用户提问的意图
 *
 * 策略：正则预过滤 + 上下文判断
 * - 正则匹配：快速排除明显不是提问的文本
 * - 上下文判断：检查是否是对工具调用结果的总结（而非真正的提问）
 */
export function detectQuestion(
  response: string,
  toolCallResults?: ToolCallResult[]
): { content: string; metadata?: Record<string, unknown> } | null {
  if (!response || response.trim().length === 0) {
    return null;
  }

  // 快速排除：如果响应以明确的结论性语句结尾，不是提问
  const conclusivePatterns = [
    /已[经完]?成/,
    /成功[地]?/,
    /结果[如为下]：/,
    /以下是.*结果/,
    /操作完成/,
  ];
  if (conclusivePatterns.some(p => p.test(response))) {
    return null;
  }

  // 正则预过滤：只对包含提问模式的文本进行后续处理
  const questionPatterns = [
    /请问您?要?选择/,
    /请选择/,
    /请提供/,
    /请问.*(?:是|是什么|是哪)/,
    /请输入/,
    /请确认/,
    /请回复/,
    /需要您?(?:提供|确认|选择|输入|回复)/,
    /您?(?:希望|想要|需要).*(?:哪个|哪些|什么)/,
  ];

  const isQuestion = questionPatterns.some(pattern => pattern.test(response));
  if (!isQuestion) {
    return null;
  }

  // 上下文判断：如果响应中包含工具调用结果的引用，可能是总结而非提问
  // 例如："请选择以下系统：\n1. EES\n2. GEAM" 是提问
  // 但 "根据查询结果，请选择以下系统..." 如果后面有具体结果，则不是提问
  if (toolCallResults && toolCallResults.length > 0) {
    // 如果最后一个工具调用是查询类工具，且响应包含查询结果的展示
    // 那么这更像是结果展示而非提问
    const lastToolCall = toolCallResults[toolCallResults.length - 1];
    const queryTools = ['conversation-get', 'grep', 'glob', 'read'];
    if (queryTools.includes(lastToolCall.name)) {
      // 检查响应是否主要是工具结果的格式化输出
      const resultIndicators = [
        /查询到/,
        /找到/,
        /共\s*\d+\s*条/,
        /以下/,
      ];
      const hasResultIndicator = resultIndicators.some(p => p.test(response));

      if (hasResultIndicator && !response.includes('?') && !response.includes('？')) {
        // 可能是结果展示，不是提问
        return null;
      }
    }
  }

  return { content: response };
}
```

### 3.7 TaskQueue 适配

TaskQueue 需要支持 `waiting` 状态的任务不被自动清理：

```typescript
// src/task-queue/index.ts

// cleanup 方法中，跳过 waiting 状态的任务
private cleanup(): void {
  const now = new Date().getTime();

  for (const [taskId, task] of this.tasks.entries()) {
    // 跳过非终态任务
    if (task.status !== 'completed' && task.status !== 'failed') {
      continue;
    }
    // ... 现有清理逻辑 ...
  }
}

// findReadyTasks 中，跳过 waiting 状态的任务
private findReadyTasks(): Task[] {
  const ready: Task[] = [];

  for (const task of this.tasks.values()) {
    if (task.status !== 'pending') {
      continue;  // waiting 状态的任务不会被选中
    }
    // ... 现有逻辑 ...
  }

  return ready;
}
```

> **注意**：实际上当前设计中，`waiting` 状态由主智能体的 `waitingStates` 管理，TaskQueue 中的任务状态仍然是 `completed`（因为子智能体已经返回了 `waiting_user_input` 的结果）。所以 TaskQueue 的改动可能不需要。这里标记为可选。

---

## 四、文件变更清单

| 文件 | 变更类型 | 变更内容 |
|------|---------|---------|
| `src/types/index.ts` | 修改 | 新增 `Question`, `WaitingState`, `ContinuationResult`, `QuestionHistoryEntry` 类型；Task 新增 `conversationContext`, `completedToolCalls`, `executionProgress` 字段 |
| `src/agents/continuation-judge.ts` | **新增** | 轻量延续判断器 |
| `src/agents/task-recaller.ts` | **新增** | 挂起任务召回器 |
| `src/agents/main-agent.ts` | **重构** | 替换 `waitingQuestions` → `waitingStates`；重写 `handleWaitingQuestion`、`continueTask`、`handleSuspendedTasks`；提取 `pollTaskCompletion`、`handleTaskCompletion` 公共方法 |
| `src/agents/sub-agent.ts` | **重构** | 支持断点续执行（`conversationContext` 恢复）；优化 `detectQuestion`；新增 `buildEnhancedPrompt` |
| `src/llm/index.ts` | 修改 | 新增 `generateWithToolsTracked` 方法（或给 `generateWithTools` 增加 `trackMessages` 选项） |
| `src/prompts/sub-agent.ts` | 修改 | 增强 prompt 模板，支持已完成步骤的展示 |
| `src/task-queue/index.ts` | 可选修改 | 如需要，支持 `waiting` 状态 |

---

## 五、实施计划

### 阶段 1：类型定义和基础设施（0.5 天）

1. 更新 `src/types/index.ts` — 新增所有类型定义
2. 创建 `src/agents/continuation-judge.ts` — 轻量判断器
3. 创建 `src/agents/task-recaller.ts` — 召回器

### 阶段 2：LLM 客户端扩展（0.5 天）

4. 在 `src/llm/index.ts` 中新增 `generateWithToolsTracked`（或修改 `generateWithTools`）

### 阶段 3：主智能体重构（1 天）

5. 重构 `MainAgent` — 替换 waitingQuestions、重写核心方法、提取公共逻辑

### 阶段 4：子智能体重构（1 天）

6. 重构 `SubAgent` — 断点续执行、detectQuestion 优化、增强 prompt

### 阶段 5：集成测试（1 天）

7. 端到端测试：正常流程、询问流程、挂起/召回流程
8. 边界测试：连续多次询问、挂起后新任务、挂起后召回

---

## 六、风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| `conversationContext` 过大导致 token 超限 | 子智能体执行失败 | 设置上下文窗口上限，超出时截断早期消息 |
| 轻量判断器误判（延续→新任务） | 用户需要重新开始 | 保守策略：不确定时默认为延续 |
| 轻量判断器误判（新任务→延续） | 用户的新请求被忽略 | 设置置信度阈值（0.6），低于阈值走正常流程 |
| `generateWithToolsTracked` 增加内存占用 | 长时间运行的服务 | 限制单个任务的 conversationContext 大小（如最近 20 轮） |
| 断点续执行时 LLM 仍然重复步骤 | 浪费 token 和时间 | 在 prompt 中明确列出已完成步骤，强化"不要重复"指令 |

---

## 七、对比总结

| 维度 | 当前实现 | 重构后 |
|------|---------|--------|
| 延续判断 | 完整 LLM 意图分类（~3-5s） | 轻量判断器（~1s） |
| requirement 处理 | 被覆盖为用户回复 | **保留原始需求** |
| 子智能体执行 | 每次从头开始 | **断点续执行**（恢复对话上下文） |
| 上下文传递 | questionHistory 文本提示 | conversationContext + completedToolCalls |
| 挂起召回 | 排除法（不是新任务就恢复） | **主动匹配**（TaskRecaller） |
| 类型安全 | `Map<string, any>` | `Map<string, WaitingState>` |
| 代码重复 | 轮询逻辑重复 3 处 | **公共方法** `pollTaskCompletion` |
| detectQuestion | 纯正则，误判率高 | 正则 + 上下文判断 |
