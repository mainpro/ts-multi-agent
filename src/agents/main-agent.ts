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

const SkillDiscoverySchema = z.object({
  selectedSkills: z.array(z.string()),
  reasoning: z.string().optional(),
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
      console.log(`Processing requirement: ${requirement}`);
      
      const analysis = await this.analyzeRequirement(requirement);
      console.log('Requirement analysis completed:', analysis);
      
      const relevantSkills = await this.discoverSkills(analysis);
      console.log('Relevant skills found:', relevantSkills.map(s => s.name));

      if (relevantSkills.length === 0) {
        const allSkills = this.skillRegistry.getAllMetadata();
        const skillsList = allSkills.length > 0 
          ? '\n\n系统当前具备的技能：\n' + allSkills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')
          : '\n\n系统当前没有可用的技能。';
        
        return {
          success: false,
          error: {
            type: 'FATAL',
            message: 'No suitable skills found for this requirement' + skillsList,
            code: 'NO_SKILLS',
          },
        };
      }

      const plan = await this.createPlan(requirement, analysis, relevantSkills);
      console.log('Task plan created:', JSON.stringify(plan, null, 2));
      
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

  async discoverSkills(analysis: RequirementAnalysis): Promise<SkillMetadata[]> {
    const allSkills = this.skillRegistry.getAllMetadata();

    if (allSkills.length === 0) {
      return [];
    }

    const systemPrompt = `You are a skill matching assistant. Given a requirement analysis and available skills, select the most relevant skills.

Important:
- Match both English and Chinese inputs to skills
- Be precise in skill names - use exactly the names from the available skills list
- Select skills based on the actual content of the requirement and the capabilities of each skill

Respond in JSON format:
{
  "selectedSkills": ["skill-name-1", "skill-name-2"],
  "reasoning": "Brief explanation of why these skills were selected"
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

    // If no skills were selected, return all available skills
    if (selectedSkills.length === 0) {
      return allSkills;
    }

    return selectedSkills;
  }

  async createPlan(
    requirement: string,
    analysis: RequirementAnalysis,
    skills: SkillMetadata[]
  ): Promise<TaskPlan> {
    const planId = `plan-${++this.planIdCounter}`;

    const systemPrompt = `You are a task planning assistant. Create a step-by-step plan to fulfill the user's requirement.

Break down the requirement into atomic tasks. Each task should:
- Use exactly one skill
- Have clear dependencies (empty array if no dependencies)
- Include a specific requirement description for the task
- Include appropriate params for the skill based on the skill's capabilities

IMPORTANT - Execution Strategy:
- Analyze whether tasks can be executed in parallel or must be executed serially
- Tasks that are independent (no shared resources, no data dependencies) should have empty dependencies [] and can run in parallel
- Tasks that depend on results from other tasks must include those task IDs in their dependencies array
- For LLM-based skills, consider API rate limits - if tasks use the same LLM skill, consider serial execution to avoid rate limiting
- Example: "Check the weather in New York and London" should create two independent tasks with empty dependencies (can run in parallel)
- Example: "First find the current temperature, then recommend suitable clothing" should create task-2 that depends on task-1 (must run serially)

IMPORTANT:
- Always create tasks based on the actual content of the requirement and the available skills
- Always include the "params" field when required by the skill
- Use appropriate parameters based on the selected skill's capabilities

Respond in JSON format:
{
  "id": "plan-1",
  "requirement": "original requirement",
  "tasks": [
    {
      "id": "task-1",
      "requirement": "What this task should do",
      "skillName": "name-of-skill",
      "params": {
        "param1": "value1",
        "param2": "value2"
      },
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

Generate a task plan with dependencies. Task IDs should be unique within this plan.`;

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
