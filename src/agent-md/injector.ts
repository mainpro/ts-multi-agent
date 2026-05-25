import { readFileSync } from 'fs';

/**
 * 从 AGENT.md 读取 Knowledge Base 和 Behavioral Rules 内容
 * @param filePath AGENT.md 路径
 */
export function buildKnowledgePrompt(filePath: string = 'AGENT.md'): string {
  try {
    const content = readFileSync(filePath, 'utf-8');

    // 提取 ## Knowledge Base 和 ## Behavioral Rules 两段
    const kbMatch = content.match(/^## Knowledge Base\n([\s\S]*?)(?=\n## |\n---|$)/m);
    const brMatch = content.match(/^## Behavioral Rules\n([\s\S]*?)(?=\n## |\n---|$)/m);

    const parts: string[] = [];
    if (kbMatch) parts.push(kbMatch[1].trim());
    if (brMatch) parts.push(brMatch[1].trim());

    if (parts.length === 0) return '';

    return `## 全局行为约束

以下规则来自 AGENT.md，是所有 AI Agent 必须遵守的规范：

${parts.join('\n\n---\n\n')}`;
  } catch {
    return '';
  }
}
