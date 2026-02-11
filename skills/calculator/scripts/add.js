#!/usr/bin/env node

/**
 * Calculator Addition Script
 * 
 * Performs addition of two numbers.
 * 
 * Usage: node add.js <a> <b>
 * Example: node add.js 10 5
 */

function add(a, b) {
  const numA = parseFloat(a);
  const numB = parseFloat(b);

  if (isNaN(numA) || isNaN(numB)) {
    console.error(JSON.stringify({
      error: 'Invalid input: both operands must be numbers',
      code: 'INVALID_INPUT'
    }));
    process.exit(1);
  }

  const result = numA + numB;
  
  console.log(JSON.stringify({
    operation: 'add',
    a: numA,
    b: numB,
    result: result
  }));

  return result;
}

// Execute if called directly
if (require.main === module) {
  const [,, a, b] = process.argv;
  
  if (a === undefined || b === undefined) {
    console.error(JSON.stringify({
      error: 'Usage: node add.js <a> <b>',
      code: 'MISSING_ARGUMENTS'
    }));
    process.exit(1);
  }

  add(a, b);
}

module.exports = { add };
