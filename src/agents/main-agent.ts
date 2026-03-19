import { z } from 'zod';
import { LLMClient } from '../llm';
import { SkillRegistry } from '../skill-registry';
import { TaskQueue } from '../task-queue';
import {
  Task,
  TaskResult,
  TaskError,
  TaskStatus,
  RequirementAnalysis,
  TaskPlan,
  CONFIG,
  RequirementAnalysisSchema,
  TaskPlanSchema,
  SkillMetadata,
} from '../types';

/** Skill discovery result with metadata */
interface SkillDiscoveryResult {
  skills: SkillMetadata[];
  needsClarification: boolean;
  clarificationOptions?: string[];
  confidence?: number;
}

const SkillDiscoverySchema = z.object({
  selectedSkills: z.array(z.string()),
  reasoning: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  needsClarification: z.boolean().optional(),
  clarificationOptions: z.array(z.string()).optional(),
});

export class MainAgent {
  private maxReplanAttempts: number;
  private planIdCounter = 0;

  constructor(
    private llm: LLMClient,
    private skillRegistry: SkillRegistry,
    private taskQueue: TaskQueue,
    maxReplanAttempts: number = CONFIG.MAX_REPLAN_ATTEMPTS
  ) {
    this.maxReplanAttempts = maxReplanAttempts;
  }

  async processRequirement(requirement: string): Promise<TaskResult> {
    try {
      console.log(`[MainAgent] 📥 收到用户请求: "${requirement}"`);
      
      console.log(`[MainAgent] 🔍 步骤 1/4: 分析用户需求...`);
      const analysis = await this.analyzeRequirement(requirement);
      console.log(`[MainAgent] ✅ 需求分析完成 - 意图: ${analysis.intent}, 实体: ${analysis.entities?.join(', ') || '无'}`);
      
      console.log(`[MainAgent] 🔍 步骤 2/4: 匹配技能...`);
      const discoveryResult = await this.discoverSkills(analysis);
      console.log(`[MainAgent] ✅ 技能匹配完成 - 找到 ${discoveryResult.skills.length} 个相关技能: ${discoveryResult.skills.map(s => s.name).join(', ')}`);
      
      const relevantSkills = discoveryResult.skills;
      console.log('Relevant skills found:', relevantSkills.map(s => s.name));

      // Handle needsClarification from skill discovery
      if (discoveryResult.needsClarification) {
        const allSkills = this.skillRegistry.getAllMetadata();
        const skillsList = allSkills.length > 0 
          ? allSkills.map((skill: SkillMetadata) => `• ${skill.name}: ${skill.description}`).join('\n')
          : '暂无功能'; // 不询问更多信息，只展示可用功能
        
        const message = `抱歉，无法处理该请求。\n\n当前系统支持：\n${skillsList}`;
        
        return {
          success: true,
          data: {
            message,
            availableSkills: allSkills.map((s: SkillMetadata) => ({ name: s.name, description: s.description })),
          },
        };
      }

      if (relevantSkills.length === 0) {
        const allSkills = this.skillRegistry.getAllMetadata();
        const skillsList = allSkills.length > 0 
          ? allSkills.map((skill: SkillMetadata) => `• ${skill.name}: ${skill.description}`).join('\n')
          : '暂无功能';
        
        const message = `抱歉，无法处理该请求。\n\n当前系统支持：\n${skillsList}`;
        
        return {
          success: true,
          data: {
            message,
            availableSkills: allSkills.map((s: SkillMetadata) => ({ name: s.name, description: s.description })),
          },
        };
      }

      console.log(`[MainAgent] 🔍 步骤 3/4: 创建任务计划...`);
      const plan = await this.createPlan(requirement, analysis, relevantSkills);
      console.log(`[MainAgent] ✅ 任务计划创建完成 - 共 ${plan.tasks.length} 个任务`);
      plan.tasks.forEach((task, idx) => {
        console.log(`[MainAgent]   任务 ${idx + 1}: [${task.skillName}] ${task.requirement}`);
      });
      
      if (plan.needsClarification) {
        return {
          success: false,
          error: {
            type: 'USER_ERROR',
            message: plan.clarificationPrompt || '请提供更明确的需求',
            code: 'NEEDS_CLARIFICATION',
          },
        };
      }
      
      console.log(`[MainAgent] 🔍 步骤 4/4: 执行任务 (监控中...)`);
      return await this.monitorAndReplan(plan);
    } catch (error) {
      console.error('Error processing requirement:', error);
      return {
        success: false,
        error: {
          type: 'FATAL',
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'PROCESSING_ERROR',
        },
      };
    }
  }

  async analyzeRequirement(requirement: string): Promise<RequirementAnalysis> {
    const systemPrompt = `You are a requirement analysis assistant. Analyze the user's requirement and extract key information.

Respond in JSON format with the following structure:
{
  "summary": "Brief summary of what needs to be done",
  "entities": ["entity1", "entity2"],
  "intent": "Primary intent (e.g., calculate, search, process)",
  "suggestedSkills": ["skill-category-1", "skill-category-2"]
}`;

    const prompt = `Analyze this requirement: "${requirement}"

What needs to be done? Identify key entities and the primary intent.`;

    return await this.llm.generateStructured(
      prompt,
      RequirementAnalysisSchema,
      systemPrompt
    );
  }

