# API 文档

## 多智能体系统 HTTP API

### 基础信息
- **基础 URL**: `http://localhost:3000`
- **Content-Type**: `application/json`
- **CORS**: 已启用

---

## 端点列表

### 1. 健康检查
```http
GET /health
```

**响应**:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

### 2. 获取所有 Skills
```http
GET /skills
```

**响应**:
```json
{
  "skills": [
    {
      "name": "calculator",
      "description": "Perform basic arithmetic calculations"
    }
  ]
}
```

---

### 3. 提交任务
```http
POST /tasks
Content-Type: application/json

{
  "requirement": "Calculate 2+2"
}
```

**响应**:
```json
{
  "taskId": "uuid-string",
  "status": "pending"
}
```

**状态码**:
- `201` - 任务创建成功
- `400` - 请求参数错误
- `500` - 服务器错误

---

### 4. 获取任务状态
```http
GET /tasks/:id
```

**响应**:
```json
{
  "id": "uuid-string",
  "status": "running",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "dependencies": []
}
```

**状态值**: `pending` | `running` | `completed` | `failed`

---

### 5. 获取任务结果
```http
GET /tasks/:id/result
```

**成功响应**:
```json
{
  "success": true,
  "data": 4
}
```

**失败响应**:
```json
{
  "success": false,
  "error": {
    "type": "SKILL_ERROR",
    "message": "Division by zero",
    "code": "DIVISION_BY_ZERO"
  }
}
```

---

### 6. 取消任务
```http
DELETE /tasks/:id
```

**响应**:
```json
{
  "success": true,
  "message": "Task cancelled"
}
```

---

## 错误类型

| 类型 | 描述 | 可重试 |
|------|------|--------|
| `RETRYABLE` | 临时错误，可以重试 | ✅ |
| `FATAL` | 致命错误，无法恢复 | ❌ |
| `USER_ERROR` | 用户输入错误 | ❌ |
| `SKILL_ERROR` | Skill 执行错误 | ❌ |

---

## 系统限制

- **最大并发任务**: 5
- **任务队列上限**: 100
- **任务超时**: 30 秒
- **LLM 超时**: 60 秒
- **重规划次数**: 最多 3 次

---

## 测试页面

访问 `http://localhost:3000/test.html` 使用 Web 界面测试 API。

---

## 内部接口文档

### AutoCompactService API

自动消息压缩服务，实现四层压缩策略。

#### 构造函数

```typescript
constructor(llmClient?: LLMClient)
```

**参数**:
- `llmClient` (可选): LLM客户端实例，用于AUTO层压缩

#### 核心方法

##### 1. microCompact()

轻量级压缩，清除超过5分钟的旧工具结果。

```typescript
microCompact(messages: Message[]): Message[]
```

**参数**:
- `messages`: 消息数组

**返回**: 压缩后的消息数组

**示例**:
```typescript
const compacted = service.microCompact(messages);
// 清除 timestamp <= (now - 5min) 的 tool 消息
```

##### 2. autoCompact()

基于阈值的LLM摘要压缩（167K tokens）。

```typescript
async autoCompact(messages: Message[]): Promise<Message[]>
```

**参数**:
- `messages`: 消息数组

**返回**: Promise<Message[]> - 包含摘要的消息数组

**特性**:
- 熔断器保护：连续3次失败后停止压缩
- 自动重置：成功后重置失败计数

##### 3. estimateTokens()

估算消息数组的token数量。

```typescript
estimateTokens(messages: Message[]): number
```

**参数**:
- `messages`: 消息数组

**返回**: 估算的token数量（字符数/4，准确率~85%）

#### 压缩策略

| 策略 | 触发条件 | 操作 | 成本 |
|------|---------|------|------|
| MICRO | 工具结果 >5min | 清除内容 | 零成本 |
| AUTO | tokens >167K | LLM摘要 | 高成本 |
| SESSION | 会话结束 | 会话级压缩 | 中等 |
| REACTIVE | 上下文压力 | 响应式压缩 | 可变 |

---

### Tool Interface

工具抽象层接口，所有工具必须实现。

#### 接口定义

```typescript
interface Tool {
  name: string;
  description: string;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
  isConcurrencySafe(input: unknown): boolean;
  isReadOnly(): boolean;
}
```

#### ToolContext

```typescript
interface ToolContext {
  workDir: string;    // 工作目录
  userId: string;     // 用户ID
  sessionId: string;  // 会话ID
}
```

#### ToolResult

```typescript
interface ToolResult {
  success: boolean;
  data?: unknown;     // 成功时返回的数据
  error?: string;     // 失败时的错误信息
}
```

#### 核心方法

##### 1. execute()

执行工具操作。

```typescript
execute(input: unknown, context: ToolContext): Promise<ToolResult>
```

**参数**:
- `input`: 工具特定输入参数
- `context`: 执行上下文（用户、会话信息）

**返回**: Promise<ToolResult>

##### 2. isConcurrencySafe()

判断是否可以并发执行。

```typescript
isConcurrencySafe(input: unknown): boolean
```

**返回**:
- `true`: 可安全并发执行
- `false`: 需要串行执行

**默认**: `false`（保守策略）

##### 3. isReadOnly()

判断是否为只读操作。

```typescript
isReadOnly(): boolean
```

**返回**:
- `true`: 只读操作，可与其他只读工具并发
- `false`: 写操作，需要协调

**默认**: `false`（保守策略）

#### 示例实现

```typescript
class FileReadTool extends BaseTool {
  name = 'file_read';
  description = 'Read file contents';

  async execute(input: { path: string }, context: ToolContext) {
    const content = await fs.readFile(input.path, 'utf-8');
    return { success: true, data: content };
  }

  isConcurrencySafe() {
    return true;  // 读操作可并发
  }

  isReadOnly() {
    return true;  // 只读
  }
}
```

---

### DynamicContextBuilder API

动态上下文构建器，集成用户记忆。

#### 构造函数

```typescript
constructor(config?: DynamicContextConfig)
```

**配置**:
```typescript
interface DynamicContextConfig {
  memoryDataDir?: string;  // 记忆数据目录，默认 'data'
}
```

#### 核心方法

##### 1. build()

构建动态上下文字符串。

```typescript
async build(userInput: string, userId?: string): Promise<string>
```

**参数**:
- `userInput`: 用户输入（用于上下文感知）
- `userId`: 用户标识符，默认 'default'

**返回**: Promise<string> - 格式化的上下文字符串

**示例输出**:
```markdown
## 用户上下文

### 用户画像
- **用户ID**: user123
- **部门**: 研发部
- **常用系统**: EES, GEAM
- **标签**: 技术专家
- **对话次数**: 15

### 对话历史
[最近对话摘要...]
```

##### 2. loadMemory()

加载用户记忆（内部方法）。

```typescript
private async loadMemory(userId: string): Promise<UserMemory | null>
```

**返回**: UserMemory对象或null

##### 3. formatMemorySection()

格式化记忆部分（内部方法）。

```typescript
private formatMemorySection(memory: UserMemory, userInput: string): string
```

**返回**: 格式化的Markdown字符串

#### 集成示例

```typescript
const contextBuilder = new DynamicContextBuilder({ memoryDataDir: 'data' });

// 在MainAgent中使用
const context = await contextBuilder.build(userInput, userId);
// 注入到规划提示词中
const planningPrompt = `${context}\n\n用户需求: ${userInput}`;
```
