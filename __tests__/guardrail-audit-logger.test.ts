import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { auditLogger } from '../src/guardrail/audit-logger';

describe('AuditLogger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-'));
    auditLogger.configure({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  test('writes JSONL to dated file', async () => {
    await auditLogger.log({
      userId: 'u-1',
      action: 'deny',
      ruleName: 'BLACKLIST_KEYWORD',
      reason: 'hit "DROP TABLE"',
      contentPreview: 'DROP TABLE foo',
      profile: { role: 'employee', permissions: [] },
      decision: { action: 'deny', reason: 'hit', ruleName: 'BLACKLIST_KEYWORD' },
    });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, 'audit', `${today}.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.userId).toBe('u-1');
    expect(entry.action).toBe('deny');
    expect(entry.timestamp).toBeDefined();
    expect(entry.traceId).toBeDefined();
  });

  test('appends to same file across multiple calls', async () => {
    for (let i = 0; i < 3; i++) {
      await auditLogger.log({
        userId: `u-${i}`,
        action: 'alert',
        ruleName: 'LONG_AMBIGUOUS',
        reason: 'too long',
        contentPreview: 'x'.repeat(100),
        profile: { role: 'employee', permissions: [] },
        decision: { action: 'alert', reason: 'long', ruleName: 'LONG_AMBIGUOUS' },
      });
    }
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, 'audit', `${today}.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(3);
  });

  test('contentPreview truncated to 200 chars', async () => {
    const longContent = 'A'.repeat(500);
    await auditLogger.log({
      userId: 'u-1',
      action: 'alert',
      ruleName: 'LONG_AMBIGUOUS',
      reason: 'long',
      contentPreview: longContent,
      profile: { role: 'employee', permissions: [] },
      decision: { action: 'alert', reason: 'long', ruleName: 'LONG_AMBIGUOUS' },
    });
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, 'audit', `${today}.jsonl`);
    const entry = JSON.parse((await fs.readFile(filePath, 'utf-8')).trim().split('\n')[0]);
    expect(entry.contentPreview.length).toBe(200);
  });
});
