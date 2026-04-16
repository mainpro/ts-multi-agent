# 架构优化方案：解决子智能体重复执行问题

## 问题描述

**当前流程**：
```
主智能体分析需求 -> 子智能体执行技能 -> 需要用户确认 -> 子智能体返回结果
-> 主智能体重新派发任务 -> 子智能体从头开始执行 ❌
```

**问题**：
- 子智能体没有"执行状态"的概念
- 每次主智能体派发任务，子智能体都从头开始
- 即使有缓存，子智能体也不知道"我之前执行到哪一步了"

---

## 解决方案

### 方案A：优化参数传递（推荐，短期方案）

**核心思路**：主智能体从对话历史提取用户选择 → 传递给子智能体 → 子智能体跳过询问步骤

#### 1. 修改主智能体的参数提取逻辑

**位置**：`src/prompts/main-agent.ts`

**修改内容**：

```typescript
// 在 TASK_PLANNER_SYSTEM_PROMPT 中添加
## 参数提取规则（重要！）

当用户回复"选择1"、"申请人2"等内容时，需要：

1. **检查对话历史**：查看之前展示的选项列表
2. **提取用户选择**：
   - "申请人1" → 列表第1项
   - "预算占用部门2" → 列表第2项
3. **传递选择结果**：
   ```json
   {
     "params": {
       "userId": "xxx",
       "selectedApplyUser": {...},  // 用户选择的申请人
       "selectedCostOrg": {...}     // 用户选择的预算占用部门
     }
   }
   ```

**示例**：

对话历史：
```
助手：请选择申请人：
1. 徐骏 (JH00140) - 信息部
2. 张蓝翔 (JH03056) - 信息部

请选择预算占用部门：
1. 财务科 (JH3002)
2. 信息部 (JH0107)
```

用户回复："申请人1，预算占用部门2"

提取结果：
```json
{
  "params": {
    "userId": "1727596139882397698",
    "selectedApplyUser": {
      "id": "1727596139882397698",
      "account": "JH00140",
      "nickName": "徐骏",
      "orgName": "信息部"
    },
    "selectedCostOrg": {
      "id": "1727507556643364866",
      "orgCode": "JH0107",
      "orgName": "信息部"
    }
  }
}
```
```

#### 2. 修改技能文档

**位置**：`skills/travel-expense-apply/SKILL.md`

**修改内容**：

```markdown
### 第1层：获取申请人和预算部门（依赖 userId）

**执行步骤**：

**步骤0：检查「已获取参数」部分**
```
检查主智能体是否已传递：
- selectedApplyUser: 如果有，跳过申请人选择
- selectedCostOrg: 如果有，跳过预算占用部门选择
如果都已传递 → 直接跳到步骤5（保存选择结果）
```

**步骤1：检查用户是否已选择**
```
使用 conversation-get(limit=3) 获取最近对话
检查用户是否已经选择了申请人和预算部门
如果用户已选择 → 直接跳到步骤4（选择逻辑）
```

**步骤2：检查缓存**
```
context-get(key="applyUserList")      → 如果 found=true，直接使用
context-get(key="costOrgList")        → 如果 found=true，直接使用
```

**步骤3：调用接口（仅当缓存不存在时）**
```bash
# 查询申请人列表
node scripts/api-call.js '{"method":"POST","path":"/edo-base/user/searchApplyUserListNew","params":{"userId":"<userId>","orderTypeCode":"sqcl"}}'

# 查询预算占用部门列表
node scripts/api-call.js '{"method":"POST","path":"/edo-base/userOrgCost/searchCostOrganizationByUserId","params":{"userId":"<userId>","isFinal":"1"}}'
```

**步骤4：保存到缓存**
```
context-set(key="applyUserList", value=<接口返回的data>)
context-set(key="costOrgList", value=<接口返回的data>)
```

**步骤5：选择逻辑**
- **优先级1**：如果主智能体已传递 selectedApplyUser/selectedCostOrg → 直接使用
- **优先级2**：如果用户已在对话中选择 → 使用用户的选择
- **优先级3**：如果只有一条数据 → 自动选择
- **优先级4**：如果有多条数据且用户未选择 → 展示列表让用户选择

**步骤6：保存选择结果**
```
context-set(key="selectedApplyUser", value=<选择的申请人>)
context-set(key="selectedCostOrg", value=<选择的预算占用部门>)
```
```

---

### 方案B：任务延续（长期方案）

**核心思路**：子智能体返回"等待用户输入"状态 → 主智能体不重新派发任务 → 用户回复后继续执行

#### 1. 修改 TaskResult 类型

**位置**：`src/types/index.ts`

```typescript
export interface TaskResult {
  success: boolean;
  status?: 'completed' | 'waiting_user_input';  // 新增状态
  data?: SkillExecutionResult | unknown;
  error?: TaskError;
  waitingFor?: string;  // 等待用户输入什么
}
```

#### 2. 修改子智能体返回逻辑

**位置**：`src/agents/sub-agent.ts`

```typescript
// 当需要用户确认时
return {
  success: true,
  status: 'waiting_user_input',
  data: {
    message: "请选择申请人：\n1. 徐骏\n2. 张蓝翔",
    waitingFor: "申请人选择"
  }
};
```

#### 3. 修改主智能体处理逻辑

**位置**：`src/agents/main-agent.ts`

```typescript
// 检查任务状态
if (result.status === 'waiting_user_input') {
  // 不重新派发任务，而是等待用户回复
  // 用户回复后，继续执行同一个任务
  this.waitingTasks.set(taskId, task);
}
```

---

## 实施计划

### 阶段1：短期方案（1-2天）

1. ✅ 修改技能文档，添加"步骤0：检查「已获取参数」部分"
2. ✅ 修改主智能体的参数提取逻辑
3. ✅ 测试验证

### 阶段2：长期方案（3-5天）

1. 修改 TaskResult 类型
2. 修改子智能体返回逻辑
3. 修改主智能体处理逻辑
4. 修改 TaskQueue 支持任务延续
5. 测试验证

---

## 预期效果

### 优化前

```
用户："申请人1，预算占用部门2"
  ↓
子智能体：检查缓存 → 展示列表 → 要求用户选择 ❌
```

### 优化后（方案A）

```
用户："申请人1，预算占用部门2"
  ↓
主智能体：提取选择 → 传递给子智能体
  ↓
子智能体：检查「已获取参数」→ 跳过询问 → 继续下一层级 ✅
```

### 优化后（方案B）

```
用户："申请人1，预算占用部门2"
  ↓
主智能体：识别这是"等待用户输入"的回复 → 继续执行同一个任务
  ↓
子智能体：接收用户回复 → 继续执行 → 完成任务 ✅
```
