# Classroom Skill - Implementation Reference

## Overview

This skill provides classroom management operations through a Node.js script interface. It allows listing all classrooms and retrieving classroom details by ID. Designed for the agentskills.io specification.

## Architecture

```
skills/classroom/
├── SKILL.md           # Skill metadata and documentation
├── scripts/
│   └── list.js        # Classroom operations implementation
└── references/
    └── README.md     # This file
```

## Script Interface

Scripts in this skill follow a standardized interface:

### Input
Arguments are passed via command line or environment variable:

**Command line:**
```bash
node scripts/list.js list
node scripts/list.js get <classId>
```

**Environment variable (used by SubAgent):**
```bash
SKILL_PARAMS='{"action":"list"}'
SKILL_PARAMS='{"action":"get","id":"class-001"}'
```

### Output
Results are returned as JSON on stdout:

**List action:**
```json
{
  "action": "list",
  "count": 6,
  "data": [
    { "id": "class-001", "name": "高一(1)班", "teacher": "张三", "students": 45 },
    { "id": "class-002", "name": "高一(2)班", "teacher": "李四", "students": 42 }
  ]
}
```

**Get action:**
```json
{
  "action": "get",
  "id": "class-001",
  "data": { "id": "class-001", "name": "高一(1)班", "teacher": "张三", "students": 45 }
}
```

### Error Handling
Errors are returned as JSON on stderr with appropriate exit codes:
```json
{
  "error": "Class with id 'class-001' not found",
  "code": "CLASS_NOT_FOUND"
}
```

## Available Operations

| Operation | Script | Description |
|-----------|--------|-------------|
| list | `scripts/list.js` | Lists all classrooms |
| get | `scripts/list.js` | Retrieves classroom details by ID |

## Future Extensions

Potential additions:
- `create.js` - Create new classroom
- `update.js` - Update classroom information
- `delete.js` - Delete classroom
- `search.js` - Search classrooms by name or teacher

## Testing

Test the list script:
```bash
node scripts/list.js list
# Expected: JSON with all classrooms

node scripts/list.js get class-001
# Expected: JSON with classroom details
```

## Error Codes

| Code | Description |
|------|-------------|
| INVALID_ACTION | Unknown action provided |
| MISSING_ARGUMENTS | Required arguments not provided |
| INVALID_PARAMS | Invalid SKILL_PARAMS format |
| CLASS_NOT_FOUND | Classroom with specified ID not found |
