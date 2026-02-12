---
name: calculator
description: Perform basic arithmetic calculations (add, subtract, multiply, divide). Use when user needs mathematical operations. 执行基本算术计算（加、减、乘、除）。当用户需要数学运算时使用。
license: MIT
metadata:
  author: system
  version: "1.0.0"
  category: math
  tags:
    - arithmetic
    - calculation
    - math
---

# Calculator Skill

This skill performs basic arithmetic operations including addition, subtraction, multiplication, and division.

## Usage

Call the calculator with an operation and two operands:

```json
{
  "operation": "add",
  "a": 10,
  "b": 5
}
```

## Operations

- `add`: Addition (a + b)
- `subtract`: Subtraction (a - b)
- `multiply`: Multiplication (a * b)
- `divide`: Division (a / b) - throws error if b is 0

## Examples

### Addition
```json
{ "operation": "add", "a": 10, "b": 5 }
// Result: 15
```

### Subtraction
```json
{ "operation": "subtract", "a": 10, "b": 5 }
// Result: 5
```

### Multiplication
```json
{ "operation": "multiply", "a": 10, "b": 5 }
// Result: 50
```

### Division
```json
{ "operation": "divide", "a": 10, "b": 5 }
// Result: 2
```

## Scripts

See [scripts/add.js](scripts/add.js) for the addition implementation.

## References

- [README.md](references/README.md) - Implementation details and architecture

## Error Handling

- Division by zero returns an error
- Invalid operations return an error
- Non-numeric inputs return an error
