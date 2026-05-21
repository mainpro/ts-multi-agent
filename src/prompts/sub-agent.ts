export const SUB_AGENT_BASE_PROMPT = `你是一名专业且可靠的中文运维执行助手，负责按照技能指令执行具体任务，使用中文回复。

## 参数获取优先级（重要！）

**在询问用户之前，必须按以下顺序尝试获取参数：**

1. **检查「已获取参数」部分**：主智能体可能已经传递了参数
2. **检查「询问历史」部分**：之前的询问和用户回复中可能已包含所需参数
3. **检查请求是否超出技能范围**：如果用户请求超出技能能力范围，直接返回兜底回复
4. **最后才询问用户**：如果以上都没有，才询问用户


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

7. **ask_user** - 向用户询问信息（**推荐方式**）
   - 用途：当你需要向用户询问信息才能继续任务时，**必须优先使用此工具**
   - 优势：系统会自动处理用户回复，无需在文本中重复提问
   - 参数：
     - question: 问题内容（必填）
     - expectedType: 期望回复类型 - text(文本)/choice(选择)/confirm(确认)/number(数字)/date(日期)
     - options: 选项列表（当 expectedType=choice 时提供）
     - paramName: 参数名（如"employeeId"），用于系统自动填充
     - context: 问题背景说明

    **使用示例**：
    - 需要确认：{ "question": "确定要删除吗？", "expectedType": "confirm", "paramName": "confirmed" }
    - 需要选择：{ "question": "请选择系统", "expectedType": "choice", "options": ["OA", "ERP"], "paramName": "system" }
    - 需要文本：{ "question": "请提供工号", "expectedType": "text", "paramName": "employeeId" }

**工具使用原则**：
- **已获取参数和询问历史已在下方直接展示，无需调用工具查看**
- **需要询问用户时，优先使用 ask_user 工具，而不是在回复文本中直接提问**
- 优先执行技能说明中的核心操作（如调用接口、处理数据）
- 使用 bash 工具执行脚本
- 使用 read 工具读取文档和配置
- 所有路径都是相对于技能根目录的

## 核心原则（必须遵守）
**只基于技能文档和参考资料回答，不添加、不扩展、不编造任何内容。**

## 执行规则
1. 仔细阅读技能说明，直接开始执行核心操作
2. **按优先级获取参数**：已获取参数（已在下方） → 询问历史（已在下方） → 使用 ask_user 工具询问用户
3. 根据技能说明调用相应的工具（bash、read、ask_user 等）
4. 只回答文档中明确提到的信息或工具返回的结果
5. **禁止**：
   - 禁止添加文档中没有的细节或原因
   - 禁止自行推断或扩展答案
   - 禁止编造解决方案
   - **禁止在文本中直接提问（应使用 ask_user 工具）**

## 输出规范

`;

import { PromptBuilder } from './prompt-builder';
import { QuestionHistoryEntry, CompletedToolCall } from '../types';

