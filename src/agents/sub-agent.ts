import { SkillRegistry } from '../skill-registry';
import { LLMClient, llmEvents } from '../llm';
import { Task, TaskResult, TaskError, Skill, SkillExecutionResult } from '../types';
import { ToolRegistry, ToolContext, Tool } from '../tools';
import { buildSubAgentPrompt } from '../prompts';

/**
 * 检测 LLM 返回的文本是否包含向用户提问的意图
 * 如果是，返回 question 内容；否则返回 null
 */
function detectQuestion(response: string): { content: string; metadata?: Record<string, unknown> } | null {
  if (!response || response.trim().length === 0) {
    return null;
  }

  // 匹配向用户提问的模式
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
      if (task.params) {
        console.log('[SubAgent] 已获取参数: ' + JSON.stringify(task.params));
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
        signal
      );
      return { success: true, data: result };
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
    questionHistory?: Array<{
      question: {
        type: string;
        content: string;
        metadata?: Record<string, unknown>;
      };
      answer: string;
      timestamp: Date;
    }>,
    signal?: AbortSignal
  ): Promise<SkillExecutionResult> {
    const skillRootDir = './skills/' + skill.name;
    const absoluteSkillRootDir = require('path').resolve(skillRootDir);
    const systemPrompt = buildSubAgentPrompt(skill.body, absoluteSkillRootDir, params, questionHistory);

    const tools = this.toolRegistry.list().map((tool: Tool) => ({
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

    const result = await this.llm.generateWithTools(
      requirement,
      tools,
      async (toolCall) => {
        console.log(`[SubAgent] 调用工具: ${toolCall.name}`);
        console.log(`[SubAgent] 工具参数: ${JSON.stringify(toolCall.arguments)}`);

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
            return data;
          } else {
            console.log(`[SubAgent] 工具执行失败: ${toolResult.error}`);
            return `工具执行失败: ${toolResult.error}`;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.log(`[SubAgent] 工具执行异常: ${errorMsg}`);
          return `工具执行异常: ${errorMsg}`;
        }
      },
      systemPrompt,
      signal
    );

    const response = result.content;

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
