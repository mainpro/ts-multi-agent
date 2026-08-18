import { describe, expect, test, beforeEach } from 'bun:test';
import { UnifiedPlanner } from '../src/planners/unified-planner';
import { SkillRegistry } from '../src/skill-registry';
import { EmployeeAgent } from '../src/agents/employee/agent';
import type { EmployeeAgentDeps } from '../src/agents/employee/agent';
import type { ILLMClient } from '../src/llm/interfaces';
import type { SkillMetadata } from '../src/types';

const mockSkill: SkillMetadata = {
  name: 'mock-skill',
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

function buildEmployee(opts: { decompositionHint?: string } = {}): EmployeeAgent {
  return new EmployeeAgent({
    employee: { id: 'mock-employee', displayName: 'Mock', enabled: true },
    capabilities: { llm: { provider: 'haier' } },
    planning: opts.decompositionHint ? { decompositionHint: opts.decompositionHint } : undefined,
  }, mockDeps);
}

describe('UnifiedPlanner.plan — hint 参数', () => {
  let capturedPrompt: string | undefined;

  const mockLlm: ILLMClient = {
    generateStructured: async (prompt: string) => {
      capturedPrompt = prompt;
      return {
        success: true,
        analysis: { intent: 'test' },
        skillSelection: ['mock-skill'],
        plan: {
          needsClarification: false,
          tasks: [
            { id: 't1', requirement: 'test', skillName: 'mock-skill' },
          ],
        },
      };
    },
    generateText: async () => '',
    generateWithTools: async () => ({ content: '', toolCalls: [], messages: [] }),
  } as unknown as ILLMClient;

  beforeEach(() => {
    capturedPrompt = undefined;
  });

  test('hint 不传 → prompt 不包含 hint 段落', async () => {
    const planner = new UnifiedPlanner(mockLlm, mockRegistry);
    await planner.plan('帮我审合同', buildEmployee());
    expect(capturedPrompt ?? '').not.toContain('【拆解偏好】');
  });

  test('hint 传入 → prompt 包含 hint 段落', async () => {
    const planner = new UnifiedPlanner(mockLlm, mockRegistry);
    await planner.plan('帮我审合同', buildEmployee({ decompositionHint: '法务任务通常拆为:条款查询 → 风险评估' }));
    expect(capturedPrompt).toContain('【拆解偏好】');
    expect(capturedPrompt).toContain('条款查询 → 风险评估');
  });
});