// src/guardrail/types.ts

export type GuardrailAction = 'allow' | 'rewrite' | 'deny' | 'alert';

export interface GuardrailContext {
  userId: string;
  userRole: string;
  userPermissions: string[];
  sessionId: string;
  isSteerEntry: boolean;
  source: 'user' | 'steer' | 'tool_result';
}

export interface GuardrailDecision {
  action: GuardrailAction;
  reason: string;
  ruleName: string;
  rewrittenContent?: string;
}
