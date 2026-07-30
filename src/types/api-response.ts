import { ErrorType } from './index';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { type: ErrorType; code: string; message: string };
}
