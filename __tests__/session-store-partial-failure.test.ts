import { SessionStore } from '../src/memory/session-store';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('SessionStore.completeRequest with partialFailure', () => {
  let dataDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-test-'));
    store = new SessionStore(10, dataDir);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('marks partialFailure=true when options provided', async () => {
    const req = await store.createRequest('user-1', 'sess-1', 'test req');
    await store.completeRequest('user-1', 'sess-1', req.requestId, 'result', {
      partialFailure: true,
      failedTaskIds: ['task-1', 'task-2'],
    });
    const session = await store.loadSession('user-1', 'sess-1');
    const r = session.requests.find(x => x.requestId === req.requestId)!;
    expect(r.partialFailure).toBe(true);
    expect(r.failedTaskIds).toEqual(['task-1', 'task-2']);
    expect(r.status).toBe('completed'); // 仍然 completed,不是 failed
  });

  it('does not set partialFailure when options omitted (backwards compat)', async () => {
    const req = await store.createRequest('user-1', 'sess-1', 'test req');
    await store.completeRequest('user-1', 'sess-1', req.requestId, 'result');
    const session = await store.loadSession('user-1', 'sess-1');
    const r = session.requests.find(x => x.requestId === req.requestId)!;
    expect(r.partialFailure).toBeUndefined();
  });

  it('keeps status=completed even when some tasks failed (syncRequestStatus bug)', async () => {
    // Bug repro: when partialFailure=true but request has tasks with mixed
    // statuses (some completed, some failed), syncRequestStatus incorrectly
    // derives status='failed'. Per spec, status must remain 'completed' and
    // partialFailure flag carries the "partial" semantics.
    const req = await store.createRequest('user-1', 'sess-1', 'test req');

    // Inject tasks with mixed statuses (one completed, one failed)
    await store.updateRequest('user-1', 'sess-1', req.requestId, {
      tasks: [
        {
          taskId: 'task-1',
          content: 'first',
          status: 'completed',
          skillName: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: 'done',
          questions: [],
          currentQuestion: null,
        },
        {
          taskId: 'task-2',
          content: 'second',
          status: 'failed',
          skillName: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: null,
          questions: [],
          currentQuestion: null,
        },
      ],
    });

    await store.completeRequest('user-1', 'sess-1', req.requestId, 'aggregated', {
      partialFailure: true,
      failedTaskIds: ['task-2'],
    });

    const session = await store.loadSession('user-1', 'sess-1');
    const r = session.requests.find(x => x.requestId === req.requestId)!;
    expect(r.partialFailure).toBe(true);
    expect(r.failedTaskIds).toEqual(['task-2']);
    // Critical contract: status must remain 'completed', not 'failed'
    expect(r.status).toBe('completed');
    expect(r.status).not.toBe('failed');
  });
});