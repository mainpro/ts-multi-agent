/**
 * Task lifecycle events.
 *
 * Emitted by MainAgent as a translation layer over TaskQueue's internal
 * `task-started` / `task-completed` / `task-failed` events. Subscribed by
 * the API layer to forward to SSE clients.
 *
 * Why a separate emitter (rather than forwarding TaskQueue's emitter directly):
 *  - TaskQueue's emitter is used by `TaskGraphExecutor.onceTaskEvent` as a
 *    one-shot subscription; mixing fan-out listeners into it would muddy that
 *    semantic.
 *  - The translation layer (MainAgent) can attach request/plan context
 *    (requestId, planId, totalTasks) without TaskQueue needing to know about
 *    those concepts.
 *  - Mirrors the `RequestLifecycleEmitter` pattern, keeping the codebase
 *    consistent.
 *
 * Payload shape is intentionally minimal — frontend reconstructs the per-task
 * row from `task_started` (which carries requirement/skillName) and updates
 * it on the subsequent state-change events.
 */
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'TaskEvents' });

export type TaskEvent =
  | {
      type: 'task_started';
      requestId: string;
      planId: string;
      taskId: string;
      requirement: string;
      skillName: string | null;
      totalTasks: number;
      startedAt: string;
    }
  | {
      type: 'task_completed';
      requestId: string;
      planId: string;
      taskId: string;
      status: 'completed';
      durationMs: number;
    }
  | {
      type: 'task_failed';
      requestId: string;
      planId: string;
      taskId: string;
      status: 'failed';
      error: {
        type: string;
        code?: string;
        message: string;
      };
      durationMs: number;
    }
  | {
      type: 'task_waiting';
      requestId: string;
      planId: string;
      taskId: string;
      status: 'waiting';
      requirement: string;
      skillName: string | null;
      question: {
        content: string;
        metadata?: Record<string, unknown>;
      };
    };

export type TaskEventType = TaskEvent['type'];

class TaskEventEmitter {
  private listeners: Map<TaskEventType, Array<(event: TaskEvent) => void>> = new Map();

  on(event: TaskEventType, callback: (event: TaskEvent) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(callback);
    return () => this.off(event, callback);
  }

  off(event: TaskEventType, callback: (event: TaskEvent) => void): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const idx = list.indexOf(callback);
    if (idx > -1) list.splice(idx, 1);
  }

  emit(event: TaskEvent): void {
    const list = this.listeners.get(event.type);
    if (!list) return;
    for (const cb of list) {
      try {
        cb(event);
      } catch (e) {
        log.warn('task event listener threw', { error: e, eventType: event.type });
      }
    }
  }
}

export const taskEvents = new TaskEventEmitter();