import * as path from 'path';
import { SkillRegistry } from '../skill-registry';
import { ILLMClient, llmEvents, LLMError } from '../llm';
import { compactMessages } from '../llm/compaction';
import {
  Task, TaskResult, Skill, SkillExecutionResult,
  Message, CompletedToolCall, QuestionHistoryEntry,
} from '../types';
import { LlmError, SkillError, BusinessError, AppError } from '../errors';
import { ToolRegistry, ToolContext, Tool } from '../tools';
import type { AskUserArgs } from '../tools/ask-user-tool';
import { buildSubAgentPrompt, SubAgentPromptOptions } from '../prompts';
import { hookManager } from '../hooks/hook-manager';
import { HookEvent } from '../hooks/types';
import { MemoryService } from '../memory/memory-service';
import { resolveResource } from '../utils/app-root';
import { DEFAULT_RECALL_CONFIG } from '../memory/types';
import { steeringBuffer } from '../memory/steering-buffer';
import { requestLifecycle } from '../events/request-lifecycle';
import { createLogger } from '../observability/logger';
import {
  syncQuestionHistoryToContext,
  buildResumedContext,
  validateResumedContext,
} from './conversation-context-helper';
import { UnknownToolLoopGuard } from './unknown-tool-guard';

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
  private static readonly log = createLogger({ module: 'SubAgent' });
  private skillRegistry: SkillRegistry;
  private llm: ILLMClient;
  private toolRegistry: ToolRegistry;
  private memoryService?: MemoryService;

  constructor(skillRegistry: SkillRegistry, llm: ILLMClient, memoryService?: MemoryService) {
    this.skillRegistry = skillRegistry;
    this.llm = llm;
    this.toolRegistry = new ToolRegistry();
    this.memoryService = memoryService;
  }

  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('SubAgent');

    try {
      SubAgent.log.debug('任务入口', { taskId: task.id, skillName: task.skillName, userId: task.userId, params: task.params ? Object.keys(task.params) : [] });

      // ===== v2: 断点续执行检测 =====
      const isResuming = !!(task.conversationContext && task.conversationContext.length > 0);
      if (isResuming) {
        SubAgent.log.info('断点续执行模式', { contextLength: task.conversationContext!.length });
      }

      SubAgent.log.debug('execute 入口状态', { isResuming, conversationContext: task.conversationContext?.length, questionHistory: task.questionHistory?.length, latestUserAnswer: (task.params as any)?.latestUserAnswer });

      if (!task.skillName) {
        throw new SkillError('MISSING_SKILL', 'No skill assigned');
      }

      const skill = await this.skillRegistry.loadFullSkill(task.skillName);
      if (!skill) {
        throw new SkillError('SKILL_NOT_FOUND', 'Skill not found: ' + task.skillName);
      }

      const result = await this.executeSkill(
        task.id,
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
        throw new SkillError('EMPTY_RESPONSE', '任务执行异常：未能生成有效回复');
      }

      // ===== 发布执行结果到长期记忆 =====
      // 旧 remember(procedural) 已由 L3 summarizeRequest 在请求完成时统一处理,
      // 此处不再单独调用(避免重复写入且无 sessionId 归属)。

      return { success: true, data: cleanResult };
    } catch (error) {
      throw mapSubAgentError(error);
    } finally {
      llmEvents.setAgent(previousAgent);
      // v4: 任务结束(成功/失败)清掉本 session 残留的 steer 消息,
      // 防止未消费的改口消息留到下一次请求被错误注入。
      if (task.sessionId) {
        const pending = steeringBuffer.peek(task.sessionId);
        if (pending.length > 0) {
          SubAgent.log.warn('任务结束,清掉残留 steer 消息', {
            sessionId: task.sessionId,
            taskId: task.id,
            droppedCount: pending.length,
          });
          steeringBuffer.clear(task.sessionId);
        }
      }
    }
  }

  private async executeSkill(
    taskId: string,
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
    const skillRootDir = resolveResource('skills', skill.name);
    const absoluteSkillRootDir = path.resolve(skillRootDir);

    // v4: 未知工具熔断(per-taskId,与 OpenClaw 一致)
    const unknownToolGuard = new UnknownToolLoopGuard(3);

    // ===== v3: 记忆召回 - 通用上下文组装（不依赖特定业务字段） =====
    let promptOptions: SubAgentPromptOptions | undefined;
    try {
      if (this.memoryService && userId) {
        const contextParts: string[] = [];

        // 1. 加载用户画像，通用序列化为 key-value（不硬编码字段名）
        const userMemory = await this.memoryService.loadUserMemory(userId, sessionId);
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
            SubAgent.log.info('已加载用户画像', { fieldsCount: profileEntries.length });
          }
        }

        // 2. 召回相关语义记忆（通用：任何被提取的语义知识都会被召回）
        try {
          const recalledResults = await this.memoryService.recall(userId, requirement, {
            topK: DEFAULT_RECALL_CONFIG.SUB_AGENT_SEMANTIC_TOP_K,
          });
          if (recalledResults.length > 0) {
            const memoryLines = recalledResults.map(r => `- ${r.content}`);
            contextParts.push('### 相关记忆\n' + memoryLines.join('\n'));
            SubAgent.log.info('已召回相关记忆', { count: recalledResults.length });
          }
        } catch (recallErr) {
          SubAgent.log.warn('记忆召回失败，继续执行', { error: (recallErr as Error).message });
        }

        // 3. 组装为统一的上下文文本
        if (contextParts.length > 0) {
          promptOptions = { recalledContext: contextParts.join('\n\n') };
        }
      }
    } catch (err) {
      SubAgent.log.warn('上下文加载失败，继续执行', { error: (err as Error).message });
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

    // 定义并发安全性检查函数（与 DEFAULT_SAFE_TOOLS 保持一致）
    const concurrencyChecker = (toolName: string): boolean => DEFAULT_SAFE_TOOLS.has(toolName);

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

      SubAgent.log.info('断点续执行模式启动');
      SubAgent.log.debug('询问历史条数', { count: questionHistory?.length || 0 });
      if (questionHistory && questionHistory.length > 0) {
        questionHistory.forEach((qh, i) => {
          SubAgent.log.debug('询问历史', { index: i, question: qh.question.content.substring(0, 80), answer: qh.answer });
        });
      }
      SubAgent.log.debug('已完成工具调用数', { count: completedToolCalls?.length || 0 });
      SubAgent.log.debug('恢复对话上下文数', { count: conversationContext.length });
      SubAgent.log.debug('latestUserAnswer', { value: params?.latestUserAnswer || '(无)' });

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
        SubAgent.log.warn('上下文验证警告', { issues: validation.issues });
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

        SubAgent.log.info('已追加用户最新回复到对话上下文', { answer: latestAnswer });
      }
    } else {
      // 首次执行：使用标准流程
      SubAgent.log.info('首次执行模式');
      messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: requirement });
    }

    SubAgent.log.info('发送给LLM', { messageCount: messages.length, branch: (conversationContext && conversationContext.length > 0) ? '断点续执行' : '首次执行' });
    messages.forEach((m, i) => {
      const preview = typeof m.content === 'string' ? m.content.substring(0, 120).replace(/\n/g, '\\n') : `(non-string: ${typeof m.content})`;
      SubAgent.log.debug('消息预览', { index: i, role: m.role, length: typeof m.content === 'string' ? m.content.length : '?', preview });
    });

    // ===== v2: 跟踪工具调用 =====
    const trackedToolCalls: CompletedToolCall[] = [...(completedToolCalls || [])];

    SubAgent.log.info('llm.request', {
      traceId: taskId,
      skillName: skill.name,
      messages: messages.length,
      tools: tools.length,
      iteration: 0,
    });

    // ===== v2: 使用 generateWithTools =====
    // 提取工具执行回调为命名 const,以便在 safe compaction 重试循环中复用
    const toolExecutor = async (toolCall: { name: string; arguments: Record<string, unknown> }) => {
      // v4: 未知工具熔断检查
      if (!allowedToolNames.has(toolCall.name)) {
        const rewrite = unknownToolGuard.check(toolCall.name);
        if (rewrite) {
          SubAgent.log.warn('未知工具熔断触发', { toolName: toolCall.name, count: '>3' });
          return rewrite;  // 直接返回改写后的 toolResult
        }
        // 未超阈值但仍不在允许名单 → 走原有 "工具不存在" 返回
        return `工具执行失败: 工具 '${toolCall.name}' 不在允许列表中,可用工具: ${Array.from(allowedToolNames).join(', ')}`;
      } else {
        unknownToolGuard.reset();  // 合法工具调用,重置计数
      }
      const toolStartTime = Date.now();
      SubAgent.log.info('调用工具', { toolName: toolCall.name, timestamp: new Date().toISOString() });
      SubAgent.log.debug('工具参数', { args: toolCall.arguments });

      SubAgent.log.info('tool.call', {
        traceId: taskId,
        skillName: skill.name,
        toolName: toolCall.name,
        argsLength: JSON.stringify(toolCall.arguments).length,
      });

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
          SubAgent.log.info('工具执行成功', { toolName: toolCall.name, duration: toolDuration });
          SubAgent.log.debug('工具返回', { preview: dataPreview });

          SubAgent.log.info('tool.result', {
            traceId: taskId,
            skillName: skill.name,
            toolName: toolCall.name,
            resultLength: data.length,
            duration: toolDuration,
          });

          // bash 工具：检测脚本返回的非 200 状态码，直接报错中断
          if (toolCall.name === 'bash' && toolResult.data) {
            const toolData = typeof toolResult.data === 'string'
              ? toolResult.data
              : JSON.stringify(toolResult.data);
            // 从 stdout 中提取 API 返回的 code 字段
            const codeMatch = toolData.match(/"code"\s*:\s*(\d+)/);
            if (codeMatch && codeMatch[1] !== '200') {
              const errMsg = `接口调用失败 (code: ${codeMatch[1]})，请检查请求参数或 token 是否有效`;
              SubAgent.log.warn('接口调用失败', { code: codeMatch[1] });
              SubAgent.log.debug('接口返回', { preview: dataPreview });
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
          SubAgent.log.info('工具执行失败', { toolName: toolCall.name, duration: toolDuration });
          SubAgent.log.debug('失败原因', { error: toolResult.error });

          SubAgent.log.error('tool.result', {
            traceId: taskId,
            skillName: skill.name,
            toolName: toolCall.name,
            error: toolResult.error,
            duration: toolDuration,
          });

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
        SubAgent.log.warn('工具执行异常', { error: errorMsg });

        SubAgent.log.error('tool.exception', {
          traceId: taskId,
          skillName: skill.name,
          toolName: toolCall.name,
          error: errorMsg,
        });

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
    };

    // ===== v4: steer 队列消费(每轮 LLM 调用前) =====
    // 用户在本 request 跑着时发来的新消息,以 user message 形式插到当前 turn 边界,
    // 不用等 checkpoint 合并。sessionId 缺失时不消费(拿不到归属,避免串会话)。
    // 消费时 emit request_steered 事件,供 SSE 前端/ops 观测。
    // 注:requestId 字段填 taskId,真正 request 级 ID 需要 planId 信息(由 MainAgent 注入)
    const consumeSteering = (trackedMessages: Message[]) => {
      if (!sessionId) return;
      const steering = steeringBuffer.consume(sessionId);
      for (const msg of steering) {
        trackedMessages.push({ role: 'user', content: msg.content });
        SubAgent.log.info('steering 消息注入到 messages', {
          sessionId,
          taskId,
          content: msg.content.substring(0, 50),
        });
        requestLifecycle.emit({
          type: 'request_steered',
          requestId: taskId,  // SubAgent 不知道 requestId,用 taskId 作 proxy
          taskId,
          content: msg.content,
          enqueuedAt: msg.enqueuedAt,
          consumedAt: new Date().toISOString(),
        });
      }
    };

    // ===== Safe Compaction: CONTEXT_TOO_LONG 时压缩并重试 1 次 =====
    // result.messages 已是完整轨迹,不能被压缩后的 messages 覆盖
    // 用 IIFE 包裹循环,使 result 一定有返回值,避免 TS "used before assigned" 报错
    const result = await (async (): Promise<{ content: string; toolCalls: any[]; messages: Message[] }> => {
      let baseMessages = messages;
      let attempts = 0;
      const MAX_COMPACTION_ATTEMPTS = 1;

      while (attempts <= MAX_COMPACTION_ATTEMPTS) {
        try {
          return await this.llm.generateWithTools(
            baseMessages,
            tools,
            toolExecutor,
            signal,
            concurrencyChecker,
            consumeSteering,
          );
        } catch (err) {
          if (err instanceof LLMError && err.type === 'CONTEXT_TOO_LONG' && attempts < MAX_COMPACTION_ATTEMPTS) {
            SubAgent.log.warn('CONTEXT_TOO_LONG,触发 safe compaction', {
              beforeLength: baseMessages.length,
            });
            baseMessages = await compactMessages(baseMessages, this.llm, {
              tokenBudget: 8000,
              keepRecent: 5,
              signal,
            });
            attempts++;
            continue;
          }
          throw err;
        }
      }
      // 不可达:循环要么 return,要么 throw
      throw new LLMError('API_ERROR', 'Safe compaction loop exited unexpectedly');
    })();

    const response = result.content;
    const toolCallsCount = result.toolCalls?.length || 0;
    SubAgent.log.info('llm.response', {
      traceId: taskId,
      skillName: skill.name,
      contentLength: response?.length || 0,
      toolCalls: toolCallsCount,
    });

    // ===== 双轨制：优先检测工具调用，其次文本检测 =====
    const askUserCall = trackedToolCalls.find(tc => tc.name === 'ask_user');
    if (askUserCall) {
      const args = askUserCall.arguments as unknown as AskUserArgs;

      // P0: 预检查 — 如果 ask_user 询问的信息已在 params 中，自动回答
      if (args.paramName && params && params[args.paramName] !== undefined && params[args.paramName] !== null && params[args.paramName] !== '') {
        const existingValue = String(params[args.paramName]);
        SubAgent.log.info('ask_user 预检查: 已在 params 中，跳过询问', { paramName: args.paramName, existingValue });

        return {
          response: `[系统自动填充] 根据已知信息，${args.paramName} = ${existingValue}`,
          status: 'completed',
          _conversationContext: result.messages,
          _completedToolCalls: trackedToolCalls,
        };
      }

      SubAgent.log.info('检测到 ask_user 工具调用，返回 waiting_user_input 状态');

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
      SubAgent.log.info('检测到询问用户意图（文本检测），返回 waiting_user_input 状态');
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
}

/**
 * Map any error thrown inside SubAgent to an AppError.
 * - LLMError → LlmError (preserves LLMErrorType classification)
 * - AppError → re-throw as-is
 * - Error with ENOENT/EACCES → BusinessError with appropriate code
 * - Other Error → SkillError
 */
function mapSubAgentError(error: unknown): never {
  if (error instanceof LLMError) {
    throw new LlmError(error.type, error.message, { cause: error, statusCode: error.statusCode });
  }
  if (error instanceof AppError) {
    throw error;
  }
  if (error instanceof Error) {
    if (error.message.includes('ENOENT') || /\bnot found\b/i.test(error.message)) {
      throw new BusinessError('FILE_NOT_FOUND', error.message, { cause: error });
    }
    if (error.message.includes('EACCES') || /permission/i.test(error.message)) {
      throw new BusinessError('PERMISSION_DENIED', error.message, { cause: error });
    }
    throw new SkillError('EXECUTION_ERROR', error.message, { cause: error });
  }
  throw new SkillError('UNKNOWN_ERROR', String(error));
}
