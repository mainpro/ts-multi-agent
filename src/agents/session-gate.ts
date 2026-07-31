/**
 * SessionGate — encapsulates the decision of whether a new user message
 * should execute immediately, queue behind an active request, or continue
 * a waiting one.
 *
 * Decision rules (locked):
 *   - No active request        -> 'fresh'
 *   - Active status=processing -> 'queue' (drains at next checkpoint)
 *   - Active status=waiting    -> 'continue_waiting' (user is answering)
 *   - Active status=other      -> 'queue' (defensive default)
 */
import { Request, PendingRequest } from '../types';
import { SessionStore } from '../memory/session-store';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'SessionGate' });

/**
 * Maximum number of pending requests allowed in a session's queue.
 * Beyond this, new submissions are rejected with 503 Service Unavailable.
 * Rationale: if R1 runs for a long time and R2-R10 queue up, the eventual
 * merge would push the merged requirement past token limits (4000+ chars).
 * The cap protects the LLM context window.
 */
export const MAX_PENDING_REQUESTS = 10;

/**
 * 'processing' request 在没有更新的情况下被视为陈旧的时间阈值。
 * 超过此时间的 'processing' active request 视为已被中断(进程崩溃后无清理),
 * gate 按 fresh 处理放行,避免卡死整个 session。
 *
 * 启动清理 (SessionStore.cleanupStaleSessions) 会持久化修正这种状态;
 * 这里只是短期 fallback,避免重启后第一次请求被错误拦截。
 */
export const STALE_PROCESSING_MS = 5 * 60 * 1000; // 5 minutes

export class QueueFullError extends Error {
  constructor(public readonly pendingCount: number) {
    super(`Pending queue full (${pendingCount}/${MAX_PENDING_REQUESTS})`);
    this.name = 'QueueFullError';
  }
}

export type SessionGateDecision =
  | { type: 'fresh' }
  | { type: 'queue'; activeRequest: Request; pending: PendingRequest[] }
  | { type: 'continue_waiting'; activeRequest: Request };

export class SessionGate {
  constructor(private sessionStore: SessionStore) {}

  async decide(
    userId: string,
    sessionId: string,
    _newDraft: Omit<PendingRequest, 'enqueuedAt'>,
  ): Promise<SessionGateDecision> {
    const session = await this.sessionStore.loadSession(userId, sessionId);
    if (!session.activeRequestId) {
      return { type: 'fresh' };
    }
    const activeRequest = session.requests.find(r => r.requestId === session.activeRequestId);
    if (!activeRequest) {
      // Defensive: dangling activeRequestId
      return { type: 'fresh' };
    }
    if (activeRequest.status === 'waiting') {
      return { type: 'continue_waiting', activeRequest };
    }
    // Stale 'processing' 检测:进程崩溃后,activeRequestId 可能指向 'processing' request,
    // 但服务器已重启,实际没有人在跑。超过阈值按 fresh 处理(不主动清 session,
    // 启动清理 cleanupStaleSessions 负责持久化修正)。
    if (activeRequest.status === 'processing') {
      const lastUpdate = new Date(activeRequest.updatedAt).getTime();
      if (Date.now() - lastUpdate > STALE_PROCESSING_MS) {
        log.warn('检测到陈旧 processing active request,按 fresh 处理', {
          requestId: activeRequest.requestId,
          staleMs: Date.now() - lastUpdate,
          thresholdMs: STALE_PROCESSING_MS,
        });
        return { type: 'fresh' };
      }
    }
    // processing (未超阈值) / suspended / checkpoint_reached / failed — queue
    return { type: 'queue', activeRequest, pending: [...session.pendingRequests] };
  }

  async enqueue(userId: string, sessionId: string, draft: PendingRequest): Promise<{ position: number }> {
    const session = await this.sessionStore.loadSession(userId, sessionId);
    if (session.pendingRequests.length >= MAX_PENDING_REQUESTS) {
      log.warn('pending queue full, rejecting enqueue', {
        draftId: draft.draftId,
        pendingCount: session.pendingRequests.length,
        max: MAX_PENDING_REQUESTS,
      });
      throw new QueueFullError(session.pendingRequests.length);
    }
    session.pendingRequests.push(draft);
    // Sync write: pending queues must survive process crashes (we'd lose the
    // user's input otherwise). Use flushToDisk directly, bypassing the
    // 100ms debounce of saveSession.
    await this.sessionStore.flushToDisk(userId, sessionId, session);
    log.info('enqueued pending request', { draftId: draft.draftId, position: session.pendingRequests.length });
    return { position: session.pendingRequests.length };
  }

  async drain(userId: string, sessionId: string): Promise<PendingRequest[]> {
    const session = await this.sessionStore.loadSession(userId, sessionId);
    const drained = [...session.pendingRequests];
    session.pendingRequests = [];
    // Sync write: at the checkpoint, pending has just been drained into R2. If
    // we crash before the next debounce flush, the queue would round-trip
    // pending → R2 → pending, causing R2 to be re-merged unexpectedly.
    await this.sessionStore.flushToDisk(userId, sessionId, session);
    return drained;
  }
}