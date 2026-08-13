import { describe, expect, test } from 'bun:test';
import {
  parseEmployeeConfig,
  EmployeeConfigSchema,
} from '../src/agents/employee/json-types';

describe('EmployeeConfigSchema', () => {
  const validConfig = {
    employee: {
      id: 'legal-assistant',
      displayName: '法务助理·小法',
      enabled: true,
    },
    persona: {
      prefix: '你是「${displayName}」',
      style: '严谨',
      boundaries: '诉讼请转人工',
    },
    capabilities: {
      skillWhitelist: { type: 'allowlist', skills: ['fawu'] },
      tools: {
        enabled: ['knowledge_search', 'contract_lookup'],
        denied: ['send_email'],
      },
      llm: {
        provider: 'haier',
        fallbackProvider: 'siliconflow',
        temperature: 0.3,
        maxTokens: 2000,
      },
    },
    planning: {
      maxParallelTasks: 5,
      decompositionHint: '法务任务通常拆为:条款查询 → 风险评估',
    },
    outputBehavior: {
      resultRewriter: {
        match: { status: 'completed' },
        transform: 'append',
        value: '\n\n---如有进一步法律问题',
      },
    },
  };

  test('合法完整配置通过校验', () => {
    expect(() => parseEmployeeConfig(JSON.stringify(validConfig))).not.toThrow();
  });

  test('最小配置(只有 employee + capabilities.llm)通过校验', () => {
    const minimal = {
      employee: { id: 'foo', displayName: 'Foo' },
      capabilities: { llm: { provider: 'haier' } },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(minimal))).not.toThrow();
  });

  test('employee.id 缺失 → 校验失败', () => {
    const bad = { ...validConfig, employee: { displayName: 'X' } };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('capabilities.llm.provider 不在枚举内 → 校验失败', () => {
    const bad = {
      ...validConfig,
      capabilities: { ...validConfig.capabilities, llm: { provider: 'openai' } },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('capabilities.tools 既无 enabled 也无 denied → 校验失败', () => {
    const bad = {
      ...validConfig,
      capabilities: { ...validConfig.capabilities, tools: {} },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('resultRewriter.transform=append 但 value 为空 → 校验失败', () => {
    const bad = {
      ...validConfig,
      outputBehavior: {
        resultRewriter: {
          match: { status: 'completed' },
          transform: 'append',
          value: '',
        },
      },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('skillWhitelist unrestricted 通过校验', () => {
    const ok = {
      ...validConfig,
      capabilities: { ...validConfig.capabilities, skillWhitelist: { type: 'unrestricted' } },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(ok))).not.toThrow();
  });

  test('LLM temperature 超出 0-2 范围 → 校验失败', () => {
    const bad = {
      ...validConfig,
      capabilities: {
        ...validConfig.capabilities,
        llm: { ...validConfig.capabilities.llm, temperature: 5 },
      },
    };
    expect(() => parseEmployeeConfig(JSON.stringify(bad))).toThrow();
  });

  test('Schema 导出供运行时校验', () => {
    expect(EmployeeConfigSchema).toBeDefined();
    const result = EmployeeConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });
});