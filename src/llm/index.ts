import { Message, CONFIG } from '../types';
import { ZodSchema } from 'zod';

/**
 * Global event emitter for LLM reasoning stream
 */
export type LLMEventType = 'reasoning' | 'response';

export interface ReasoningEvent {
  content: string;
  agent: 'MainAgent' | 'SubAgent';
}

export class LLMEventEmitter {
  private listeners: Map<LLMEventType, ((data: string | ReasoningEvent) => void)[]> = new Map();
  private currentAgent: 'MainAgent' | 'SubAgent' = 'MainAgent';

  setAgent(agent: 'MainAgent' | 'SubAgent'): void {
    this.currentAgent = agent;
  }

  getAgent(): 'MainAgent' | 'SubAgent' {
    return this.currentAgent;
  }

  on(event: LLMEventType, callback: (data: string | ReasoningEvent) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  off(event: LLMEventType, callback: (data: string | ReasoningEvent) => void): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  emit(event: LLMEventType, data: string): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const enrichedData: ReasoningEvent = {
        content: data,
        agent: this.currentAgent,
      };
      callbacks.forEach(callback => {
        try {
          callback(enrichedData);
        } catch (e) {
          // Ignore listener errors
        }
      });
    }
  }
}

// Global event emitter instance
export const llmEvents = new LLMEventEmitter();

/**
 * LLM error types for classification
 */
export type LLMErrorType =
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'INVALID_KEY'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

/**
 * LLM error class with classification
 */
export class LLMError extends Error {
  constructor(
    public readonly type: LLMErrorType,
    message: string,
    public readonly statusCode?: number,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * GLM API response structure
 */
interface GLMResponse {
  choices: Array<{
    message: {
      content: string | null;
      reasoning_content?: string | null;
      role: string;
    };
    finish_reason: string;
    index: number;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: {
    message: string;
    type: string;
    code: string;
  };
}

/**
 * LLM client for interacting with GLM-4.7-flash API
 */
export class LLMClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private timeoutMs: number;
  private maxRetries: number;

  /**
   * Create a new LLM client
   * @param apiKey - NVIDIA API key (defaults to NVIDIA_API_KEY env var)
   */
  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.NVIDIA_API_KEY || '';
    this.baseUrl = CONFIG.LLM_BASE_URL;
    this.model = CONFIG.LLM_MODEL;
    this.temperature = CONFIG.LLM_TEMPERATURE;
    this.timeoutMs = CONFIG.LLM_TIMEOUT_MS;
    this.maxRetries = 3;

    if (!this.apiKey) {
      throw new LLMError(
        'INVALID_KEY',
        'NVIDIA_API_KEY environment variable is not set'
      );
    }
  }

  /**
   * Classify an error based on response status and error details
   * @param statusCode - HTTP status code
   * @param errorData - Error response data
   * @param originalError - Original error object
   * @returns Classified LLMError
   */
  private classifyError(
    statusCode: number,
    errorData?: { message?: string; code?: string },
    originalError?: unknown
  ): LLMError {
    const message = errorData?.message || 'Unknown API error';

    // Rate limit errors (429)
    if (statusCode === 429) {
      return new LLMError(
        'RATE_LIMIT',
        `Rate limit exceeded: ${message}`,
        statusCode,
        originalError
      );
    }

    // Authentication errors (401)
    if (statusCode === 401) {
      return new LLMError(
        'INVALID_KEY',
        `Invalid API key: ${message}`,
        statusCode,
        originalError
      );
    }

    // Server errors (5xx)
    if (statusCode >= 500) {
      return new LLMError(
        'API_ERROR',
        `Server error: ${message}`,
        statusCode,
        originalError
      );
    }

    // Client errors (4xx)
    if (statusCode >= 400) {
      return new LLMError(
        'API_ERROR',
        `Client error: ${message}`,
        statusCode,
        originalError
      );
    }

    return new LLMError(
      'UNKNOWN_ERROR',
      `Unknown error: ${message}`,
      statusCode,
      originalError
    );
  }

  /**
   * Calculate delay for exponential backoff
   * @param attempt - Current attempt number (0-indexed)
   * @returns Delay in milliseconds
   */
  private getRetryDelay(attempt: number): number {
    return Math.pow(2, attempt) * 1000;
  }

  /**
   * Sleep for a given duration
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Make a request to the GLM API with timeout and retry logic
   * @param messages - Array of messages for the conversation
   * @param responseFormat - Optional response format (e.g., for JSON mode)
   * @returns API response
   */
  private async makeRequest(
    messages: Message[],
    responseFormat?: { type: 'json_object' },
    signal?: AbortSignal
  ): Promise<GLMResponse> {
    let lastError: LLMError | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        console.log(`LLM request attempt ${attempt + 1}/${this.maxRetries}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          console.log('LLM request timeout');
          controller.abort();
        }, this.timeoutMs);

        if (signal?.aborted) {
          controller.abort();
        }

        signal?.addEventListener('abort', () => controller.abort());

const requestBody: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      })),
      temperature: this.temperature,
      max_tokens: 4096,
    };

        if (responseFormat) {
          requestBody.response_format = responseFormat;
        }

        console.log('Sending LLM request to:', `${this.baseUrl}/chat/completions`);
        console.log('Request body:', JSON.stringify(requestBody, null, 2));

        const response = await fetch(
          `${this.baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          }
        );

        clearTimeout(timeoutId);
        console.log('LLM request response status:', response.status);

        const data = (await response.json()) as GLMResponse;
        console.log('LLM request response data:', JSON.stringify(data, null, 2));

        // Check for API error in response body
        if (data.error) {
          console.log('LLM API error:', data.error);
          throw this.classifyError(response.status, {
            message: data.error.message,
            code: data.error.code,
          });
        }

        if (!response.ok) {
          console.log('LLM request not ok:', response.status);
          throw this.classifyError(response.status);
        }

        console.log('LLM request successful');
        return data;
      } catch (error) {
        console.log('LLM request error:', error);
        
        if (error instanceof LLMError) {
          lastError = error;

          // Don't retry on invalid key or non-retryable errors
          if (error.type === 'INVALID_KEY') {
            console.log('Invalid API key, throwing error');
            throw error;
          }

          // Check if this is the last attempt
          if (attempt === this.maxRetries - 1) {
            console.log('Last attempt failed, throwing error');
            throw error;
          }
        } else if (error instanceof Error) {
          if (error.name === 'AbortError') {
            lastError = new LLMError(
              'TIMEOUT',
              `Request timeout after ${this.timeoutMs}ms`,
              undefined,
              error
            );

            // Check if this is the last attempt
            if (attempt === this.maxRetries - 1) {
              console.log('Request timeout, throwing error');
              throw lastError;
            }
          } else {
            lastError = new LLMError(
              'NETWORK_ERROR',
              `Network error: ${error.message}`,
              undefined,
              error
            );

            // Check if this is the last attempt
            if (attempt === this.maxRetries - 1) {
              console.log('Network error, throwing error');
              throw lastError;
            }
          }
        } else {
          lastError = new LLMError(
            'UNKNOWN_ERROR',
            `Unknown error occurred`,
            undefined,
            error
          );

          if (attempt === this.maxRetries - 1) {
            console.log('Unknown error, throwing error');
            throw lastError;
          }
        }

        // Wait before retrying (exponential backoff)
        const delay = this.getRetryDelay(attempt);
        console.log(`Waiting ${delay}ms before retrying`);
        await this.sleep(delay);
      }
    }

