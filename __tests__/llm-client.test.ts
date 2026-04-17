import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { LLMClient, LLMError, llmEvents } from '../src/llm';
import { Message, ToolDefinition } from '../src/types';

// Mock fetch
const originalFetch = global.fetch;

describe('LLMClient', () => {
  let llmClient: LLMClient;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    // Mock API key
    process.env.OPENROUTER_API_KEY = 'test-api-key';
    process.env.LLM_PROVIDER = 'openrouter';

    // Mock fetch
    mockFetch = mock(async (url: string, options: any) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Test response',
                reasoning_content: 'Test reasoning',
                role: 'assistant'
              },
              finish_reason: 'stop',
              index: 0
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30
          }
        })
      };
    });
    global.fetch = mockFetch;

    // Create LLM client
    llmClient = new LLMClient('test-api-key');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_PROVIDER;
  });

  describe('constructor', () => {
    it('should create LLMClient with provided API key', () => {
      expect(llmClient).toBeDefined();
    });

    it('should throw error when no API key provided', () => {
      delete process.env.OPENROUTER_API_KEY;
      expect(() => new LLMClient()).toThrow('openrouter API key environment variable is not set');
    });
  });

  describe('generateText', () => {
    it('should generate text successfully', async () => {
      const prompt = 'Test prompt';
      const systemPrompt = 'Test system prompt';

      const result = await llmClient.generateText(prompt, systemPrompt);
      
      expect(result).toBe('Test response');
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle response without content', async () => {
      // Mock response without content
      mockFetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                reasoning_content: 'Test reasoning',
                role: 'assistant'
              },
              finish_reason: 'stop',
              index: 0
            }
          ]
        })
      }));

      const prompt = 'Test prompt';
      const result = await llmClient.generateText(prompt);
      
      expect(result).toBe('Test reasoning');
    });

    it('should throw error when no choices in response', async () => {
      // Mock response without choices
      mockFetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: []
        })
      }));

      const prompt = 'Test prompt';
      await expect(llmClient.generateText(prompt)).rejects.toThrow('No choices in response');
    });
  });

  describe('generateStructured', () => {
    it('should generate structured data successfully', async () => {
      // Mock stream request
      const mockMakeStreamRequest = mock(async () => ({
        reasoning: 'Test reasoning',
        content: '{"test": "value"}'
      }));
      (llmClient as any).makeStreamRequest = mockMakeStreamRequest;

      const prompt = 'Test prompt';
      const schema = {
        parse: (data: any) => data
      } as any;

      const result = await llmClient.generateStructured(prompt, schema);
      
      expect(result).toEqual({ test: 'value' });
    });

    it('should handle JSON in code blocks', async () => {
      // Mock stream request with JSON in code blocks
      const mockMakeStreamRequest = mock(async () => ({
        reasoning: 'Test reasoning',
        content: '```json\n{"test": "value"}\n```'
      }));
      (llmClient as any).makeStreamRequest = mockMakeStreamRequest;

      const prompt = 'Test prompt';
      const schema = {
        parse: (data: any) => data
      } as any;

      const result = await llmClient.generateStructured(prompt, schema);
      
      expect(result).toEqual({ test: 'value' });
    });

    it('should throw error when no content in response', async () => {
      // Mock stream request without content
      const mockMakeStreamRequest = mock(async () => ({
        reasoning: '',
        content: ''
      }));
      (llmClient as any).makeStreamRequest = mockMakeStreamRequest;

      const prompt = 'Test prompt';
      const schema = {
        parse: (data: any) => data
      } as any;

      await expect(llmClient.generateStructured(prompt, schema)).rejects.toThrow('No content in response');
    });
  });

  describe('generateWithTools', () => {
    it('should generate text with tools successfully', async () => {
      // Mock tool request
      const mockMakeToolRequestStream = mock(async () => ({
        message: {
          role: 'assistant',
          content: 'Test response',
          tool_calls: []
        },
        reasoning: 'Test reasoning'
      }));
      (llmClient as any).makeToolRequestStream = mockMakeToolRequestStream;

      const prompt = 'Test prompt';
      const tools: ToolDefinition[] = [];
      const toolExecutor = mock(async () => 'Tool result');

      const result = await llmClient.generateWithTools(prompt, tools, toolExecutor);
      
      expect(result.content).toBe('Test response');
      expect(result.toolCalls).toEqual([]);
    });

    it('should handle tool calls', async () => {
      // Mock tool request with tool calls
      const mockMakeToolRequestStream = mock(async (messages: Message[]) => {
        // Second call returns no tool calls
        if (messages.length > 2) {
          return {
            message: {
              role: 'assistant',
              content: 'Tool execution result',
              tool_calls: []
            },
            reasoning: 'Test reasoning'
          };
        }
        // First call returns tool calls
        return {
          message: {
            role: 'assistant',
            content: 'Need to call tool',
            tool_calls: [
              {
                id: 'tool-call-1',
                type: 'function',
                function: {
                  name: 'test-tool',
                  arguments: '{"param": "value"}'
                }
              }
            ]
          },
          reasoning: 'Test reasoning'
        };
      });
      (llmClient as any).makeToolRequestStream = mockMakeToolRequestStream;

      const prompt = 'Test prompt';
      const tools: ToolDefinition[] = [
        {
          name: 'test-tool',
          description: 'Test tool',
          parameters: {
            type: 'object',
            properties: {
              param: {
                type: 'string'
              }
            },
            required: ['param']
          },
          required: ['param']
        }
      ];
      const toolExecutor = mock(async () => 'Tool result');

      const result = await llmClient.generateWithTools(prompt, tools, toolExecutor);
      
      expect(result.content).toBe('Tool execution result');
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0].name).toBe('test-tool');
    });
  });

  describe('classifyError', () => {
    it('should classify rate limit error', () => {
      const error = (llmClient as any).classifyError(429, { message: 'Rate limit exceeded' });
      expect(error.type).toBe('RATE_LIMIT');
      expect(error.message).toContain('Rate limit exceeded');
    });

    it('should classify invalid key error', () => {
      const error = (llmClient as any).classifyError(401, { message: 'Invalid API key' });
      expect(error.type).toBe('INVALID_KEY');
      expect(error.message).toContain('Invalid API key');
    });

    it('should classify context too long error', () => {
      const error = (llmClient as any).classifyError(400, { message: 'Context length exceeded' });
      expect(error.type).toBe('CONTEXT_TOO_LONG');
      expect(error.message).toContain('Context too long');
    });

    it('should classify output too long error', () => {
      const error = (llmClient as any).classifyError(400, { message: 'Max output tokens exceeded' });
      expect(error.type).toBe('OUTPUT_TOO_LONG');
      expect(error.message).toContain('Output too long');
    });

    it('should classify server error', () => {
      const error = (llmClient as any).classifyError(500, { message: 'Server error' });
      expect(error.type).toBe('API_ERROR');
      expect(error.message).toContain('Server error');
    });

    it('should classify client error', () => {
      const error = (llmClient as any).classifyError(400, { message: 'Bad request' });
      expect(error.type).toBe('API_ERROR');
      expect(error.message).toContain('Client error');
    });

    it('should classify unknown error', () => {
      const error = (llmClient as any).classifyError(0, { message: 'Unknown error' });
      expect(error.type).toBe('UNKNOWN_ERROR');
      expect(error.message).toContain('Unknown error');
    });
  });

  describe('getRetryDelay', () => {
    it('should calculate retry delay correctly', () => {
      const delay0 = (llmClient as any).getRetryDelay(0);
      const delay1 = (llmClient as any).getRetryDelay(1);
      const delay2 = (llmClient as any).getRetryDelay(2);

      expect(delay0).toBeGreaterThanOrEqual(2000);
      expect(delay0).toBeLessThan(2500);
      expect(delay1).toBeGreaterThanOrEqual(4000);
      expect(delay1).toBeLessThan(4500);
      expect(delay2).toBeGreaterThanOrEqual(8000);
      expect(delay2).toBeLessThan(8500);
    });
  });

  describe('LLMEventEmitter', () => {
    it('should emit and listen to events', () => {
      let eventData: any;
      const listener = (data: any) => {
        eventData = data;
      };

      llmEvents.on('reasoning', listener);
      llmEvents.emit('reasoning', 'Test reasoning');

      expect(eventData).toBeDefined();
      expect(eventData.content).toBe('Test reasoning');

      llmEvents.off('reasoning', listener);
    });

    it('should set and get agent', () => {
      llmEvents.setAgent('SubAgent');
      expect(llmEvents.getAgent()).toBe('SubAgent');

      llmEvents.setAgent('MainAgent');
      expect(llmEvents.getAgent()).toBe('MainAgent');
    });
  });

  describe('LLMError', () => {
    it('should create LLMError with correct properties', () => {
      const error = new LLMError('RATE_LIMIT', 'Rate limit exceeded', 429, new Error('Original error'));
      
      expect(error.type).toBe('RATE_LIMIT');
      expect(error.message).toBe('Rate limit exceeded');
      expect(error.statusCode).toBe(429);
      expect(error.originalError).toBeDefined();
      expect(error.name).toBe('LLMError');
    });
  });
});
