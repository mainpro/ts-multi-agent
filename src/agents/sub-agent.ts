import { SkillRegistry } from '../skill-registry';
import { LLMClient, llmEvents } from '../llm';
import { Task, TaskResult, TaskError, Skill, SkillExecutionResult } from '../types';
import { buildSkillExecutionPrompt, buildRefinementPrompt } from '../prompts';
import { promises as fs } from 'fs';
import * as path from 'path';
import { z } from 'zod';

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
    const Phase1Schema = z.object({
      response: z.string().describe('给用户的回复'),
      needRefs: z.array(z.string()).optional().default([]).describe('如需参考资料，在此列出文件名'),
    });

    const refsAvailable = skill.referencesDir ? await this.listReferences(skill.referencesDir) : [];
    const refsHint = refsAvailable.length > 0
      ? `\n可用参考资料: ${refsAvailable.join(', ')}`
      : '';

    const step1 = await this.llm.generateStructured(
      buildSkillExecutionPrompt(skill, requirement, refsHint),
      Phase1Schema,
      undefined,
      signal
    );

    if (!step1.needRefs?.length || !skill.referencesDir) {
      return { response: step1.response };
    }

    console.log('[SubAgent] 需要参考资料: ' + step1.needRefs!.join(', '));
    const refContents = await this.readReferences(skill.referencesDir, step1.needRefs!);

    const Phase2Schema = z.object({
      response: z.string(),
    });

    const step2 = await this.llm.generateStructured(
      buildRefinementPrompt(step1.response, refContents),
      Phase2Schema,
      undefined,
      signal
    );

    return { response: step2.response };
  }

  private async listReferences(refsDir: string): Promise<string[]> {
    try {
      const files = await fs.readdir(refsDir);
      return files.filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    } catch {
      return [];
    }
  }

  private async readReferences(refsDir: string, fileNames: string[]): Promise<string> {
    let content = '';
    let totalSize = 0;
    const maxTotal = 3000;

    for (const file of fileNames) {
      if (totalSize >= maxTotal) break;
      const fullPath = path.join(refsDir, file);
      try {
        const fileContent = await fs.readFile(fullPath, 'utf-8');
        const truncated = fileContent.substring(0, maxTotal - totalSize);
        content += `\n### ${file}\n${truncated}\n`;
        totalSize += truncated.length;
      } catch {
        content += `\n### ${file}\n(读取失败)\n`;
      }
    }

    return content;
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
