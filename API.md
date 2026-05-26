# API 接口文档

本文档描述多智能体协作系统的 HTTP API 接口。

---

## 目录

- [接口概览](#接口概览)
- [任务接口](#任务接口)
  - [流式提交任务](#流式提交任务)
  - [同步提交任务](#同步提交任务)
  - [查询任务状态](#查询任务状态)
- [技能接口](#技能接口)
  - [获取技能列表](#获取技能列表)
- [其他接口](#其他接口)
  - [健康检查](#健康检查)

---

## 接口概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/tasks/stream` | SSE 流式提交任务 |
| POST | `/tasks` | 任务 |
| GET | `/tasks/:id` | 查询任务状态 |
| GET | `/skills` | 获取技能列表 |
| GET | `/health` | 健康检查 |

**基础 URL**: `http://localhost:3000` (默认端口)

**Content-Type**: `application/json`

---

## 任务接口

### 流式提交任务

通过 SSE (Server-Sent Events) 流式接收任务执行过程中的事件。

```http
POST /tasks/stream
```

#### 请求体

```json
{
  "requirement": "查询 GEAM 系统的用户手册",
  "userId": "user-123",
  "sessionId": "session-456",
  "imageAttachment": "base64encodedimage...",
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requirement` | string | 是 | 用户需求描述 |
| `userId` | string | 是 | 用户唯一标识 |
| `sessionId` | string | 是 | 会话唯一标识 |
| `imageAttachment` | string | 否 | 图片附件 Base64 |

#### SSE 事件

| 事件类型 | 说明 |
|----------|------|
| `start` | 任务开始 |
| `step` | 执行步骤更新 |
| `reasoning` | 推理过程 |
| `question` | 需要用户回答 |
| `complete` | 任务完成 |
| `error` | 执行错误 |

#### 响应示例

```
event: start
data: {"type":"start","requestId":"req-xxx","timestamp":"2024-01-01T00:00:00Z"}

event: step
data: {"type":"step","step":"intent_classify","data":{"intent":"skill_task","skill":"geam-qa"}}

event: step
data: {"type":"step","step":"task_plan","data":{"tasks":[{"id":"task-1","skill":"geam-qa","description":"查询用户手册"}]}}

event: complete
data: {"type":"complete","result":"GEAM 系统的用户手册位于...","usage":{"tokens":1234}}
```

---

### 同步提交任务

非流式方式提交任务，等待执行完成后返回结果。

```http
POST /tasks
```

#### 请求体

与流式接口相同。

#### 响应

```json
{
  "success": true,
  "requestId": "req-xxx",
  "result": "执行结果内容",
  "status": "completed",
  "question": null,
  "waitingTaskId": null
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否成功 |
| `requestId` | string | 请求 ID |
| `result` | string | 执行结果 |
| `status` | string | 状态: completed/waiting_user_input/failed |
| `question` | object | 询问信息（当 status 为 waiting_user_input 时）|
| `waitingTaskId` | string | 等待的任务 ID |

#### 等待用户输入响应

```json
{
  "success": true,
  "requestId": "req-xxx",
  "status": "waiting_user_input",
  "question": {
    "type": "text",
    "text": "请提供您的工号",
    "paramName": "employeeId"
  },
  "waitingTaskId": "task-xxx"
}
```

---

### 查询任务状态

查询指定任务的执行状态。

```http
GET /tasks/:id
```

#### 路径参数

| 参数 | 说明 |
|------|------|
| `id` | 任务 ID |

#### 响应

```json
{
  "id": "task-xxx",
  "status": "completed",
  "skillName": "geam-qa",
  "result": "执行结果",
  "createdAt": "2024-01-01T00:00:00Z",
  "completedAt": "2024-01-01T00:00:05Z"
}
```

---

## 技能接口

### 获取技能列表

获取系统中所有可用技能。

```http
GET /skills
```

#### 响应

```json
{
  "skills": [
    {
      "name": "geam-qa",
      "description": "GEAM 系统问答",
      "keywords": ["geam", "设备管理"],
      "examples": ["如何查询设备状态？"]
    },
    {
      "name": "ees-qa",
      "description": "EES 系统问答",
      "keywords": ["ees", "能源管理"],
      "examples": ["如何查看能耗报表？"]
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `name` | 技能标识名 |
| `description` | 技能描述 |
| `keywords` | 关键词列表 |
| `examples` | 示例问题 |

---

## 其他接口

### 健康检查

检查服务运行状态。

```http
GET /health
```

#### 响应

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

---

## 错误处理

### 错误响应格式

```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "请求参数错误",
    "details": "requirement 字段不能为空"
  }
}
```

### 错误码

| 错误码 | 说明 |
|--------|------|
| `INVALID_REQUEST` | 请求参数错误 |
| `TASK_NOT_FOUND` | 任务不存在 |
| `SKILL_NOT_FOUND` | 技能不存在 |
| `LLM_ERROR` | LLM 调用失败 |
| `TIMEOUT` | 执行超时 |
| `INTERNAL_ERROR` | 内部错误 |

---

## 调用示例

### cURL 示例

**流式提交任务：**
```bash
curl -X POST http://localhost:3000/tasks/stream \
  -H "Content-Type: application/json" \
  -d '{
    "requirement": "查询考勤记录",
    "userId": "user-123",
    "sessionId": "session-456"
  }'
```

**同步提交任务：**
```bash
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "requirement": "查询考勤记录",
    "userId": "user-123",
    "sessionId": "session-456"
  }'
```

**获取技能列表：**
```bash
curl http://localhost:3000/skills
```

---

## 注意事项

1. **会话保持**: 使用相同的 `userId` 和 `sessionId` 可保持对话上下文
2. **断点续传**: 当返回 `waiting_user_input` 状态时，使用相同的会话信息再次调用即可恢复
3. **图片限制**: 图片附件建议不超过 5MB，支持 PNG/JPEG 格式
4. **超时设置**: 单任务默认超时 30 秒，复杂任务可能更长
