import { SkillRegistry } from '../skill-registry';
import { LLMClient } from '../llm';
import { Task, TaskResult, TaskError, Skill, CONFIG } from '../types';
import { promises as fs } from 'fs';
import * as path from 'path';
import { z } from 'zod';

/**
 * SubAgent - Skill execution engine
 *
 * Responsibilities:
 * - Execute tasks by running the associated Skill
 * - Handle both script-based and LLM-based skills
 * - Classify errors for retry/replan decisions
 * - Return structured TaskResult
 *
 * Constraints:
 * - Single-layer execution (cannot spawn nested SubAgents)
 * - Script execution is sandboxed to skill's scripts/ directory
 * - LLM calls respect timeout and retry settings
 */
export class SubAgent {
  private skillRegistry: SkillRegistry;
  private llm: LLMClient;

  constructor(skillRegistry: SkillRegistry, llm: LLMClient) {
    this.skillRegistry = skillRegistry;
    this.llm = llm;
  }

  /**
   * Execute a task by running its associated Skill
   *
   * @param task - The task to execute
   * @returns TaskResult with success status, data, or error
   */
  async execute(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    try {
      console.log('[SubAgent] ⚡ 任务执行 - 开始处理子任务');
      console.log('[SubAgent] ⚡ 任务ID: ' + task.id);
      console.log('[SubAgent] ⚡ 技能名称: ' + task.skillName);
      console.log('[SubAgent] ⚡ 任务需求: "' + task.requirement + '"');

      if (!task.skillName) {
        console.log('[SubAgent] ⚡ 错误: 任务没有关联的技能');
        return {
          success: false,
          error: {
            type: 'FATAL',
            message: 'Task does not have an associated skill',
            code: 'MISSING_SKILL',
          },
        };
      }

      console.log('[SubAgent] ⚡ 正在加载技能: ' + task.skillName);
      const skill = await this.skillRegistry.loadFullSkill(task.skillName);
      if (!skill) {
        console.log('[SubAgent] ⚡ 错误: 技能未找到 - ' + task.skillName);
        return {
          success: false,
          error: {
            type: 'FATAL',
            message: 'Skill not found: ' + task.skillName,
            code: 'SKILL_NOT_FOUND',
          },
        };
      }

      console.log('[SubAgent] ⚡ 技能加载成功');
      console.log('[SubAgent] ⚡ - 技能描述: ' + skill.description);
      console.log('[SubAgent] ⚡ - 技能步骤数: ' + (skill.steps?.length || 0));

      console.log('[SubAgent] ⚡ 步骤 1/2: 生成执行参数...');
      console.log('[SubAgent] ⚡ 分析需求: "' + task.requirement + '"');
      console.log('[SubAgent] ⚡ 匹配技能: "' + skill.name + '"');
      const params = await this.generateParams(task.requirement, skill, signal);
      console.log('[SubAgent] ⚡ 参数生成完成: ' + JSON.stringify(params));

      console.log('[SubAgent] ⚡ 步骤 2/2: 执行技能脚本...');
      console.log('[SubAgent] ⚡ 执行方式: ' + (skill.scripts?.length > 0 ? '脚本执行' : 'LLM执行'));
      const result = await this.runSkill(skill, params);

      console.log('[SubAgent] ⚡ 任务执行成功');
      console.log('[SubAgent] ⚡ 结果: ' + JSON.stringify(result).substring(0, 200));
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const taskError = this.classifyError(error);
      console.log('[SubAgent] ⚡ 任务执行失败: ' + taskError.message);
      console.log('[SubAgent] ⚡ 错误类型: ' + taskError.type);
      return {
        success: false,
        error: taskError,
      };
    }
  }

