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
  async execute(task: Task): Promise<TaskResult> {
    try {
      console.log(`[SubAgent] 🔧 开始执行任务 [${task.id}] - 技能: ${task.skillName}`);
      console.log(`[SubAgent] 📝 任务需求: "${task.requirement}"`);
      
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

      console.log(`[SubAgent] 📦 加载技能: ${task.skillName}`);
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

      console.log(`[SubAgent] ⚙️  步骤 1/2: 生成执行参数...`);
      const params = await this.generateParams(task.requirement, skill);
      console.log(`[SubAgent] ✅ 参数生成完成: ${JSON.stringify(params)}`);

      console.log(`[SubAgent] ⚙️  步骤 2/2: 执行技能...`);
      const result = await this.runSkill(skill, params);

      console.log(`[SubAgent] ✅ 任务 [${task.id}] 执行成功`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const taskError = this.classifyError(error);
      console.log(`[SubAgent] ❌ 任务 [${task.id}] 执行失败: ${taskError.message}`);
      return {
        success: false,
        error: taskError,
      };
    }
  }

  private async generateParams(
    requirement: string, 
    skill: Skill
  ): Promise<Record<string, unknown>> {
    const prompt = `分析用户需求，生成技能执行参数。

用户需求: ${requirement}

技能名称: ${skill.name}
技能描述: ${skill.description}

技能完整说明（包括脚本和参考资料使用指引）：
${skill.body}

请仔细阅读技能说明，根据其中的执行步骤和分支逻辑，判断需要执行什么操作。
只返回必要的参数（如 operation, operands 等）。

关键原则：
- 如果技能说明提到需要特定脚本/操作，应该生成对应的 operation 参数
- 如果技能说明有分支条件（IF/THEN），根据需求判断走哪个分支
- 不要假设所有 scripts 都必须被列出，只使用技能说明中指引的`;

    try {
      const result = await this.llm.generateStructured(
        prompt,
        z.record(z.unknown()),
        "你是一个参数生成助手。根据技能说明和用户需求，生成正确的执行参数。只返回 JSON 对象。"
      );
      return result;
    } catch (error) {
      console.warn('Failed to generate params:', error);
      return {};
    }
  }

  /**
   * Run a Skill based on its definition
   *
   * Execution strategy:
   * 1. If skill has steps defined in body, execute them in order
   * 2. If skill has scriptsDir, look for a main script or operation-specific script
   * 3. If no scriptsDir or script execution fails, fall back to LLM-based execution
   * 4. For LLM execution, use skill body as context
   *
   * @param skill - The Skill to execute
   * @param params - Parameters for the skill execution
   * @returns Execution result
   */
  private async runSkill(skill: Skill, params?: Record<string, unknown>): Promise<unknown> {
    // First check if skill has steps defined in body
    const steps = this.parseStepsFromSkillBody(skill.body);
    if (steps && steps.length > 0) {
      try {
        return await this.runSteps(skill, steps, params);
      } catch (error) {
        console.warn(`Step execution failed for skill "${skill.name}", falling back to script execution:`, error);
      }
    }

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
   * Parse steps from skill body
   * Looks for numbered steps in skill body
   * 
   * Example patterns in SKILL.md:
   * 1. Step 1: Use A.js
   * 2. Step 2: Use B.js
   * 3. Step 3: Use C.js
   * 
   * @param body - Skill body content
   * @returns Array of steps or null if no steps found
   */
  private parseStepsFromSkillBody(body?: string): Array<{step: number, description: string, scriptPath?: string}> | null {
    if (!body) {
      return null;
    }

    const steps: Array<{step: number, description: string, scriptPath?: string}> = [];
    const stepPattern = /^(\d+)\.\s*(.+)$/gm;
    let match;

    while ((match = stepPattern.exec(body)) !== null) {
      const stepNumber = parseInt(match[1]);
      const stepDescription = match[2].trim();
      
      // Look for script references in the step description
      const scriptMatch = stepDescription.match(/(scripts\/[^\s\")\]+|\w+\.[a-z]+)/i);
      let scriptPath = undefined;
      
      if (scriptMatch) {
        scriptPath = scriptMatch[1];
      }

      steps.push({
        step: stepNumber,
        description: stepDescription,
        scriptPath
      });
    }

    return steps.length > 0 ? steps : null;
  }

  /**
   * Run steps in order
   * Executes steps sequentially, loading scripts only when needed
   * 
   * @param skill - The Skill to execute
   * @param steps - Array of steps to execute
   * @param params - Parameters for the skill execution
   * @returns Execution result
   */
  private async runSteps(skill: Skill, steps: Array<{step: number, description: string, scriptPath?: string}>, params?: Record<string, unknown>): Promise<unknown> {
    const results: Array<unknown> = [];
    let currentParams = {...params};

    for (const step of steps) {
      console.log(`Executing step ${step.step}: ${step.description}`);

      if (step.scriptPath && skill.scriptsDir) {
        // Build full script path
        let scriptPath = step.scriptPath;
        if (!scriptPath.startsWith('scripts/')) {
          scriptPath = `scripts/${scriptPath}`;
        }
        const fullScriptPath = path.join(skill.scriptsDir, scriptPath);

        // Validate script exists
        try {
          const stat = await fs.stat(fullScriptPath);
          if (!stat.isFile()) {
            throw new Error(`Script not found: ${fullScriptPath}`);
          }

          // Execute the script
          const scriptResult = await this.executeScriptFile(fullScriptPath, skill, currentParams);
          results.push({
            step: step.step,
            description: step.description,
            result: scriptResult
          });

          // Pass result to next step
          currentParams = {
            ...currentParams,
            previousResult: scriptResult,
            currentStep: step.step,
            totalSteps: steps.length
          };
        } catch (error) {
          console.warn(`Failed to execute script for step ${step.step}:`, error);
          // Continue with next step even if one step fails
          results.push({
            step: step.step,
            description: step.description,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        // No script specified for this step, use LLM to execute
        const llmResult = await this.runLLMExecution(skill, {
          ...currentParams,
          step: step.step,
          stepDescription: step.description
        });
        results.push({
          step: step.step,
          description: step.description,
          result: llmResult
        });

        // Pass result to next step
        currentParams = {
          ...currentParams,
          previousResult: llmResult,
          currentStep: step.step,
          totalSteps: steps.length
        };
      }
    }

    return {
      steps: results,
      finalResult: results[results.length - 1]
    };
  }

  /**
   * Execute a specific script file
   * 
   * @param scriptPath - Full path to the script file
   * @param skill - The Skill object
   * @param params - Parameters for the script execution
   * @returns Script execution result
   */
  private async executeScriptFile(scriptPath: string, skill: Skill, params?: Record<string, unknown>): Promise<unknown> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const env = {
      ...process.env,
      SKILL_NAME: skill.name,
      SKILL_PARAMS: JSON.stringify(params || {}),
      SCRIPT_PATH: scriptPath
    };

    try {
      let execArgs: [string, string[], { env: NodeJS.ProcessEnv; timeout: number }];
      const ext = path.extname(scriptPath);
      
      switch (ext) {
        case '.ts':
          execArgs = ['tsx', [scriptPath], { env, timeout: CONFIG.TASK_TIMEOUT_MS }];
          break;
        case '.js':
          execArgs = ['node', [scriptPath], { env, timeout: CONFIG.TASK_TIMEOUT_MS }];
          break;
        case '.py':
          execArgs = ['python3', [scriptPath], { env, timeout: CONFIG.TASK_TIMEOUT_MS }];
          break;
        case '.sh':
          execArgs = ['bash', [scriptPath], { env, timeout: CONFIG.TASK_TIMEOUT_MS }];
          break;
        default:
          throw new Error(`Unsupported script extension: ${ext}`);
      }

      const { stdout, stderr } = await execFileAsync(...execArgs);

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
      // First try to get script path from skill body (SKILL.md content)
      scriptPath = await this.getScriptPathFromSkillBody(skill, operation);
      
      // If not found in skill body, try metadata (backward compatibility)
      if (!scriptPath) {
        scriptPath = this.getScriptPathFromMetadata(skill, operation);
      }
      
      // If still not found, try automatic discovery
      if (!scriptPath) {
        scriptPath = await this.findScriptByOperation(skill.scriptsDir, operation);
      }
    }

    if (!scriptPath) {
      // Try default scripts
      scriptPath = await this.findDefaultScript(skill.scriptsDir);
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
      let execArgs: [string, string[], { env: NodeJS.ProcessEnv; timeout: number }];
      const ext = path.extname(scriptPath);
      
      switch (ext) {
        
        case '.ts':
          execArgs = ['tsx', [scriptPath], { env, timeout: CONFIG.TASK_TIMEOUT_MS }];
          break;
case '.js':
          execArgs = ['node', [scriptPath], { env, timeout: CONFIG.TASK_TIMEOUT_MS }];
          break;
        case '.py':
          execArgs = ['python3', [scriptPath], { env, timeout: CONFIG.TASK_TIMEOUT_MS }];
          break;
        case '.sh':
          execArgs = ['bash', [scriptPath], { env, timeout: CONFIG.TASK_TIMEOUT_MS }];
          break;
        default:
          throw new Error(`Unsupported script extension: ${ext}`);
      }

      const { stdout, stderr } = await execFileAsync(...execArgs);

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
   * Get script path from skill definition
   * Looks for script references in skill body (SKILL.md content)
   * 
   * Example patterns in SKILL.md:
   * - "See [scripts/add.js](scripts/add.js) for the addition implementation"
   * - "Addition: scripts/add.js"
   * - "Operation add uses scripts/add.js"
   * 
   * @param skill - The Skill object
   * @param operation - The operation name
   * @returns Script path or null if not found
   */
  private async getScriptPathFromSkillBody(skill: Skill, operation: string): Promise<string | null> {
    if (!skill.body) {
      return null;
    }

    // Look for script references in the skill body
    const operationLower = operation.toLowerCase();
    
    // Patterns to match script references
    const patterns = [
      // "scripts/add.js" or "scripts/add.py"
      new RegExp(`scripts/[^\\s\")\]*${operationLower}[^\\s\")\]*\\.[a-z]+`, 'gi'),
      // "add.js" or "add.py" in scripts context
      new RegExp(`${operationLower}\\.[a-z]+`, 'gi')
    ];

    for (const pattern of patterns) {
      const matches = skill.body.match(pattern);
      if (matches) {
        for (const match of matches) {
          // Check if the match is a valid script path
          let scriptRelativePath = match;
          
          // If it's just a filename without directory, assume scripts/ directory
          if (!scriptRelativePath.startsWith('scripts/')) {
            scriptRelativePath = `scripts/${scriptRelativePath}`;
          }
          
          // Validate the path exists
          const scriptPath = path.join(skill.scriptsDir!, scriptRelativePath);
          
          try {
            const stat = await fs.stat(scriptPath);
            if (stat.isFile()) {
              return scriptPath;
            }
          } catch {
            // Path doesn't exist, continue to next match
          }
        }
      }
    }

    return null;
  }

  /**
   * Get script path from skill metadata (backward compatibility)
   * Looks for scripts configuration in skill metadata
   * 
   * Example metadata structure:
   * {
   *   "scripts": {
   *     "add": "add.js",
   *     "multiply": "multiply.py"
   *   }
   * }
   * 
   * @param skill - The Skill object
   * @param operation - The operation name
   * @returns Script path or null if not found
   */
  private getScriptPathFromMetadata(skill: Skill, operation: string): string | null {
    if (!skill.metadata || typeof skill.metadata !== 'object') {
      return null;
    }

    const metadata = skill.metadata as Record<string, unknown>;
    const scriptsConfig = metadata.scripts as Record<string, string> | undefined;

    if (!scriptsConfig || typeof scriptsConfig !== 'object') {
      return null;
    }

    const scriptRelativePath = scriptsConfig[operation];
    if (!scriptRelativePath || typeof scriptRelativePath !== 'string') {
      return null;
    }

    const scriptPath = path.join(skill.scriptsDir!, scriptRelativePath);
    return scriptPath;
  }

  /**
   * Find script by operation name
   * Tries different extensions for the operation
   * 
   * @param scriptsDir - Scripts directory path
   * @param operation - Operation name
   * @returns Script path or null if not found
   */
  private async findScriptByOperation(scriptsDir: string, operation: string): Promise<string | null> {
    const extensions = ['.js', '.py', '.sh'];
    
    for (const ext of extensions) {
      const scriptPath = path.join(scriptsDir, `${operation}${ext}`);
      try {
        const stat = await fs.stat(scriptPath);
        if (stat.isFile()) {
          return scriptPath;
        }
      } catch {
        // Script doesn't exist with this extension, continue
      }
    }
    
    return null;
  }

  /**
   * Find default script in scripts directory
   * Tries common default script names with different extensions
   * 
   * @param scriptsDir - Scripts directory path
   * @returns Script path or null if not found
   */
  private async findDefaultScript(scriptsDir: string): Promise<string | null> {
    const defaultScripts = ['index', 'main', 'run'];
    const extensions = ['.js', '.py', '.sh'];
    
    for (const script of defaultScripts) {
      for (const ext of extensions) {
        const scriptPath = path.join(scriptsDir, `${script}${ext}`);
        try {
          const stat = await fs.stat(scriptPath);
          if (stat.isFile()) {
            return scriptPath;
          }
        } catch {
          // Script doesn't exist, continue
        }
      }
    }
    
    return null;
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
    // 构建增强的系统提示，让 LLM 自主决定如何使用资源
    let systemPrompt = `You are executing the "${skill.name}" skill.

Skill Description: ${skill.description}

Skill Documentation:
${skill.body}`;

    // 如果有 references 目录，提供可用列表
    // 但是否读取由 LLM 根据 SKILL.md 自主决定
    if (skill.referencesDir) {
      try {
        const refs = await this.listReferences(skill);
        if (refs.length > 0) {
          systemPrompt += `

Available References:
If you need to read documentation for implementation details, the following files are available:
${refs.map(f => `- ${f}`).join('\n')}

Note: Whether to read references depends on the skill documentation above. 
If the documentation says "See references/X.md for details", you should load it if needed.`;
        }
      } catch {
        // ignore errors in listing references
      }
    }

    const userPrompt = `Execute this skill with the following parameters:
${JSON.stringify(params || {}, null, 2)}

请根据技能文档中的执行步骤执行。如果文档中提到需要读取参考资料（references），请自主决定是否需要加载。`;

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

  /**
   * Load a reference file on-demand
   * 
   * 提供读取 references 目录中文件的能力
   * 是否读取由 SKILL.md + LLM 决定，代码只负责读取
   * 
   * @param skill - The Skill containing references
   * @param filename - Reference filename (e.g., "README.md", "advanced.md")
   * @returns Reference content or null if not found
   */
  async loadReference(skill: Skill, filename: string): Promise<string | null> {
    if (!skill.referencesDir) {
      console.log(`[SubAgent] 📖 尝试加载 references，但 skill "${skill.name}" 没有 references 目录`);
      return null;
    }

    const fullPath = path.join(skill.referencesDir, filename);
    
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      console.log(`[SubAgent] 📖 已加载 reference: ${filename} (${content.length} chars)`);
      return content;
    } catch (error) {
      console.warn(`[SubAgent] 📖 无法加载 reference "${filename}":`, error);
      return null;
    }
  }

  /**
   * List available references in a skill
   * 
   * @param skill - The Skill
   * @returns Array of reference file names
   */
  async listReferences(skill: Skill): Promise<string[]> {
    if (!skill.referencesDir) {
      return [];
    }

    try {
      const files = await fs.readdir(skill.referencesDir);
      const mdFiles = files.filter(f => 
        f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json')
      );
      console.log(`[SubAgent] 📚 Skill "${skill.name}" 可用的 references: ${mdFiles.join(', ')}`);
      return mdFiles;
    } catch {
      return [];
    }
  }
}

export default SubAgent;
