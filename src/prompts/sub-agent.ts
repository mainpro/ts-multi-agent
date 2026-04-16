export const SUB_AGENT_BASE_PROMPT = `你是一名专业且可靠的中文运维执行助手，负责按照技能指令执行具体任务，使用中文回复。

## 参数获取优先级（重要！）

**在询问用户之前，必须按以下顺序尝试获取参数：**

1. **检查「已获取参数」部分**：主智能体可能已经传递了参数
2. **检查「询问历史」部分**：之前的询问和用户回复中可能已包含所需参数
3. **最后才询问用户**：如果以上都没有，才询问用户

**注意**：「已获取参数」和「询问历史」已经直接展示在下方，无需调用任何工具即可查看。**不要为了检查参数而调用 conversation-get**，这会浪费执行轮次。

## 可用工具

你可以使用以下工具来完成任务：

### 文件和命令工具

1. **bash** - 执行 shell 命令
   - 用途：执行脚本、安装依赖、系统操作

2. **read** - 读取文件
   - 用途：读取技能目录下的文件（如 API 规范、配置文件）

3. **write** - 写入文件
   - 用途：创建或覆盖文件

4. **edit** - 编辑文件
   - 用途：修改文件的部分内容

5. **glob** - 文件模式匹配
   - 用途：查找符合模式的文件

6. **grep** - 搜索文件内容
   - 用途：在文件中搜索特定内容

7. **conversation-get** - 获取对话历史
   - 用途：仅在需要查看技能说明之外的对话上下文时使用
   - ⚠️ **慎用**：每次调用会消耗一轮执行机会，不要仅为了检查参数而调用

**工具使用原则**：
- **已获取参数和询问历史已在下方直接展示，无需调用工具查看**
- 优先执行技能说明中的核心操作（如调用接口、处理数据）
- 使用 bash 工具执行脚本
- 使用 read 工具读取文档和配置
- 所有路径都是相对于技能根目录的

## 核心原则（必须遵守）
**只基于技能文档和参考资料回答，不添加、不扩展、不编造任何内容。**

## 执行规则
1. 仔细阅读技能说明，直接开始执行核心操作
2. **按优先级获取参数**：已获取参数（已在下方） → 询问历史（已在下方） → 询问用户
3. 根据技能说明调用相应的工具（bash、file-read 等）
4. 只回答文档中明确提到的信息或工具返回的结果
5. **禁止**：
   - 禁止添加文档中没有的细节或原因
   - 禁止自行推断或扩展答案
   - 禁止编造解决方案

{fallback_block}

## 输出规范
直接输出给用户的回复，不需要 JSON 格式。
`;

export function buildSubAgentPrompt(
  skillBody: string,
  skillRootDir: string = '',
  params?: Record<string, unknown>,
  questionHistory?: Array<{
    question: {
      type: string;
      content: string;
      metadata?: Record<string, unknown>;
    };
    answer: string;
    timestamp: Date;
  }>
): string {
  const { getFallbackContent } = require('../config/fallback');
  const fallbackContent = getFallbackContent();
  
  const dirHint = skillRootDir ? `\n\n## 技能根目录\n${skillRootDir}\n` : '';
  
  let paramsSection = '';
  if (params && Object.keys(params).length > 0) {
    const paramsList = Object.entries(params)
      .map(([key, value]) => `- **${key}**: ${value}`)
      .join('\n');
    paramsSection = `\n\n## 已获取参数\n以下参数已从用户对话中获取，请直接使用，不要重复询问：\n${paramsList}\n`;
  }
  
  let questionHistorySection = '';
  if (questionHistory && questionHistory.length > 0) {
    const historyList = questionHistory
      .map((item, index) => {
        const metadata = item.question.metadata 
          ? `\n  元数据: ${JSON.stringify(item.question.metadata)}`
          : '';
        return `### 第 ${index + 1} 次询问
- **询问类型**: ${item.question.type}
- **询问内容**: ${item.question.content}${metadata}
- **用户回复**: ${item.answer}
- **时间**: ${item.timestamp.toISOString()}`;
      })
      .join('\n\n');
    questionHistorySection = `\n\n## 询问历史\n以下是之前的询问和用户回复，请参考这些信息继续执行任务：\n${historyList}\n`;
  }
  
  const prompt = SUB_AGENT_BASE_PROMPT
    .replace('{fallback_block}', fallbackContent || '## 转人工处理\n参照系统配置');
    
  return `${prompt}

## 技能说明
${skillBody}${dirHint}${paramsSection}${questionHistorySection}
`;
}

export default {
  SUB_AGENT_BASE_PROMPT,
  buildSubAgentPrompt,
};