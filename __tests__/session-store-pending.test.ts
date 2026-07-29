import { describe, test, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../src/memory/session-store';
import { Session, PendingRequest } from '../src/types';

describe('SessionStore pendingRequests', () => {
  let dataDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `ss-pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
    store = new SessionStore(100, dataDir);
  });

  test('loadSession on new user returns pendingRequests: []', async () => {
    const session = await store.loadSession('u1', 's1');
    expect(session.pendingRequests).toEqual([]);
  });

  test('loadSession on legacy JSON missing pendingRequests defaults to []', async () => {
    const dir = path.join(dataDir, 'memory', 'u1', 'session');
    await fs.mkdir(dir, { recursive: true });
    const legacy: Session = {
      sessionId: 's1', userId: 'u1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requests: [], activeRequestId: null,
      pendingRequests: undefined as any,  // simulate legacy
    };
    await fs.writeFile(path.join(dir, 's1.json'), JSON.stringify(legacy, null, 2));
    // wait for any debounce to flush
    await new Promise(r => setTimeout(r, 200));
    const loaded = await store.loadSession('u1', 's1');
    expect(Array.isArray(loaded.pendingRequests)).toBe(true);
    expect(loaded.pendingRequests).toEqual([]);
  });

  test('pendingRequests roundtrip via saveSession', async () => {
    let session = await store.loadSession('u1', 's1');
    const pending: PendingRequest[] = [
      { draftId: 'd1', requirement: 'msg A', enqueuedAt: new Date().toISOString(), hasImage: false },
      { draftId: 'd2', requirement: 'msg B', enqueuedAt: new Date().toISOString(), hasImage: false },
    ];
    session.pendingRequests = pending;
    await store.saveSession('u1', 's1', session);
    // wait for debounce
    await new Promise(r => setTimeout(r, 200));
    // drop in-memory cache to force disk read
    const store2 = new SessionStore(100, dataDir);
    const reloaded = await store2.loadSession('u1', 's1');
    expect(reloaded.pendingRequests).toEqual(pending);
  });
});