  private async generateParams(
    requirement: string,
    skill: Skill,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const prompt = `分析用户需求，生成技能执行参数。

用户需求: ${requirement}

技能名称: ${skill.name}
技能描述: ${skill.description}

技能完整说明（包括脚本和参考资料使用指引）：
${skill.body}

请仔细阅读技能说明，根据其中的执行步骤和分支逻辑，判断需要执行什么操作。

使用说明中的脚本路径（如果有）。

Response format (JSON only):
{
  "action": "具体操作名称",
  "params": { "key": "value" },
  "reasoning": "为什么选择这些参数"
}`;

    const ParamSchema = z.object({
      action: z.string(),
      params: z.record(z.unknown()),
      reasoning: z.string().optional(),
    });

    const result = await this.llm.generateStructured(prompt, ParamSchema, undefined, signal);
    // Merge action into params for script selection
    return { action: result.action, ...result.params };
  }

  private async runSkill(
    skill: Skill,
    params: Record<string, unknown>
  ): Promise<unknown> {
    // First try script execution if scripts exist
    if (skill.scripts && skill.scripts.length > 0) {
      // Find the most appropriate script
      const scriptPath = this.getScriptPathFromSkillBody(skill.body, params);
      if (scriptPath) {
        return await this.executeScriptFile(skill, scriptPath, params);
      }
    }

    // Fall back to LLM-based execution
    return await this.runLLMExecution(skill, params);
  }

