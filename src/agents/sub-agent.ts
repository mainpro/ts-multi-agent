import { SkillRegistry } from '../skill-registry';
import { LLMClient } from '../llm';
import { Task, TaskResult, TaskError, Skill, CONFIG } from '../types';
import { promises as fs } from 'fs';
import * as path from 'path';

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
  async execute(task: Task): Promise<TaskResult> {
    try {
      if (!task.skillName) {
        return {
          success: false,
          error: {
            type: 'FATAL',
            message: 'Task does not have an associated skill',
            code: 'MISSING_SKILL',
          },
        };
      }

      const skill = await this.skillRegistry.loadFullSkill(task.skillName);
      if (!skill) {
        return {
          success: false,
          error: {
            type: 'FATAL',
            message: `Skill not found: ${task.skillName}`,
            code: 'SKILL_NOT_FOUND',
          },
        };
      }

      const result = await this.runSkill(skill, task.params);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const taskError = this.classifyError(error);
      return {
        success: false,
        error: taskError,
      };
    }
  }

  /**
   * Run a Skill based on its definition
   *
   * Execution strategy:
   * 1. If skill has scriptsDir, look for a main script or operation-specific script
   * 2. If no scriptsDir or script execution fails, fall back to LLM-based execution
   * 3. For LLM execution, use skill body as context
   *
   * @param skill - The Skill to execute
   * @param params - Parameters for the skill execution
   * @returns Execution result
   */
  private async runSkill(skill: Skill, params?: Record<string, unknown>): Promise<unknown> {
    if (skill.scriptsDir) {
      try {
        return await this.runScript(skill, params);
      } catch (error) {
        console.warn(`Script execution failed for skill "${skill.name}", falling back to LLM:`, error);
      }
    }

    return await this.runLLMExecution(skill, params);
  }

  /**
   * Execute a script from the skill's scripts directory
   *
   * @param skill - The Skill containing the script
   * @param params - Parameters to pass to the script
   * @returns Script execution result
   */
  private async runScript(
    skill: Skill,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    if (!skill.scriptsDir) {
      throw new Error('Skill does not have a scripts directory');
    }

    const operation = params?.operation as string | undefined;
    let scriptPath: string | null = null;

    if (operation) {
      const operationScript = path.join(skill.scriptsDir, `${operation}.js`);
      try {
        const stat = await fs.stat(operationScript);
        if (stat.isFile()) {
          scriptPath = operationScript;
        }
      } catch {
        // Operation script doesn't exist, continue to fallback
      }
    }

    if (!scriptPath) {
      const candidates = ['index.js', 'main.js', 'run.js'];
      for (const candidate of candidates) {
        const candidatePath = path.join(skill.scriptsDir, candidate);
        try {
          const stat = await fs.stat(candidatePath);
          if (stat.isFile()) {
            scriptPath = candidatePath;
            break;
          }
        } catch {
          // Candidate doesn't exist, try next
        }
      }
    }

    if (!scriptPath) {
      throw new Error(`No executable script found in ${skill.scriptsDir}`);
    }

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const env = {
      ...process.env,
      SKILL_NAME: skill.name,
      SKILL_PARAMS: JSON.stringify(params || {}),
    };

    try {
      const { stdout, stderr } = await execFileAsync('node', [scriptPath], {
        env,
        timeout: CONFIG.TASK_TIMEOUT_MS,
        cwd: skill.scriptsDir,
      });

      if (stderr) {
        console.warn(`Script stderr for skill "${skill.name}":`, stderr);
      }

      const trimmedOutput = stdout.trim();
      if (trimmedOutput) {
        try {
          return JSON.parse(trimmedOutput);
        } catch {
          return trimmedOutput;
        }
      }

      return null;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'TIMEOUT') {
        throw Object.assign(new Error(`Script execution timed out after ${CONFIG.TASK_TIMEOUT_MS}ms`), {
          code: 'TIMEOUT',
        });
      }
      throw error;
    }
  }

  /**
   * Execute a skill using LLM
   *
   * Uses the skill body as context and generates a response based on parameters
   *
   * @param skill - The Skill to execute
   * @param params - Parameters for the skill execution
   * @returns LLM-generated result
   */
  private async runLLMExecution(
    skill: Skill,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    const systemPrompt = `You are executing the "${skill.name}" skill.\n\nSkill Description: ${skill.description}\n\nSkill Documentation:\n${skill.body}`;
    const userPrompt = `Execute this skill with the following parameters:\n${JSON.stringify(params || {}, null, 2)}\n\nProvide your response as valid JSON.`;

    try {
      const response = await this.llm.generateText(userPrompt, systemPrompt);

      try {
        return JSON.parse(response);
      } catch {
        return response;
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`LLM execution failed for skill "${skill.name}": ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Classify an error into TaskError with appropriate ErrorType
   *
   * Classification rules:
   * - TIMEOUT → RETRYABLE (can retry with same parameters)
   * - SKILL_NOT_FOUND → FATAL (skill doesn't exist, need replan)
   * - Script/execution errors → SKILL_ERROR (skill implementation issue)
   * - Other errors → SKILL_ERROR (default)
   *
   * @param error - The error to classify
   * @returns Classified TaskError
   */
  private classifyError(error: unknown): TaskError {
    if (error instanceof Error && error.name === 'LLMError') {
      const llmError = error as Error & { type?: string };

      if (llmError.type === 'TIMEOUT') {
        return {
          type: 'RETRYABLE',
          message: error.message,
          code: 'TIMEOUT',
          stack: error.stack,
        };
      }

      if (llmError.type === 'RATE_LIMIT' || llmError.type === 'NETWORK_ERROR') {
        return {
          type: 'RETRYABLE',
          message: error.message,
          code: llmError.type,
          stack: error.stack,
        };
      }

      if (llmError.type === 'INVALID_KEY') {
        return {
          type: 'FATAL',
          message: error.message,
          code: 'INVALID_KEY',
          stack: error.stack,
        };
      }

      return {
        type: 'SKILL_ERROR',
        message: error.message,
        code: llmError.type || 'LLM_ERROR',
        stack: error.stack,
      };
    }

    if (error instanceof Error && 'code' in error) {
      const code = (error as { code: string }).code;

      if (code === 'TIMEOUT') {
        return {
          type: 'RETRYABLE',
          message: error.message,
          code: 'TIMEOUT',
          stack: error.stack,
        };
      }

      if (code === 'SKILL_NOT_FOUND') {
        return {
          type: 'FATAL',
          message: error.message,
          code: 'SKILL_NOT_FOUND',
          stack: error.stack,
        };
      }

      if (code === 'MISSING_SKILL') {
        return {
          type: 'FATAL',
          message: error.message,
          code: 'MISSING_SKILL',
          stack: error.stack,
        };
      }
    }

    if (error instanceof Error) {
      if (error.message.includes('ENOENT') || error.message.includes('not found')) {
        return {
          type: 'SKILL_ERROR',
          message: `Script not found: ${error.message}`,
          code: 'SCRIPT_NOT_FOUND',
          stack: error.stack,
        };
      }

      if (error.message.includes('EACCES') || error.message.includes('permission')) {
        return {
          type: 'FATAL',
          message: `Permission denied: ${error.message}`,
          code: 'PERMISSION_DENIED',
          stack: error.stack,
        };
      }

      return {
        type: 'SKILL_ERROR',
        message: error.message,
        code: 'EXECUTION_ERROR',
        stack: error.stack,
      };
    }

    return {
      type: 'SKILL_ERROR',
      message: String(error),
      code: 'UNKNOWN_ERROR',
    };
  }
}

export default SubAgent;
