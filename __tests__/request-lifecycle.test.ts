import { describe, test, expect } from 'bun:test';
import { requestLifecycle, RequestLifecycleEvent } from '../src/events/request-lifecycle';

describe('requestLifecycle emitter', () => {
  test('on() registers a listener that receives matching events', () => {
    const received: RequestLifecycleEvent[] = [];
    const handler = (e: RequestLifecycleEvent) => received.push(e);
    requestLifecycle.on('request_queued', handler);
    requestLifecycle.emit({ type: 'request_queued', draftId: 'd1', position: 1, enqueuedAt: '2026-07-29T00:00:00Z' });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('request_queued');
    expect((received[0] as any).draftId).toBe('d1');
    requestLifecycle.off('request_queued', handler);
  });

  test('off() removes the listener', () => {
    const received: RequestLifecycleEvent[] = [];
    const handler = (e: RequestLifecycleEvent) => received.push(e);
    requestLifecycle.on('request_checkpoint', handler);
    requestLifecycle.off('request_checkpoint', handler);
    requestLifecycle.emit({ type: 'request_checkpoint', requestId: 'r1', checkpointAt: 'x', pendingCount: 0, completedTaskCount: 0 });
    expect(received).toHaveLength(0);
  });

  test('listeners for different event types do not cross-fire', () => {
    const queuedReceived: RequestLifecycleEvent[] = [];
    const handler = (e: RequestLifecycleEvent) => queuedReceived.push(e);
    requestLifecycle.on('request_queued', handler);
    requestLifecycle.emit({ type: 'request_spawned', requestId: 'r2', parentRequestId: 'r1', draftIds: ['d1'], requirementPreview: '...' });
    expect(queuedReceived).toHaveLength(0);
    requestLifecycle.off('request_queued', handler);
  });

  test('listener error does not break subsequent listeners', () => {
    const received: RequestLifecycleEvent[] = [];
    const badHandler = () => { throw new Error('boom'); };
    const goodHandler = (e: RequestLifecycleEvent) => received.push(e);
    requestLifecycle.on('request_queued', badHandler);
    requestLifecycle.on('request_queued', goodHandler);
    requestLifecycle.emit({ type: 'request_queued', draftId: 'd1', position: 1, enqueuedAt: 'x' });
    expect(received).toHaveLength(1);
    requestLifecycle.off('request_queued', badHandler);
    requestLifecycle.off('request_queued', goodHandler);
  });
});