export function buildSubAgentPrompt(
  skillBody: string,
  skillRootDir: string = '',
  params?: Record<string, unknown>,
  questionHistory?: QuestionHistoryEntry[],
  completedToolCalls?: CompletedToolCall[],
  userId?: string
): string {
  // 静态部分
  const staticParts = [
    { key: 'sub-agent-base', content: SUB_AGENT_BASE_PROMPT },
    { key: `skill-${skillBody.substring(0, 50)}`, content: `## 技能说明\n${skillBody}` }
  ];

  // 动态部分
  const dynamicParts = [];

  if (skillRootDir) {
    dynamicParts.push(`## 技能根目录\n${skillRootDir}`);
  }

  // 合并参数和用户 ID（排除内部使用的参数，它们有专门的处理路径）
  let mergedParams = { ...params };
  if (userId) {
    mergedParams.userId = userId;
  }
  const conversationSummary = mergedParams.conversationSummary as string | undefined;
  delete mergedParams.latestUserAnswer;
  delete mergedParams.conversationSummary;

  if (mergedParams && Object.keys(mergedParams).length > 0) {
    const paramsList = Object.entries(mergedParams)
      .map(([key, value]) => `- **${key}**: ${value}`)
      .join('\n');
    dynamicParts.push(`## 已获取参数\n以下参数已从用户对话中获取，请直接使用，不要重复询问：\n${paramsList}`);
  }

  // ===== v2: 已完成的执行步骤（断点续执行时展示） =====
  if (completedToolCalls && completedToolCalls.length > 0) {
    const stepsSummary = completedToolCalls
      .map((tc, i) => {
        const argsStr = Object.entries(tc.arguments)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(', ');
        const resultPreview = tc.result.length > 200
          ? tc.result.substring(0, 200) + '...'
          : tc.result;
        return `### 步骤 ${i + 1}: ${tc.name}\n- 参数: ${argsStr}\n- 结果: ${resultPreview}`;
      })
      .join('\n\n');

    dynamicParts.push(
      `## 已完成的执行步骤\n以下是之前已经执行过的步骤，**请勿重复执行**：\n${stepsSummary}`
    );
  }

  if (conversationSummary) {
    dynamicParts.push(`## 之前的对话\n以下是之前与用户的对话记录，这些问题已经被回答，请不要重复询问：\n${conversationSummary}`);
  }

  // ===== 展示 ask_user 工具调用历史 =====
  const askUserCalls = completedToolCalls?.filter(tc => tc.name === 'ask_user');
  if (askUserCalls && askUserCalls.length > 0) {
    const askUserSummary = askUserCalls
      .map((tc, i) => {
        const args = tc.arguments as { question?: string; options?: string[]; paramName?: string };
        const optionsStr = args.options ? ` [选项: ${args.options.join('/')}]` : '';
        const paramStr = args.paramName ? ` (参数名: ${args.paramName})` : '';
        return `${i + 1}. ${args.question}${optionsStr}${paramStr}`;
      })
      .join('\n');

    dynamicParts.push(
      `## 已发起的询问（等待回复）\n${askUserSummary}\n\n**注意**：以上询问已发送给用户，请等待用户回复后继续执行，不要重复询问。`
    );
  }

  // ===== 展示通过 ask_user 获取的参数 =====
  const filledParamsFromAskUser = questionHistory
    ?.filter(qh => qh.question.metadata?.source === 'tool_call' && qh.question.metadata?.paramName && qh.answer)
    ?.map(qh => `- **${qh.question.metadata!.paramName}**: ${qh.answer}`);

  if (filledParamsFromAskUser && filledParamsFromAskUser.length > 0) {
    dynamicParts.push(
      `## 通过 ask_user 获取的参数\n${filledParamsFromAskUser.join('\n')}\n\n以上参数已通过 ask_user 工具获取，可直接使用。`
    );
  }

  if (questionHistory && questionHistory.length > 0) {
    const historyList = questionHistory
      .map((item, index) => {
        const metadata = item.question.metadata
          ? `\n  元数据: ${JSON.stringify(item.question.metadata)}`
          : '';
        const source = item.question.metadata?.source === 'tool_call' ? ' [ask_user工具]' : '';
        return `### 第 ${index + 1} 次询问${source}
- **询问类型**: ${item.question.type}
- **询问内容**: ${item.question.content}${metadata}
- **用户回复**: ${item.answer}
- **时间**: ${item.timestamp.toISOString()}`;
      })
      .join('\n\n');
    dynamicParts.push(`## 询问历史\n以下是之前的询问和用户回复，请参考这些信息继续执行任务：\n${historyList}`);

    // 添加明确的指导，告诉LLM不要重复询问
    dynamicParts.push(`\n## 重要提示\n如果您之前已经问过用户某个问题（特别是通过 ask_user 工具），并且用户已经回答了，请不要重复询问相同的问题。请根据用户的回答继续执行任务，跳过已经完成的步骤。`);
  }

  return PromptBuilder.build(staticParts, dynamicParts);
}

export default {
  SUB_AGENT_BASE_PROMPT,
  buildSubAgentPrompt,
};
