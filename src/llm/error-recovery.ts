/**
 * 错误恢复管理器
 * P0-4: 错误恢复增强
 *
 * 删除 AutoCompactService 依赖。CONTEXT_TOO_LONG 时改为简单截断:
 * - 保留 system + 最后 N 条消息
 * - 不再调用 LLM 压缩(因为 buildContextPrompt 已 slice(-50))
 */

export interface RecoveryAction {
  strategy: string;
  description: string;
  execute: () => Promise<boolean>;
}

export class ErrorRecoveryManager {
  // @ts-expect-error reserved for future use
  private _maxRecoveryAttempts: number = 2;

  /**
   * 根据错误类型生成恢复策略
   * 使用 error.type 判断，而非 error.message 字符串匹配
   */
  getRecoveryActions(error: { type: string; message: string }, context: {
    messages?: any[];
    currentMaxTokens?: number;
  }): RecoveryAction[] {
    const actions: RecoveryAction[] = [];

    switch (error.type) {
      case 'RATE_LIMIT': {
        // 退避时间序列：10s → 30s → 60s
        const backoffDelays = [10000, 30000, 60000];
        let attempt = 0;
        actions.push({
          strategy: 'extended_backoff',
          description: '延长退避时间后重试（10s → 30s → 60s）',
          execute: async () => {
            const delay = backoffDelays[Math.min(attempt, backoffDelays.length - 1)];
            attempt++;
            console.log(`[ErrorRecovery] RATE_LIMIT 退避等待 ${delay / 1000}s (第 ${attempt} 次)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return true;
          },
        });
        break;
      }

      case 'TIMEOUT':
        actions.push({
          strategy: 'increase_timeout',
          description: '增加超时时间后重试',
          execute: async () => true,
        });
        break;

      case 'CONTEXT_TOO_LONG':
        actions.push({
          strategy: 'context_truncate',
          description: '截断上下文保留 system + 最后 N 条消息后重试',
          execute: async () => {
            if (context.messages && context.messages.length > 0) {
              // 简单截断:保留 system 消息 + 最后 10 条
              const systemMsgs = context.messages.filter((m: any) => m.role === 'system');
              const nonSystem = context.messages.filter((m: any) => m.role !== 'system');
              const kept = nonSystem.slice(-10);
              context.messages.length = 0;
              context.messages.push(...systemMsgs, ...kept);
              console.log(`[ErrorRecovery] CONTEXT_TOO_LONG 截断: ${systemMsgs.length + nonSystem.length} → ${systemMsgs.length + kept.length} 条`);
              return true;
            }
            return false;
          },
        });
        break;

      case 'OUTPUT_TOO_LONG':
        actions.push({
          strategy: 'increase_max_tokens',
          description: '增大 max_tokens 后重试',
          execute: async () => {
            if (context.currentMaxTokens) {
              context.currentMaxTokens = Math.min(context.currentMaxTokens * 4, 65536);
              return true;
            }
            return false;
          },
        });
        break;

      case 'API_ERROR':
        actions.push({
          strategy: 'generic_retry',
          description: '通用重试（指数退避）',
          execute: async () => true,
        });
        break;
    }

    return actions;
  }
}
