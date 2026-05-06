# 通用询问机制设计方案

## 设计原则

### 1. 通用性原则

- ❌ **不要写死字段名**：不预设 `selectedApplyUser`、`selectedCostOrg` 等
- ❌ **不要写死答案提取逻辑**：不预设 `申请人1` → `1` 的解析规则
- ❌ **不要写死询问格式**：不预设询问必须是选择题

- ✅ **技能定义询问内容**：技能自己决定返回什么
- ✅ **主智能体只传递**：不关心具体内容，只传递"问题 + 答案"
- ✅ **子智能体自己解析**：自己决定如何使用询问历史

---

## 数据结构设计

### 1. TaskResult 扩展（通用）

```typescript
// src/types/index.ts

export interface TaskResult {
  success: boolean;
  status?: 'completed' | 'waiting_user_input';
  data?: SkillExecutionResult | unknown;
  error?: TaskError;
  
  // 通用询问字段
  question?: {
    // 技能自己定义询问内容（完全自由）
    content: string;  // 展示给用户的内容（可以是文本、选项列表、表单等）
    
    // 可选：结构化数据（技能自己决定格式）
    metadata?: Record<string, unknown>;
  };
  
  // 执行状态（技能自己决定保存什么）
  executionState?: Record<string, unknown>;
}
```

### 2. Task 扩展（通用）

```typescript
// src/types/index.ts

export interface Task {
  // ... 现有字段 ...
  
  // 询问历史（通用）
  questionHistory?: Array<{
    question: {
      content: string;
      metadata?: Record<string, unknown>;
    };
    answer: string;  // 用户的原始回复
    timestamp: Date;
  }>;
  
  // 执行状态（技能自己决定格式）
  executionState?: Record<string, unknown>;
}
```

---

## 主智能体逻辑（通用）

### 核心逻辑：只传递，不解析

```typescript
// src/agents/main-agent.ts

class MainAgent {
  private waitingQuestions: Map<string, any> = new Map();
  
  async processRequirement(requirement: string, userId?: string, sessionId?: string) {
    // 检查是否有等待的问题
    const waitingQuestion = this.waitingQuestions.get(sessionId);
    
    if (waitingQuestion) {
      // ✅ 通用处理：不解析答案，直接传递用户原始回复
      return this.continueTask(sessionId, waitingQuestion, requirement);
    }
    
    // ... 正常处理 ...
    
    const result = await this.taskQueue.waitForCompletion(plan.id);
    
    // ✅ 通用处理：检查是否需要等待用户输入
    if (result.status === 'waiting_user_input' && result.question) {
      // 保存询问内容
      this.waitingQuestions.set(sessionId, result.question);
      
      // 返回给用户
      return {
        success: true,
        data: {
          message: result.question.content,
          type: 'question'
        }
      };
    }
    
    // ... 正常返回 ...
  }
  
  private async continueTask(
    sessionId: string, 
    question: any, 
    userAnswer: string
  ) {
    // 获取之前的任务
    const previousTask = this.getPreviousTask(sessionId);
    
    // ✅ 通用处理：添加询问历史（不解析答案）
    previousTask.questionHistory = previousTask.questionHistory || [];
    previousTask.questionHistory.push({
      question,
      answer: userAnswer,  // 用户的原始回复
      timestamp: new Date()
    });
    
    // ✅ 通用处理：保留执行状态
    // 不做任何修改，直接传递给子智能体
    
    // 重新执行任务
    return this.taskQueue.addTask(previousTask);
  }
}
```

---

## 子智能体逻辑（通用）

### 核心逻辑：接收询问历史，自己解析

```typescript
// src/agents/sub-agent.ts

async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
  // ✅ 通用处理：检查是否有询问历史
  if (task.questionHistory && task.questionHistory.length > 0) {
    // 将询问历史传递给技能执行环境
    // 技能自己决定如何解析和使用
    const questionHistoryContext = JSON.stringify(task.questionHistory);
    
    // 添加到系统提示
    systemPrompt += `\n\n## 询问历史\n\n${questionHistoryContext}`;
  }
  
  // ✅ 通用处理：检查是否有执行状态
  if (task.executionState) {
    // 恢复执行状态（技能自己决定如何使用）
    systemPrompt += `\n\n## 执行状态\n\n${JSON.stringify(task.executionState)}`;
  }
  
  // ... 正常执行 ...
}
```

---

## 技能文档示例（通用）

### 差旅费用申请技能

```markdown
## 询问机制

