import { describe, it, expect } from 'bun:test';
import { UnifiedPlanner } from '../src/planners/unified-planner';
import { EmployeeAgent } from '../src/agents/employee/agent';
import type { EmployeeAgentDeps } from '../src/agents/employee/agent';
import type { ILLMClient } from '../src/llm/interfaces';
import type { SkillRegistry } from '../src/skill-registry';
import type { SkillMetadata } from '../src/types';

const mockSkill: SkillMetadata = {
  name: 'ees-qa',
  description: 'mock skill for testing',
};

const mockRegistry = {
  getAllMetadata: () => [mockSkill],
} as unknown as SkillRegistry;

const mockDeps: EmployeeAgentDeps = {
  llm: {} as any,
  memoryService: {} as any,
  sessionStore: {} as any,
  skillRegistry: mockRegistry,
};

describe('UnifiedPlanner 接收 EmployeeAgent', () => {
  it('plan() 使用 employee.decompositionHint 并在生成的 system prompt 中体现', async () => {
    const employee = new EmployeeAgent({
      employee: { id: 'legal', displayName: '法务', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
      planning: { decompositionHint: '先审查条款再起草' },
    }, mockDeps);

    let capturedPrompt: string | undefined;
    const mockLLM: ILLMClient = {
      generateStructured: async (prompt: string) => {
        capturedPrompt = prompt;
        // 验证 prompt 中包含 decompositionHint
        if (!prompt.includes('先审查条款再起草')) {
          throw new Error('decompositionHint 未注入到 plan prompt');
        }
        return {
          analysis: { intent: 'test' },
          skillSelection: ['ees-qa'],
          plan: { needsClarification: false, tasks: [] },
        } as any;
      },
      generateText: async () => '',
      generateWithTools: async () => ({ content: '', toolCalls: [], messages: [] }),
    } as unknown as ILLMClient;

    const planner = new UnifiedPlanner(mockLLM, mockRegistry);
    await planner.plan('起草合同', employee);
    expect(capturedPrompt).toContain('先审查条款再起草');
  });

  it('生成的每个 task 携带 employeeId', async () => {
    const employee = new EmployeeAgent({
      employee: { id: 'legal-assistant', displayName: '法务', enabled: true },
      capabilities: { llm: { provider: 'haier' } },
    }, mockDeps);

    const mockLLM: ILLMClient = {
      generateStructured: async () => ({
        analysis: { intent: 'test' },
        skillSelection: ['ees-qa'],
        plan: {
          needsClarification: false,
          tasks: [{ requirement: '查 EES', skillName: 'ees-qa' }],
        },
      }),
      generateText: async () => '',
      generateWithTools: async () => ({ content: '', toolCalls: [], messages: [] }),
    } as unknown as ILLMClient;

    const planner = new UnifiedPlanner(mockLLM, mockRegistry);
    const plan = await planner.plan('查能耗', employee);
    expect(plan.plan!.tasks[0].employeeId).toBe('legal-assistant');
  });
});
