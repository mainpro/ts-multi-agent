/**
 * 结构化日志
 * P2-1: 结构化日志与指标
 *
 * 自动从 AsyncLocalStorage 注入 traceId(若 RequestContext 中存在),
 * 无需在每个 log 调用点显式传递。运维可通过 `grep traceId=xxx`
 * 串联单次请求跨模块的全链路日志。
 */

import { RequestContext } from '../context/request-context';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  module: string;
  message: string;
  [key: string]: any;
}

class Logger {
  private context: Record<string, string>;
  private minLevel: LogLevel;

  constructor(context: Record<string, string> = {}, minLevel: LogLevel = LogLevel.INFO) {
    this.context = context;
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private log(level: LogLevel, message: string, data?: Record<string, any>): void {
    if (!this.shouldLog(level)) return;

    // 从 RequestContext 注入 traceId(若有),保证全链路日志可串联
    const ctxTraceId = RequestContext.getStore()?.traceId;
    const traceContext = ctxTraceId ? { traceId: ctxTraceId } : {};

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      module: this.context.module || 'unknown',
      message,
      ...this.context,
      ...traceContext,
      ...data,
    };

    const output = JSON.stringify(entry);

    switch (level) {
      case LogLevel.ERROR:
        console.error(output);
        break;
      case LogLevel.WARN:
        console.warn(output);
        break;
      case LogLevel.DEBUG:
        console.debug(output);
        break;
      default:
        console.log(output);
    }
  }

  debug(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.ERROR, message, data);
  }

  /**
   * 创建子 Logger（继承上下文）
   */
  child(additionalContext: Record<string, string>): Logger {
    return new Logger({ ...this.context, ...additionalContext }, this.minLevel);
  }
}

// 默认日志级别从环境变量读取
const defaultLevel = (process.env.LOG_LEVEL?.toUpperCase() as LogLevel) || LogLevel.INFO;

export function createLogger(context: Record<string, string> = {}): Logger {
  return new Logger(context, defaultLevel);
}

export { Logger };
