import { describe, test, expect } from 'bun:test';
import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import {
  errorToResponse,
  globalErrorHandler,
  traceIdMiddleware,
} from '../src/api/error-handler';
import { BusinessError, LlmError, SkillError } from '../src/errors';

function startApp(
  routes: (app: express.Application) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(traceIdMiddleware);
    routes(app);
    app.use(globalErrorHandler);
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function request(
  url: string,
  method: string,
  path: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${url}${path}`,
      { method },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let body: any = data;
          try {
            body = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode ?? 500, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Express global error middleware', () => {
  test('endpoint throwing BusinessError → 400 envelope', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/bad', () => {
        throw new BusinessError('INVALID_INPUT', 'bad input');
      });
    });
    try {
      const r = await request(url, 'GET', '/bad');
      expect(r.status).toBe(400);
      expect(r.body.success).toBe(false);
      expect(r.body.error.code).toBe('INVALID_INPUT');
      expect(r.body.error.type).toBe('USER_ERROR');
      expect(r.headers['x-trace-id']).toBeTruthy();
    } finally {
      await close();
    }
  });

  test('endpoint throwing LlmError RATE_LIMIT → 429', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/llm', () => {
        throw new LlmError('RATE_LIMIT', 'slow down');
      });
    });
    try {
      const r = await request(url, 'GET', '/llm');
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('LLM_RATE_LIMIT');
    } finally {
      await close();
    }
  });

  test('endpoint throwing SkillError → 422', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/skill', () => {
        throw new SkillError('EXEC_FAIL', 'crashed');
      });
    });
    try {
      const r = await request(url, 'GET', '/skill');
      expect(r.status).toBe(422);
      expect(r.body.error.type).toBe('SKILL_ERROR');
    } finally {
      await close();
    }
  });

  test('endpoint throwing plain Error → 500 INTERNAL_ERROR', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/oops', () => {
        throw new Error('secret internal detail');
      });
    });
    try {
      const r = await request(url, 'GET', '/oops');
      expect(r.status).toBe(500);
      expect(r.body.error.code).toBe('INTERNAL_ERROR');
      expect(r.body.error.message).not.toContain('secret');
    } finally {
      await close();
    }
  });

  test('successful endpoint → 200 with X-Trace-Id header', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/ok', (_req, res) => {
        res.json({ success: true, data: { hello: 'world' } });
      });
    });
    try {
      const r = await request(url, 'GET', '/ok');
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
      expect(r.body.data.hello).toBe('world');
      expect(r.headers['x-trace-id']).toBeTruthy();
    } finally {
      await close();
    }
  });

  test('incoming X-Trace-Id header is preserved', async () => {
    const { url, close } = await startApp((app) => {
      app.get('/ok', (_req, res) => res.json({ success: true }));
    });
    try {
      const result = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
      }>((resolve, reject) => {
        const req = http.request(
          `${url}/ok`,
          { method: 'GET', headers: { 'X-Trace-Id': 'my-trace-123' } },
          (res) => {
            res.on('data', () => {});
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 200,
                headers: res.headers,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(result.headers['x-trace-id']).toBe('my-trace-123');
    } finally {
      await close();
    }
  });
});