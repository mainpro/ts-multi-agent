# 如何创建技能 (Skill)

本指南将帮助您创建新的技能，遵循 **Progressive Disclosure** 原则。

## 核心原则

> **代码只提供能力，所有的决定都是在 skill.md 中描述的，由 LLM 自行决定**

| 角色 | 职责 |
|------|------|
| **代码** | 提供能力（读取文件、执行脚本） |
| **SKILL.md** | 描述执行路径、分支逻辑 |
| **LLM** | 根据 SKILL.md 自主决定何时加载什么 |

## 目录结构

```
skills/
└── <skill-name>/
    ├── SKILL.md              # 技能定义（必需）
    ├── scripts/              # 脚本目录（可选）
    │   └── script1.js
    └── references/           # 参考文档目录（可选）
        └── detail.md
```

## 创建步骤

### Step 1: 创建目录结构

```bash
mkdir -p skills/<skill-name>/{scripts,references}
```

### Step 2: 编写 SKILL.md

这是最重要的文件！

### Step 3: 实现脚本（可选）

```javascript
// scripts/example.js
const args = process.argv.slice(2);
const result = { success: true, data: /* ... */ };
console.log(JSON.stringify(result));
```

### Step 4: 添加参考文档（可选）

```markdown
# 参考文档

## 概述
文档内容...
```

## SKILL.md 编写要点

### 1. Frontmatter

```yaml
---
name: skill-name
description: 技能描述，包含触发条件
---
```

### 2. Quick Reference (RIF)

```markdown
## Quick Reference (RIF)
**Operations**: `op1`, `op2`
**Usage**: `{ "operation": "op1" }`
```

### 3. Execution Steps

```markdown
## Execution Steps

### Step 1: 理解需求
<描述>

### Step 2: 分支逻辑

**IF <条件>:**
  → <动作>

**ELSE:**
  → <默认>
```

### 4. References

```markdown
## References

See [references/details.md](references/details.md)
- **何时读取**: <条件>
```

## 测试技能

```bash
# 启动服务
bun run src/index.ts

# 测试
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"requirement":"<您的需求>"}'
```

## 示例技能

参考现有技能：
- `skills/calculator/` - 计算器
- `skills/classroom/` - 班级管理

更多详情请参考：
- `docs/SKILL-MD-FORMAT.md` - SKILL.md 编写规范
