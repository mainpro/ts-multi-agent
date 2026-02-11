# Calculator Skill - Implementation Reference

## Overview

This skill provides basic arithmetic operations through a simple Node.js script interface. It's designed as a reference implementation for the agentskills.io specification.

## Architecture

```
skills/calculator/
├── SKILL.md           # Skill metadata and documentation
├── scripts/
│   └── add.js        # Addition implementation
└── references/
    └── README.md     # This file
```

## Script Interface

Scripts in this skill follow a standardized interface:

### Input
Arguments are passed via command line:
```bash
node scripts/add.js <operand_a> <operand_b>
```

### Output
Results are returned as JSON on stdout:
```json
{
  "operation": "add",
  "a": 10,
  "b": 5,
  "result": 15
}
```

### Error Handling
Errors are returned as JSON on stderr with appropriate exit codes:
```json
{
  "error": "Invalid input: both operands must be numbers",
  "code": "INVALID_INPUT"
}
```

## Available Operations

| Operation | Script | Description |
|-----------|--------|-------------|
| add | `scripts/add.js` | Adds two numbers |

## Future Extensions

Potential additions:
- `subtract.js` - Subtraction operation
- `multiply.js` - Multiplication operation
- `divide.js` - Division operation
- `power.js` - Exponentiation
- `sqrt.js` - Square root

## Testing

Test the addition script:
```bash
node scripts/add.js 10 5
# Expected: {"operation":"add","a":10,"b":5,"result":15}
```

## Error Codes

| Code | Description |
|------|-------------|
| INVALID_INPUT | Non-numeric input provided |
| MISSING_ARGUMENTS | Required arguments not provided |
| DIVISION_BY_ZERO | Attempted division by zero (future) |
