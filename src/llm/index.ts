import { Message, CONFIG, ToolDefinition, ToolCallResult } from '../types';
import { ZodSchema } from 'zod';
import type { ILLMClient } from './interfaces';
import { createLogger } from '../observability/logger';
export type { ILLMClient } from './interfaces';

const log = createLogger({ module: 'LLM' });

/**
 * 安全地拼接 base URL 和路径，处理末尾斜杠问题
 */
function buildApiUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * 修复 LLM 输出的 JSON 中字符串值内部未转义的双引号
 *
 * LLM 常见问题：在字符串值里直接使用 ASCII 双引号（如 "用户输入"你好""），
 * 导致 JSON.parse 失败。本函数逐字符扫描，识别字符串边界，
 * 将字符串内部的未转义双引号转义为 \"。
 */
function repairUnescapedQuotes(jsonStr: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        // 字符串开始
        inString = true;
        result += ch;
      } else {
        // 在字符串内，判断这个双引号是字符串结束还是内部未转义引号
        // 向后看：跳过空白，如果是 , } ] : 说明是字符串结束
        let j = i + 1;
        while (j < jsonStr.length && /\s/.test(jsonStr[j])) j++;
        const nextCh = jsonStr[j];
        if (nextCh === ',' || nextCh === '}' || nextCh === ']' || nextCh === ':') {
          // 字符串结束
          inString = false;
          result += ch;
        } else {
          // 字符串内部的未转义双引号，转义为 \"
          result += '\\"';
        }
      }
    } else {
      result += ch;
    }
  }

  return result;
}


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
  | 'OUTPUT_TOO_LONG'
  | 'CANCELLED'
  | 'QUEUE_FULL';

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

type LLMProvider = 'openrouter' | 'nvidia' | 'zhipu' | 'siliconflow' | 'haier';

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
  siliconflow: {
    supportsReasoning: true,
    supportsStreaming: true,
    reasoningField: 'reasoning_content',
  },
  haier: {
    supportsReasoning: true,
    supportsStreaming: true,
    reasoningField: 'reasoning_content',
  },
};

/**
 * LLM client for interacting with GLM-4.7-flash API
 */
