import { AppError, AppErrorOptions } from './app-error';

export class SkillError extends AppError {
  readonly type = 'SKILL_ERROR' as const;

  constructor(
    public readonly code: string,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message, { ...options, statusCode: options?.statusCode ?? 422 });
  }
}
