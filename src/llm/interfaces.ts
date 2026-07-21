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
  ): Promise<{ content: string; toolCalls: ToolCallResult[]; messages: Message[] }>;
}