export class LLMClient implements ILLMClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private timeoutMs: number;
  private maxRetries: number;
  private provider: LLMProvider;
  private capabilities: ProviderCapabilities;
  
  
  // Semaphore for limiting concurrent LLM requests
  private static semaphore = {
    max: CONFIG.LLM_MAX_CONCURRENT_REQUESTS,
    maxQueue: CONFIG.LLM_MAX_QUEUE_SIZE,
    current: 0,
    queue: [] as (() => void)[],
  };

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
    } else if (this.provider === 'haier') {
      this.apiKey = process.env.HAIER_API_KEY || '';
    } else {
      this.apiKey = '';
    }
    // 移除 baseUrl 末尾的斜杠，避免拼接时出现双斜杠
    this.baseUrl = CONFIG.LLM_BASE_URL.replace(/\/$/, '');
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
  }
  
  /**
   * Acquire a slot for concurrent request limiting
   */
  private async acquireSlot(): Promise<void> {
    if (LLMClient.semaphore.current < LLMClient.semaphore.max) {
      LLMClient.semaphore.current++;
      return;
    }

    // 队列已满：快速拒绝，避免 OOM（Issue #4）
    if (LLMClient.semaphore.maxQueue > 0 &&
        LLMClient.semaphore.queue.length >= LLMClient.semaphore.maxQueue) {
      throw new LLMError('QUEUE_FULL', `LLM request queue is full (${LLMClient.semaphore.maxQueue}), try again later`);
    }

    return new Promise(resolve => {
      LLMClient.semaphore.queue.push(() => {
        LLMClient.semaphore.current++;
        resolve();
      });
    });
  }
  
  /**
   * Release a slot after request completion
   */
  private releaseSlot(): void {
    LLMClient.semaphore.current--;
    const next = LLMClient.semaphore.queue.shift();
    if (next) next();
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
   * Sleep for a given duration
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 统一的退避延迟计算，带 jitter
   * @param attempt - 当前重试次数（从 0 开始）
   * @param errorType - 错误类型，用于调整基础延迟
   * @returns 延迟毫秒数
   */
  private getBackoffDelay(attempt: number, errorType?: string): number {
    const baseDelay = errorType === 'RATE_LIMIT' ? 5000 : 2000;
    return Math.min(Math.pow(2, attempt) * baseDelay + Math.random() * 1000, 60000);
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryable(error: LLMError): boolean {
    if (error.type === 'INVALID_KEY' || error.type === 'CANCELLED' || error.type === 'QUEUE_FULL') {
      return false;
    }
    const retryableTypes = ['RATE_LIMIT', 'TIMEOUT', 'NETWORK_ERROR'];
    return retryableTypes.includes(error.type) ||
      (error.type === 'API_ERROR' && error.statusCode !== undefined && error.statusCode >= 500);
  }

  /**
   * 构建请求 headers（统一所有 provider 的认证逻辑）
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    // 海尔 API 可能需要的额外 headers
    if (this.provider === 'haier' && process.env.HAIER_EXTRA_HEADERS) {
      const extraHeaders = process.env.HAIER_EXTRA_HEADERS.split(',');
      extraHeaders.forEach(h => {
        const [key, value] = h.split(':');
        if (key && value) headers[key.trim()] = value.trim();
      });
    }

    return headers;
  }

  /**
   * 统一的 fetch + 重试原语
   *
   * 封装了所有三个请求方法共享的逻辑：
   * - 信号量（acquireSlot/releaseSlot）
   * - 内部超时 + 外部 AbortSignal 转发
   * - 错误分类 + 可重试性判断
   * - 指数退避重试
   *
   * @param requestBody - 已构建的请求体
   * @param signal - 可选的外部取消信号
   * @returns fetch Response（已确认 response.ok）
   */
  private async fetchWithRetry(
    requestBody: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Response> {
    let lastError: LLMError | undefined;

    if (signal?.aborted) {
      throw new LLMError('CANCELLED', 'Request cancelled by external signal');
    }

    const apiUrl = buildApiUrl(this.baseUrl, '/chat/completions');

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let onExternalAbort: (() => void) | undefined;

      try {
        log.debug('请求 attempt', { attempt: attempt + 1, maxRetries: this.maxRetries });

        // 内部超时
        timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        // 外部 signal → 转发到内部 controller
        if (signal) {
          onExternalAbort = () => controller.abort();
          signal.addEventListener('abort', onExternalAbort);
        }

        await this.acquireSlot();

        const headers = this.buildHeaders();
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        // 清除内部超时（响应已到达）
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = undefined;

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw this.classifyError(response.status, {
            message: errorText || `HTTP ${response.status}`,
          });
        }

        return response;
      } catch (error) {
        const errObj = error instanceof Error ? error : null;
        const isExternalAbort = signal?.aborted && errObj?.name === 'AbortError';
        const isInternalTimeout = !signal?.aborted && errObj?.name === 'AbortError';

        if (isExternalAbort) {
          throw new LLMError('CANCELLED', 'Request cancelled by external signal');
        }

        if (isInternalTimeout) {
          lastError = new LLMError('TIMEOUT', `Request timeout after ${this.timeoutMs}ms`);
        } else if (error instanceof LLMError) {
          lastError = error;
        } else if (errObj) {
          lastError = new LLMError(
            'NETWORK_ERROR',
            `Network error: ${errObj.message}`,
            undefined,
            errObj
          );
        } else {
          lastError = new LLMError('UNKNOWN_ERROR', 'Unknown error occurred', undefined, error);
        }

        // 不可重试的错误直接抛出
        if (!this.isRetryable(lastError)) {
          throw lastError;
        }

        if (attempt < this.maxRetries - 1) {
          const delay = this.getBackoffDelay(attempt, lastError.type);
          log.info('后重试', { delay, errorType: lastError.type });
          await this.sleep(delay);
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (onExternalAbort && signal) {
          signal.removeEventListener('abort', onExternalAbort);
        }
        this.releaseSlot();
      }
    }

    throw lastError || new LLMError('UNKNOWN_ERROR', 'Request failed after all retries');
  }

  /**
   * 读取 SSE 流并提取 reasoning + content
   *
   * 封装了流式响应的解析逻辑：
   * - 逐行解析 data: 前缀的 SSE 事件
   * - 提取 reasoning_content / reasoning / thinking 字段
   * - 每次 read 独立超时（防止流式传输中途卡住）
   * - 发送 reasoning 事件到 LLMEventEmitter
   */
  private async readSSEStream(
    response: Response,
    signal?: AbortSignal,
    options: { emitContent?: boolean } = {}
  ): Promise<{ reasoning: string; content: string }> {
    if (!response.body) {
      throw new LLMError('API_ERROR', 'No response body');
    }

    let reasoning = '';
    let content = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readTimeoutMs = 60000;

    while (true) {
      const readController = new AbortController();
      const readTimeoutId = setTimeout(() => readController.abort(), readTimeoutMs);
      let onReadAbort: (() => void) | undefined;

      let readResult: { done: boolean; value?: Uint8Array };
      try {
        onReadAbort = () => readController.abort();
        signal?.addEventListener('abort', onReadAbort);

        readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            readController.signal.addEventListener('abort', () => {
              reject(new Error(`流式读取超时 (${readTimeoutMs}ms)，LLM 可能已停止发送数据`));
            });
          }),
        ]);
      } finally {
        clearTimeout(readTimeoutId);
        if (onReadAbort && signal) {
          signal.removeEventListener('abort', onReadAbort);
        }
      }
      if (readResult.done) break;

      buffer += decoder.decode(readResult.value, { stream: true });
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
            // 透传 content delta 到 SSE,让用户在 IntentRouter 等慢路径
            // 能看到模型正在"打字"。仅在调用方显式开启时触发,
            // 避免 SubAgent 等多步骤路径上的重复事件。
            if (options.emitContent) {
              llmEvents.emit('reasoning', delta.content);
            }
          }
        } catch {
        }
      }
    }

    log.info('流式请求完成', { reasoningLength: reasoning.length, contentLength: content.length });

    if (!content && !reasoning) {
      throw new LLMError('API_ERROR', `Empty response from LLM (reasoning: ${reasoning.length}, content: ${content.length})`);
    }

    return { reasoning, content };
  }

  /**
   * Make a non-streaming request to the LLM API
   * @param messages - Array of messages for the conversation
   * @param responseFormat - Optional response format (e.g., for JSON mode)
   * @param signal - Optional external abort signal
   * @returns API response
   */
  private async makeRequest(
    messages: Message[],
    responseFormat?: { type: 'json_object' },
    signal?: AbortSignal
  ): Promise<GLMResponse> {
    const requestBody = this.buildRequestBody(messages, { responseFormat });
    const response = await this.fetchWithRetry(requestBody, signal);

    const data = (await response.json()) as GLMResponse;
    log.debug('LLM request response data', { data: JSON.stringify(data, null, 2) });

    if (data.error) {
      throw this.classifyError(response.status, {
        message: data.error.message,
        code: data.error.code,
      });
    }

    return data;
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
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    const response = await this.makeRequest(messages);

    if (!response.choices || response.choices.length === 0) {
      throw new LLMError('API_ERROR', 'No choices in response');
    }

    const message = response.choices[0].message;

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

    const response = await this.makeStreamRequest(messages, signal, { emitContent: true });

    if (!response.content) {
      throw new LLMError('API_ERROR', 'No content in response');
    }

    let content = response.content.trim();

    // 剥离 markdown 代码块标记
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      content = jsonMatch[1].trim();
    }

    // 始终提取第一个完整 JSON 对象（避免 content 前后有附加文本导致 JSON.parse 失败）
    const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
      content = jsonObjectMatch[0];
    }

    try {
      const parsed = JSON.parse(content);
      return schema.parse(parsed);
    } catch (parseError) {
      // LLM 常见问题：字符串值内部包含未转义的双引号
      try {
        const repaired = repairUnescapedQuotes(content);
        const parsed = JSON.parse(repaired);
        log.warn('JSON 修复成功（原内容包含未转义双引号）');
        return schema.parse(parsed);
      } catch {
        // 修复后仍失败，抛出原始错误
      }
      const errMsg = parseError instanceof Error
        ? `${parseError.name}: ${parseError.message}`
        : String(parseError);
      log.error('Schema validation failed', { content: content.substring(0, 500) });
      log.error('Parse error', { errMsg });
      throw new LLMError('API_ERROR', 'Schema validation failed: ' + errMsg);
    }
  }

  /**
   * Make a streaming request to the LLM API
   * @param messages - Array of messages for the conversation
   * @param signal - Optional external abort signal
   * @returns Extracted reasoning and content from the stream
   */
  private async makeStreamRequest(
    messages: Message[],
    signal?: AbortSignal,
    options: { emitContent?: boolean } = {}
  ): Promise<{ reasoning: string; content: string }> {
    // 总超时计时器（5 分钟），防止整个重试过程无限等待
    const totalTimeoutController = new AbortController();
    const totalTimeoutId = setTimeout(() => totalTimeoutController.abort(), 300000);
    const onTotalTimeoutAbort = () => totalTimeoutController.abort();
    signal?.addEventListener('abort', onTotalTimeoutAbort);

    try {
      const requestBody = this.buildRequestBody(messages, { stream: true });
      const response = await this.fetchWithRetry(requestBody, signal);
      return await this.readSSEStream(response, signal, options);
    } finally {
      clearTimeout(totalTimeoutId);
      if (signal) {
        signal.removeEventListener('abort', onTotalTimeoutAbort);
      }
    }
  }

  /**
   * Generate text with tool calling support - with message tracking
   *
   * @param messages - 初始消息数组（支持传入已有上下文用于断点续执行）
   * @param tools - 可用工具定义
   * @param toolExecutor - 工具执行回调
   * @param signal - 可选的中止信号
   * @param concurrencyChecker - 并发安全性检查函数
   * @returns 包含 content、toolCalls 和完整 messages 的结果
   */
  async generateWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    toolExecutor: (toolCall: { name: string; arguments: Record<string, unknown> }) => Promise<string>,
    signal?: AbortSignal,
    concurrencyChecker?: (toolName: string, toolArgs: Record<string, unknown>) => boolean
  ): Promise<{ content: string; toolCalls: ToolCallResult[]; messages: Message[] }> {
    const trackedMessages = [...messages];

    const toolCallsResults: ToolCallResult[] = [];
    let maxIterations = 10;
    let iteration = 0;

    while (maxIterations-- > 0) {
      if (signal?.aborted) {
        throw new LLMError('CANCELLED', 'Tool calling loop cancelled by external signal');
      }

      iteration++;
      log.debug('工具调用循环开始', { iteration, timestamp: new Date().toISOString() });
      const llmStartTime = Date.now();
      const result = await this.makeToolRequestStream(trackedMessages, tools, signal);
      const llmDuration = Date.now() - llmStartTime;
      log.debug('LLM 响应耗时', { duration: llmDuration });

      if (!result.message) {
        throw new LLMError('API_ERROR', 'No message in response');
      }

      const message = result.message;

      log.debug('Response message.content', { content: message.content?.substring(0, 200) });
      log.debug('Response message.tool_calls', { count: message.tool_calls?.length });

      if (!message.tool_calls || message.tool_calls.length === 0) {
        log.debug('No tool_calls in response, returning content directly');

        // NOTE: 必须在返回前将 assistant 回复加入 trackedMessages，
        // 否则纯对话技能的 conversationContext 会丢失 assistant 的提问，
        // 导致断点续执行时 LLM 看不到历史问答而重复提问
        trackedMessages.push({
          role: 'assistant',
          content: message.content || '',
        });

        return {
          content: message.content || '',
          toolCalls: toolCallsResults,
          messages: trackedMessages,
        };
      }

      log.debug('Has tool_calls, will execute them');

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
        log.debug('P1-2: 并行执行并发安全工具调用', { count: safeCalls.length });
        const safeResults = await Promise.allSettled(
          safeCalls.map(async (toolCall) => {
            const toolName = toolCall.function.name;
            let toolArgs: Record<string, unknown>;
            try {
              toolArgs = JSON.parse(toolCall.function.arguments);
            } catch {
              toolArgs = {};
            }

            log.debug('执行工具 (并行)', { toolName, toolArgs });

            let toolResult: string;
            try {
              const execStart = Date.now();
              toolResult = await toolExecutor({ name: toolName, arguments: toolArgs });
              const execDuration = Date.now() - execStart;
              log.debug('并行工具完成', { toolName, duration: execDuration, resultLength: toolResult.length });
            } catch (execError) {
              log.error('工具执行失败', { error: execError });
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
            log.error('并行工具调用失败', { reason: result.reason });
            const failedIndex = safeResults.indexOf(result);
            if (failedIndex >= 0 && safeCalls[failedIndex]) {
              const errorMsg = `工具执行失败: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`;
              trackedMessages.push({
                role: 'tool',
                content: errorMsg,
                tool_call_id: safeCalls[failedIndex].id,
              });
            }
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
          log.error('工具参数 JSON 解析失败', { arguments: toolCall.function.arguments });
          toolArgs = {};
        }

        log.debug('执行工具 (串行)', { toolName, toolArgs });

        let toolResult: string;
        try {
          const execStart = Date.now();
          toolResult = await toolExecutor({
            name: toolName,
            arguments: toolArgs,
          });
          const execDuration = Date.now() - execStart;
          log.debug('工具执行完成', { toolName, duration: execDuration, resultLength: toolResult.length });
        } catch (execError) {
          log.error('工具执行失败', { error: execError });
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

  /**
   * Make a non-streaming tool-calling request to the LLM API
   * @param messages - Array of messages for the conversation
   * @param tools - Available tool definitions
   * @param signal - Optional external abort signal
   * @returns Parsed message with tool_calls and reasoning
   */
  private async makeToolRequestStream(
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<{ message: Message; reasoning: string }> {
    const requestBody = this.buildRequestBody(messages, { tools, stream: false });
    const response = await this.fetchWithRetry(requestBody, signal);

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

    log.info('工具调用请求完成', { reasoningLength: reasoning.length, contentLength: (message.content || '').length, toolCallsCount: message.tool_calls?.length || 0 });

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
  }
}
