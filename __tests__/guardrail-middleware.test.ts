// __tests__/guardrail-middleware.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import { guardrailMiddleware } from '../src/guardrail/middleware';
import { auditLogger } from '../src/guardrail/audit-logger';

// Mock UserProfileService
import { mockUserProfileService } from './helpers/mock-profile-service';

describe('guardrailMiddleware', () => {
  let app: any;
  let server: any;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-mw-'));
    auditLogger.configure({ dataDir: tmpDir });
    app = express();
    app.use(express.json());
    app.use(mockUserProfileService());
    app.post('/tasks/stream', guardrailMiddleware(), (req: any, res: any) => {
      res.json({ received: req.body.content, receivedReq: req.body.requirement });
    });
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true });
  });

  test('allow passes through', async () => {
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-1', sessionId: 's-1', content: '请帮我看看 OA' }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.received).toBe('请帮我看看 OA');
  });

  test('rewrite replaces content in body', async () => {
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-1', sessionId: 's-1', content: '身份证 110101199003078813' }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.received).toContain('**********');
    expect(json.received).not.toContain('110101199003078813');
  });

  test('deny returns 200 with transferToHuman flag', async () => {
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-1', sessionId: 's-1', content: 'DROP TABLE users' }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.transferToHuman).toBe(true);
    expect(json.reason).toContain('blacklist');
    expect(json.ruleName).toBe('BLACKLIST_KEYWORD');
  });

  test('alert passes through but audit log has alert=true', async () => {
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u-1', sessionId: 's-1', content: 'A'.repeat(2000) }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.received).toBe('A'.repeat(2000));
    const today = new Date().toISOString().slice(0, 10);
    const entries = await auditLogger.query({ date: today });
    expect(entries.some((e: any) => e.ruleName === 'LONG_AMBIGUOUS')).toBe(true);
  });

  // ===== Final Review fix #3: production 路径走 `requirement` 字段 =====

  test('requirement field is rewritten (PII redaction via production field path)', async () => {
    // 仅传 `requirement`、不传 `content` — 模拟生产 SubmitTaskRequest 形态
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'u-1',
        sessionId: 's-1',
        requirement: '我的身份证号是 110101199003078813,请帮我看看',
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    // 改写应落到 requirement 字段(生产路径字段)
    expect(json.receivedReq).toContain('**********');
    expect(json.receivedReq).not.toContain('110101199003078813');
    // mirror 逻辑会同步把改写后文本落到 content 字段,便于下游统一读任一字段
    expect(json.received).toBe('我的身份证号是 1101**********8813,请帮我看看');
  });

  test('requirement field is denied (blacklist keyword via production field path)', async () => {
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'u-1',
        sessionId: 's-1',
        requirement: 'DROP TABLE users',
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.transferToHuman).toBe(true);
    expect(json.reason).toContain('blacklist');
    expect(json.ruleName).toBe('BLACKLIST_KEYWORD');
  });

  test('rewrite mirrors to BOTH content and requirement when only requirement is provided', async () => {
    // 验证 rewrite 路径上的镜像逻辑:即使入参只传 requirement,
    // 改写后的内容应同步落到 content 字段,让下游 handler 读任一字段都能拿到 redact 后文本
    const res = await fetch(`http://localhost:${port}/tasks/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'u-1',
        sessionId: 's-1',
        requirement: '我的手机 13812345678 内有敏感信息',
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    // content 字段应被 mirror 写入改写后文本
    expect(json.received).toContain('****');
    expect(json.received).not.toContain('13812345678');
    // requirement 字段也应保留改写后文本
    expect(json.receivedReq).toContain('****');
    expect(json.receivedReq).not.toContain('13812345678');
  });
});