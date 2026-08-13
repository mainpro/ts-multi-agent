import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadEmployeeConfig } from '../src/agents/employee/loader';
import { BootstrapError } from '../src/errors/bootstrap-error';

let tmpDir: string;
const VALID_LEGAL = {
  employee: { id: 'legal-assistant', displayName: '法务助理·小法', enabled: true },
  persona: { prefix: '你是「${displayName}」', style: '严谨', boundaries: '诉讼请转人工' },
  capabilities: {
    skillWhitelist: { type: 'allowlist', skills: ['fawu'] },
    tools: { enabled: ['knowledge_search'], denied: ['send_email'] },
    llm: { provider: 'haier', fallbackProvider: 'siliconflow', temperature: 0.3, maxTokens: 2000 },
  },
  planning: { maxParallelTasks: 5, decompositionHint: '法务任务通常拆为:条款查询 → 风险评估' },
  outputBehavior: { resultRewriter: { match: { status: 'completed' }, transform: 'append', value: '\n\n---' } },
};

const VALID_IT = {
  employee: { id: 'it-ops-consultant', displayName: 'IT 运维顾问·小海', enabled: true },
  capabilities: { llm: { provider: 'siliconflow' } },
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emp-loader-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadEmployeeConfig', () => {
  test('显式 --employee=legal-assistant → 加载对应 JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'legal-assistant.json'), JSON.stringify(VALID_LEGAL));
    const cfg = await loadEmployeeConfig({ explicitId: 'legal-assistant', directory: tmpDir });
    expect(cfg.employee.id).toBe('legal-assistant');
    expect(cfg.capabilities.llm.provider).toBe('haier');
  });

  test('无 explicitId + 目录只有 1 个 enabled JSON → 兜底加载', async () => {
    await fs.writeFile(path.join(tmpDir, 'legal-assistant.json'), JSON.stringify(VALID_LEGAL));
    const cfg = await loadEmployeeConfig({ directory: tmpDir });
    expect(cfg.employee.id).toBe('legal-assistant');
  });

  test('无 explicitId + 目录多个 enabled JSON → 加载按文件名排序的第一个', async () => {
    await fs.writeFile(path.join(tmpDir, 'a-first.json'), JSON.stringify({ ...VALID_LEGAL, employee: { ...VALID_LEGAL.employee, id: 'a-first' } }));
    await fs.writeFile(path.join(tmpDir, 'b-second.json'), JSON.stringify(VALID_IT));
    const cfg = await loadEmployeeConfig({ directory: tmpDir });
    expect(cfg.employee.id).toBe('a-first');
  });

  test('enabled=false 的 JSON 被跳过', async () => {
    const disabled = { ...VALID_LEGAL, employee: { ...VALID_LEGAL.employee, enabled: false } };
    await fs.writeFile(path.join(tmpDir, 'disabled.json'), JSON.stringify(disabled));
    await fs.writeFile(path.join(tmpDir, 'enabled.json'), JSON.stringify(VALID_IT));
    const cfg = await loadEmployeeConfig({ directory: tmpDir });
    expect(cfg.employee.id).toBe('it-ops-consultant');
  });

  test('explicitId 不存在 → BootstrapError(EMPLOYEE_NOT_FOUND)', async () => {
    await fs.writeFile(path.join(tmpDir, 'legal-assistant.json'), JSON.stringify(VALID_LEGAL));
    await expect(
      loadEmployeeConfig({ explicitId: 'non-existent', directory: tmpDir })
    ).rejects.toThrow(BootstrapError);
  });

  test('目录空 / 无 enabled JSON → BootstrapError(NO_EMPLOYEE_CONFIG)', async () => {
    await expect(
      loadEmployeeConfig({ directory: tmpDir })
    ).rejects.toThrow(BootstrapError);
  });

  test('JSON 解析失败 → BootstrapError(EMPLOYEE_CONFIG_INVALID)', async () => {
    await fs.writeFile(path.join(tmpDir, 'broken.json'), '{ not valid json');
    await expect(
      loadEmployeeConfig({ directory: tmpDir })
    ).rejects.toThrow(BootstrapError);
  });

  test('JSON zod 校验失败 → BootstrapError(EMPLOYEE_CONFIG_INVALID)', async () => {
    const bad = { employee: { id: 'x', displayName: 'X' } /* 缺 capabilities.llm */ };
    await fs.writeFile(path.join(tmpDir, 'bad.json'), JSON.stringify(bad));
    await expect(
      loadEmployeeConfig({ directory: tmpDir })
    ).rejects.toThrow(BootstrapError);
  });
});
