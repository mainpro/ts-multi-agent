// src/guardrail/pii-patterns.ts

export const PII_PATTERNS = {
  /** 中国大陆身份证号(18 位,末位可 X) */
  idCard: /\d{17}[\dXx]/,
  /** 银行卡号(16-19 位纯数字) */
  bankCard: /\d{16,19}/,
  /** 中国大陆手机号(11 位,1 开头) */
  phoneCN: /1[3-9]\d{9}/,
} as const;

export interface PiiMatch {
  kind: keyof typeof PII_PATTERNS;
  raw: string;
  masked: string;
}

/**
 * 把检测到的 PII 片段替换为脱敏表达
 * @param text 原始文本
 * @returns 脱敏后的文本 + 命中列表
 */
export function redactPii(text: string): { redacted: string; matches: PiiMatch[] } {
  const matches: PiiMatch[] = [];
  let redacted = text;

  for (const [kind, pattern] of Object.entries(PII_PATTERNS)) {
    redacted = redacted.replace(pattern, (m) => {
      const masked = maskOf(kind, m);
      matches.push({ kind: kind as keyof typeof PII_PATTERNS, raw: m, masked });
      return masked;
    });
  }

  return { redacted, matches };
}

function maskOf(kind: string, raw: string): string {
  if (kind === 'idCard') return raw.slice(0, 4) + '**********' + raw.slice(-4);
  if (kind === 'bankCard') return raw.slice(0, 4) + '********' + raw.slice(-4);
  if (kind === 'phoneCN') return raw.slice(0, 3) + '****' + raw.slice(-4);
  return '****';
}
