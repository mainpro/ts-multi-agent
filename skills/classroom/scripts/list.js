#!/usr/bin/env node

/**
 * Classroom List Script
 * 
 * Mock database for class information.
 * 
 * Usage: 
 *   node list.js list
 *   node list.js get <classId>
 * 
 * Environment: SKILL_PARAMS='{"action":"list"}' or SKILL_PARAMS='{"action":"get","id":"class-001"}'
 */

// Mock database
const classes = [
  { id: 'class-001', name: '高一(1)班', teacher: '张三', students: 45 },
  { id: 'class-002', name: '高一(2)班', teacher: '李四', students: 42 },
  { id: 'class-003', name: '高二(1)班', teacher: '王五', students: 48 },
  { id: 'class-004', name: '高二(2)班', teacher: '赵六', students: 44 },
  { id: 'class-005', name: '高三(1)班', teacher: '孙七', students: 50 },
  { id: 'class-006', name: '高三(2)班', teacher: '周八', students: 46 }
];

function findClassById(id) {
  return classes.find(c => c.id === id);
}

function handleList() {
  console.log(JSON.stringify({
    action: 'list',
    count: classes.length,
    data: classes
  }));
}

function handleGet(id) {
  const classItem = findClassById(id);
  
  if (!classItem) {
    console.error(JSON.stringify({
      error: `Class with id '${id}' not found`,
      code: 'CLASS_NOT_FOUND'
    }));
    process.exit(1);
  }
  
  console.log(JSON.stringify({
    action: 'get',
    id: id,
    data: classItem
  }));
}

function main() {
  let action, id;
  
  // Try to read params from environment variable (used by SubAgent)
  if (process.env.SKILL_PARAMS) {
    try {
      const params = JSON.parse(process.env.SKILL_PARAMS);
      action = params.action;
      id = params.id;
    } catch (error) {
      console.error(JSON.stringify({
        error: 'Invalid SKILL_PARAMS: ' + error.message,
        code: 'INVALID_PARAMS'
      }));
      process.exit(1);
    }
  }
  
  // Fallback to command line arguments
  if (action === undefined) {
    const [,, cliAction, cliId] = process.argv;
    action = cliAction;
    id = cliId;
  }
  
  if (action === undefined) {
    console.error(JSON.stringify({
      error: 'Usage: node list.js <action> [id]',
      code: 'MISSING_ARGUMENTS'
    }));
    process.exit(1);
  }
  
  if (action === 'list') {
    handleList();
  } else if (action === 'get') {
    if (id === undefined) {
      console.error(JSON.stringify({
        error: 'Missing class id for get action',
        code: 'MISSING_ARGUMENTS'
      }));
      process.exit(1);
    }
    handleGet(id);
  } else {
    console.error(JSON.stringify({
      error: `Unknown action: ${action}`,
      code: 'INVALID_ACTION'
    }));
    process.exit(1);
  }
}

// Execute if called directly
if (require.main === module) {
  main();
}

module.exports = { handleList, handleGet, classes };
