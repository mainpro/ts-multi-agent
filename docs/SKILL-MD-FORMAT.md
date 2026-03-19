# SKILL.md 编写规范

## 核心原则

1. **代码只提供能力** - SubAgent 提供文件读取、脚本执行等能力
2. **SKILL.md 描述决策** - 执行路径、分支逻辑在 SKILL.md 中描述
3. **LLM 自主决定** - 根据 SKILL.md 引导，LLM 决定何时加载什么资源
4. **Progressive Disclosure** - 只在需要时加载，只加载需要的

## 必需元素

### 1. Frontmatter (Metadata)

```yaml
---
name: skill-name
description: 技能描述，包含触发条件和用途
---
```

### 2. Quick Reference (RIF)

```markdown
## Quick Reference (RIF)

**Operations/Actions**: `op1`, `op2`
**Usage**: `{ "operation": "op1", ... }`
```

### 3. Execution Steps

```markdown
## Execution Steps

### Step 1: <步骤名称>

<描述>

### Step 2: Validate Input (分支逻辑)

**IF <条件1>:**
  → <动作1>

**ELSE:**
  → <默认动作>
```

### 4. References

```markdown
## References

See [references/filename.md](references/filename.md)
- **何时读取**: <条件>
- **内容**: <摘要>
```

## 格式约定

| 元素 | 格式 | 示例 |
|------|------|------|
| 步骤 | ### Step N: | ### Step 1: Parse input |
| 分支 | **IF ...:** | **IF operation == "add":** |
| 动作 | → | → 执行 scripts/add.js |
| 引用 | See [path](path) | See [README.md](references/README.md) |

## 反模式 ❌

- ❌ 列出所有 scripts 供选择
- ❌ 在 body 中复制 references 内容
- ❌ 模糊的描述

## 正确模式 ✅

- ✅ 清晰的执行步骤
- ✅ 明确的分支逻辑
- ✅ 指引性引用

## SKILL.md 模板

```markdown
---
name: <skill-name>
description: <技能描述>
---

# <Skill Name>

## Quick Reference (RIF)

**Operations**: `op1`, `op2`
**Usage**: `{ "operation": "op1" }`

## Execution Steps

### Step 1: <步骤>

<描述>

**IF <条件>:**
  → <动作>

### Step 2: Execute

<执行描述>

## References

See [references/file.md](references/file.md)
- **何时读取**: <条件>
- **内容**: <摘要>

## Error Handling

| 错误 | 处理 |
|------|------|
| <条件> | <处理> |
```

## 实施检查清单

- [ ] frontmatter 包含 name 和 description
- [ ] Quick Reference (RIF) 在开头
- [ ] Execution Steps 描述执行顺序
- [ ] 分支逻辑用 **IF ...:** 格式
- [ ] 明确标注何时需要读取 references
- [ ] references 用 See [path](path) 引用
- [ ] Error Handling 表格完整
