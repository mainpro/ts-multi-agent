# 统一询问机制设计方案

## 现状分析

### 现有机制：confirm_system

**使用场景**：主智能体在意图识别时，不确定用户要使用哪个系统

**返回格式**：
```json
{
  "intent": "confirm_system",
  "suggestedResponse": "请问您说的是哪个系统？EES 还是 GEAM？"
}
```

**处理流程**：
```
用户："帮我查一下问题"
  ↓
主智能体：无法确定系统 → 返回 confirm_system
  ↓
用户："EES系统"
  ↓
主智能体：重新处理 → 匹配到 EES 技能
```

---

### 新需求：技能执行过程中的询问

**使用场景**：子智能体执行技能时，需要用户确认

**返回格式**：
```json
{
  "status": "waiting_user_input",
  "question": {
    "content": "请选择申请人：\n1. 徐骏\n2. 张蓝翔"
  }
}
```

**处理流程**：
```
用户："帮我申请差旅"
  ↓
子智能体：需要选择申请人 → 返回 waiting_user_input
  ↓
用户："申请人1"
  ↓
子智能体：继续执行
```

---

## 统一设计方案

### 核心思路

**统一询问类型**，区分不同层级：

1. **主智能体层面**：系统确认、技能确认
2. **子智能体层面**：技能执行过程中的询问

---

### 1. 统一数据结构

#### IntentResult 扩展

```typescript
// src/routers/intent-router.ts

export type IntentType = 
  | 'skill_task'      // 明确的任务
  | 'small_talk'      // 闲聊
  | 'confirm_system'  // 系统确认（主智能体层面）
  | 'unclear';        // 无法匹配

export interface TaskItem {
  requirement: string;
  skillName?: string;
  intent: 'skill_task' | 'unclear';
}

export interface IntentResult {
  intent: IntentType;
  confidence: number;
  tasks: TaskItem[];
  
  // 统一询问字段
  question?: {
    type: 'system_confirm' | 'skill_confirm';
    content: string;  // 展示给用户的内容
    metadata?: Record<string, unknown>;  // 可选的结构化数据
  };
}
}
```

#### TaskResult 扩展

```typescript
// src/types/index.ts

export interface TaskResult {
  success: boolean;
  status?: 'completed' | 'waiting_user_input';
  data?: SkillExecutionResult | unknown;
  error?: TaskError;
  
  // 统一询问字段
  question?: {
    type: 'skill_question';  // 技能执行过程中的询问
    content: string;
    metadata?: Record<string, unknown>;
  };
  
  // 执行状态
  executionState?: Record<string, unknown>;
}
```

#### Task 扩展

```typescript
// src/types/index.ts

export interface Task {
  // ... 现有字段 ...
  
  // 询问历史（统一）
  questionHistory?: Array<{
    question: {
      type: string;
      content: string;
      metadata?: Record<string, unknown>;
    };
    answer: string;
    timestamp: Date;
  }>;
  
  // 执行状态
  executionState?: Record<string, unknown>;
}
```

---

### 2. 主智能体处理逻辑（统一）

```typescript
// src/agents/main-agent.ts

class MainAgent {
  private waitingQuestions: Map<string, any> = new Map();
  
  async processRequirement(requirement: string, userId?: string, sessionId?: string) {
    // ========== 步骤1：检查是否有等待的问题 ==========
    const waitingQuestion = this.waitingQuestions.get(sessionId);
    
    if (waitingQuestion) {
      // 根据询问类型处理
      switch (waitingQuestion.type) {
        case 'system_confirm':
        case 'skill_confirm':
          // 主智能体层面的确认 → 重新处理意图识别
          this.waitingQuestions.delete(sessionId);
          return this.processRequirement(requirement, userId, sessionId);
          
        case 'skill_question':
          // 子智能体层面的询问 → 继续执行任务
          return this.continueTask(sessionId, waitingQuestion, requirement);
      }
    }
    
    // ========== 步骤2：意图识别 ==========
    const intentResult = await this.intentRouter.route(enrichedRequirement);
    
    // ========== 步骤3：处理 confirm_system ==========
    if (intentResult.intent === "confirm_system") {
      // 保存询问内容
      const question = {
        type: 'system_confirm' as const,
        content: intentResult.question?.content || "请问您说的是哪个系统？"
      };
      this.waitingQuestions.set(sessionId, question);
      
      // 返回给用户
      return {
        success: true,
        data: {
          message: question.content,
          type: 'question',
          question
        }
      };
    }
    
    // ========== 步骤4：执行任务 ==========
    const result = await this.executePlan(plan, sessionId, userId);
    
    // ========== 步骤5：检查子智能体是否需要询问 ==========
    if (result.status === 'waiting_user_input' && result.question) {
      // 保存询问内容
      this.waitingQuestions.set(sessionId, result.question);
      
      // 返回给用户
      return {
        success: true,
        data: {
          message: result.question.content,
          type: 'question',
          question: result.question
        }
      };
    }
    
    // ========== 步骤6：正常返回 ==========
    return result;
  }
  
  private async continueTask(
    sessionId: string, 
    question: any, 
    userAnswer: string
  ) {
    // 获取之前的任务
    const previousTask = this.getPreviousTask(sessionId);
    
    // 添加询问历史
    previousTask.questionHistory = previousTask.questionHistory || [];
    previousTask.questionHistory.push({
      question,
      answer: userAnswer,
      timestamp: new Date()
    });
    
    // 清除等待状态
    this.waitingQuestions.delete(sessionId);
    
    // 继续执行任务
    return this.taskQueue.addTask(previousTask);
  }
}
```

