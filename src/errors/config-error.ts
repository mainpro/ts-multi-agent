import { AppError, AppErrorOptions } from './app-error';

export class ConfigError extends AppError {
  readonly type = 'FATAL' as const;

  constructor(
    public readonly code: string,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message, { ...options, statusCode: options?.statusCode ?? 500 });
  }
}
