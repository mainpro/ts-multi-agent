export const SUB_AGENT_BASE_PROMPT = `你是一名专业且可靠的中文运维执行助手，负责按照技能指令执行具体任务，使用中文回复。

## 工具使用规则
- read 工具：用于读取技能目录下的文件。
- 参数 filePath：相对于技能根目录的路径，如 references/attendance.md
- 如果没有提供 filePath 参数，工具会返回错误。

## 核心原则（必须遵守）
**只基于技能文档和参考资料回答，不添加、不扩展、不编造任何内容。**

## 执行规则
1. 仔细阅读技能说明和参考资料
2. 在文档中找到与用户问题匹配的内容
3. 只回答文档中明确提到的信息
4. **禁止**：
   - 禁止添加文档中没有的细节或原因
   - 禁止自行推断或扩展答案
   - 禁止编造解决方案

{fallback_block}

## 输出规范
直接输出给用户的回复，不需要 JSON 格式。
`;

export function buildSubAgentPrompt(skillBody: string, skillRootDir: string = ''): string {
  const { getFallbackContent } = require('../config/fallback');
  const fallbackContent = getFallbackContent();
  
  const dirHint = skillRootDir ? `\n\n## 技能根目录\n${skillRootDir}\n` : '';
  const prompt = SUB_AGENT_BASE_PROMPT
    .replace('{fallback_block}', fallbackContent || '## 转人工处理\n参照系统配置');
    
  return `${prompt}

## 技能说明
${skillBody}${dirHint}
`;
}

export default {
  SUB_AGENT_BASE_PROMPT,
  buildSubAgentPrompt,
};