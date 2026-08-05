// src/guardrail/rule-engine.ts
import type { GuardrailContext, GuardrailDecision } from './types';
import { BLACKLIST_KEYWORDS, KEYWORD_RULES } from './keywords';
import { redactPii } from './pii-patterns';

export interface RuleEngine {
  evaluate(input: string, ctx: GuardrailContext): Promise<GuardrailDecision>;
}

/** 长文本告警阈值(超过则 alert) */
const LONG_AMBIGUOUS_THRESHOLD = 1500;

export class L1RuleEngine implements RuleEngine {
  async evaluate(input: string, ctx: GuardrailContext): Promise<GuardrailDecision> {
    // ctx is reserved for future per-role / per-source rules (current rules
    // are content-only). Touch it so strict noUnusedParameters stays happy.
    void ctx;
    // 1. 黑名单关键字(按 KEYWORD_RULES 区分注入 vs 敏感)
    for (const kw of BLACKLIST_KEYWORDS) {
      if (input.includes(kw)) {
        const ruleName = KEYWORD_RULES.get(kw) ?? 'BLACKLIST_KEYWORD';
        return {
          action: 'deny',
          reason: `Hit ${ruleName === 'SENSITIVE_KEYWORD' ? 'sensitive' : 'blacklist'} keyword: ${kw}`,
          ruleName,
        };
      }
    }

    // 2. PII 改写
    const { redacted, matches } = redactPii(input);
    if (matches.length > 0) {
      return {
        action: 'rewrite',
        reason: `PII redacted: ${matches.map((m) => m.kind).join(',')}`,
        ruleName: 'PII_REDACT',
        rewrittenContent: redacted,
      };
    }

    // 3. 长文本告警
    if (input.length > LONG_AMBIGUOUS_THRESHOLD) {
      return {
        action: 'alert',
        reason: `Long ambiguous input: ${input.length} chars`,
        ruleName: 'LONG_AMBIGUOUS',
      };
    }

    // 4. 通过
    return {
      action: 'allow',
      reason: 'no rule matched',
      ruleName: 'NONE',
    };
  }
}