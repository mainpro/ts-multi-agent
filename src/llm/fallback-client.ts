/**
 * FallbackLLMClient — ILLMClient 装饰器,按 priority 顺序遍历 LLMFallbackConfig 的候选,
 * 在 cooldown / AbortSignal / failover-classifier 的协同下实现 provider 自动切换。
 *
 * 协作模块(全部来自 Task 1-5):
 *  - classifyFailoverReason(Task 2):把任意 thrown err 映射为 FailoverReason(或不映射)
 *  - cooldown(Task 3): 进程级单例,带 TTL 指数退避,跳过 / 标记不可用 provider
 *  - sharedSlot(Task 4): 全局共享并发槽位池,failover 链中所有 candidate 共享同一上限
 *  - FailoverError(Task 1): 切换穷尽后的最终错误,message 不含原始异常细节(防信息泄露)
 *  - LLMFallbackConfig(Task 5): zod 校验过的候选链配置
 *
 * 切换语义:
 *  - candidate 在 cooldown → 跳过
 *  - candidate 抛 LLMError → classifyFailoverReason 拿到 reason:
 *      - context_too_long / output_too_long:model-specific,不切换,原样抛出
 *      - 其他:push attempt + cooldown.mark + log warn,继续下一个
 *  - candidate 抛非 LLMError / CANCELLED/QUEUE_FULL/UNKNOWN_ERROR → classifyFailoverReason
 *    返回 null,按 brief 直接 throw err(不切换)
 *  - candidate 成功且有过 failover → log warn(便于排障)
 *  - 全部候选穷尽 → throw FailoverError(reason = 最后一次 attempt 的 reason)
 *
 * AbortSignal 语义:每次进入循环 / 跨 candidate 都会检查;已 abort 则抛错并停止。
 * `sharedSlot.acquire` 已支持 signal(已 abort 立即抛 'aborted'),双重保险。
 *
 * 信息脱敏:FailoverError.message 仅含 providerId + reason + attempts.length,
 * 不含任何原始 LLMError.message 或 originalError 的细节,避免凭据 / PII 泄露到上游日志。
 */
import { ILLMClient } from './interfaces';
import { Message, ToolDefinition, ToolCallResult } from '../types';
import { classifyFailoverReason } from './failover-classifier';
import { cooldown } from './cooldown-cache';
import { sharedSlot } from './llm-slot-registry';
import { FailoverError, FailoverAttempt } from './failover-types';
import { LLMFallbackConfig } from './failover-config';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'FallbackLLMClient' });

interface Candidate {
  providerKey: string;
  client: ILLMClient;
  priority: number;
}

export class FallbackLLMClient implements ILLMClient {
  private candidates: Candidate[];

  constructor(config: LLMFallbackConfig, buildClient: (providerKey: string) => ILLMClient) {
    this.candidates = config.candidates
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map(c => ({
        providerKey: c.providerKey,
        priority: c.priority,
        client: buildClient(c.providerKey),
      }));
  }

  async generateText(prompt: string, systemPrompt?: string): Promise<string> {
    return this.runWithFailover(c => c.client.generateText(prompt, systemPrompt));
  }

  async generateStructured<T>(
    prompt: string,
    schema: any,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.runWithFailover(c => c.client.generateStructured(prompt, schema, systemPrompt, signal), signal);
  }

  async generateWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    toolExecutor: (call: { name: string; arguments: Record<string, unknown> }) => Promise<string>,
    signal?: AbortSignal,
    concurrencyChecker?: any,
    onIterationStart?: any,
    requestId?: string,
  ): Promise<{ content: string; toolCalls: ToolCallResult[]; messages: Message[] }> {
    return this.runWithFailover(
      c => c.client.generateWithTools(messages, tools, toolExecutor, signal, concurrencyChecker, onIterationStart, requestId),
      signal,
    );
  }

  private async runWithFailover<T>(
    fn: (candidate: Candidate) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const attempts: FailoverAttempt[] = [];
    for (const c of this.candidates) {
      if (signal?.aborted) throw new Error('aborted');
      if (!cooldown.isAvailable(c.providerKey)) {
        log.debug('skipping candidate in cooldown', { providerKey: c.providerKey });
        continue;
      }
      try {
        await sharedSlot.acquire(signal);
        try {
          const result = await fn(c);
          if (attempts.length > 0) {
            log.warn('LLM failover succeeded', {
              fromProviderKey: attempts[0].providerKey,
              toProviderKey: c.providerKey,
              attempts: attempts.length,
            });
          }
          return result;
        } finally {
          sharedSlot.release();
        }
      } catch (err) {
        const reason = classifyFailoverReason(err);
        if (!reason) throw err;
        if (reason === 'context_too_long' || reason === 'output_too_long') {
          throw err;
        }
        attempts.push({ providerKey: c.providerKey, reason });
        cooldown.mark(c.providerKey, reason);
        log.warn('LLM candidate failed, trying next', {
          providerKey: c.providerKey,
          reason,
        });
      }
    }
    throw new FailoverError(
      attempts.at(-1)?.reason ?? 'server_error',
      attempts.at(-1)?.providerKey ?? 'unknown',
      attempts,
    );
  }
}
