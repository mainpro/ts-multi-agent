import { LLMClient } from '../src/llm';
import { ErrorRecoveryManager } from '../src/llm/error-recovery';
import { AutoCompactService } from '../src/memory/auto-compact';

describe('ErrorRecoveryManager', () => {
  let errorRecoveryManager: ErrorRecoveryManager;
  let mockAutoCompactService: jest.Mocked<AutoCompactService>;

  beforeEach(() => {
    // Create a mock AutoCompactService
    mockAutoCompactService = {
      autoCompact: jest.fn(),
    } as any;

    errorRecoveryManager = new ErrorRecoveryManager(mockAutoCompactService);
  });

  it('should return context collapse action for CONTEXT_TOO_LONG error', async () => {
    const error = { type: 'CONTEXT_TOO_LONG', message: 'Context too long' };
    const context = { messages: [{ role: 'user', content: 'Test message' }] };
    const compactedMessages = [{ role: 'system', content: 'Compacted context' }];

    // Mock autoCompact to return compacted messages
    mockAutoCompactService.autoCompact.mockResolvedValue(compactedMessages);

    const actions = errorRecoveryManager.getRecoveryActions(error, context);
    expect(actions.length).toBe(1);
    expect(actions[0].strategy).toBe('context_collapse');

    // Execute the recovery action
    const success = await actions[0].execute();
    expect(success).toBe(true);
    expect(mockAutoCompactService.autoCompact).toHaveBeenCalledWith(context.messages);
    expect(context.messages).toEqual(compactedMessages);
  });

  it('should return increase max tokens action for OUTPUT_TOO_LONG error', async () => {
    const error = { type: 'OUTPUT_TOO_LONG', message: 'Output too long' };
    const context = { currentMaxTokens: 1024 };

    const actions = errorRecoveryManager.getRecoveryActions(error, context);
    expect(actions.length).toBe(1);
    expect(actions[0].strategy).toBe('increase_max_tokens');

    // Execute the recovery action
    const success = await actions[0].execute();
    expect(success).toBe(true);
    expect(context.currentMaxTokens).toBe(4096);
  });

  it('should return extended backoff action for RATE_LIMIT error', async () => {
    const error = { type: 'RATE_LIMIT', message: 'Rate limit exceeded' };
    const context = {};

    const actions = errorRecoveryManager.getRecoveryActions(error, context);
    expect(actions.length).toBe(1);
    expect(actions[0].strategy).toBe('extended_backoff');

    // Execute the recovery action
    const success = await actions[0].execute();
    expect(success).toBe(true);
  });

  it('should return increase timeout action for TIMEOUT error', async () => {
    const error = { type: 'TIMEOUT', message: 'Request timeout' };
    const context = {};

    const actions = errorRecoveryManager.getRecoveryActions(error, context);
    expect(actions.length).toBe(1);
    expect(actions[0].strategy).toBe('increase_timeout');

    // Execute the recovery action
    const success = await actions[0].execute();
    expect(success).toBe(true);
  });

  it('should return generic retry action for API_ERROR', async () => {
    const error = { type: 'API_ERROR', message: 'API error' };
    const context = {};

    const actions = errorRecoveryManager.getRecoveryActions(error, context);
    expect(actions.length).toBe(1);
    expect(actions[0].strategy).toBe('generic_retry');

    // Execute the recovery action
    const success = await actions[0].execute();
    expect(success).toBe(true);
  });

  it('should return empty array for unknown error type', async () => {
    const error = { type: 'UNKNOWN_ERROR', message: 'Unknown error' };
    const context = {};

    const actions = errorRecoveryManager.getRecoveryActions(error, context);
    expect(actions.length).toBe(0);
  });
});

describe('LLMClient Error Handling', () => {
  it('should classify context too long error correctly', () => {
    const llmClient = new LLMClient('test-api-key');
    
    // Test context too long error classification
    const contextError = llmClient['classifyError'](400, {
      message: 'Context length exceeded',
      code: 'context_length_exceeded'
    });
    expect(contextError.type).toBe('CONTEXT_TOO_LONG');
    expect(contextError.message).toContain('Context too long');

    // Test output too long error classification
    const outputError = llmClient['classifyError'](400, {
      message: 'Max output tokens exceeded',
      code: 'max_output_tokens'
    });
    expect(outputError.type).toBe('OUTPUT_TOO_LONG');
    expect(outputError.message).toContain('Output too long');
  });
});