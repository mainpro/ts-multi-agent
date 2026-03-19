---
name: calculator
description: Perform basic arithmetic calculations (add, subtract, multiply, divide). Use when user needs mathematical operations. 执行基本算术计算（加、减、乘、除）。当用户需要数学运算时使用。
license: MIT
metadata:
  author: system
  version: "2.0.0"
  category: math
  tags:
    - arithmetic
    - calculation
    - math
---

# Calculator Skill

## Quick Reference (RIF)

**Operations**: `add`, `subtract`, `multiply`, `divide`
**Usage**: `{ "operation": "add", "a": 10, "b": 5 }`
**Scripts**: `scripts/add.js`

## Execution Steps

### Step 1: Identify Operation

根据需求判断需要哪个操作：

| 需求关键词 | Operation | Script |
|-----------|-----------|--------|
| 加、plus、+、求和、和 | `add` | `scripts/add.js` |
| 减、minus、-、差 | `subtract` | `scripts/subtract.js` |
| 乘、times、×、积 | `multiply` | `scripts/multiply.js` |
| 除、divide、÷、商 | `divide` | `scripts/divide.js` |

### Step 2: Validate Input (分支逻辑)

**IF operation == "divide" AND b == 0:**
  → 返回错误 `{ "error": "Division by zero", "code": "DIVISION_BY_ZERO" }`
  → **不需要执行任何 script**

**IF a 或 b 不是数字:**
  → 返回错误 `{ "error": "Invalid input", "code": "INVALID_INPUT" }`
  → **不需要执行任何 script**

**ELSE:**
  → 继续执行 Step 3

### Step 3: Execute Operation

根据 operation 执行对应 script：

- `add` → 执行 `scripts/add.js`，参数 `{ "a": <值>, "b": <值> }`
- `subtract` → 执行 `scripts/subtract.js`，参数 `{ "a": <值>, "b": <值> }`
- `multiply` → 执行 `scripts/multiply.js`，参数 `{ "a": <值>, "b": <值> }`
- `divide` → 执行 `scripts/divide.js`，参数 `{ "a": <值>, "b": <值> }`

### Step 4: Return Result

返回 JSON 格式结果：
```json
{
  "operation": "add",
  "a": 10,
  "b": 5,
  "result": 15
}
```

## References

**详细文档**: See [references/README.md](references/README.md)
- **何时读取**: 当需要了解脚本接口规范或错误代码时
- **内容**: 脚本实现细节、错误处理规范

## Error Handling

| 错误条件 | 处理方式 | 需要读取 References |
|---------|---------|------------------|
| 非数字输入 | 返回 INVALID_INPUT 错误 | ❌ 不需要 |
| 除以零 | 返回 DIVISION_BY_ZERO 错误 | ❌ 不需要 |
| 未知操作 | 返回 UNKNOWN_OPERATION 错误 | ❌ 不需要 |
| 需要了解脚本实现 | 读取 references/README.md | ✅ 需要 |

## Examples

### Addition
```
Input: "Calculate 10 + 5"
Params: { "operation": "add", "a": 10, "b": 5 }
Output: { "result": 15 }
```

### Division by Zero
```
Input: "Calculate 10 / 0"
Params: { "operation": "divide", "a": 10, "b": 0 }
Output: { "error": "Division by zero", "code": "DIVISION_BY_ZERO" }
```
