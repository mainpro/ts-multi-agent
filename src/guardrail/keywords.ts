// src/guardrail/keywords.ts

/**
 * 黑名单关键字。命中即 deny。
 *
 * 维护规则:每条加注释说明来源。
 * 拆分为 INJECTION_KEYWORDS / SENSITIVE_KEYWORDS,这样规则引擎可以区分
 *   注入/越权类(ruleName: BLACKLIST_KEYWORD)
 *   敏感词类(ruleName: SENSITIVE_KEYWORD)
 * BLACKLIST_KEYWORDS 是两者的并集,用于粗粒度断言。
 */

export type KeywordRuleName = 'BLACKLIST_KEYWORD' | 'SENSITIVE_KEYWORD';

// ===== 注入类(越权 + prompt injection) — ruleName: BLACKLIST_KEYWORD =====
export const INJECTION_KEYWORDS: readonly string[] = [
  // prompt injection
  'ignore previous instructions',
  '忽略之前指令',
  'DAN',
  'jailbreak',
  'developer mode',
  'do anything now',
  'disabling safety',
  // 越权 / 危险操作
  'DROP TABLE',
  'rm -rf /',
  'sudo ',
];

// ===== 敏感词类(机密 / 凭据) — ruleName: SENSITIVE_KEYWORD =====
export const SENSITIVE_KEYWORDS: readonly string[] = [
  '机密',
  '绝密',
  '密码',
];

/**
 * 关键字 → ruleName 映射表。规则引擎按匹配的 keyword 查找对应的 ruleName。
 * 导出以便测试和外部扩展。
 */
export const KEYWORD_RULES: ReadonlyMap<string, KeywordRuleName> = new Map([
  ...INJECTION_KEYWORDS.map((kw): [string, KeywordRuleName] => [kw, 'BLACKLIST_KEYWORD']),
  ...SENSITIVE_KEYWORDS.map((kw): [string, KeywordRuleName] => [kw, 'SENSITIVE_KEYWORD']),
]);

/** 合并视图,保留对所有 keyword 的粗粒度断言(toContain 等)。 */
export const BLACKLIST_KEYWORDS: readonly string[] = [
  ...INJECTION_KEYWORDS,
  ...SENSITIVE_KEYWORDS,
];