import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { IntentRouter } from '../src/routers/intent-router';
import { SkillRegistry } from '../src/skill-registry';

describe('IntentRouter 扩展 employeeId', () => {
  let mockLLM: any;
  let router: IntentRouter;

  beforeEach(() => {
    mockLLM = {
      generateStructured: mock(async (prompt: string, schema: any) => {
        // 模拟 LLM 返回,prompt 应包含员工列表
        return {
          intent: 'skill_task',
          confidence: 0.9,
          tasks: [{ requirement: '查询 MDM 状态', skillName: 'ees-qa', intent: 'skill_task' }],
          employeeId: 'it-ops-consultant',
          reasoning: 'IT 问题派给 IT 员工',
        };
      }),
    };
    const registry = new SkillRegistry({ skillsDir: './skills', autoLoad: false });
    router = new IntentRouter(mockLLM, registry);
  });

  it('classify 返回 employeeId 字段', async () => {
    const result = await router.classify(
      '我的 MDM 客户端登不上去了',
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ id: 'legal-assistant', brief: '法务助理' }, { id: 'it-ops-consultant', brief: 'IT 运维顾问' }],
    );
    expect(result.employeeId).toBe('it-ops-consultant');
  });

  it('LLM prompt 中注入可用员工列表', async () => {
    let capturedPrompt = '';
    mockLLM.generateStructured = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return { intent: 'skill_task', tasks: [], employeeId: 'legal-assistant', reasoning: '' };
    });

    await router.classify(
      '查合同',
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ id: 'legal-assistant', brief: '法务助理' }, { id: 'it-ops-consultant', brief: 'IT 运维' }],
    );

    expect(capturedPrompt).toContain('legal-assistant');
    expect(capturedPrompt).toContain('法务助理');
    expect(capturedPrompt).toContain('it-ops-consultant');
    expect(capturedPrompt).toContain('IT 运维');
  });

  it('不传 availableEmployees 时 employeeId 不出现', async () => {
    mockLLM.generateStructured = mock(async () => ({
      intent: 'small_talk',
      tasks: [],
      friendlyResponse: '你好',
      reasoning: '',
    }));

    const result = await router.classify('你好');
    expect(result.employeeId).toBeUndefined();
  });

  it('LLM 返回不存在 employeeId 时不报错(路由层兜底处理)', async () => {
    mockLLM.generateStructured = mock(async () => ({
      intent: 'skill_task',
      tasks: [],
      employeeId: 'unknown-employee',
      reasoning: '',
    }));

    const result = await router.classify(
      '随便问问',
      undefined, [], undefined, undefined, undefined, undefined, undefined,
      [{ id: 'legal-assistant', brief: '法务' }],
    );
    // IntentRouter 不负责兜底,只透传 LLM 返回值
    expect(result.employeeId).toBe('unknown-employee');
  });
});