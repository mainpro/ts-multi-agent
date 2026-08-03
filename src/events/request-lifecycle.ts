/**
 * Request lifecycle events.
 *
 * Emitted by MainAgent during queue-and-merge orchestration.
 * Subscribed by the API layer to forward to SSE clients.
 *
 * Separated from llmEvents (which carries LLM reasoning) to keep concerns
 * isolated: lifecycle events have structured payloads and never carry
 * reasoning content.
 */
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'RequestLifecycle' });

export type RequestLifecycleEvent =
  | {
      type: 'request_queued';
      draftId: string;
      position: number;
      enqueuedAt: string;
    }
  | {
      type: 'request_checkpoint';
      requestId: string;
      checkpointAt: string;
      pendingCount: number;
      completedTaskCount: number;
    }
  | {
      type: 'request_spawned';
      requestId: string;
      parentRequestId: string;
      draftIds: string[];
      requirementPreview: string;
    }
  | {
      type: 'request_error';
      requestId: string;           // the request that failed (R2 in merge flow)
      parentRequestId?: string;    // present when failure is in a merged/spawned request
      error: {
        type: 'FATAL' | 'USER_ERROR' | string;
        code?: string;
        message: string;
      };
      timestamp: string;
    }
  | {
      type: 'request_steered';
      requestId: string;           // the active request receiving the steer
      taskId: string;              // which SubAgent task consumed the steer
      content: string;             // the steer message content
      enqueuedAt: string;          // when the user sent it
      consumedAt: string;          // when SubAgent consumed it
    }
  | {
      type: 'request_completed';
      requestId: string;
      sessionId: string;
      status: 'completed' | 'failed';
      completedAt: string;
    };

export type RequestLifecycleEventType = RequestLifecycleEvent['type'];

class RequestLifecycleEmitter {
  private listeners: Map<RequestLifecycleEventType, Array<(event: RequestLifecycleEvent) => void>> = new Map();

  on(event: RequestLifecycleEventType, callback: (event: RequestLifecycleEvent) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(callback);
  }

  off(event: RequestLifecycleEventType, callback: (event: RequestLifecycleEvent) => void): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const idx = list.indexOf(callback);
    if (idx > -1) list.splice(idx, 1);
  }

  emit(event: RequestLifecycleEvent): void {
    const list = this.listeners.get(event.type);
    if (!list) return;
    for (const cb of list) {
      try {
        cb(event);
      } catch (e) {
        log.warn('lifecycle listener threw', { error: e, eventType: event.type });
      }
    }
  }
}

export const requestLifecycle = new RequestLifecycleEmitter();