# 班级技能 (Classroom Skill) 创建计划

## TL;DR

> **快速摘要**: 创建一个新的 classroom skill，当用户查询"班级"数据时返回班级列表
> 
> **交付物**:
> - `skills/classroom/SKILL.md` - 技能定义文件
> - `skills/classroom/scripts/list.js` - 模拟数据库读取的脚本
> 
> **预估工作量**: 快速 (Quick)
> **并行执行**: 否 - 顺序执行
> **关键路径**: 创建目录 → SKILL.md → list.js → 测试

---

## Context

### 原始需求
用户希望在 skills 目录下创建一个新的"班级"技能，当用户输入"班级"数据时返回班级列表。

### 调研发现
- 现有 skills 结构: `skills/calculator/` 作为参考
- Skill 格式: `SKILL.md` (YAML frontmatter + markdown body)
- Scripts 目录: `skills/[skill-name]/scripts/[script].js`
- Skill registry 会自动扫描 skills/ 目录下的 SKILL.md 文件

### Metis 建议
- 使用与 calculator skill 完全相同的目录结构
- 在 SKILL.md 中定义输入/输出 JSON schema
- 添加错误处理部分

---

## Work Objectives

### 核心目标
创建一个 classroom skill，当用户查询班级信息时返回模拟的班级列表数据。

### 具体交付物
- [x] `skills/classroom/SKILL.md` - 技能定义
- [x] `skills/classroom/scripts/list.js` - 模拟数据库读取

### 完成定义
- [x] 技能自动注册到 /skills 端点
- [x] 运行 `node skills/classroom/scripts/list.js list` 返回班级列表

### 必须包含
- 技能名称: classroom
- 支持 list 和 get 两个操作
- 模拟数据包含至少 6 个班级

### 必须不包含
- 不修改现有的 skill-registry 代码
- 不创建额外的测试文件

---

## Verification Strategy

> **通用规则: 零人工干预**
> 
> 所有任务必须可通过命令验证，无需人工操作。

### Agent-Executed QA Scenarios

**Scenario 1: 验证 skill 被注册**
```
Tool: Bash
Preconditions: 服务器运行中
Steps:
  1. curl -s http://localhost:3000/skills
  2. Assert: response contains "classroom"
Expected Result: skills 列表包含 classroom
Evidence: curl 输出
```

**Scenario 2: 运行 list 脚本**
```
Tool: Bash
Preconditions: 无
Steps:
  1. node skills/classroom/scripts/list.js list
  2. Assert: JSON output with success=true
  3. Assert: data array length > 0
Expected Result: 返回班级列表 JSON
Evidence: 命令输出
```

**Scenario 3: 运行 get 脚本**
```
Tool: Bash
Preconditions: 无
Steps:
  1. node skills/classroom/scripts/list.js get class-001
  2. Assert: JSON output with success=true
  3. Assert: data.id equals "class-001"
Expected Result: 返回单个班级信息
Evidence: 命令输出
```

**Scenario 4: 测试错误情况**
```
Tool: Bash
Preconditions: 无
Steps:
  1. node skills/classroom/scripts/list.js get invalid-id
  2. Assert: exit code is 1
  3. Assert: output contains "CLASS_NOT_FOUND"
Expected Result: 返回错误信息
Evidence: 命令输出
```

---

## Execution Strategy

### 顺序步骤

```
Step 1: 创建目录结构
Step 2: 创建 SKILL.md
Step 3: 创建 scripts/list.js
Step 4: 验证脚本执行
```

### 依赖矩阵

| Step | 依赖 | 阻塞 | 可并行 |
|------|------|------|--------|
| 1 | 无 | 2, 3 | - |
| 2 | 1 | 4 | 3 |
| 3 | 1 | 4 | 2 |
| 4 | 2, 3 | 无 | - |

---

## TODOs

### Task 1: 创建目录结构

**What to do**:
- 创建 `skills/classroom/` 目录
- 创建 `skills/classroom/scripts/` 目录

**Must NOT do**:
- 不要修改已有的 skills

**Recommended Agent Profile**:
- **Category**: `quick`
  - Reason: 简单目录创建操作
- **Skills**: []
  - 无需特殊技能

