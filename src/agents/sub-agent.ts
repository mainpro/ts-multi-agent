import { SkillRegistry } from '../skill-registry';
import { LLMClient, llmEvents } from '../llm';
import {
  Task, TaskResult, TaskError, Skill, SkillExecutionResult,
  Message, CompletedToolCall, QuestionHistoryEntry,
} from '../types';
import { ToolRegistry, ToolContext, Tool } from '../tools';
import { buildSubAgentPrompt } from '../prompts';
import { hookManager } from '../hooks/hook-manager';
import { HookEvent } from '../hooks/types';

// P0-1: 默认安全工具白名单（仅包含 ToolRegistry 中实际注册的只读工具）
const DEFAULT_SAFE_TOOLS = new Set([
  'conversation-get',
  'read',
  'glob',
  'grep',
]);

/** 子智能体执行结果（内部使用，包含断点续执行所需的上下文） */
interface SubAgentInternalResult extends SkillExecutionResult {
  /** 保存的 LLM 对话上下文（用于断点续执行） */
  _conversationContext?: Message[];
  /** 已完成的工具调用记录 */
  _completedToolCalls?: CompletedToolCall[];
  /** 执行进度描述 */
  _executionProgress?: string;
}

/**
 * 检测 LLM 返回的文本是否包含向用户提问的意图
 *
 * v2 重构：增加结论性语句排除 + 上下文判断，降低误判率
 */
export function detectQuestion(
  response: string,
  toolCallResults?: Array<{ name: string; result: string }>
): { content: string; metadata?: Record<string, unknown> } | null {
  if (!response || response.trim().length === 0) {
    return null;
  }

  // ===== 快速排除：结论性语句 =====
  const conclusivePatterns = [
    /已[经完]?成/,
    /成功[地]?/,
    /结果[如为下]：/,
    /以下是.*结果/,
    /操作完成/,
  ];
  if (conclusivePatterns.some(p => p.test(response))) {
    return null;
  }

  // ===== 正则预过滤 =====
  const questionPatterns = [
    /请问您?要?选择/,
    /请选择/,
    /请提供/,
    /请问.*(?:是|是什么|是哪)/,
    /请输入/,
    /请确认/,
    /请回复/,
    /需要您?(?:提供|确认|选择|输入|回复)/,
    /您?(?:希望|想要|需要).*(?:哪个|哪些|什么)/,
    /请.?问.*(?:多少|什么|哪个|哪些)/,
  ];

  const isQuestion = questionPatterns.some(pattern => pattern.test(response));
  if (!isQuestion) {
    return null;
  }

  // ===== 上下文判断：区分结果展示 vs 真正提问 =====
  if (toolCallResults && toolCallResults.length > 0) {
    const lastToolCall = toolCallResults[toolCallResults.length - 1];
    const queryTools = ['conversation-get', 'grep', 'glob', 'read'];
    if (queryTools.includes(lastToolCall.name)) {
      // 结果指示词：精确匹配"以下是查询结果"等结果展示模式
      const resultIndicators = [
        /查询到\s*\d+/,
        /找到\s*\d+/,
        /共\s*\d+\s*条/,
        /^以下是.*结果/,
        /结果如下/,
      ];
      const hasResultIndicator = resultIndicators.some(p => p.test(response));

      // 提问指示词：如果文本中包含明确的提问模式，即使有结果指示词也是提问
      const questionIndicators = [
        /请提供/,
        /请确认/,
        /请选择/,
        /请输入/,
        /请回复/,
        /请问/,
        /需要您?(?:提供|确认|选择|输入|回复)/,
      ];
      const hasQuestionIndicator = questionIndicators.some(p => p.test(response));

      if (hasResultIndicator && !hasQuestionIndicator && !response.includes('?') && !response.includes('？')) {
        return null;
      }
    }
  }

  return { content: response };
}

export class SubAgent {
  private skillRegistry: SkillRegistry;
  private llm: LLMClient;
  private toolRegistry: ToolRegistry;

  constructor(skillRegistry: SkillRegistry, llm: LLMClient) {
    this.skillRegistry = skillRegistry;
    this.llm = llm;
    this.toolRegistry = new ToolRegistry();
  }

  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('SubAgent');

