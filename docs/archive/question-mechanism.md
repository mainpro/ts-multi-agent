# 询问机制 + 任务延续方案

## 核心设计

### 1. 数据结构定义

#### Question 类型

```typescript
// src/types/index.ts

export interface Question {
  type: 'choice' | 'text' | 'date' | 'number';
  field: string;  // 对应的字段名
  message: string;  // 展示给用户的消息
  options?: Array<{  // 如果是选择题
    id: string | number;
    label: string;
    data: Record<string, unknown>;  // 完整的数据对象
  }>;
  required: boolean;  // 是否必填
  layer: number;  // 当前层级
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
  
  // 新增：询问内容
  question?: Question;
  
  // 新增：执行状态（用于任务延续）
  executionState?: {
    currentLayer: number;
    collectedFields: Record<string, unknown>;
    cachedData: Record<string, unknown>;
  };
}
```

#### Task 扩展

```typescript
// src/types/index.ts

export interface Task {
  id: string;
  requirement: string;
  skillName?: string;
  dependencies: string[];
  dependents?: string[];
  status?: TaskStatus;
  result?: TaskResult;
  error?: TaskError;
  startedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  retryCount?: number;
  params?: Record<string, unknown>;
  sessionId?: string;
  userId?: string;
  
  // 新增：询问历史
  questionHistory?: Array<{
    question: Question;
    answer: string | number;
    timestamp: Date;
  }>;
  
  // 新增：执行状态
  executionState?: {
    currentLayer: number;
    collectedFields: Record<string, unknown>;
    cachedData: Record<string, unknown>;
  };
}
```

---

### 2. 子智能体返回逻辑

#### 当需要用户确认时

```typescript
// src/agents/sub-agent.ts

// 示例：需要用户选择申请人
if (applyUserList.length > 1) {
  return {
    success: true,
    status: 'waiting_user_input',
    question: {
      type: 'choice',
      field: 'applyUser',
      message: `请选择申请人：\n${applyUserList.map((u, i) => `${i+1}. ${u.nickName} (${u.account})`).join('\n')}`,
      options: applyUserList.map((u, i) => ({
        id: i + 1,
        label: `${u.nickName} (${u.account})`,
        data: u
      })),
      required: true,
      layer: 1
    },
    executionState: {
      currentLayer: 1,
      collectedFields: { userId: params.userId },
      cachedData: { applyUserList, costOrgList }
    }
  };
}
```

---

### 3. 主智能体处理逻辑

#### 保存询问内容

```typescript
// src/agents/main-agent.ts

class MainAgent {
  private waitingQuestions: Map<string, Question> = new Map();
  
  async processRequirement(requirement: string, userId?: string, sessionId?: string) {
    // ... 执行任务 ...
    
    const result = await this.taskQueue.waitForCompletion(plan.id);
    
    // 检查是否需要等待用户输入
    if (result.status === 'waiting_user_input' && result.question) {
      // 保存询问内容
      this.waitingQuestions.set(sessionId, result.question);
      
      // 返回给用户
      return {
        success: true,
        data: {
          message: result.question.message,
          type: 'question',
          question: result.question
        }
      };
    }
    
    // ... 正常返回 ...
  }
}
```

#### 处理用户回复

```typescript
// src/agents/main-agent.ts

async processRequirement(requirement: string, userId?: string, sessionId?: string) {
  // 检查是否有等待的问题
  const waitingQuestion = this.waitingQuestions.get(sessionId);
  
  if (waitingQuestion) {
    // 识别这是用户对问题的回答
    const answer = this.extractAnswer(requirement, waitingQuestion);
    
    // 继续执行任务
    return this.continueTask(sessionId, waitingQuestion, answer);
  }
  
  // ... 正常处理 ...
}

private extractAnswer(userInput: string, question: Question): string | number {
  if (question.type === 'choice') {
    // 提取选择：申请人1 → 1
    const match = userInput.match(/(\d+)/);
    return match ? parseInt(match[1]) : userInput;
  }
  return userInput;
}

private async continueTask(
  sessionId: string, 
  question: Question, 
  answer: string | number
) {
  // 获取之前的任务
  const previousTask = this.getPreviousTask(sessionId);
  
  // 添加询问历史
  previousTask.questionHistory = previousTask.questionHistory || [];
  previousTask.questionHistory.push({
    question,
    answer,
    timestamp: new Date()
  });
  
  // 更新执行状态
  if (question.type === 'choice' && question.options) {
    const selectedOption = question.options.find(o => o.id === answer);
    if (selectedOption) {
      previousTask.executionState = previousTask.executionState || {};
      previousTask.executionState.collectedFields[question.field] = selectedOption.data;
    }
  }
  
  // 重新执行任务（传递询问历史和执行状态）
  return this.taskQueue.addTask(previousTask);
}
```

