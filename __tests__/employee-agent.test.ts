import { describe, it, expect } from 'bun:test';
import { EmployeeAgent } from '../src/agents/employee/agent';
import type { EmployeeConfig } from '../src/agents/employee/json-types';
import type { EmployeeAgentDeps } from '../src/agents/employee/agent';

const baseConfig: EmployeeConfig = {
  employee: { id: 'test-employee', displayName: '测试员工', enabled: true },
  capabilities: { llm: { provider: 'haier' } },
};

const mockDeps: EmployeeAgentDeps = {
  llm: {} as any,
  memoryService: {} as any,
  sessionStore: {} as any,
  skillRegistry: {} as any,
};

describe('EmployeeAgent', () => {
  describe('基础字段', () => {
    it('暴露 id / displayName / isEnabled', () => {
      const agent = new EmployeeAgent(baseConfig, mockDeps);
      expect(agent.id).toBe('test-employee');
      expect(agent.displayName).toBe('测试员工');
      expect(agent.isEnabled).toBe(true);
    });

    it('enabled=false 时 isEnabled 为 false', () => {
      const agent = new EmployeeAgent({ ...baseConfig, employee: { ...baseConfig.employee, enabled: false } }, mockDeps);
      expect(agent.isEnabled).toBe(false);
    });
  });

  describe('persona 透传', () => {
    it('无 persona 时 persona / personaPrefix 都 undefined', () => {
      const agent = new EmployeeAgent(baseConfig, mockDeps);
      expect(agent.persona).toBeUndefined();
      expect(agent.personaPrefix).toBeUndefined();
    });

    it('persona.prefix 替换 ${displayName} 模板变量', () => {
      const config: EmployeeConfig = {
        ...baseConfig,
        persona: { prefix: '我是 ${displayName},擅长法务' },
      };
      const agent = new EmployeeAgent(config, mockDeps);
      expect(agent.personaPrefix).toBe('我是 测试员工,擅长法务');
    });

    it('persona.style / boundaries 拼到 prefix', () => {
      // 注意:目前只在 prefix,style/boundaries 是 IntentRouter 内部拼装
      // EmployeeAgent 仅暴露 persona 整个对象,不预拼
      const config: EmployeeConfig = {
        ...baseConfig,
        persona: { prefix: '我是 ${displayName}', style: '严谨', boundaries: '不答非法律问题' },
      };
      const agent = new EmployeeAgent(config, mockDeps);
      expect(agent.persona?.style).toBe('严谨');
      expect(agent.persona?.boundaries).toBe('不答非法律问题');
    });
  });

  describe('planning 透传', () => {
    it('planning 字段透传', () => {
      const config: EmployeeConfig = {
        ...baseConfig,
        planning: { maxParallelTasks: 8, decompositionHint: '先分析再执行' },
      };
      const agent = new EmployeeAgent(config, mockDeps);
      expect(agent.decompositionHint).toBe('先分析再执行');
      expect(agent.maxParallelTasks).toBe(8);
    });
  });

  describe('execution 透传', () => {
    it('execution 字段透传(部分失败重试配置)', () => {
      const config: EmployeeConfig = {
        ...baseConfig,
        capabilities: {
          ...baseConfig.capabilities,
          execution: { maxRetries: 3, transferOnPartialFailure: true },
        },
      };
      const agent = new EmployeeAgent(config, mockDeps);
      expect(agent.execution?.maxRetries).toBe(3);
      expect(agent.execution?.transferOnPartialFailure).toBe(true);
    });
  });

  describe('resultRewriter 透传', () => {
    it('outputBehavior.resultRewriter 透传', () => {
      const config: EmployeeConfig = {
        ...baseConfig,
        outputBehavior: {
          resultRewriter: { transform: 'append', value: '\n\n如需转人工请回复"人工"' },
        },
      };
      const agent = new EmployeeAgent(config, mockDeps);
      expect(agent.resultRewriter?.transform).toBe('append');
      expect(agent.resultRewriter?.value).toBe('\n\n如需转人工请回复"人工"');
    });
  });

  describe('isSkillAllowed', () => {
    it('无 skillWhitelist 时所有 skill 允许', () => {
      const agent = new EmployeeAgent(baseConfig, mockDeps);
      expect(agent.isSkillAllowed('ees-qa')).toBe(true);
      expect(agent.isSkillAllowed('geam-qa')).toBe(true);
    });

    it('allowlist 模式:只允许白名单内', () => {
      const config: EmployeeConfig = {
        ...baseConfig,
        capabilities: {
          ...baseConfig.capabilities,
          skillWhitelist: { type: 'allowlist', skills: ['ees-qa', 'geam-qa'] },
        },
      };
      const agent = new EmployeeAgent(config, mockDeps);
      expect(agent.isSkillAllowed('ees-qa')).toBe(true);
      expect(agent.isSkillAllowed('geam-qa')).toBe(true);
      expect(agent.isSkillAllowed('fawu')).toBe(false);
    });

    it('unrestricted 模式:所有 skill 允许', () => {
      const config: EmployeeConfig = {
        ...baseConfig,
        capabilities: {
          ...baseConfig.capabilities,
          skillWhitelist: { type: 'unrestricted' },
        },
      };
      const agent = new EmployeeAgent(config, mockDeps);
      expect(agent.isSkillAllowed('any-skill')).toBe(true);
    });
  });

  describe('computeAllowedTools', () => {
    it('3 段过滤:skill.allowedTools ∩ employee.tools.enabled − employee.tools.denied', () => {
      const config: EmployeeConfig = {
        ...baseConfig,
        capabilities: {
          ...baseConfig.capabilities,
          tools: { enabled: ['read', 'bash', 'grep'], denied: ['bash'] },
        },
      };
      const agent = new EmployeeAgent(config, mockDeps);
      // skill.allowedTools = ['read', 'bash', 'write']
      // ∩ enabled = ['read', 'bash']
      // − denied = ['read']
      expect(agent.computeAllowedTools(['read', 'bash', 'write'])).toEqual(['read']);
    });
  });
});