  private getScriptPathFromSkillBody(
    skillBody: string,
    params: Record<string, unknown>
  ): string | null {
    // Parse the body to find script references
    // Look for patterns like: 1. Step Name
    // or: `scripts/filename.js`
    const lines = skillBody.split('\n');
    let currentStep = '';

    for (const line of lines) {
      const stepMatch = line.match(/^\s*(\d+)\.\s*(.+)/);
      if (stepMatch) {
        currentStep = stepMatch[2].toLowerCase();
      }

      const scriptMatch = line.match(/`([^`]+\.(?:js|ts|py|sh))`/);
      if (scriptMatch) {
        // Check if this script is relevant based on params.action or step
        const scriptPath = scriptMatch[1];
        if (this.isScriptRelevant(scriptPath, params, currentStep)) {
          return scriptPath;
        }
      }
    }

    // If no specific script found, return first available script
    return null;
  }

  private isScriptRelevant(
    scriptPath: string,
    params: Record<string, unknown>,
    currentStep: string
  ): boolean {
    const action = (params.action as string)?.toLowerCase() || '';
    const scriptName = path.basename(scriptPath).toLowerCase();

    // Check for action matching script name
    if (action && scriptName.includes(action)) {
      return true;
    }

    // Check for step relevance
    if (currentStep && scriptName.includes(currentStep.replace(/\s+/g, '_'))) {
      return true;
    }

    return false;
  }

  private async executeScriptFile(
    skill: Skill,
    scriptPath: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const scriptsDir = skill.scriptsDir;
    if (!scriptsDir) {
      throw new Error('Skill has no scripts directory');
    }

    const fullPath = path.join(scriptsDir, scriptPath);

    // Verify the script exists
    try {
      await fs.access(fullPath);
    } catch {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    // Determine interpreter based on extension
    const ext = path.extname(scriptPath);
    let command: string;
    let args: string[];

    switch (ext) {
      case '.ts':
        command = 'tsx';
        args = [fullPath];
        break;
      case '.js':
        command = 'node';
        args = [fullPath];
        break;
      case '.py':
        command = 'python3';
        args = [fullPath];
        break;
      case '.sh':
        command = 'bash';
        args = [fullPath];
        break;
      default:
        throw new Error(`Unsupported script extension: ${ext}`);
    }

    // Execute the script
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const result = await execFileAsync(command, args, {
      cwd: scriptsDir,
      env: {
        ...process.env,
        SKILL_NAME: skill.name,
        SKILL_PARAMS: JSON.stringify(params),
        SCRIPT_PATH: scriptPath,
      },
      timeout: CONFIG.SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024, // 1MB buffer
    });

    // Try to parse result as JSON, otherwise return as string
    try {
      return JSON.parse(result.stdout);
    } catch {
      return result.stdout.trim();
    }
  }

  private async runSteps(
    skill: Skill,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const steps: unknown[] = [];

    if (!skill.steps) {
      return { message: 'No steps defined for this skill' };
    }

    for (let i = 0; i < skill.steps.length; i++) {
      const step = skill.steps[i];
      console.log(`[SubAgent] Executing step ${i + 1}: ${step.name}`);

      // Check if step should be executed based on conditions
      if (step.condition) {
        const shouldExecute = await this.evaluateCondition(step.condition, params);
        if (!shouldExecute) {
          console.log(`[SubAgent] Skipping step ${i + 1}: condition not met`);
          continue;
        }
      }

      // Execute the step
      const stepResult = await this.executeStep(step, params);
      steps.push(stepResult);

      // Update params for subsequent steps
      params = { ...params, ...stepResult };
    }

    return { steps, finalParams: params };
  }

  private async executeStep(
    step: { name: string; description?: string; action?: string },
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // Execute step using LLM
    const prompt = `执行步骤: ${step.name}

步骤描述: ${step.description || 'N/A'}
当前参数: ${JSON.stringify(params)}

请执行此步骤并返回结果。`;

    const StepResultSchema = z.object({
      success: z.boolean(),
      result: z.record(z.unknown()),
      message: z.string().optional(),
    });

    const result = await this.llm.generateStructured(prompt, StepResultSchema);

    if (!result.success) {
      throw new Error(`Step execution failed: ${result.message || 'Unknown error'}`);
    }

    return result.result || {};
  }

  private async evaluateCondition(
    condition: string,
    params: Record<string, unknown>
  ): Promise<boolean> {
    const prompt = `评估条件: ${condition}

当前参数: ${JSON.stringify(params)}

条件是否满足? (true/false)`;

    const ConditionSchema = z.object({
      satisfied: z.boolean(),
    });

    const result = await this.llm.generateStructured(prompt, ConditionSchema);
    return result.satisfied;
  }

  private async runLLMExecution(
    skill: Skill,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const prompt = `执行任务: ${skill.name}

任务描述: ${skill.description}

执行参数: ${JSON.stringify(params)}

技能说明: ${skill.body}

请根据技能说明和执行参数，生成合适的响应。`;

    const systemPrompt = `你是一个专业的任务执行助手。请根据提供的技能说明和参数，生成准确的执行结果。

Response format (JSON only):
{
  "success": true,
  "result": { /* 执行结果 */ },
  "message": "可选的执行说明"
}`;

    const ExecutionResultSchema = z.object({
      success: z.boolean(),
      result: z.unknown(),
      message: z.string().optional(),
    });

    const result = await this.llm.generateStructured(
      prompt,
      ExecutionResultSchema,
      systemPrompt
    );

    if (!result.success) {
      throw new Error(result.message || 'LLM execution failed');
    }

    return result.result;
  }

  private classifyError(error: unknown): TaskError {
    if (error instanceof Error) {
      // Check for specific error types
      if (error.message.includes('timeout') || error.message.includes('timed out')) {
        return {
          type: 'RETRYABLE',
          message: 'Task timed out',
          code: 'TIMEOUT',
        };
      }

      if (error.message.includes('not found') || error.message.includes('ENOENT')) {
        return {
          type: 'FATAL',
          message: error.message,
          code: 'FILE_NOT_FOUND',
        };
      }

      if (error.message.includes('permission') || error.message.includes('EACCES')) {
        return {
          type: 'FATAL',
          message: 'Permission denied: ' + error.message,
          code: 'PERMISSION_DENIED',
        };
      }

      // Default to retryable
      return {
        type: 'RETRYABLE',
        message: error.message,
        code: 'EXECUTION_ERROR',
      };
    }

    return {
      type: 'RETRYABLE',
      message: String(error),
      code: 'UNKNOWN_ERROR',
    };
  }
}
