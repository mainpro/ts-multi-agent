import { SkillRegistry } from '../skill-registry';
import { LLMClient, llmEvents } from '../llm';
import { Task, TaskResult, TaskError, Skill, SkillExecutionResult } from '../types';
import { promises as fs } from 'fs';
import * as path from 'path';
import { buildSubAgentPrompt } from '../prompts';

export class SubAgent {
  private skillRegistry: SkillRegistry;
  private llm: LLMClient;

  constructor(skillRegistry: SkillRegistry, llm: LLMClient) {
    this.skillRegistry = skillRegistry;
    this.llm = llm;
  }

  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    const previousAgent = llmEvents.getAgent();
    llmEvents.setAgent('SubAgent');

    try {
      console.log('[SubAgent] 任务ID: ' + task.id + ' 技能: ' + task.skillName);

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

      const result = await this.executeSkill(task.requirement, skill, signal);
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
    signal?: AbortSignal
  ): Promise<SkillExecutionResult> {
    const skillRootDir = skill.referencesDir ? path.dirname(skill.referencesDir) : './skills/' + skill.name;
    const systemPrompt = buildSubAgentPrompt(skill.body, skillRootDir);

    const tools = [
      {
        name: 'read',
        description: '读取技能目录下的文件。参数 filePath 为相对于技能根目录的路径，如 references/attendance.md',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: '相对于技能根目录的文件路径，如 references/attendance.md',
            },
          },
          required: ['filePath'],
        },
      },
    ];

    const result = await this.llm.generateWithTools(
      requirement,
      tools,
      async (toolCall) => {
        if (toolCall.name === 'read') {
          const filePath = toolCall.arguments.filePath as string;

          if (!filePath) {
            return '错误：缺少必需参数 filePath。请提供要读取的文件路径，如 references/attendance.md';
          }

          const fullPath = path.join(skillRootDir, filePath);

          console.log(`[SubAgent] 读取文件: ${fullPath}`);

          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const truncated = content.substring(0, 3000);
            return truncated;
          } catch (err) {
            return `读取文件失败: ${filePath}。请检查路径是否正确。`;
          }
        }
        return '未知工具';
      },
      systemPrompt,
      signal
    );

    return { response: result.content };
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
