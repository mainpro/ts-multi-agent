import { AppError } from '../errors';
import { ApiResponse } from '../types/api-response';

export function errorToResponse(error: unknown): {
  status: number;
  body: ApiResponse<null>;
} {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: {
        success: false,
        error: {
          type: error.type,
          code: error.code,
          message: error.message,
        },
      },
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      body: {
        success: false,
        error: {
          type: 'FATAL',
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      success: false,
      error: {
        type: 'FATAL',
        code: 'UNKNOWN_ERROR',
        message: String(error),
      },
    },
  };
}
