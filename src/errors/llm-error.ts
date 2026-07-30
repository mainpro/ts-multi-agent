import { LLMErrorType } from '../llm';
import { AppError, AppErrorOptions } from './app-error';

export class LlmError extends AppError {
  readonly type = 'RETRYABLE' as const;
  readonly code: string;

  constructor(
    public readonly llmErrorType: LLMErrorType,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message, {
      ...options,
      statusCode: options?.statusCode ?? LlmError.mapStatusCode(llmErrorType),
    });
    this.code = `LLM_${llmErrorType}`;
  }

  static mapStatusCode(t: LLMErrorType): number {
    if (t === 'RATE_LIMIT') return 429;
    if (t === 'INVALID_KEY') return 401;
    if (t === 'TIMEOUT') return 504;
    if (t === 'CONTEXT_TOO_LONG' || t === 'OUTPUT_TOO_LONG') return 400;
    if (t === 'CANCELLED') return 499;
    if (t === 'QUEUE_FULL') return 503;
    if (t === 'UNKNOWN_ERROR') return 500;
    return 502;
  }
}
