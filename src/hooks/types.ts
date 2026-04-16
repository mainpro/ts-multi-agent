/**
 * Hook 类型定义
 * P2-2: Hooks 生命周期系统
 */

export enum HookEvent {
  BEFORE_INTENT_CLASSIFY = 'before:intent_classify',
  AFTER_INTENT_CLASSIFY = 'after:intent_classify',
  BEFORE_TASK_EXECUTE = 'before:task_execute',
  AFTER_TASK_EXECUTE = 'after:task_execute',
  BEFORE_TOOL_CALL = 'before:tool_call',
  AFTER_TOOL_CALL = 'after:tool_call',
  ON_ERROR = 'on:error',
  ON_FALLBACK = 'on:fallback',
}

export interface HookContext {
  event: HookEvent;
  taskId?: string;
  skillName?: string;
  toolName?: string;
  userId?: string;
  sessionId?: string;
  timestamp: Date;
  data: Record<string, unknown>;
}

export type HookHandler = (context: HookContext) => Promise<void> | void;
