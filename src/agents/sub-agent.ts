import * as path from 'path';
import { SkillRegistry } from '../skill-registry';
import { LLMClient, llmEvents } from '../llm';
import {
  Task, TaskResult, TaskError, Skill, SkillExecutionResult,
  Message, CompletedToolCall, QuestionHistoryEntry,
} from '../types';
import { ToolRegistry, ToolContext, Tool } from '../tools';
import type { AskUserArgs } from '../tools/ask-user-tool';
import { buildSubAgentPrompt, SubAgentPromptOptions } from '../prompts';
import { hookManager } from '../hooks/hook-manager';
import { HookEvent } from '../hooks/types';
import { MemoryService } from '../memory/memory-service';
import { MemoryLayer, DEFAULT_RECALL_CONFIG } from '../memory/types';
import {
  syncQuestionHistoryToContext,
  buildResumedContext,
  validateResumedContext,
} from '../memory/conversation-context-helper';

// P0-1: 默认安全工具白名单（仅包含 ToolRegistry 中实际注册的只读工具）
const DEFAULT_SAFE_TOOLS = new Set([
  'conversation-get',
  'read',
  'glob',
  'grep',
  'ask_user',  // 新增：ask_user 工具为只读工具
  'append_improvement',  // SubAgent 自我审查：记录技能执行中发现的质量问题
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
    /请告诉/,
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
  private memoryService?: MemoryService;

  constructor(skillRegistry: SkillRegistry, llm: LLMClient, memoryService?: MemoryService) {
    this.skillRegistry = skillRegistry;
    this.llm = llm;
    this.toolRegistry = new ToolRegistry();
    this.memoryService = memoryService;
  }

  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('SubAgent');

    try {
      console.log('[SubAgent] 任务ID: ' + task.id + ' 技能: ' + task.skillName);
      console.log('[SubAgent] 用户ID: ' + task.userId);
      if (task.params) {
        console.log('[SubAgent] 已获取参数: ' + JSON.stringify({
          taskId: task.id,
          skillName: task.skillName,
          paramKeys: task.params ? Object.keys(task.params) : [],
        }));
      }

      // ===== v2: 断点续执行检测 =====
      const isResuming = !!(task.conversationContext && task.conversationContext.length > 0);
      if (isResuming) {
        console.log(`[SubAgent] 🔄 断点续执行模式: 恢复 ${task.conversationContext!.length} 条对话上下文`);
      }

      console.log(`[SubAgent] 📊 execute() 入口状态: isResuming=${isResuming}, conversationContext=${task.conversationContext?.length ?? 'null'}, questionHistory=${task.questionHistory?.length ?? 0}, latestUserAnswer="${(task.params as any)?.latestUserAnswer ?? '(无)'}"`);

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

      // 防止 response 为空或 undefined 时返回无意义内容
      if (!cleanResult.response) {
        return {
          success: false,
          error: { type: 'FATAL', message: '任务执行异常：未能生成有效回复', code: 'EMPTY_RESPONSE' },
        };
      }

      // ===== 发布执行结果到共享记忆池 =====
      if (this.memoryService && cleanResult.response) {
        const responseText = cleanResult.response.substring(0, 200);
        this.memoryService.shareMemory('sub-agent', {
          id: `shared-${task.id}-${Date.now()}`,
          layer: 'procedural' as any,
          content: responseText,
          metadata: {
            publishedBy: 'sub-agent',
            skillName: task.skillName,
            taskId: task.id,
            success: true,
          },
          importance: 0.7,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          namespace: 'shared/sub-agent',
        }).catch(e => console.error('[SubAgent] Failed to publish to shared pool:', e));
      }

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
    const absoluteSkillRootDir = path.resolve(skillRootDir);

    // ===== v3: 记忆召回 - 通用上下文组装（不依赖特定业务字段） =====
    let promptOptions: SubAgentPromptOptions | undefined;
    try {
      if (this.memoryService && userId) {
        const contextParts: string[] = [];

        // 1. 加载用户画像，通用序列化为 key-value（不硬编码字段名）
        const userMemory = await this.memoryService.loadMemory(userId);
        if (userMemory?.profile) {
          const profile = userMemory.profile;
          const profileEntries: string[] = [];
          // 通用遍历：只取有值的字段，不关心具体字段名
          for (const [key, value] of Object.entries(profile)) {
            if (value !== undefined && value !== null && key !== 'userId' && key !== 'conversationCount') {
              if (Array.isArray(value) && value.length > 0) {
                profileEntries.push(`- **${key}**: ${value.join(', ')}`);
              } else if (typeof value === 'string' && value.trim()) {
                profileEntries.push(`- **${key}**: ${value}`);
              }
            }
          }
          if (profileEntries.length > 0) {
            contextParts.push('### 用户画像\n' + profileEntries.join('\n'));
            console.log(`[SubAgent] 👤 已加载用户画像 (${profileEntries.length} 个字段)`);
          }
        }

        // 2. 召回相关语义记忆（通用：任何被提取的语义知识都会被召回）
        try {
          const recalledResults = await this.memoryService.recall(userId, requirement, {
            namespace: userId,
            topK: DEFAULT_RECALL_CONFIG.SUB_AGENT_SEMANTIC_TOP_K,
            layers: [MemoryLayer.SEMANTIC],
          });
          if (recalledResults.length > 0) {
            const memoryLines = recalledResults.map(r => `- ${r.entry.content}`);
            contextParts.push('### 相关记忆\n' + memoryLines.join('\n'));
            console.log(`[SubAgent] 🧠 已召回 ${recalledResults.length} 条相关记忆`);
          }
        } catch (recallErr) {
          console.warn('[SubAgent] ⚠️ 记忆召回失败，继续执行:', (recallErr as Error).message);
        }

        // 3. 组装为统一的上下文文本
        if (contextParts.length > 0) {
          promptOptions = { recalledContext: contextParts.join('\n\n') };
        }
      }
    } catch (err) {
      console.warn('[SubAgent] ⚠️ 上下文加载失败，继续执行:', (err as Error).message);
    }

    // ===== v2: 构建增强的 system prompt =====
    const systemPrompt = await buildSubAgentPrompt(
      skill.body,
      absoluteSkillRootDir,
      params,
      questionHistory,
      completedToolCalls,
      userId,
      skill.name,
      promptOptions
    );

    const allTools = this.toolRegistry.list();

    // P0-1: 根据 allowedTools 过滤工具（直接使用 execute 中已加载的 skill，避免重复加载）
    const allowedToolNames = (skill.allowedTools && skill.allowedTools.length > 0)
      ? new Set(skill.allowedTools)
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

    // ===== v2.1: 初始化或恢复对话上下文（优化版）=====
    let messages: Message[];

    if (conversationContext && conversationContext.length > 0) {
      // ===== 断点续执行：重新构建 system prompt（包含最新的 questionHistory） =====
      const refreshedSystemPrompt = await buildSubAgentPrompt(
        skill.body,
        absoluteSkillRootDir,
        params,
        questionHistory,     // 使用最新的 questionHistory（包含刚添加的回答）
        completedToolCalls,
        userId,
        skill.name
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

      // 使用优化后的上下文构建函数
      messages = buildResumedContext(
        conversationContext,
        questionHistory || [],
        refreshedSystemPrompt,
        {
          maxToolMessages: 10,
          addContinuationPrompt: false,  // 我们在下面手动添加
        }
      );

      // 验证上下文完整性
      const validation = validateResumedContext(messages, questionHistory || []);
      if (!validation.valid) {
        console.warn(`[SubAgent] ⚠️ 上下文验证警告:`, validation.issues);
        // 尝试修复：同步 questionHistory
        messages = syncQuestionHistoryToContext(messages, questionHistory || []);
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

    console.log(`[SubAgent] 📊 发送给LLM: messages=${messages.length}条, 分支=${(conversationContext && conversationContext.length > 0) ? '断点续执行' : '首次执行'}`);
    messages.forEach((m, i) => {
      const preview = typeof m.content === 'string' ? m.content.substring(0, 120).replace(/\n/g, '\\n') : `(non-string: ${typeof m.content})`;
      console.log(`[SubAgent] 📊 msg[${i}]: role=${m.role} len=${typeof m.content === 'string' ? m.content.length : '?'} preview="${preview}..."`);
    });

    // ===== v2: 跟踪工具调用 =====
    const trackedToolCalls: CompletedToolCall[] = [...(completedToolCalls || [])];

    // ===== v2: 使用 generateWithTools =====
    const result = await this.llm.generateWithTools(
      messages,
      tools,
      async (toolCall) => {
        const toolStartTime = Date.now();
        console.log(`[SubAgent] 🔧 调用工具: ${toolCall.name} (开始于 ${new Date().toISOString()})`);
        console.log(`[SubAgent] 📥 工具参数: ${JSON.stringify(toolCall.arguments)}`);

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
            const toolDuration = Date.now() - toolStartTime;
            const data = typeof toolResult.data === 'string'
              ? toolResult.data
              : JSON.stringify(toolResult.data, null, 2);
            const dataPreview = data.length > 500 ? data.substring(0, 500) + `... (共${data.length}字符)` : data;
            console.log(`[SubAgent] ✅ 工具执行成功: ${toolCall.name} (耗时 ${toolDuration}ms)`);
            console.log(`[SubAgent] 📤 工具返回: ${dataPreview}`);

            // bash 工具：检测脚本返回的非 200 状态码，直接报错中断
            if (toolCall.name === 'bash' && toolResult.data) {
              const toolData = typeof toolResult.data === 'string'
                ? toolResult.data
                : JSON.stringify(toolResult.data);
              // 从 stdout 中提取 API 返回的 code 字段
              const codeMatch = toolData.match(/"code"\s*:\s*(\d+)/);
              if (codeMatch && codeMatch[1] !== '200') {
                const errMsg = `接口调用失败 (code: ${codeMatch[1]})，请检查请求参数或 token 是否有效`;
                console.log(`[SubAgent] 🚫 ${errMsg}`);
                console.log(`[SubAgent] 🚫 接口返回: ${dataPreview}`);
                throw new Error(errMsg);
              }
            }

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

            // 记录工具调用（截断过大的结果，避免无限累积）
            const MAX_RESULT_LENGTH = 2000;
            let truncatedResult: string;
            if (typeof data === 'string') {
              truncatedResult = data.length > MAX_RESULT_LENGTH
                ? data.slice(0, MAX_RESULT_LENGTH) + '\n... [结果已截断，原始长度: ' + data.length + ' 字符]'
                : data;
            } else {
              const jsonStr = JSON.stringify(data);
              truncatedResult = jsonStr.length > MAX_RESULT_LENGTH
                ? jsonStr.slice(0, MAX_RESULT_LENGTH) + '\n... [结果已截断，原始长度: ' + jsonStr.length + ' 字符]'
                : jsonStr;
            }

            trackedToolCalls.push({
              name: toolCall.name,
              arguments: toolCall.arguments,
              result: truncatedResult,
              timestamp: new Date(),
            });

            return data;
          } else {
            const toolDuration = Date.now() - toolStartTime;
            console.log(`[SubAgent] ❌ 工具执行失败: ${toolCall.name} (耗时 ${toolDuration}ms)`);
            console.log(`[SubAgent] ❌ 失败原因: ${toolResult.error}`);

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

    // ===== 双轨制：优先检测工具调用，其次文本检测 =====

    // 轨道 1: 检测是否调用了 ask_user 工具
    const askUserCall = trackedToolCalls.find(tc => tc.name === 'ask_user');
    if (askUserCall) {
      const args = askUserCall.arguments as unknown as AskUserArgs;
      console.log(`[SubAgent] 🔄 检测到 ask_user 工具调用，返回 waiting_user_input 状态`);

      return {
        response: args.question,
        status: 'waiting_user_input',
        question: {
          type: 'skill_question',
          content: args.question,
          metadata: {
            source: 'tool_call',
            expectedType: args.expectedType,
            options: args.options,
            paramName: args.paramName,
            isBlocking: args.isBlocking,
            context: args.context,
          },
        },
        // 保存上下文用于断点续执行
        _conversationContext: result.messages,
        _completedToolCalls: trackedToolCalls,
        _executionProgress: args.question,
      };
    }

    // 轨道 2: 文本检测（兼容旧技能）
    const question = detectQuestion(response, result.toolCalls);
    if (question) {
      console.log(`[SubAgent] 🔄 检测到询问用户意图（文本检测），返回 waiting_user_input 状态`);
      return {
        response,
        status: 'waiting_user_input',
        question: {
          type: 'skill_question',
          content: question.content,
          metadata: {
            source: 'text_detection',
            ...question.metadata,
          },
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
      if (/permission/i.test(error.message) || error.message.includes('EACCES')) {
        return { type: 'FATAL', message: 'Permission denied: ' + error.message, code: 'PERMISSION_DENIED' };
      }
      return { type: 'RETRYABLE', message: error.message, code: 'EXECUTION_ERROR' };
    }
    return { type: 'RETRYABLE', message: String(error), code: 'UNKNOWN_ERROR' };
  }
}
