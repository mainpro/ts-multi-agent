import { ErrorType } from '../types';

export interface AppErrorOptions {
  cause?: unknown;
  statusCode?: number;
}

export abstract class AppError extends Error {
  abstract readonly type: ErrorType;
  abstract readonly code: string;
  readonly statusCode: number = 500;
  readonly cause?: unknown;

  constructor(message: string, options?: AppErrorOptions) {
    super(message);
    this.name = this.constructor.name;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options?.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    Error.captureStackTrace?.(this, this.constructor);
  }
}
