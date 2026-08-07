import { AppError, AppErrorOptions } from './app-error';

/**
 * 服务启动期失败。
 *
 * 用途:替换 `src/index.ts` 中 2 个 `process.exit(1)` 调用点(LLM 客户端初始化失败、
 * 整体 bootstrap 失败),使失败语义可被测试捕获、可被调用方决定如何处理。
 *
 * 显式区别于 `ConfigError`(FATAL):ConfigError 表示「配置不可用」,通常是单点配置问题;
 * BootstrapError 表示「启动流程失败」,可能由多个子步骤失败引起(如 LLM init、server listen 等)。
 */
export class BootstrapError extends AppError {
  readonly type = 'BOOTSTRAP_FAILED' as const;

  constructor(
    public readonly code: string,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message, { ...options, statusCode: options?.statusCode ?? 500 });
  }
}