当需要用户确认时，返回以下格式：

```json
{
  "status": "waiting_user_input",
  "question": {
    "content": "请选择申请人：\n1. 徐骏 (JH00140)\n2. 张蓝翔 (JH03056)",
    "metadata": {
      "type": "choice",
      "field": "applyUser",
      "options": [
        {"id": 1, "data": {...}},
        {"id": 2, "data": {...}}
      ]
    }
  },
  "executionState": {
    "currentLayer": 1,
    "applyUserList": [...],
    "costOrgList": [...]
  }
}
```

**处理用户回复**：

当收到询问历史时，检查最后一个问题的 metadata：
- 如果 type="choice"，从用户输入中提取数字（如"申请人1" → 1）
- 如果 type="text"，直接使用用户输入
- 如果 type="date"，解析日期格式

**示例**：

询问历史：
```json
[{
  "question": {
    "content": "请选择申请人：\n1. 徐骏\n2. 张蓝翔",
    "metadata": {"type": "choice", "field": "applyUser", "options": [...]}
  },
  "answer": "申请人1"
}]
```

解析：
- 从 answer 中提取数字：1
- 从 options 中找到对应数据：options[0].data
- 保存到 collectedFields：{"applyUser": {...}}
```

---

### 其他技能示例（通用）

#### QA 技能

```markdown
## 询问机制

当需要用户确认时：

```json
{
  "status": "waiting_user_input",
  "question": {
    "content": "请问您的问题是关于哪个系统的？\n1. EES\n2. GEAM\n3. 其他",
    "metadata": {
      "type": "system_selection"
    }
  }
}
```

**处理用户回复**：

从询问历史中提取用户选择的系统，然后继续搜索知识库。
```

---

## 通用性验证

### ✅ 支持不同类型的询问

1. **选择题**：技能自己定义选项列表和解析规则
2. **文本输入**：技能自己定义需要什么文本
3. **日期输入**：技能自己定义日期格式
4. **表单输入**：技能自己定义表单字段

### ✅ 支持不同技能

1. **差旅申请技能**：多层级询问，复杂解析
2. **QA 技能**：单次询问，简单解析
3. **其他技能**：完全自定义询问格式

### ✅ 主智能体不关心具体内容

1. 只传递"问题 + 答案"
2. 不解析答案
3. 不修改执行状态

### ✅ 子智能体完全自主

1. 自己定义询问格式
2. 自己解析用户回复
3. 自己管理执行状态

---

## 实施计划

### 阶段1：修改类型定义（0.5天）

1. ✅ 扩展 TaskResult 类型（通用）
2. ✅ 扩展 Task 类型（通用）

### 阶段2：修改主智能体（1天）

1. ✅ 添加询问保存逻辑（通用）
2. ✅ 添加任务继续逻辑（通用）
3. ✅ 不解析答案，只传递原始回复

### 阶段3：修改子智能体（1天）

1. ✅ 添加询问历史传递逻辑（通用）
2. ✅ 添加执行状态传递逻辑（通用）
3. ✅ 不解析答案，由技能自己解析

### 阶段4：修改技能文档（0.5天）

1. ✅ 添加询问机制说明
2. ✅ 添加答案解析示例

### 阶段5：测试验证（1天）

1. ✅ 测试差旅申请技能
2. ✅ 测试其他技能
3. ✅ 验证通用性

---

## 总结

### 核心设计

```
┌─────────────────────────────────────────────────────────────┐
│ 技能定义询问格式                                             │
│ - content: 展示给用户的内容                                  │
│ - metadata: 技能自己定义的结构化数据                         │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 主智能体只传递                                               │
│ - 保存询问内容                                               │
│ - 传递用户原始回复                                           │
│ - 不解析、不修改                                             │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 子智能体自己解析                                             │
│ - 接收询问历史                                               │
│ - 根据技能定义解析答案                                        │
│ - 自己管理执行状态                                           │
└─────────────────────────────────────────────────────────────┘
```

### 优势

1. **完全通用**：不依赖任何特定技能
2. **技能自主**：技能完全控制询问格式和解析逻辑
3. **易于扩展**：新技能可以自由定义询问机制
4. **易于维护**：主智能体逻辑简单，不关心具体内容
