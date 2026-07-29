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
    // processing / suspended / checkpoint_reached / failed — queue
    return { type: 'queue', activeRequest, pending: [...session.pendingRequests] };
  }

  async enqueue(userId: string, sessionId: string, draft: PendingRequest): Promise<{ position: number }> {
    const session = await this.sessionStore.loadSession(userId, sessionId);
    session.pendingRequests.push(draft);
    await this.sessionStore.saveSession(userId, sessionId, session);
    log.info('enqueued pending request', { draftId: draft.draftId, position: session.pendingRequests.length });
    return { position: session.pendingRequests.length };
  }

  async drain(userId: string, sessionId: string): Promise<PendingRequest[]> {
    const session = await this.sessionStore.loadSession(userId, sessionId);
    const drained = [...session.pendingRequests];
    session.pendingRequests = [];
    await this.sessionStore.saveSession(userId, sessionId, session);
    return drained;
  }
}