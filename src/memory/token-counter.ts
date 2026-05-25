/**
 * Token 计数器
 * 使用估算模式（区分中英文），无需外部 tokenizer 库
 */

/**
 * Token 估算（区分中英文）
 * - CJK 统一汉字：每个约 1.5 tokens
 * - CJK 标点：每个约 1 token
 * - ASCII/Latin：每 4 字符约 1 token
 */
export function countTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      tokens += 1.5;
    } else if (code >= 0x3000 && code <= 0x3030F) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}