**Parallelization**:
- **Can Run In Parallel**: NO
- **Parallel Group**: Sequential
- **Blocks**: Tasks 2, 3
- **Blocked By**: None

**Acceptance Criteria**:
- [x] `skills/classroom/` 目录存在
- [x] `skills/classroom/scripts/` 目录存在

**Evidence to Capture**:
- [x] 目录创建命令输出

---

### Task 2: 创建 SKILL.md

**What to do**:
- 在 `skills/classroom/SKILL.md` 创建技能定义文件
- 包含 YAML frontmatter: name, description, license, metadata
- 包含 markdown body: usage, actions, examples

**Must NOT do**:
- 不要复制 calculator 的内容，只参考格式

**Recommended Agent Profile**:
- **Category**: `quick`
  - Reason: 创建配置文件，简单任务
- **Skills**: []

**Parallelization**:
- **Can Run In Parallel**: YES
- **Parallel Group**: Wave 1 (with Task 3)
- **Blocks**: Task 4
- **Blocked By**: Task 1

**References**:
- `skills/calculator/SKILL.md:1-77` - SKILL.md 格式参考

**Acceptance Criteria**:
- [x] SKILL.md 文件存在
- [x] frontmatter 包含 name: "classroom"
- [x] frontmatter 包含 description (包含中文和英文)
- [x] body 包含 usage 说明
- [x] body 包含 actions: list, get
- [x] body 包含 examples

**Evidence to Capture**:
- [x] SKILL.md 文件内容

---

### Task 3: 创建 scripts/list.js

**What to do**:
- 在 `skills/classroom/scripts/list.js` 创建脚本
- 模拟数据库: 6个班级数据 (高一、高二、高三各2个班)
- 支持 actions: list (返回列表), get (按ID查询)
- 支持环境变量 SKILL_PARAMS 传入参数
- 支持命令行参数 fallback

**Must NOT do**:
- 不要连接真实数据库

**Recommended Agent Profile**:
- **Category**: `quick`
  - Reason: 创建简单脚本文件
- **Skills**: []

**Parallelization**:
- **Can Run In Parallel**: YES
- **Parallel Group**: Wave 1 (with Task 2)
- **Blocks**: Task 4
- **Blocked By**: Task 1

**References**:
- `skills/calculator/scripts/add.js:1-74` - 脚本格式参考 (读取 SKILL_PARAMS, JSON 输出)

**Acceptance Criteria**:
- [x] list.js 文件存在
- [x] `node skills/classroom/scripts/list.js list` 返回 JSON 数组
- [x] `node skills/classroom/scripts/list.js get class-001` 返回单个班级
- [x] 无效 ID 返回错误

**Evidence to Capture**:
- [x] 脚本执行输出

---

### Task 4: 验证脚本执行

**What to do**:
- 运行脚本验证功能正常
- 测试 list action
- 测试 get action
- 测试错误处理

**Must NOT do**:
- 不要修改任何代码

**Recommended Agent Profile**:
- **Category**: `quick`
  - Reason: 验证测试，简单任务
- **Skills**: []

**Parallelization**:
- **Can Run In Parallel**: NO
- **Parallel Group**: Sequential (final)
- **Blocks**: None
- **Blocked By**: Tasks 2, 3

**Acceptance Criteria**:
- [x] `node skills/classroom/scripts/list.js list` 成功执行
- [x] 输出包含 "success": true
- [x] 输出包含 6 个班级数据

**Evidence to Capture**:
- [x] 命令输出截图

---

## Success Criteria

### 验证命令
```bash
# 验证目录结构
ls -la skills/classroom/

# 验证脚本执行
node skills/classroom/scripts/list.js list

# 预期输出包含:
# {
#   "success": true,
#   "data": [
#     { "id": "class-001", "name": "高一(1)班", ... },
#     ...
#   ],
#   "total": 6
# }
```

### 最终检查清单
- [x] `skills/classroom/` 目录已创建
- [x] `skills/classroom/SKILL.md` 已创建
- [x] `skills/classroom/scripts/list.js` 已创建
- [x] list 脚本可执行并返回数据
- [x] get 脚本可执行并返回单个班级
- [x] 错误处理正常工作

---

## COMPLETED

All tasks completed on 2026-02-13
