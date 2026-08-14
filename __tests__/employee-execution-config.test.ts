import { ExecutionSchema } from '../src/agents/employee/json-types';

describe('ExecutionSchema', () => {
  it('applies default maxRetries=2 when omitted', () => {
    const parsed = ExecutionSchema.parse({});
    expect(parsed.maxRetries).toBe(2);
  });

  it('applies default retryableErrorTypes when omitted', () => {
    const parsed = ExecutionSchema.parse({});
    expect(parsed.retryableErrorTypes).toEqual(['TIMEOUT', 'NETWORK_ERROR', 'API_ERROR']);
  });

  it('applies default transferOnPartialFailure=false when omitted', () => {
    const parsed = ExecutionSchema.parse({});
    expect(parsed.transferOnPartialFailure).toBe(false);
  });

  it('accepts override values', () => {
    const parsed = ExecutionSchema.parse({
      maxRetries: 5,
      retryableErrorTypes: ['TIMEOUT'],
      transferOnPartialFailure: true,
    });
    expect(parsed.maxRetries).toBe(5);
    expect(parsed.retryableErrorTypes).toEqual(['TIMEOUT']);
    expect(parsed.transferOnPartialFailure).toBe(true);
  });

  it('rejects maxRetries > 10', () => {
    expect(() => ExecutionSchema.parse({ maxRetries: 11 })).toThrow();
  });

  it('rejects negative maxRetries', () => {
    expect(() => ExecutionSchema.parse({ maxRetries: -1 })).toThrow();
  });
});