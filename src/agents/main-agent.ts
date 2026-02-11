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
    const analysis = await this.analyzeRequirement(requirement);
    const relevantSkills = await this.discoverSkills(analysis);

    if (relevantSkills.length === 0) {
      return {
        success: false,
        error: {
          type: 'FATAL',
          message: 'No suitable skills found for this requirement',
          code: 'NO_SKILLS',
        },
      };
    }

    const plan = await this.createPlan(requirement, analysis, relevantSkills);
    return await this.monitorAndReplan(plan);
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

Respond in JSON format:
{
  "selectedSkills": ["skill-name-1", "skill-name-2"],
  "reasoning": "Brief explanation of why these skills were selected"
}`;

    const prompt = `Requirement Analysis:
- Summary: ${analysis.summary}
- Intent: ${analysis.intent || 'Unknown'}
- Entities: ${analysis.entities?.join(', ') || 'None'}
- Suggested Skills: ${analysis.suggestedSkills?.join(', ') || 'None'}

Available Skills:
${allSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}

Which skills are most relevant for this requirement? Return only the skill names.`;

    const result = await this.llm.generateStructured(
      prompt,
      SkillDiscoverySchema,
      systemPrompt
    );

    return allSkills.filter((skill) => result.selectedSkills.includes(skill.name));
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

Respond in JSON format:
{
  "id": "plan-1",
  "requirement": "original requirement",
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

Generate a task plan with dependencies. Task IDs should be unique within this plan.`;

    const plan = await this.llm.generateStructured(prompt, TaskPlanSchema, systemPrompt);

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
      const task: Task = {
        id: taskDef.id,
        requirement: taskDef.requirement,
        status: 'pending' as TaskStatus,
        skillName: taskDef.skillName,
        dependencies: taskDef.dependencies,
        dependents: [],
        createdAt: new Date(),
        retryCount: 0,
      };

      for (const otherTask of plan.tasks) {
        if (otherTask.dependencies.includes(taskDef.id)) {
          task.dependents.push(otherTask.id);
        }
      }

      this.taskQueue.addTask(task);
    }
  }

  private async waitForCompletion(planId: string): Promise<TaskResult> {
    const startTime = Date.now();
    const maxWaitTime = CONFIG.TOTAL_TIMEOUT_MS;

    while (Date.now() - startTime < maxWaitTime) {
      const allTasks = this.taskQueue.getAllTasks();

      const allCompleted = allTasks.every(
        (t) => t.status === 'completed' || t.status === 'failed'
      );

      if (allCompleted) {
        const failedTasks = allTasks.filter((t) => t.status === 'failed');

        if (failedTasks.length === 0) {
          const results = allTasks
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

      await this.sleep(100);
    }

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
      .map((t) => this.taskQueue.getTask(t.id))
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
        this.taskQueue.cancelTask(taskDef.id);
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
