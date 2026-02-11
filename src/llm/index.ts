import { Message, CONFIG } from '../types';
import { ZodSchema } from 'zod';

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
      content: string;
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
   * @param apiKey - GLM API key (defaults to ZHIPU_API_KEY env var)
   */
  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.ZHIPU_API_KEY || '';
    this.baseUrl = CONFIG.LLM_BASE_URL;
    this.model = CONFIG.LLM_MODEL;
    this.temperature = CONFIG.LLM_TEMPERATURE;
    this.timeoutMs = CONFIG.LLM_TIMEOUT_MS;
    this.maxRetries = 3;

    if (!this.apiKey) {
      throw new LLMError(
        'INVALID_KEY',
        'ZHIPU_API_KEY environment variable is not set'
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
    responseFormat?: { type: 'json_object' }
  ): Promise<GLMResponse> {
    let lastError: LLMError | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, this.timeoutMs);

        const requestBody: Record<string, unknown> = {
          model: this.model,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
          })),
          temperature: this.temperature,
        };

        if (responseFormat) {
          requestBody.response_format = responseFormat;
        }

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

        const data = (await response.json()) as GLMResponse;

        // Check for API error in response body
        if (data.error) {
          throw this.classifyError(response.status, {
            message: data.error.message,
            code: data.error.code,
          });
        }

        if (!response.ok) {
          throw this.classifyError(response.status);
        }

        return data;
      } catch (error) {
        if (error instanceof LLMError) {
          lastError = error;

          // Don't retry on invalid key or non-retryable errors
          if (error.type === 'INVALID_KEY') {
            throw error;
          }

          // Check if this is the last attempt
          if (attempt === this.maxRetries - 1) {
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
            throw lastError;
          }
        }

        // Wait before retrying (exponential backoff)
        const delay = this.getRetryDelay(attempt);
        await this.sleep(delay);
      }
    }

    // This should never be reached, but just in case
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

    return response.choices[0].message.content;
  }

  /**
   * Generate structured output using JSON mode
   * @param prompt - User prompt
   * @param schema - Zod schema for validation
   * @param systemPrompt - Optional system prompt
   * @returns Parsed and validated structured data
   */
  async generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    systemPrompt?: string
  ): Promise<T> {
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

    const response = await this.makeRequest(messages, { type: 'json_object' });

    if (!response.choices || response.choices.length === 0) {
      throw new LLMError('API_ERROR', 'No choices in response');
    }

    const content = response.choices[0].message.content;

    try {
      const parsed = JSON.parse(content);
      return schema.parse(parsed);
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        throw new LLMError(
          'API_ERROR',
          `Schema validation failed: ${error.message}`,
          undefined,
          error
        );
      }
      throw new LLMError(
        'API_ERROR',
        `Failed to parse JSON response: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        error
      );
    }
  }
}

/**
 * Create a default LLM client instance
 * @returns LLMClient instance
 */
export function createLLMClient(): LLMClient {
  return new LLMClient();
}
