/**
 * LLM client interface — enables dependency injection and mocking in tests.
 * 放在独立文件以避免与 memory 模块的循环依赖。
 */
import { Message, ToolDefinition, ToolCallResult } from '../types';
import { ZodSchema } from 'zod';

export interface ILLMClient {
  generateText(prompt: string, systemPrompt?: string): Promise<string>;
  generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<T>;
  generateWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    toolExecutor: (toolCall: { name: string; arguments: Record<string, unknown> }) => Promise<string>,
    signal?: AbortSignal,
    concurrencyChecker?: (toolName: string, toolArgs: Record<string, unknown>) => boolean,
    /**
     * 每轮 LLM 调用前的回调,接收当前(可变的)消息数组。
     * 调用方可以往里 push 消息(例如 steer 队列里的用户改口),实现 turn 边界注入。
     */
    onIterationStart?: (messages: Message[]) => void,
    /**
     * 可选的请求级 ID(Final Review fix #2),用于把 LLM SLA breach 关联回
     * 上层 request / task。不传则走 fallback `llm-${ts}-${rand}`,时间戳已含
     * 在 slaId 内,便于人工对账。
     */
    requestId?: string,
  ): Promise<{ content: string; toolCalls: ToolCallResult[]; messages: Message[] }>;
}