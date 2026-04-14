# Multi-Agent System

智能体协作系统，支持多任务分派、意图识别、技能匹配。

## 系统架构

```
用户请求 → [API] → [MainAgent] → [UnifiedPlanner] → [TaskQueue] → [SubAgent执行]
                ↓                                    ↓
            [IntentRouter] ←── [SkillRegistry]    [Skill执行]
                ↓
         [SessionContext] + [Memory]
```

## 处理流程

### 1. 意图识别 (IntentRouter)

```
用户输入 → 关键词匹配 → LLM辅助判断 → 意图分类
```

**意图类型：**
| 类型 | 说明 | 处理 |
|------|------|------|
| skill_task | 技能任务 | 匹配技能，执行任务 |
| small_talk | 闲聊/结束语 | 直接返回默认回复 |
| confirm_system | 需确认系统 | 反问用户确认系统 |
| unclear | 无法匹配 | 转人工处理 |

**辅助信号优先级：**
0. 用户输入的系统名 (0.90-1.00)
1. Session Context 当前技能 (0.70-0.90)
2. 关键词命中 (0.70-0.88)
3. 历史技能 (0.60-0.75)
4. 用户画像 (0.50-0.65)

### 2. 任务规划 (UnifiedPlanner)

```
意图 → 技能选择 → 任务分解 → 依赖分析 → 计划生成
```

**多任务场景：**
- 用户输入包含多个问题（逗号/空格分隔）→ 返回多个任务
- 并行执行的技能 → 同时派发到 TaskQueue

### 3. 任务执行 (TaskQueue + SubAgent)

```
TaskQueue → 技能调用 → SubAgent → 知识库检索 → 返回结果
```

**SubAgent 执行规则：**
- 只基于技能文档回答，不添加/扩展/编造
- 知识库检索至少2次后再提问
- 追问超过2次必须给出结论或转人工

### 4. 转人工机制 (Fallback)

**触发条件：**
- 用户明确要求（转人工/转系统工程师）
- 文档无法回答（检索2次后无结果）
- 追问超过2次仍无法确定

## 保底机制配置

业务相关的保底规则在 `config/fallback.md`，可通过环境变量切换：

```bash
FALLBACK_CONFIG=fallback.md  # 运维业务（默认）
FALLBACK_CONFIG=ecommerce.md  # 电商业务
```

## API 接口

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | /health | 健康检查 |
| GET | /skills | 列出所有技能 |
| POST | /tasks/stream | SSE 流式任务提交 |
| GET | /tasks/:id | 任务状态 |
| GET | /tasks/:id/result | 任务结果 |
| DELETE | /tasks/:id | 取消任务 |

### 请求格式

```json
{
  "userId": "user-xxx",
  "sessionId": "session-xxx",
  "requirement": "用户需求描述"
}
```

### 响应格式

**技能任务：**
```json
{
  "results": [
    {
      "taskId": "plan-xxx-task-1",
      "skillName": "geam-qa",
      "requirement": "申请GEAM权限",
      "response": "您好！请问您要登录系统操作什么？...",
      "status": "completed"
    }
  ],
  "type": "skill_task"
}
```

**转人工：**
```json
{
  "message": "您好，我帮您转到人工这边...",
  "type": "unclear"
}
```

**确认系统：**
```json
{
  "message": "您提到的'BCC系统'，请问具体是哪个系统？",
  "type": "confirm_system"
}
```

## 会话管理

- **SessionContext**: 内存中的短期会话上下文
- **ConversationMemory**: 持久化的会话历史
- **UserProfile**: 用户画像（部门、常用系统等）

每个浏览器窗口独立：
- `userId`: `user-{时间戳}-{随机6位}`
- `sessionId`: `session-{时间戳}`

## 技能结构

```
skills/
├── {skill-name}/
│   ├── skill.md           # 技能定义
│   ��── references/        # 知识库
│       ├── permission.md  # 权限申请
│       ├── login.md      # 登录问题
│       └── ...
```

### 技能元数据

```typescript
interface SkillMetadata {
  name: string;
  description: string;
  metadata: {
    systemName: string;  // 系统名（精确匹配）
    keywords: string[];  // 关键词（模糊匹配）
    trigger: string;    // 触发场景
    exclude: string;   // 排除条件
  };
}
```

## 快速开始

```bash
# 安装
bun install

# 配置环境变量
cp .env.example .env
# 编辑 .env 添加 API Key

# 启动
bun run src/index.ts

# 测试页面
open http://localhost:3000/test.html
```

## 配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| ZHIPU_API_KEY | 智谱 API Key | - |
| NVIDIA_API_KEY | NVIDIA API Key | - |
| OPENROUTER_API_KEY | OpenRouter API Key | - |
| LLM_PROVIDER | LLM 提供商 | zhipu |
| LLM_MODEL | 模型名称 | glm-4.5-air |
| FALLBACK_CONFIG | 保底机制配置文件 | fallback.md |

## 限制

- 最大并发任务: 5
- 任务队列大小: 100
- 任务超时: 30s
- LLM 超时: 60s
- 最大重规划次数: 3