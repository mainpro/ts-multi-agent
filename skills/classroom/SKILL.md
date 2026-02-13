---
name: classroom
description: 班级管理技能，当用户查询班级时使用
license: MIT
metadata:
  author: system
  version: "1.0.0"
  category: education
  tags:
    - classroom
    - class
    - education
    - management
---

# Classroom Skill

This skill manages classroom information including listing all classrooms and retrieving classroom details by ID.

## Usage

Call the classroom skill with an action and optional parameters:

```json
{
  "action": "list"
}
```

## Actions

- `list`: Returns a list of all classrooms
- `get`: Retrieves classroom details by ID

### List Classrooms

Returns all classrooms in the system.

```json
{
  "action": "list"
}
```

### Get Classroom by ID

Returns details for a specific classroom.

```json
{
  "action": "get",
  "id": "class-001"
}
```

## Examples

### List All Classrooms
```json
{ "action": "list" }
// Result: [{ "id": "class-001", "name": "高一(1)班", "teacher": "张三", "students": 45 }, { "id": "class-002", "name": "高一(2)班", "teacher": "李四", "students": 42 }]
```

### Get Classroom by ID
```json
{ "action": "get", "id": "class-001" }
// Result: { "id": "class-001", "name": "高一(1)班", "teacher": "张三", "students": 45 }
```

## Scripts

See [scripts/list.js](scripts/list.js) for the implementation.

## References

- [README.md](references/README.md) - Implementation details and architecture

## Error Handling

- Invalid action returns an error
- Classroom not found returns an error
- Missing required parameters returns an error
