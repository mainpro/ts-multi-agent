import { describe, it, expect } from 'bun:test';

describe('Test Environment', () => {
  it('should have test environment configured', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });
});