    try {
      console.log('[SubAgent] 任务ID: ' + task.id + ' 技能: ' + task.skillName);
      console.log('[SubAgent] 用户ID: ' + task.userId);
      if (task.params) {
        console.log('[SubAgent] 已获取参数: ' + JSON.stringify(task.params));
      }

      // ===== v2: 断点续执行检测 =====
      const isResuming = !!(task.conversationContext && task.conversationContext.length > 0);
      if (isResuming) {
        console.log(`[SubAgent] 🔄 断点续执行模式: 恢复 ${task.conversationContext!.length} 条对话上下文`);
      }

      if (!task.skillName) {
        return {
          success: false,
          error: { type: 'FATAL', message: 'No skill assigned', code: 'MISSING_SKILL' },
        };
      }

      const skill = await this.skillRegistry.loadFullSkill(task.skillName);
      if (!skill) {
        return {
          success: false,
          error: { type: 'FATAL', message: 'Skill not found: ' + task.skillName, code: 'SKILL_NOT_FOUND' },
        };
      }

      const result = await this.executeSkill(
        task.requirement,
        skill,
        task.params,
        task.sessionId,
        task.userId,
        task.questionHistory,
        task.conversationContext,   // v2: 传入保存的对话上下文
        task.completedToolCalls,    // v2: 传入已完成的工具调用
        signal
      );

      // ===== v2: 保存断点上下文到任务 =====
      if (result._conversationContext) {
        task.conversationContext = result._conversationContext;
      }
      if (result._completedToolCalls) {
        task.completedToolCalls = result._completedToolCalls;
      }
      if (result._executionProgress) {
        task.executionProgress = result._executionProgress;
      }

      // 清理内部字段，不暴露给外部
      const {
        _conversationContext,
        _completedToolCalls,
        _executionProgress,
        ...cleanResult
      } = result;

      return { success: true, data: cleanResult };
    } catch (error) {
      return { success: false, error: this.classifyError(error) };
    } finally {
      llmEvents.setAgent(previousAgent);
    }
  }

  private async executeSkill(
    requirement: string,
    skill: Skill,
    params?: Record<string, unknown>,
    sessionId?: string,
    userId?: string,
    questionHistory?: QuestionHistoryEntry[],
    conversationContext?: Message[],          // v2: 断点续执行上下文
    completedToolCalls?: CompletedToolCall[], // v2: 已完成的工具调用
    signal?: AbortSignal
  ): Promise<SubAgentInternalResult> {
    const skillRootDir = './skills/' + skill.name;
    const absoluteSkillRootDir = require('path').resolve(skillRootDir);

    // ===== v2: 构建增强的 system prompt =====
    const systemPrompt = buildSubAgentPrompt(
      skill.body,
      absoluteSkillRootDir,
      params,
      questionHistory,
      completedToolCalls,
      userId
    );

    const allTools = this.toolRegistry.list();

    // P0-1: 根据 allowedTools 过滤工具
    const skillDef = await this.skillRegistry.loadFullSkill(skill.name);
    const allowedToolNames = (skillDef?.allowedTools && skillDef.allowedTools.length > 0)
      ? new Set(skillDef.allowedTools)
      : DEFAULT_SAFE_TOOLS;

    const filteredTools = allTools.filter((tool: any) => allowedToolNames.has(tool.name));

    const tools = filteredTools.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.parameters || {},
        required: tool.required || [],
      },
    }));

    const toolContext: ToolContext = {
      workDir: absoluteSkillRootDir,
      userId: userId || 'sub-agent',
      sessionId: sessionId || 'skill-execution',
    };

    // 定义并发安全性检查函数
    const concurrencyChecker = (toolName: string): boolean => {
      const safeTools = new Set(['read', 'glob', 'grep', 'conversation-get']);
      return safeTools.has(toolName);
    };

    // ===== v2: 初始化或恢复对话上下文 =====
    let messages: Message[];

    if (conversationContext && conversationContext.length > 0) {
      // ===== 断点续执行：重新构建 system prompt（包含最新的 questionHistory） =====
      const refreshedSystemPrompt = buildSubAgentPrompt(
        skill.body,
        absoluteSkillRootDir,
        params,
        questionHistory,     // 使用最新的 questionHistory（包含刚添加的回答）
        completedToolCalls,
        userId
      );

      console.log(`[SubAgent] 🔄 断点续执行模式启动`);
      console.log(`[SubAgent] 📋 询问历史条数: ${questionHistory?.length || 0}`);
      if (questionHistory && questionHistory.length > 0) {
        questionHistory.forEach((qh, i) => {
          console.log(`[SubAgent] 📋 询问历史[${i}]: Q="${qh.question.content.substring(0, 80)}..." A="${qh.answer}"`);
        });
      }
      console.log(`[SubAgent] 📋 已完成工具调用数: ${completedToolCalls?.length || 0}`);
      console.log(`[SubAgent] 📋 恢复对话上下文数: ${conversationContext.length}`);
      console.log(`[SubAgent] 📋 latestUserAnswer: "${params?.latestUserAnswer || '(无)'}"`);

      // 恢复对话上下文，但替换 system prompt 为最新版本
      messages = conversationContext.map(msg => ({
        role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
        content: msg.content,
        tool_call_id: msg.tool_call_id,
        tool_calls: msg.tool_calls,
      }));

      // 替换第一条 system 消息为最新的 system prompt（包含最新的 questionHistory）
      if (messages.length > 0 && messages[0].role === 'system') {
        console.log(`[SubAgent] 🔄 替换 system prompt（原长度: ${messages[0].content.length} → 新长度: ${refreshedSystemPrompt.length}）`);
        messages[0] = { role: 'system', content: refreshedSystemPrompt };
      } else {
        // 如果没有 system 消息，在最前面插入
        console.log(`[SubAgent] 🔄 插入新的 system prompt（长度: ${refreshedSystemPrompt.length}）`);
        messages.unshift({ role: 'system', content: refreshedSystemPrompt });
      }

      // 追加用户最新回复（从 params 中获取）
      const latestAnswer = params?.latestUserAnswer as string | undefined;
      if (latestAnswer) {
        messages.push({
          role: 'user',
          content: `[用户回复] ${latestAnswer}\n\n请根据以上对话上下文和用户的最新回复，继续执行任务。不要重复已经完成的步骤。`,
        });

        console.log(`[SubAgent] 📥 已追加用户最新回复到对话上下文: "${latestAnswer}"`);
      }
    } else {
      // 首次执行：使用标准流程
      console.log(`[SubAgent] 🆕 首次执行模式`);
      messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: requirement });
    }

    // ===== v2: 跟踪工具调用 =====
    const trackedToolCalls: CompletedToolCall[] = [...(completedToolCalls || [])];

    // ===== v2: 使用 generateWithToolsTracked =====
    const result = await this.llm.generateWithToolsTracked(
      messages,
      tools,
      async (toolCall) => {
        console.log(`[SubAgent] 调用工具: ${toolCall.name}`);
        console.log(`[SubAgent] 工具参数: ${JSON.stringify(toolCall.arguments)}`);

        // 触发工具调用前钩子
        await hookManager.emit(HookEvent.BEFORE_TOOL_CALL, {
          skillName: skill.name,
          toolName: toolCall.name,
          userId: userId || 'sub-agent',
          sessionId: sessionId || 'skill-execution',
          data: { arguments: toolCall.arguments }
        });

        try {
          const toolResult = await this.toolRegistry.execute(
            toolCall.name,
            toolCall.arguments,
            toolContext
          );

          if (toolResult.success) {
            const data = typeof toolResult.data === 'string'
              ? toolResult.data
              : JSON.stringify(toolResult.data, null, 2);
            console.log(`[SubAgent] 工具执行成功: ${data.substring(0, 500)}`);

            // 触发工具调用后钩子
            await hookManager.emit(HookEvent.AFTER_TOOL_CALL, {
              skillName: skill.name,
              toolName: toolCall.name,
              userId: userId || 'sub-agent',
              sessionId: sessionId || 'skill-execution',
              data: {
                arguments: toolCall.arguments,
                result: data,
                success: true
              }
            });

            // 记录工具调用
            trackedToolCalls.push({
              name: toolCall.name,
              arguments: toolCall.arguments,
              result: data,
              timestamp: new Date(),
            });

            return data;
          } else {
            console.log(`[SubAgent] 工具执行失败: ${toolResult.error}`);

            await hookManager.emit(HookEvent.AFTER_TOOL_CALL, {
              skillName: skill.name,
              toolName: toolCall.name,
              userId: userId || 'sub-agent',
              sessionId: sessionId || 'skill-execution',
              data: {
                arguments: toolCall.arguments,
                error: toolResult.error,
                success: false
              }
            });

            return `工具执行失败: ${toolResult.error}`;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.log(`[SubAgent] 工具执行异常: ${errorMsg}`);

          await hookManager.emit(HookEvent.AFTER_TOOL_CALL, {
            skillName: skill.name,
            toolName: toolCall.name,
            userId: userId || 'sub-agent',
            sessionId: sessionId || 'skill-execution',
            data: {
              arguments: toolCall.arguments,
              error: errorMsg,
              success: false
            }
          });

          return `工具执行异常: ${errorMsg}`;
        }
      },
      signal,
      concurrencyChecker
    );

    const response = result.content;

    // ===== v2: 使用增强的 detectQuestion =====
    const question = detectQuestion(response, result.toolCalls);
    if (question) {
      console.log(`[SubAgent] 🔄 检测到询问用户意图，返回 waiting_user_input 状态`);
      return {
        response,
        status: 'waiting_user_input',
        question: {
          type: 'skill_question',
          content: question.content,
          metadata: question.metadata,
        },
        // 保存上下文用于断点续执行
        _conversationContext: result.messages,
        _completedToolCalls: trackedToolCalls,
        _executionProgress: response,
      };
    }

    // 正常完成时也保存上下文（以防后续需要）
    return {
      response,
      _conversationContext: result.messages,
      _completedToolCalls: trackedToolCalls,
      _executionProgress: response,
    };
  }

  private classifyError(error: unknown): TaskError {
    if (error instanceof Error) {
      if (error.message.includes('timeout') || error.message.includes('timed out')) {
        return { type: 'RETRYABLE', message: 'Task timed out', code: 'TIMEOUT' };
      }
      if (error.message.includes('not found') || error.message.includes('ENOENT')) {
        return { type: 'FATAL', message: error.message, code: 'FILE_NOT_FOUND' };
      }
      if (error.message.includes('permission') || error.message.includes('EACCES')) {
        return { type: 'FATAL', message: 'Permission denied: ' + error.message, code: 'PERMISSION_DENIED' };
      }
      return { type: 'RETRYABLE', message: error.message, code: 'EXECUTION_ERROR' };
    }
    return { type: 'RETRYABLE', message: String(error), code: 'UNKNOWN_ERROR' };
  }
}