  async discoverSkills(analysis: RequirementAnalysis): Promise<SkillDiscoveryResult> {
    const allSkills = this.skillRegistry.getAllMetadata();

    if (allSkills.length === 0) {
      return { skills: [], needsClarification: false };
    }

    const systemPrompt = `You are a skill matching assistant. Given a requirement analysis and available skills, select the most relevant skills.

Important:
- 你必须用中文回复
- Match both English and Chinese inputs to skills
- Be precise in skill names - use exactly the names from the available skills list
- Select skills based on the actual content of the requirement and the capabilities of each skill
- Rate your confidence (0-1) that the selected skills are correct
- If the requirement is ambiguous or no skills match well, set needsClarification to true and provide clarificationOptions in Chinese

Respond in JSON format:
{
  "selectedSkills": ["skill-name-1"],
  "reasoning": "Brief explanation",
  "confidence": 0.8,
  "needsClarification": false,
  "clarificationOptions": ["option1", "option2"]
}`;

    const entities = Array.isArray(analysis.entities) ? analysis.entities.join(', ') : (analysis.entities || 'None');
    const suggestedSkills = Array.isArray(analysis.suggestedSkills) ? analysis.suggestedSkills.join(', ') : (analysis.suggestedSkills || 'None');

    const prompt = `Requirement Analysis:
- Summary: ${analysis.summary}
- Intent: ${analysis.intent || 'Unknown'}
- Entities: ${entities}
- Suggested Skills: ${suggestedSkills}

Available Skills:
${allSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}

Which skills are most relevant for this requirement? Return only the skill names.`;

    const result = await this.llm.generateStructured(
      prompt,
      SkillDiscoverySchema,
      systemPrompt
    );

    const selectedSkills = allSkills.filter((skill) => result.selectedSkills.includes(skill.name));

    // Fast-fail: If no skills selected or low confidence, return empty with metadata
    const needsClarification = result.needsClarification || 
      selectedSkills.length === 0 || 
      (result.confidence !== undefined && result.confidence < 0.5);
    
    return {
      skills: selectedSkills,
      needsClarification,
      clarificationOptions: result.clarificationOptions,
      confidence: result.confidence,
    };
  }

  async createPlan(
    requirement: string,
    analysis: RequirementAnalysis,
    skills: SkillMetadata[]
  ): Promise<TaskPlan> {
    const planId = `plan-${++this.planIdCounter}`;

    const systemPrompt = `You are a task planning assistant. Create a step-by-step plan to fulfill the user's requirement.

IMPORTANT - Your role:
- Analyze the user's requirement
- Break down into atomic tasks
- Assign appropriate skills to each task
- Determine dependencies between tasks

DO NOT generate "params" - params will be generated by SubAgent based on the skill's content.

Task structure:
{
  "id": "task-1",
  "requirement": "What this task should do (in user's language)",
  "skillName": "name-of-skill",
  "dependencies": []
}

IMPORTANT - Execution Strategy:
- Analyze whether tasks can be executed in parallel or must be executed serially
- Tasks that are independent should have empty dependencies [] and can run in parallel
- Tasks that depend on results from other tasks must include those task IDs in their dependencies array

IMPORTANT - Requirement Clarity:
- If the requirement is VAGUE or UNCLEAR, set "needsClarification" to true and provide "clarificationPrompt"
- If no skills match the requirement, set "needsClarification" to true and list available skills

Response format:
{
  "id": "plan-1",
  "requirement": "original requirement",
  "needsClarification": false,
  "clarificationPrompt": "optional friendly message to user",
  "tasks": [
    {
      "id": "task-1",
      "requirement": "What this task should do",
      "skillName": "name-of-skill",
      "dependencies": []
    }
  ]
}`;

    const prompt = `Create a plan for this requirement: "${requirement}"

Analysis:
- Summary: ${analysis.summary}
- Intent: ${analysis.intent || 'Unknown'}

Available Skills:
${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}

Guidelines:
- If requirement is unclear, set needsClarification: true
- If no skill matches, set needsClarification: true and explain available skills
- Otherwise, create tasks with requirement + skillName only (no params needed)`;

    const plan = await this.llm.generateStructured(prompt, TaskPlanSchema, systemPrompt);

    // Validate each task has a skillName
    for (const task of plan.tasks) {
      if (!task.skillName) {
        // If no skillName, try to assign the most relevant skill
        const relevantSkill = skills[0];
        if (relevantSkill) {
          task.skillName = relevantSkill.name;
        } else {
          // If no relevant skills, throw error
          throw new Error('Generated task has no skillName and no relevant skills available');
        }
      }
    }

    plan.id = planId;
    plan.requirement = requirement;

    return plan;
  }