    // This should never be reached, but just in case
    console.log('All retry attempts failed');
    throw lastError || new LLMError('UNKNOWN_ERROR', 'Request failed after all retries');
  }

  /**
   * Generate text using the GLM API
   * @param prompt - User prompt
   * @param systemPrompt - Optional system prompt
   * @returns Generated text
   */
  async generateText(
    prompt: string,
    systemPrompt?: string
  ): Promise<string> {
    const messages: Message[] = [];

    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    messages.push({
      role: 'user',
      content: prompt,
    });

    const response = await this.makeRequest(messages);

    if (!response.choices || response.choices.length === 0) {
      throw new LLMError('API_ERROR', 'No choices in response');
    }

    const message = response.choices[0].message;
    
    // Emit reasoning_content if present
    if (message.reasoning_content) {
      llmEvents.emit('reasoning', message.reasoning_content);
    }
    
    return message.content || message.reasoning_content || '';
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<T> {
    const messages: Message[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    const response = await this.makeStreamRequest(messages, signal);

    if (!response.content) {
      throw new LLMError('API_ERROR', 'No content in response');
    }

    let content = response.content.trim();
    
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      content = jsonMatch[1].trim();
    }
    
    const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch && !content.startsWith('{')) {
      content = jsonObjectMatch[0];
    }

    try {
      const parsed = JSON.parse(content);
      return schema.parse(parsed);
    } catch (parseError) {
      console.error('[LLM] Schema validation failed. Content:', content.substring(0, 500));
      throw new LLMError('API_ERROR', 'Schema validation failed: ' + JSON.stringify(parseError));
    }
  }

  private async makeStreamRequest(
    messages: Message[],
    signal?: AbortSignal
  ): Promise<{ reasoning: string; content: string }> {
    let lastError: LLMError | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        console.log(`[LLM] 流式请求 attempt ${attempt + 1}/${this.maxRetries}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        signal?.addEventListener('abort', () => controller.abort());

        const requestBody = {
          model: this.model,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content,
            ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
          })),
          temperature: this.temperature,
      max_tokens: CONFIG.LLM_MAX_TOKENS || 512,
          stream: true,
          response_format: { type: 'json_object' },
        };

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw this.classifyError(response.status, { message: errorText });
        }

        if (!response.body) {
          throw new LLMError('API_ERROR', 'No response body');
        }

        let reasoning = '';
        let content = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              if (delta.reasoning_content) {
                reasoning += delta.reasoning_content;
                llmEvents.emit('reasoning', delta.reasoning_content);
              }

              if (delta.content) {
                content += delta.content;
              }
            } catch {
            }
          }
        }

        console.log(`[LLM] 流式请求完成, reasoning: ${reasoning.length} chars, content: ${content.length} chars`);
        return { reasoning, content };

      } catch (error) {
        console.log('[LLM] 流式请求错误:', error);

        if (error instanceof LLMError) {
          lastError = error;
          if (error.type === 'INVALID_KEY') throw error;
          if (!error.type.includes('RATE_LIMIT') && !error.type.includes('SERVER')) throw error;
        } else {
          lastError = new LLMError('NETWORK_ERROR', error instanceof Error ? error.message : 'Unknown error');
        }

        if (attempt < this.maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`[LLM] ${delay}ms 后重试`);
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new LLMError('UNKNOWN_ERROR', 'Request failed after all retries');
  }
}

/**
 * Create a default LLM client instance
 * @returns LLMClient instance
 */
export function createLLMClient(): LLMClient {
  return new LLMClient();
}
