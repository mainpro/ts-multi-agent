import { Message, CONFIG, ToolDefinition, ToolCallResult } from '../types';
import { ZodSchema } from 'zod';
import { ErrorRecoveryManager } from './error-recovery';
import { AutoCompactService } from '../memory/auto-compact';

export type LLMEventType = 'reasoning' | 'response';

export interface ReasoningEvent {
  content: string;
  agent: 'MainAgent' | 'SubAgent';
}

export class LLMEventEmitter {
  private listeners: Map<LLMEventType, ((data: string | ReasoningEvent) => void)[]> = new Map();
  private currentAgent: 'MainAgent' | 'SubAgent' = 'MainAgent';
  private muted = false;

  setAgent(agent: 'MainAgent' | 'SubAgent'): void {
    this.currentAgent = agent;
  }

  getAgent(): 'MainAgent' | 'SubAgent' {
    return this.currentAgent;
  }

  /**
   * 临时静默 reasoning 事件（用于内部判断逻辑，如延续判断、召回判断等）
   * 返回一个恢复函数，调用后恢复事件发送
   */
  muteReasoning(): () => void {
    this.muted = true;
    return () => { this.muted = false; };
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
    // 静默状态下跳过 reasoning 事件
    if (this.muted && event === 'reasoning') return;

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
  | 'UNKNOWN_ERROR'
  | 'CONTEXT_TOO_LONG'
  | 'OUTPUT_TOO_LONG';

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
      reasoning?: string | null;
      thinking?: string | null;
      role: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
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

type LLMProvider = 'openrouter' | 'nvidia' | 'zhipu';

interface ProviderCapabilities {
  supportsReasoning: boolean;
  supportsStreaming: boolean;
  reasoningField: 'reasoning_content' | 'reasoning' | 'thinking';
}

const PROVIDER_CONFIGS: Record<LLMProvider, ProviderCapabilities> = {
  openrouter: {
    supportsReasoning: true,
    supportsStreaming: true,
    reasoningField: 'reasoning_content',
  },
  nvidia: {
    supportsReasoning: false,
    supportsStreaming: true,
    reasoningField: 'reasoning_content',
  },
  zhipu: {
    supportsReasoning: true,
    supportsStreaming: true,
    reasoningField: 'reasoning_content',
  },
};

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
  private provider: LLMProvider;
  private capabilities: ProviderCapabilities;
  private errorRecoveryManager: ErrorRecoveryManager;

  /**
   * Create a new LLM client
   * @param apiKey - API key (defaults to OPENROUTER_API_KEY or NVIDIA_API_KEY env var)
   */
  constructor(apiKey?: string) {
    this.provider = (process.env.LLM_PROVIDER || 'openrouter') as LLMProvider;
    this.capabilities = PROVIDER_CONFIGS[this.provider] || PROVIDER_CONFIGS.openrouter;

    if (apiKey) {
      this.apiKey = apiKey;
    } else if (this.provider === 'openrouter') {
      this.apiKey = process.env.OPENROUTER_API_KEY || '';
    } else if (this.provider === 'nvidia') {
      this.apiKey = process.env.NVIDIA_API_KEY || '';
    } else if (this.provider === 'zhipu') {
      this.apiKey = process.env.ZHIPU_API_KEY || '';
    } else if (this.provider === 'siliconflow') {
      this.apiKey = process.env.SILICONFLOW_API_KEY || '';
    } else {
      this.apiKey = '';
    }
    this.baseUrl = CONFIG.LLM_BASE_URL;
    this.model = CONFIG.LLM_MODEL;
    this.temperature = CONFIG.LLM_TEMPERATURE;
    this.timeoutMs = CONFIG.LLM_TIMEOUT_MS;
    this.maxRetries = 3;

    if (!this.apiKey) {
      throw new LLMError(
        'INVALID_KEY',
        `${this.provider} API key environment variable is not set`
      );
    }

    // 初始化错误恢复管理器
    const autoCompactService = new AutoCompactService(this);
    this.errorRecoveryManager = new ErrorRecoveryManager(autoCompactService);
  }

  private buildRequestBody(
    messages: Message[],
    options: {
      responseFormat?: { type: 'json_object' };
      tools?: ToolDefinition[];
      stream?: boolean;
    } = {}
  ): Record<string, unknown> {
    const baseRequest: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls) {
          msg.tool_calls = m.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        }
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      }),
      temperature: this.temperature,
      max_tokens: CONFIG.LLM_MAX_TOKENS || 4096,
    };

    if (this.capabilities.supportsReasoning) {
      baseRequest.reasoning = { enabled: true };
    }

    if (options.responseFormat) {
      baseRequest.response_format = options.responseFormat;
    }

    if (options.tools && options.tools.length > 0) {
      baseRequest.tools = options.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    if (options.stream) {
      baseRequest.stream = true;
    }

    return baseRequest;
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
    const code = errorData?.code || '';

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

    // Context too long errors (400 with specific message)
    if (statusCode === 400) {
      if (code.includes('output') ||
          message.includes('output') && message.includes('length') ||
          message.includes('max_output_tokens')) {
        return new LLMError(
          'OUTPUT_TOO_LONG',
          `Output too long: ${message}`,
          statusCode,
          originalError
        );
      }
      if (code.includes('context_length') || code.includes('max_tokens') ||
          message.includes('context') && message.includes('length') ||
          message.includes('token') && message.includes('limit')) {
        return new LLMError(
          'CONTEXT_TOO_LONG',
          `Context too long: ${message}`,
          statusCode,
          originalError
        );
      }
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
    // Exponential backoff with jitter for rate limit errors
    // Base delay: 2s, 4s, 8s for attempts 0, 1, 2
    const baseDelay = Math.pow(2, attempt + 1) * 1000;
    // Add jitter (0-500ms) to avoid thundering herd
    const jitter = Math.random() * 500;
    return baseDelay + jitter;
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

        const requestBody = this.buildRequestBody(messages, { responseFormat });

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

          // 尝试错误恢复
          if (this.errorRecoveryManager && attempt < this.maxRetries - 1) {
            const recoveryActions = this.errorRecoveryManager.getRecoveryActions(error, { messages });
            for (const action of recoveryActions) {
              console.log(`Attempting recovery: ${action.description}`);
              const success = await action.execute();
              if (success) {
                console.log(`Recovery successful: ${action.strategy}`);
                // 恢复成功，继续下一次尝试
                break;
              }
            }
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

        const requestBody = this.buildRequestBody(messages, { stream: true });

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
              } else if (delta.reasoning) {
                reasoning += delta.reasoning;
                llmEvents.emit('reasoning', delta.reasoning);
              } else if (delta.thinking) {
                reasoning += delta.thinking;
                llmEvents.emit('reasoning', delta.thinking);
              }

              if (delta.content) {
                content += delta.content;
              }
            } catch {
            }
          }
        }

        console.log(`[LLM] 流式请求完成, reasoning: ${reasoning.length} chars, content: ${content.length} chars`);
        
        if (!content && !reasoning) {
          throw new LLMError('API_ERROR', `Empty response from LLM (reasoning: ${reasoning.length}, content: ${content.length})`);
        }
        
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

  /**
   * Generate text with tool calling support (streaming)
   * Allows LLM to call tools during generation, and continues with tool results
   */
  async generateWithTools(
    prompt: string,
    tools: ToolDefinition[],
    toolExecutor: (toolCall: { name: string; arguments: Record<string, unknown> }) => Promise<string>,
    systemPrompt?: string,
    signal?: AbortSignal,
    concurrencyChecker?: (toolName: string, toolArgs: Record<string, unknown>) => boolean
  ): Promise<{ content: string; toolCalls: ToolCallResult[] }> {
    const messages: Message[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    } 

    messages.push({ role: 'user', content: prompt });

    const toolCallsResults: ToolCallResult[] = [];
    let maxIterations = 10;

    while (maxIterations-- > 0) {
      const result = await this.makeToolRequestStream(messages, tools, signal);

      if (!result.message) {
        throw new LLMError('API_ERROR', 'No message in response');
      }

      const message = result.message;

      console.log('[LLM] Response message.content:', message.content?.substring(0, 200));
      console.log('[LLM] Response message.tool_calls:', message.tool_calls?.length);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        console.log('[LLM] No tool_calls in response, returning content directly');
        
        return {
          content: message.content || '',
          toolCalls: toolCallsResults,
        };
      }

      console.log('[LLM] Has tool_calls, will execute them');
     

      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.tool_calls?.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      } as Message);

      // P1-2: Split tool_calls into safe (parallel) and unsafe (serial) groups
      const safeCalls = [];
      const unsafeCalls = [];
      for (const toolCall of message.tool_calls) {
        let toolArgs: Record<string, unknown>;
        try { toolArgs = JSON.parse(toolCall.function.arguments); } catch { toolArgs = {}; }
        if (concurrencyChecker && concurrencyChecker(toolCall.function.name, toolArgs)) {
          safeCalls.push(toolCall);
        } else {
          unsafeCalls.push(toolCall);
        }
      }

      // Execute safe calls in parallel
      if (safeCalls.length > 0) {
        console.log(`[LLM] P1-2: 并行执行 ${safeCalls.length} 个并发安全工具调用`);
        const safeResults = await Promise.allSettled(
          safeCalls.map(async (toolCall) => {
            const toolName = toolCall.function.name;
            let toolArgs: Record<string, unknown>;
            try {
              toolArgs = JSON.parse(toolCall.function.arguments);
            } catch {
              toolArgs = {};
            }

            console.log(`[LLM] 执行工具 (并行): ${toolName}`, toolArgs);

            let toolResult: string;
            try {
              toolResult = await toolExecutor({ name: toolName, arguments: toolArgs });
            } catch (execError) {
              console.error('[LLM] 工具执行失败:', execError);
              toolResult = `工具执行错误: ${execError instanceof Error ? execError.message : 'Unknown error'}`;
            }

            return { toolCall, toolName, toolArgs, toolResult };
          })
        );

        for (const result of safeResults) {
          if (result.status === 'fulfilled') {
            const { toolCall, toolName, toolArgs, toolResult } = result.value;
            toolCallsResults.push({
              name: toolName,
              arguments: toolArgs,
              result: toolResult,
            });
            messages.push({
              role: 'tool',
              content: toolResult,
              tool_call_id: toolCall.id,
            });
          } else {
            console.error('[LLM] 并行工具调用失败:', result.reason);
          }
        }
      }

      // Execute unsafe calls serially
      for (const toolCall of unsafeCalls) {
        const toolName = toolCall.function.name;

        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          console.error('[LLM] 工具参数 JSON 解析失败:', toolCall.function.arguments);
          toolArgs = {};
        }

        console.log(`[LLM] 执行工具 (串行): ${toolName}`, toolArgs);

        let toolResult: string;
        try {
          toolResult = await toolExecutor({
            name: toolName,
            arguments: toolArgs,
          });
        } catch (execError) {
          console.error('[LLM] 工具执行失败:', execError);
          toolResult = `工具执行错误: ${execError instanceof Error ? execError.message : 'Unknown error'}`;
        }

        toolCallsResults.push({
          name: toolName,
          arguments: toolArgs,
          result: toolResult,
        });

        messages.push({
          role: 'tool',
          content: toolResult,
          tool_call_id: toolCall.id,
        });
      }
    }

    throw new LLMError('API_ERROR', 'Max tool call iterations reached');
  }

  /**
   * Generate text with tool calling support (streaming) - with message tracking
   *
   * 与 generateWithTools 功能相同，但额外返回完整的 messages 数组，
   * 用于子智能体断点续执行时恢复对话上下文。
   *
   * @param messages - 初始消息数组（支持传入已有上下文用于断点续执行）
   * @param tools - 可用工具定义
   * @param toolExecutor - 工具执行回调
   * @param signal - 可选的中止信号
   * @param concurrencyChecker - 并发安全性检查函数
   * @returns 包含 content、toolCalls 和完整 messages 的结果
   */
  async generateWithToolsTracked(
    messages: Message[],
    tools: ToolDefinition[],
    toolExecutor: (toolCall: { name: string; arguments: Record<string, unknown> }) => Promise<string>,
    signal?: AbortSignal,
    concurrencyChecker?: (toolName: string, toolArgs: Record<string, unknown>) => boolean
  ): Promise<{ content: string; toolCalls: ToolCallResult[]; messages: Message[] }> {
    // 使用传入的 messages（可能包含断点恢复的上下文）
    const trackedMessages = [...messages];

    const toolCallsResults: ToolCallResult[] = [];
    let maxIterations = 10;
    let iteration = 0;

    while (maxIterations-- > 0) {
      iteration++;
      console.log(`[LLM] [Tracked] 🔄 第 ${iteration} 轮工具调用循环开始 (${new Date().toISOString()})`);
      const llmStartTime = Date.now();
      const result = await this.makeToolRequestStream(trackedMessages, tools, signal);
      const llmDuration = Date.now() - llmStartTime;
      console.log(`[LLM] [Tracked] ⏱️ LLM 响应耗时 ${llmDuration}ms`);

      if (!result.message) {
        throw new LLMError('API_ERROR', 'No message in response');
      }

      const message = result.message;

      console.log('[LLM] [Tracked] Response message.content:', message.content?.substring(0, 200));
      console.log('[LLM] [Tracked] Response message.tool_calls:', message.tool_calls?.length);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        console.log('[LLM] [Tracked] No tool_calls in response, returning content directly');

        return {
          content: message.content || '',
          toolCalls: toolCallsResults,
          messages: trackedMessages,
        };
      }

      console.log('[LLM] [Tracked] Has tool_calls, will execute them');

      // 添加 assistant 消息（含 tool_calls）到跟踪数组
      trackedMessages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.tool_calls?.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      } as Message);

      // P1-2: Split tool_calls into safe (parallel) and unsafe (serial) groups
      const safeCalls = [];
      const unsafeCalls = [];
      for (const toolCall of message.tool_calls) {
        let toolArgs: Record<string, unknown>;
        try { toolArgs = JSON.parse(toolCall.function.arguments); } catch { toolArgs = {}; }
        if (concurrencyChecker && concurrencyChecker(toolCall.function.name, toolArgs)) {
          safeCalls.push(toolCall);
        } else {
          unsafeCalls.push(toolCall);
        }
      }

      // Execute safe calls in parallel
      if (safeCalls.length > 0) {
        console.log(`[LLM] [Tracked] P1-2: 并行执行 ${safeCalls.length} 个并发安全工具调用`);
        const safeResults = await Promise.allSettled(
          safeCalls.map(async (toolCall) => {
            const toolName = toolCall.function.name;
            let toolArgs: Record<string, unknown>;
            try {
              toolArgs = JSON.parse(toolCall.function.arguments);
            } catch {
              toolArgs = {};
            }

            console.log(`[LLM] [Tracked] 执行工具 (并行): ${toolName}`, toolArgs);

            let toolResult: string;
            try {
              const execStart = Date.now();
              toolResult = await toolExecutor({ name: toolName, arguments: toolArgs });
              const execDuration = Date.now() - execStart;
              console.log(`[LLM] [Tracked] ✅ 并行工具完成: ${toolName} (耗时 ${execDuration}ms, 结果 ${toolResult.length} 字符)`);
            } catch (execError) {
              console.error('[LLM] [Tracked] 工具执行失败:', execError);
              toolResult = `工具执行错误: ${execError instanceof Error ? execError.message : 'Unknown error'}`;
            }

            return { toolCall, toolName, toolArgs, toolResult };
          })
        );

        for (const result of safeResults) {
          if (result.status === 'fulfilled') {
            const { toolCall, toolName, toolArgs, toolResult } = result.value;
            toolCallsResults.push({
              name: toolName,
              arguments: toolArgs,
              result: toolResult,
            });
            trackedMessages.push({
              role: 'tool',
              content: toolResult,
              tool_call_id: toolCall.id,
            });
          } else {
            console.error('[LLM] [Tracked] 并行工具调用失败:', result.reason);
          }
        }
      }

      // Execute unsafe calls serially
      for (const toolCall of unsafeCalls) {
        const toolName = toolCall.function.name;

        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          console.error('[LLM] [Tracked] 工具参数 JSON 解析失败:', toolCall.function.arguments);
          toolArgs = {};
        }

        console.log(`[LLM] [Tracked] 执行工具 (串行): ${toolName}`, toolArgs);

        let toolResult: string;
        try {
          const execStart = Date.now();
          toolResult = await toolExecutor({
            name: toolName,
            arguments: toolArgs,
          });
          const execDuration = Date.now() - execStart;
          console.log(`[LLM] [Tracked] ✅ 工具执行完成: ${toolName} (耗时 ${execDuration}ms, 结果 ${toolResult.length} 字符)`);
        } catch (execError) {
          console.error('[LLM] [Tracked] 工具执行失败:', execError);
          toolResult = `工具执行错误: ${execError instanceof Error ? execError.message : 'Unknown error'}`;
        }

        toolCallsResults.push({
          name: toolName,
          arguments: toolArgs,
          result: toolResult,
        });

        trackedMessages.push({
          role: 'tool',
          content: toolResult,
          tool_call_id: toolCall.id,
        });
      }
    }

    throw new LLMError('API_ERROR', 'Max tool call iterations reached');
  }

  private async makeToolRequestStream(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<{ message: Message; reasoning: string }> {
    let lastError: LLMError | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        console.log(`[LLM] 工具调用请求 attempt ${attempt + 1}/${this.maxRetries}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        signal?.addEventListener('abort', () => controller.abort());

        const requestBody = this.buildRequestBody(messages, { tools, stream: false });

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

        const data = await response.json() as GLMResponse;
        const choice = data.choices?.[0];
        
        if (!choice?.message) {
          throw new LLMError('API_ERROR', 'No message in response');
        }

        const message = choice.message;
        const reasoning = message.reasoning_content || message.reasoning || '';

        if (reasoning) {
          llmEvents.emit('reasoning', reasoning);
        }

        console.log(`[LLM] 工具调用请求完成, reasoning: ${reasoning.length} chars, content: ${(message.content || '').length} chars, tool_calls: ${message.tool_calls?.length || 0}`);

        return {
          message: {
            role: 'assistant',
            content: message.content || '',
            tool_calls: message.tool_calls?.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            })),
          },
          reasoning,
        };
      } catch (error) {
        console.log('[LLM] 工具调用请求错误:', error);

        if (error instanceof LLMError) {
          lastError = error;
          if (error.type === 'INVALID_KEY') throw error;
          if (!error.type.includes('RATE_LIMIT') && !error.type.includes('SERVER')) throw error;
        } else {
          lastError = new LLMError(
            'NETWORK_ERROR',
            error instanceof Error ? error.message : 'Unknown error'
          );
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