  async monitorAndReplan(plan: TaskPlan): Promise<TaskResult> {
    let replanAttempts = 0;
    let currentPlan = plan;

    while (replanAttempts <= this.maxReplanAttempts) {
      this.submitPlanTasks(currentPlan);
      const result = await this.waitForCompletion(currentPlan.id);

      if (result.success) {
        return result;
      }

      const failedTasks = this.getFailedTasks(currentPlan);

      if (failedTasks.length === 0) {
        return result;
      }

      const errors = failedTasks.map((t) => t.error!).filter(Boolean);
      const allRetryable = errors.every((e) => e.type === 'RETRYABLE');

      if (!allRetryable) {
        const fatalError = errors.find((e) => e.type !== 'RETRYABLE');
        return {
          success: false,
          error: fatalError || errors[0],
        };
      }

      if (replanAttempts >= this.maxReplanAttempts) {
        return {
          success: false,
          error: {
            type: 'FATAL',
            message: `Max replan attempts (${this.maxReplanAttempts}) exceeded`,
            code: 'MAX_REPLAN_EXCEEDED',
          },
        };
      }

      replanAttempts++;
      currentPlan = await this.replan(currentPlan, errors);
    }

    return {
      success: false,
      error: {
        type: 'FATAL',
        message: 'Unexpected end of replan loop',
        code: 'UNEXPECTED',
      },
    };
  }

  private submitPlanTasks(plan: TaskPlan): void {
    console.log(`[MainAgent] 📤 向任务队列提交 ${plan.tasks.length} 个任务`);
    for (const taskDef of plan.tasks) {
      // Generate unique task ID by combining plan ID and task ID
      const uniqueTaskId = `${plan.id}-${taskDef.id}`;
      
      // Update dependencies to use unique task IDs
      const updatedDependencies = taskDef.dependencies.map(depId => `${plan.id}-${depId}`);
      
      const task: Task = {
        id: uniqueTaskId,
        requirement: taskDef.requirement,
        status: 'pending' as TaskStatus,
        skillName: taskDef.skillName,
        params: (taskDef as any).params,
        dependencies: updatedDependencies,
        dependents: [],
        createdAt: new Date(),
        retryCount: 0,
      };

      this.taskQueue.addTask(task);
    }
  }

  private async waitForCompletion(planId: string): Promise<TaskResult> {
    const startTime = Date.now();
    const maxWaitTime = CONFIG.TOTAL_TIMEOUT_MS;

    while (Date.now() - startTime < maxWaitTime) {
      const allTasks = this.taskQueue.getAllTasks();

      // Only check tasks with skillName (exclude tracking tasks)
      const tasksWithSkill = allTasks.filter((t) => t.skillName);

      // If no tasks with skillName, return success
      if (tasksWithSkill.length === 0) {
        return {
          success: true,
          data: {
            planId,
            results: [],
          },
        };
      }

      // Check if all tasks with skillName are completed
      const allCompleted = tasksWithSkill.every(
        (t) => t.status === 'completed' || t.status === 'failed'
      );

      if (allCompleted) {
        const failedTasks = tasksWithSkill.filter((t) => t.status === 'failed');

        if (failedTasks.length === 0) {
          const results = tasksWithSkill
            .filter((t) => t.status === 'completed')
            .map((t) => ({
              taskId: t.id,
              skillName: t.skillName,
              result: t.result,
            }));

          console.log(`[MainAgent] ✅ 所有任务执行完成 (${results.length}/${tasksWithSkill.length})`);
          return {
            success: true,
            data: {
              planId,
              results,
            },
          };
        }

        return {
          success: false,
          error: failedTasks[0].error,
        };
      }

      // Sleep for a short time before checking again
      await this.sleep(100);
    }

    // If we've timed out, return an error
    return {
      success: false,
      error: {
        type: 'RETRYABLE',
        message: `Workflow timeout after ${maxWaitTime}ms`,
        code: 'TIMEOUT',
      },
    };
  }

  private getFailedTasks(plan: TaskPlan): Task[] {
    return plan.tasks
      .map((t) => this.taskQueue.getTask(`${plan.id}-${t.id}`))
      .filter((t): t is Task => t !== undefined && t.status === 'failed');
  }

  private async replan(failedPlan: TaskPlan, errors: TaskError[]): Promise<TaskPlan> {
    const systemPrompt = `You are a replanning assistant. The previous plan failed. Create a revised plan.

Consider:
- Alternative approaches to achieve the goal
- Different skill combinations
- Simplified subtasks

Respond in the same JSON format as before.`;

    const errorSummary = errors
      .map((e) => `- ${e.type}: ${e.message}${e.code ? ` (${e.code})` : ''}`)
      .join('\n');

    const prompt = `The previous plan failed with these errors:
${errorSummary}

Original requirement: "${failedPlan.requirement}"

Previous plan had ${failedPlan.tasks.length} tasks. Create a revised plan that might succeed.`;

    try {
      const newPlan = await this.llm.generateStructured(prompt, TaskPlanSchema, systemPrompt);
      newPlan.id = `${failedPlan.id}-retry`;
      newPlan.requirement = failedPlan.requirement;

      for (const taskDef of failedPlan.tasks) {
        this.taskQueue.cancelTask(`${failedPlan.id}-${taskDef.id}`);
      }

      return newPlan;
    } catch {
      return failedPlan;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default MainAgent;