---

### 4. 子智能体接收询问历史

#### 修改 SubAgent.execute

```typescript
// src/agents/sub-agent.ts

async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
  // 检查是否有询问历史
  if (task.questionHistory && task.questionHistory.length > 0) {
    // 从询问历史中提取已收集的字段
    const collectedFields: Record<string, unknown> = {};
    for (const { question, answer } of task.questionHistory) {
      if (question.type === 'choice' && question.options) {
        const selectedOption = question.options.find(o => o.id === answer);
        if (selectedOption) {
          collectedFields[question.field] = selectedOption.data;
        }
      } else {
        collectedFields[question.field] = answer;
      }
    }
    
    // 合并到 params
    task.params = {
      ...task.params,
      ...collectedFields
    };
  }
  
  // 检查是否有执行状态
  if (task.executionState) {
    // 恢复缓存数据
    for (const [key, value] of Object.entries(task.executionState.cachedData)) {
      await this.contextTool.set(key, value);
    }
  }
  
  // ... 正常执行 ...
}
```

---

### 5. 技能文档修改

#### 添加询问机制说明

```markdown
## 询问机制

当需要用户确认时，返回以下格式：

```json
{
  "status": "waiting_user_input",
  "question": {
    "type": "choice",
    "field": "applyUser",
    "message": "请选择申请人：\n1. 徐骏\n2. 张蓝翔",
    "options": [
      {"id": 1, "label": "徐骏 (JH00140)", "data": {...}},
      {"id": 2, "label": "张蓝翔 (JH03056)", "data": {...}}
    ],
    "required": true,
    "layer": 1
  },
  "executionState": {
    "currentLayer": 1,
    "collectedFields": {"userId": "xxx"},
    "cachedData": {"applyUserList": [...], "costOrgList": [...]}
  }
}
```

**主智能体会保存询问内容，等待用户回复后继续执行。**
```

---

## 实施计划

### 阶段1：修改类型定义（1天）

1. ✅ 添加 Question 类型
2. ✅ 扩展 TaskResult 类型
3. ✅ 扩展 Task 类型

### 阶段2：修改子智能体（2天）

1. ✅ 添加询问返回逻辑
2. ✅ 添加询问历史接收逻辑
3. ✅ 添加执行状态恢复逻辑

### 阶段3：修改主智能体（2天）

1. ✅ 添加询问保存逻辑
2. ✅ 添加答案提取逻辑
3. ✅ 添加任务继续逻辑

### 阶段4：测试验证（1天）

1. ✅ 测试单次询问
2. ✅ 测试多次询问
3. ✅ 测试任务延续

---

## 预期效果

### 优化前

```
用户："申请人1"
  ↓
主智能体：重新派发任务
  ↓
子智能体：从头开始执行 ❌
```

### 优化后

```
用户："申请人1"
  ↓
主智能体：识别这是对问题的回答 → 提取答案 → 继续执行任务
  ↓
子智能体：接收询问历史 → 恢复执行状态 → 继续执行 ✅
```

---

## 优势

1. **明确的状态管理**：子智能体知道"我之前问了什么"和"用户回答了什么"
2. **避免重复执行**：子智能体从上次的位置继续，而不是从头开始
3. **减少 LLM 推断**：不需要从对话历史推断，直接使用结构化数据
4. **支持多次询问**：可以处理多个层级的多轮询问
5. **易于调试**：询问历史和执行状态都是结构化的，便于追踪问题
