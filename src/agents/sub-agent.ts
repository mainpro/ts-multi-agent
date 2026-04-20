import { SkillRegistry } from '../skill-registry';
import { LLMClient, llmEvents } from '../llm';
import { Task, TaskResult, TaskError, Skill, SkillExecutionResult } from '../types';
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

/**
 * 检测 LLM 返回的文本是否包含向用户提问的意图
 * 如果是，返回 question 内容；否则返回 null
 */
export function detectQuestion(response: string): { content: string; metadata?: Record<string, unknown> } | null {
  if (!response || response.trim().length === 0) {
    return null;
  }

  // 匹配向用户提问的模式
  const questionPatterns = [
    /请问您?要?选择/,
    /请选择/,
    /请提供/,
    /请问.*(?:是|是什么|是哪)[?？]?/,
    /请输入/,
    /请确认/,
    /请回复/,
    /请告诉/,
    /需要您?(?:提供|确认|选择|输入|回复)/,
    /您?(?:希望|想要|需要).*(?:哪个|哪些|什么)[?？]?/,
    /请.?问.*(?:多少|什么|哪个|哪些)[?？]?/,
    /请提供以下信息/,
  ];

  const isQuestion = questionPatterns.some(pattern => pattern.test(response));

  if (isQuestion) {
    return {
      content: response,
    };
  }

  return null;
}

export class SubAgent {
  private skillRegistry: SkillRegistry;
  private llm: LLMClient;
  private toolRegistry: ToolRegistry;
  private skillCache: Map<string, Skill> = new Map();

  constructor(skillRegistry: SkillRegistry, llm: LLMClient) {
    this.skillRegistry = skillRegistry;
    this.llm = llm;
    this.toolRegistry = new ToolRegistry();
  }

  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('SubAgent');

