// src/guardrail/middleware.ts
//
// Express middleware that runs the L1 rule engine on every user input that
// flows through `POST /tasks/stream`. Actions:
//   - deny    → return 200 + { transferToHuman, reason, ruleName } (上层路由兜底)
//   - rewrite → mutate req.body.{content,requirement} = redacted, then next()
//   - alert   → next() (with audit log entry)
//   - allow   → next()
//
// Notes:
// - The middleware is body-shape tolerant: missing fields are passed through
//   untouched so the upstream handler can validate them (and return 400).
// - It requires `req.profile` to already be set by a previous middleware
//   (see `src/api/index.ts` Step 4.6). If absent, fall back to a minimal
//   employee context so rules can still run.
// - Audit log is only written for non-trivial decisions (deny / rewrite / alert);
//   `allow` is intentionally silent to avoid log spam.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { L1RuleEngine } from './rule-engine';
import { auditLogger } from './audit-logger';
import type { GuardrailContext } from './types';
import {
  guardrailDenied,
  guardrailRewritten,
  guardrailAlerted,
} from '../observability/metrics';

const engine = new L1RuleEngine();

export function guardrailMiddleware(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Production API uses `requirement` (SubmitTaskRequest.requirement);
    // accept `content` as a fallback for tests / future routes that use it.
    const body = req.body ?? {};
    const userId = body.userId as string | undefined;
    const sessionId = body.sessionId as string | undefined;
    const content = (body.content ?? body.requirement) as string | undefined;
    if (!content || typeof content !== 'string') {
      return next(); // 缺字段交给上层(沿用 INVALID_REQUEST 400 路径)
    }

    const profile = (req as any).profile ?? {
      role: 'employee',
      permissions: [],
    };

    const ctx: GuardrailContext = {
      userId: userId ?? 'anonymous',
      userRole: profile.role,
      userPermissions: profile.permissions ?? [],
      sessionId: sessionId ?? 'unknown',
      isSteerEntry: false,
      source: 'user',
    };

    const decision = await engine.evaluate(content, ctx);

    if (decision.action === 'deny' || decision.action === 'alert' || decision.action === 'rewrite') {
      await auditLogger.log({
        userId: ctx.userId,
        action: decision.action,
        ruleName: decision.ruleName,
        reason: decision.reason,
        contentPreview: content,
        profile: { role: ctx.userRole, permissions: ctx.userPermissions },
        decision,
      });
    }

    switch (decision.action) {
      case 'deny':
        // Metrics (Task 12): 缺口 1 拦截 — hard block 计数。
        guardrailDenied.add(1, { rule: decision.ruleName });
        // 走人工兜底:返回 200 + transferToHuman flag,由上层路由处理
        return res.json({
          transferToHuman: true,
          reason: decision.reason,
          ruleName: decision.ruleName,
        });
      case 'rewrite':
        // Metrics (Task 12): 缺口 1 拦截 — soft rewrite 计数。
        guardrailRewritten.add(1, { rule: decision.ruleName });
        if (req.body) {
          // Mirror the rewrite to both fields so downstream handlers using
          // either the legacy `content` field or the production `requirement`
          // field see the redacted text.
          req.body.content = decision.rewrittenContent;
          req.body.requirement = decision.rewrittenContent;
        }
        return next();
      case 'alert':
        // Metrics (Task 12): 缺口 1 拦截 — 静默告警计数(pass-through + audit)。
        guardrailAlerted.add(1, { rule: decision.ruleName });
        return next();
      case 'allow':
      default:
        return next();
    }
  };
}