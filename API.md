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
