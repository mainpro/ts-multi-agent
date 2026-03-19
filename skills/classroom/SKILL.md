---
name: classroom
description: 班级管理技能，当用户查询班级时使用
license: MIT
metadata:
  author: system
  version: "2.0.0"
  category: education
  tags:
    - classroom
    - class
    - education
    - management
---

# Classroom Skill

## Quick Reference (RIF)

**Actions**: `list`, `get`
**Usage**: `{ "action": "list" }` 或 `{ "action": "get", "id": "class-001" }`
**Script**: `scripts/list.js`

## Execution Steps

### Step 1: Identify Action

根据需求判断需要哪个操作：

| 需求关键词 | Action | 描述 |
|-----------|--------|------|
| 列出、列表、全部、所有班级 | `list` | 获取所有班级列表 |
| 查看、获取、详情、ID 为 | `get` | 根据 ID 获取班级详情 |

### Step 2: Validate Input (分支逻辑)

**IF action == "get" AND id 不存在或为空:**
  → 返回错误 `{ "error": "Missing ID", "code": "MISSING_PARAMETER" }`
  → **不需要执行 script**

**ELSE:**
  → 继续执行 Step 3

### Step 3: Execute Operation

**IF action == "list":**
  → 执行 `scripts/list.js`，参数 `{ "action": "list" }`
  → 返回所有班级列表

**IF action == "get":**
  → 执行 `scripts/list.js`，参数 `{ "action": "get", "id": "<id>" }`
  → 返回指定班级详情

### Step 4: Return Result

返回 JSON 格式结果：
```json
// list 结果
{ "classrooms": [{ "id": "class-001", "name": "高一(1)班" }, ...] }

// get 结果
{ "id": "class-001", "name": "高一(1)班", "teacher": "张三", "students": 45 }
```

## References

**详细文档**: See [references/README.md](references/README.md)
- **何时读取**: 当需要了解数据结构或字段含义时
- **内容**: 数据库 schema、字段说明

## Error Handling

| 错误条件 | 处理方式 | 需要读取 References |
|---------|---------|------------------|
| action 缺失 | 返回 MISSING_ACTION 错误 | ❌ 不需要 |
| id 缺失（action == "get"） | 返回 MISSING_ID 错误 | ❌ 不需要 |
| 班级不存在 | 返回 NOT_FOUND 错误 | ❌ 不需要 |
| 需要了解数据结构 | 读取 references/README.md | ✅ 需要 |

## Examples

### List All Classrooms
```
Input: "列出所有班级"
Params: { "action": "list" }
Output: { "classrooms": [...] }
```

### Get Classroom by ID
```
Input: "查看 ID 为 class-001 的班级"
Params: { "action": "get", "id": "class-001" }
Output: { "id": "class-001", "name": "高一(1)班", "teacher": "张三" }
```