---

### 3. 询问类型说明

| 类型 | 层面 | 使用场景 | 示例 |
|------|------|----------|------|
| `system_confirm` | 主智能体 | 不确定用户要使用哪个系统 | "请问您说的是哪个系统？EES 还是 GEAM？" |
| `skill_confirm` | 主智能体 | 不确定用户要使用哪个技能 | "您是想查询问题还是提交问题？" |
| `skill_question` | 子智能体 | 技能执行过程中需要用户确认 | "请选择申请人：\n1. 徐骏\n2. 张蓝翔" |

---

### 4. 兼容性处理

#### 主智能体提示词修改

```typescript
// src/prompts/main-agent.ts

export const SKILL_MATCHER_SYSTEM_PROMPT = `你是一个专业的意图识别与技能匹配助手。

## 输出格式

请返回以下 JSON 格式：
{
  "intent": "skill_task" 或 "small_talk" 或 "confirm_system" 或 "unclear",
  "confidence": 0.0-1.0,
  "tasks": [...],
  "question": {
    "type": "system_confirm" 或 "skill_confirm",
    "content": "询问内容"
  }
}

**注意**：
- 当 intent="confirm_system" 时，必须填写 question 字段
`;
```

---

### 5. 完整流程示例

#### 示例1：系统确认（主智能体层面）

```
用户："帮我查一下问题"
  ↓
主智能体：无法确定系统 → 返回 confirm_system
{
  "intent": "confirm_system",
  "question": {
    "type": "system_confirm",
    "content": "请问您说的是哪个系统？EES 还是 GEAM？"
  }
}
  ↓
保存询问：waitingQuestions.set(sessionId, question)
  ↓
用户："EES系统"
  ↓
主智能体：检测到等待问题 → 清除等待状态 → 重新处理
  ↓
匹配到 EES 技能 → 执行任务
```

#### 示例2：技能执行询问（子智能体层面）

```
用户："帮我申请差旅"
  ↓
主智能体：匹配到 travel-expense-apply 技能 → 派发任务
  ↓
子智能体：需要选择申请人 → 返回 waiting_user_input
{
  "status": "waiting_user_input",
  "question": {
    "type": "skill_question",
    "content": "请选择申请人：\n1. 徐骏\n2. 张蓝翔",
    "metadata": {...}
  }
}
  ↓
主智能体：保存询问 → 返回给用户
  ↓
用户："申请人1"
  ↓
主智能体：检测到等待问题 → 添加询问历史 → 继续执行任务
  ↓
子智能体：接收询问历史 → 解析答案 → 继续执行
```

---

## 实施计划

### 阶段1：修改类型定义 ✅

1. ✅ 扩展 IntentResult 类型
2. ✅ 扩展 TaskResult 类型
3. ✅ 扩展 Task 类型

### 阶段2：修改主智能体 ✅

1. ✅ 添加统一询问处理逻辑
2. ✅ 移除 suggestedResponse 字段，统一使用 question
3. ✅ 添加任务继续逻辑

### 阶段3：修改子智能体 ✅

1. ✅ 添加询问历史接收逻辑
2. ✅ 添加执行状态传递逻辑

### 阶段4：修改提示词 ✅

1. ✅ 修改 SKILL_MATCHER_SYSTEM_PROMPT
2. ✅ 移除 suggestedResponse，统一使用 question

### 阶段5：测试验证

1. ⏳ 测试系统确认
2. ⏳ 测试技能执行询问
3. ⏳ 测试多次询问

---

## 优势

1. **统一机制**：一套询问机制处理所有场景
2. **类型明确**：区分主智能体层面和子智能体层面的询问
3. **易于扩展**：新增询问类型只需添加新的 type
4. **易于维护**：统一的处理逻辑，减少重复代码
5. **清晰的历史记录**：questionHistory 记录所有询问和回答