    const startTime = Date.now();
    const executionId = `sub-agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      console.log(JSON.stringify({
        level: 'INFO',
        timestamp: new Date().toISOString(),
        executionId,
        agent: 'SubAgent',
        action: 'task_start',
        taskId: task.id,
        skillName: task.skillName,
        userId: task.userId,
        params: task.params,
        sessionId: task.sessionId
      }));

      if (task.params) {
        console.log(JSON.stringify({
          level: 'DEBUG',
          timestamp: new Date().toISOString(),
          executionId,
          agent: 'SubAgent',
          action: 'task_params',
          params: task.params
        }));
      }

      if (!task.skillName) {
        return {
          success: false,
          error: { type: 'FATAL', message: 'No skill assigned', code: 'MISSING_SKILL' },
        };
      }

      let skill = this.skillCache.get(task.skillName);
      if (!skill) {
        skill = await this.skillRegistry.loadFullSkill(task.skillName);
        if (!skill) {
          return {
            success: false,
            error: { type: 'FATAL', message: 'Skill not found: ' + task.skillName, code: 'SKILL_NOT_FOUND' },
          };
        }
        this.skillCache.set(task.skillName, skill);
      }

      const result = await this.executeSkill(
        task.requirement,
        skill,
        task.params,
        task.sessionId,
        task.userId,
        task.questionHistory,
        signal,
        executionId
      );

      const endTime = Date.now();
      console.log(JSON.stringify({
        level: 'INFO',
        timestamp: new Date().toISOString(),
        executionId,
        agent: 'SubAgent',
        action: 'task_complete',
        taskId: task.id,
        skillName: task.skillName,
        userId: task.userId,
        duration: endTime - startTime,
        result: {
          status: result.status,
          hasResponse: !!result.response
        }
      }));

      return { success: true, data: result };
    } catch (error) {
      const endTime = Date.now();
      const classifiedError = this.classifyError(error);
      
      console.log(JSON.stringify({
        level: 'ERROR',
        timestamp: new Date().toISOString(),
        executionId,
        agent: 'SubAgent',
        action: 'task_error',
        taskId: task.id,
        skillName: task.skillName,
        userId: task.userId,
        duration: endTime - startTime,
        error: {
          type: classifiedError.type,
          code: classifiedError.code,
          message: classifiedError.message
        }
      }));
      
      return { success: false, error: classifiedError };
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
    questionHistory?: Array<{
      question: {
        type: string;
        content: string;
        metadata?: Record<string, unknown>;
      };
      answer: string;
      timestamp: Date;
    }>,
    signal?: AbortSignal,
    executionId?: string
  ): Promise<SkillExecutionResult> {
    const { skillRootDir, absoluteSkillRootDir, systemPrompt } = this.prepareSkillExecution(skill, params, questionHistory, userId);
    const { tools, toolContext } = this.prepareTools(skill, absoluteSkillRootDir, userId, sessionId);
    
    const result = await this.executeWithLLM(
      requirement,
      tools,
      toolContext,
      systemPrompt,
      skill,
      userId,
      sessionId,
      signal,
      executionId
    );

    return this.processLLMResponse(result.content);
  }

  private prepareSkillExecution(
    skill: Skill,
    params?: Record<string, unknown>,
    questionHistory?: Array<{
      question: {
        type: string;
        content: string;
        metadata?: Record<string, unknown>;
      };
      answer: string;
      timestamp: Date;
    }>,
    userId?: string
  ) {
    const skillRootDir = './skills/' + skill.name;
    const absoluteSkillRootDir = require('path').resolve(skillRootDir);
    const systemPrompt = buildSubAgentPrompt(skill.body, absoluteSkillRootDir, params, questionHistory, userId);
    
    return { skillRootDir, absoluteSkillRootDir, systemPrompt };
  }

  private prepareTools(
    skill: Skill,
    absoluteSkillRootDir: string,
    userId?: string,
    sessionId?: string
  ) {
    const allTools = this.toolRegistry.list();

    // P0-1: 根据 allowedTools 过滤工具
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

    return { tools, toolContext };
  }

  private async executeWithLLM(
    requirement: string,
    tools: any[],
    toolContext: ToolContext,
    systemPrompt: string,
    skill: Skill,
    userId?: string,
    sessionId?: string,
    signal?: AbortSignal,
    executionId?: string
  ) {
    // 定义并发安全性检查函数
    const concurrencyChecker = (toolName: string): boolean => {
      // 并发安全工具列表
      const safeTools = new Set([
        'read', 'glob', 'grep', 'conversation-get', // 只读工具
        'bash' // 某些bash命令也是并发安全的
      ]);
      return safeTools.has(toolName);
    };

    return await this.llm.generateWithTools(
      requirement,
      tools,
      async (toolCall) => {
        return this.executeToolCall(toolCall, toolContext, skill, userId, sessionId, executionId);
      },
      systemPrompt,
      signal,
      concurrencyChecker
    );
  }

  private async executeToolCall(
    toolCall: any,
    toolContext: ToolContext,
    skill: Skill,
    userId?: string,
    sessionId?: string,
    executionId?: string
  ) {
    const toolCallId = `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const toolStartTime = Date.now();

    console.log(JSON.stringify({
      level: 'INFO',
      timestamp: new Date().toISOString(),
      executionId,
      agent: 'SubAgent',
      action: 'tool_call_start',
      toolCallId,
      toolName: toolCall.name,
      skillName: skill.name,
      arguments: toolCall.arguments
    }));

    // 触发工具调用前钩子
    await hookManager.emit(HookEvent.BEFORE_TOOL_CALL, {
      skillName: skill.name,
      toolName: toolCall.name,
      userId: userId || 'sub-agent',
      sessionId: sessionId || 'skill-execution',
      data: { 
        arguments: toolCall.arguments,
        toolCallId
      }
    });

