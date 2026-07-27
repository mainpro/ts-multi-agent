import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { AppError } from '../errors';
import { ApiResponse } from '../types/api-response';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'api-error-handler' });

export interface RequestWithTrace extends Request {
  traceId: string;
}

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

export function traceIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers['x-trace-id'];
  const traceId =
    typeof incoming === 'string' && incoming.length > 0
      ? incoming
      : crypto.randomUUID();
  (req as RequestWithTrace).traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  next();
}

export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const traceId = (req as RequestWithTrace).traceId ?? 'unknown';
  const { status, body } = errorToResponse(err);

  log.error('Request failed', {
    traceId,
    method: req.method,
    path: req.path,
    status,
    errType: err instanceof AppError ? err.constructor.name : 'Unknown',
    errMessage: err instanceof Error ? err.message : String(err),
  });

  res.status(status).json(body);
}
