/**
 * Token 计数器
 * P1-3: Token 精确计算
 *
 * 注意: js-tiktoken 使用 OpenAI 的 cl100k_base 编码，主要针对英文优化。
 * 对于中文，计算结果是近似值，但比 字符数/4 准确得多。
 */

let encoding: any = null;

async function getEncoding() {
  if (!encoding) {
    try {
      // @ts-expect-error js-tiktoken is an optional dependency
      const mod = await import('js-tiktoken');
      encoding = mod.encodingForModel('gpt-4');
    } catch {
      console.warn('[TokenCounter] js-tiktoken 不可用，回退到估算模式');
      encoding = null;
    }
  }
  return encoding;
}

/**
 * 精确计算 Token 数（使用 tiktoken，如可用）
 */
export async function countTokens(text: string): Promise<number> {
  if (!text) {
    return 0;
  }
  const enc = await getEncoding();
  if (enc) {
    return enc.encode(text).length;
  }
  return estimateTokens(text);
}

/**
 * 改进的 Token 估算（区分中英文）
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      // CJK 统一汉字：每个汉字约 1.5 tokens
      tokens += 1.5;
    } else if (code >= 0x3000 && code <= 0x303F) {
      // CJK 标点
      tokens += 1;
    } else {
      // ASCII/Latin：约 4 字符 1 token
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}