    try {
      // 输入验证和路径安全检查
      const validatedArgs = this.validateToolArguments(toolCall.name, toolCall.arguments, toolContext);
      if (!validatedArgs.valid) {
        return `工具执行失败: ${validatedArgs.error}`;
      }

      return await this.executeToolWithRetry(
        toolCall.name,
        validatedArgs.arguments,
        toolContext,
        skill,
        toolCallId,
        toolStartTime,
        executionId
      );
    } catch (err) {
      const toolEndTime = Date.now();
      const errorMsg = err instanceof Error ? err.message : String(err);
      
      console.log(JSON.stringify({
        level: 'ERROR',
        timestamp: new Date().toISOString(),
        executionId,
        agent: 'SubAgent',
        action: 'tool_call_unexpected_error',
        toolCallId,
        toolName: toolCall.name,
        skillName: skill.name,
        duration: toolEndTime - toolStartTime,
        error: errorMsg
      }));
      
      // 触发工具调用后钩子
      await hookManager.emit(HookEvent.AFTER_TOOL_CALL, {
        skillName: skill.name,
        toolName: toolCall.name,
        userId: userId || 'sub-agent',
        sessionId: sessionId || 'skill-execution',
        data: { 
          arguments: toolCall.arguments,
          error: errorMsg,
          success: false,
          toolCallId,
          duration: toolEndTime - toolStartTime
        }
      });
      
      return `工具执行异常: ${errorMsg}`;
    }
  }

  private async executeToolWithRetry(
    toolName: string,
    args: any,
    toolContext: ToolContext,
    skill: Skill,
    toolCallId: string,
    toolStartTime: number,
    executionId?: string
  ) {
    // 工具调用重试机制
    const maxRetries = 0;
    const retryDelay = 1000; // 1秒
    let lastError: string | null = null;

    // 确保至少执行一次，即使 maxRetries 为 0
    let attempt = 1;
    while (attempt <= maxRetries + 1) {
      try {
        // 超时控制
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('工具执行超时')), 30000); // 30秒超时
        });

        const toolResult = await Promise.race([
          this.toolRegistry.execute(
            toolName,
            args,
            toolContext
          ),
          timeoutPromise
        ]);

        if (toolResult.success) {
          return this.handleToolSuccess(
            toolResult.data,
            toolName,
            skill,
            args,
            toolCallId,
            toolStartTime,
            executionId
          );
        } else {
          lastError = toolResult.error;
          this.handleToolFailure(
            lastError,
            toolName,
            skill,
            attempt,
            maxRetries,
            toolCallId,
            toolStartTime,
            executionId
          );
          
          // 检查是否应该重试
          if (!this.shouldRetry(lastError, toolName)) {
            break;
          }
          
          // 等待重试
          if (attempt <= maxRetries) {
            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        lastError = errorMsg;
        
        this.handleToolException(
          errorMsg,
          toolName,
          skill,
          attempt,
          maxRetries,
          toolCallId,
          toolStartTime,
          executionId
        );
        
        // 检查是否应该重试
        if (!this.shouldRetry(errorMsg, toolName)) {
          break;
        }
        
        // 等待重试
        if (attempt <= maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
      }
      attempt++;
    }

    // 所有重试都失败
    return this.handleToolFinalFailure(
      lastError || '工具执行失败',
      toolName,
      skill,
      args,
      maxRetries,
      toolCallId,
      toolStartTime,
      executionId
    );
  }

  private handleToolSuccess(
    data: any,
    toolName: string,
    skill: Skill,
    args: any,
    toolCallId: string,
    toolStartTime: number,
    executionId?: string
  ) {
    const toolEndTime = Date.now();
    const resultData = typeof data === 'string'
      ? data
      : JSON.stringify(data, null, 2);
    
    console.log(JSON.stringify({
      level: 'INFO',
      timestamp: new Date().toISOString(),
      executionId,
      agent: 'SubAgent',
      action: 'tool_call_complete',
      toolCallId,
      toolName: toolName,
      skillName: skill.name,
      duration: toolEndTime - toolStartTime,
      result: resultData.substring(0, 500)
    }));
    
    // 触发工具调用后钩子
    hookManager.emit(HookEvent.AFTER_TOOL_CALL, {
      skillName: skill.name,
      toolName: toolName,
      userId: 'sub-agent',
      sessionId: 'skill-execution',
      data: { 
        arguments: args,
        result: resultData,
        success: true,
        toolCallId,
        duration: toolEndTime - toolStartTime
      }
    });
    
    return resultData;
  }

  private handleToolFailure(
    error: string,
    toolName: string,
    skill: Skill,
    attempt: number,
    maxRetries: number,
    toolCallId: string,
    toolStartTime: number,
    executionId?: string
  ) {
    const toolEndTime = Date.now();
    console.log(JSON.stringify({
      level: 'WARN',
      timestamp: new Date().toISOString(),
      executionId,
      agent: 'SubAgent',
      action: 'tool_call_failure',
      toolCallId,
      toolName: toolName,
      skillName: skill.name,
      duration: toolEndTime - toolStartTime,
      attempt: attempt,
      maxRetries: maxRetries,
      error: error
    }));
  }

  private handleToolException(
    error: string,
    toolName: string,
    skill: Skill,
    attempt: number,
    maxRetries: number,
    toolCallId: string,
    toolStartTime: number,
    executionId?: string
  ) {
    const toolEndTime = Date.now();
    console.log(JSON.stringify({
      level: 'ERROR',
      timestamp: new Date().toISOString(),
      executionId,
      agent: 'SubAgent',
      action: 'tool_call_exception',
      toolCallId,
      toolName: toolName,
      skillName: skill.name,
      duration: toolEndTime - toolStartTime,
      attempt: attempt,
      maxRetries: maxRetries,
      error: error
    }));
  }

  private async handleToolFinalFailure(
    error: string,
    toolName: string,
    skill: Skill,
    args: any,
    maxRetries: number,
    toolCallId: string,
    toolStartTime: number,
    executionId?: string
  ) {
    const toolEndTime = Date.now();
    
    console.log(JSON.stringify({
      level: 'ERROR',
      timestamp: new Date().toISOString(),
      executionId,
      agent: 'SubAgent',
      action: 'tool_call_final_failure',
      toolCallId,
      toolName: toolName,
      skillName: skill.name,
      duration: toolEndTime - toolStartTime,
      maxRetries: maxRetries,
      error: error
    }));
    
    // 触发工具调用后钩子
    await hookManager.emit(HookEvent.AFTER_TOOL_CALL, {
      skillName: skill.name,
      toolName: toolName,
      userId: 'sub-agent',
      sessionId: 'skill-execution',
      data: { 
        arguments: args,
        error: error,
        success: false,
        toolCallId,
        duration: toolEndTime - toolStartTime,
        maxRetries: maxRetries
      }
    });
    
    return `工具执行失败: ${error}`;
  }

  private processLLMResponse(response: string): SkillExecutionResult {
    // 检测 LLM 输出是否包含向用户提问的意图
    const question = detectQuestion(response);
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
      };
    }

    return { response };
  }

  private classifyError(error: unknown): TaskError {
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      
      // 超时错误
      if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
        return { type: 'RETRYABLE', message: 'Task timed out', code: 'TIMEOUT' };
      }
      
      // 文件不存在错误
      if (errorMessage.includes('not found') || errorMessage.includes('enoent')) {
        return { type: 'FATAL', message: error.message, code: 'FILE_NOT_FOUND' };
      }
      
      // 权限错误
      if (errorMessage.includes('permission') || errorMessage.includes('eacces') || errorMessage.includes('permission denied')) {
        return { type: 'FATAL', message: 'Permission denied: ' + error.message, code: 'PERMISSION_DENIED' };
      }
      
      // 网络错误
      if (errorMessage.includes('network') || errorMessage.includes('connection') || errorMessage.includes('connect')) {
        return { type: 'RETRYABLE', message: 'Network error: ' + error.message, code: 'NETWORK_ERROR' };
      }
      
      // 内存错误
      if (errorMessage.includes('memory') || errorMessage.includes('heap')) {
        return { type: 'FATAL', message: 'Memory error: ' + error.message, code: 'MEMORY_ERROR' };
      }
      
      // 系统错误
      if (errorMessage.includes('system') || errorMessage.includes('os')) {
        return { type: 'FATAL', message: 'System error: ' + error.message, code: 'SYSTEM_ERROR' };
      }
      
      // 默认情况
      return { type: 'RETRYABLE', message: error.message, code: 'EXECUTION_ERROR' };
    }
    return { type: 'RETRYABLE', message: String(error), code: 'UNKNOWN_ERROR' };
  }

  private validateToolArguments(toolName: string, args: any, toolContext: ToolContext): { valid: boolean; arguments?: any; error?: string } {
    // 基本参数验证
    if (!args || typeof args !== 'object') {
      return { valid: false, error: '工具参数必须是对象' };
    }

    // 针对不同工具的特定验证
    switch (toolName) {
      case 'read':
      case 'write':
      case 'edit':
        return this.validateFileToolArguments(args, toolContext);
      case 'glob':
      case 'grep':
        return this.validateSearchToolArguments(args, toolContext);
      case 'bash':
        return this.validateBashToolArguments(args);
      default:
        return { valid: true, arguments: args };
    }
  }

  private validateFileToolArguments(args: any, toolContext: ToolContext): { valid: boolean; arguments?: any; error?: string } {
    // 向后兼容：支持 filePath、fileName 和 file_path 参数名
    const filePath = args.filePath || args.fileName || args.file_path;
    
    // 检查文件路径参数
    if (!filePath) {
      return { valid: false, error: '缺少必要参数: filePath (或 fileName、file_path)' };
    }

    if (typeof filePath !== 'string') {
      return { valid: false, error: 'filePath 必须是字符串' };
    }

    // 路径安全检查
    if (!this.isSafePath(filePath, toolContext.workDir)) {
      return { valid: false, error: '路径安全检查失败，可能存在路径遍历攻击' };
    }

    // 标准化参数，确保工具接收到正确的参数名
    const normalizedArgs = { ...args, filePath };

    return { valid: true, arguments: normalizedArgs };
  }

  private validateSearchToolArguments(args: any, toolContext: ToolContext): { valid: boolean; arguments?: any; error?: string } {
    // 检查 path 参数
    if (args.path && typeof args.path !== 'string') {
      return { valid: false, error: 'path 必须是字符串' };
    }

    // 路径安全检查
    if (args.path && !this.isSafePath(args.path, toolContext.workDir)) {
      return { valid: false, error: '路径安全检查失败，可能存在路径遍历攻击' };
    }

    return { valid: true, arguments: args };
  }

  private validateBashToolArguments(args: any): { valid: boolean; arguments?: any; error?: string } {
    // 检查 command 参数
    if (!args.command) {
      return { valid: false, error: '缺少必要参数: command' };
    }

    if (typeof args.command !== 'string') {
      return { valid: false, error: 'command 必须是字符串' };
    }

    // 基本的命令安全检查
    const dangerousCommands = ['rm -rf', 'format', 'mkfs', 'dd if=', 'shutdown', 'reboot'];
    for (const dangerousCmd of dangerousCommands) {
      if (args.command.includes(dangerousCmd)) {
        return { valid: false, error: '命令包含潜在危险操作' };
      }
    }

    return { valid: true, arguments: args };
  }

  private isSafePath(path: string, baseDir: string): boolean {
    try {
      // 检查是否包含 ~ 路径
      if (path.includes('~')) {
        return false;
      }
      
      const resolvedPath = require('path').resolve(baseDir, path);
      return resolvedPath.startsWith(baseDir);
    } catch (error) {
      return false;
    }
  }

  private shouldRetry(error: string, toolName: string): boolean {
    // 不应该重试的错误类型
    const nonRetryableErrors = [
      '路径安全检查失败',
      '缺少必要参数',
      '命令包含潜在危险操作',
      'Permission denied',
      'EACCES',
      'file not found',
      'ENOENT'
    ];

    // 检查是否包含不应该重试的错误
    for (const nonRetryableError of nonRetryableErrors) {
      if (error.includes(nonRetryableError)) {
        return false;
      }
    }

    // 可以重试的错误类型
    const retryableErrors = [
      'timeout',
      'timed out',
      'connection',
      'network',
      '暂时不可用',
      '服务不可用'
    ];

    // 检查是否包含可以重试的错误
    for (const retryableError of retryableErrors) {
      if (error.includes(retryableError)) {
        return true;
      }
    }

    // 默认情况下，对于网络相关工具可以重试
    const networkTools = ['bash'];
    return networkTools.includes(toolName);
  }
}
