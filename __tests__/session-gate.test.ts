import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../src/memory/session-store';
import { SessionGate } from '../src/agents/session-gate';
import { Session, Request, PendingRequest } from '../src/types';

describe('SessionGate', () => {
  let dataDir: string;
  let store: SessionStore;
  let gate: SessionGate;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `sg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
    store = new SessionStore(100, dataDir);
    gate = new SessionGate(store);
  });

  test('decide: no active request returns "fresh"', async () => {
    const decision = await gate.decide('u1', 's1', { draftId: 'd1', requirement: 'hi', hasImage: false });
    expect(decision.type).toBe('fresh');
  });

  test('decide: active in processing returns "queue"', async () => {
    let session = await store.loadSession('u1', 's1');
    const r1: Request = {
      requestId: 'r1', content: 'first', status: 'processing',
      createdAt: 'x', updatedAt: 'x',
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null, tasks: [], result: null,
    };
    session.requests.push(r1);
    session.activeRequestId = 'r1';
    session.pendingRequests = [];
    await store.saveSession('u1', 's1', session);
    await new Promise(r => setTimeout(r, 150));

    const decision = await gate.decide('u1', 's1', { draftId: 'd2', requirement: 'second', hasImage: false });
    expect(decision.type).toBe('queue');
    if (decision.type === 'queue') expect(decision.activeRequest.requestId).toBe('r1');
  });

  test('decide: active in waiting returns "continue_waiting" (NOT queue)', async () => {
    let session = await store.loadSession('u1', 's1');
    const r1: Request = {
      requestId: 'r1', content: 'first', status: 'waiting',
      createdAt: 'x', updatedAt: 'x',
      suspendedAt: null, suspendedReason: null,
      questions: [], currentQuestion: null, tasks: [], result: null,
    };
    session.requests.push(r1);
    session.activeRequestId = 'r1';
    session.pendingRequests = [];
    await store.saveSession('u1', 's1', session);
    await new Promise(r => setTimeout(r, 150));

    const decision = await gate.decide('u1', 's1', { draftId: 'd2', requirement: 'answer', hasImage: false });
    expect(decision.type).toBe('continue_waiting');
  });

  test('enqueue: appends to pendingRequests and returns position', async () => {
    await store.loadSession('u1', 's1');
    const draft: PendingRequest = { draftId: 'd1', requirement: 'hi', enqueuedAt: new Date().toISOString(), hasImage: false };
    const { position } = await gate.enqueue('u1', 's1', draft);
    expect(position).toBe(1);

    const draft2: PendingRequest = { draftId: 'd2', requirement: 'hi 2', enqueuedAt: new Date().toISOString(), hasImage: false };
    const { position: p2 } = await gate.enqueue('u1', 's1', draft2);
    expect(p2).toBe(2);
  });

  test('drain: returns and clears all pending in FIFO order', async () => {
    await store.loadSession('u1', 's1');
    await gate.enqueue('u1', 's1', { draftId: 'd1', requirement: 'A', enqueuedAt: 't1', hasImage: false });
    await gate.enqueue('u1', 's1', { draftId: 'd2', requirement: 'B', enqueuedAt: 't2', hasImage: false });

    const drained = await gate.drain('u1', 's1');
    expect(drained.map(p => p.draftId)).toEqual(['d1', 'd2']);

    const session = await store.loadSession('u1', 's1');
    expect(session.pendingRequests).toEqual([]);
  });
});