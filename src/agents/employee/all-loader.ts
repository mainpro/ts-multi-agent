// src/agents/employee/all-loader.ts
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseEmployeeConfig } from './json-types';
import { EmployeeAgent, type EmployeeAgentDeps } from './agent';
import { EmployeeRegistry } from './registry';
import { BootstrapError } from '../../errors';
import { resolveResource } from '../../utils/app-root';
import { createLogger } from '../../observability/logger';

const log = createLogger({ module: 'EmployeeAllLoader' });

export interface LoadAllOptions {
  /** 员工 JSON 目录(默认 resolveResource('employees')) */
  directory?: string;
  /** EmployeeAgent 构造依赖(LLM/MemoryService/SessionStore/SkillRegistry) */
  deps: EmployeeAgentDeps;
}

/**
 * 加载指定目录中所有 enabled 的员工 JSON,构造 EmployeeRegistry。
 *
 * 行为:
 *   - 遍历 <directory>/*.json(按文件名排序)
 *   - 每个文件 zod 校验通过 + employee.enabled !== false → register
 *   - 校验失败只 warn,不抛错(继续遍历其他)
 *   - 目录不存在或无 enabled 员工 → BootstrapError(NO_EMPLOYEE_CONFIG)
 *
 * 错误(抛 BootstrapError):
 *   - NO_EMPLOYEE_CONFIG    目录不存在 / 目录空 / 全 disabled
 *   - FALLBACK_EMPLOYEE_MISSING 加载完成但无 fallback-service-desk(defaultFallback 触发)
 *   - FALLBACK_EMPLOYEE_DISABLED 兜底员工 enabled=false(defaultFallback 触发)
 *   - DUPLICATE_EMPLOYEE    重复 id(register 触发,fail-fast)
 */
export async function loadAllEnabledEmployees(
  opts: LoadAllOptions,
): Promise<EmployeeRegistry> {
  const directory = opts.directory ?? resolveResource('employees');

  // 1. 读目录
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new BootstrapError(
        'NO_EMPLOYEE_CONFIG',
        `员工配置目录不存在: ${directory}`,
        { cause: err },
      );
    }
    throw new BootstrapError(
      'NO_EMPLOYEE_CONFIG',
      `读员工配置目录失败: ${directory}`,
      { cause: err },
    );
  }

  // 2. 遍历 *.json
  const jsonFiles = entries.filter((f) => f.endsWith('.json')).sort();
  if (jsonFiles.length === 0) {
    throw new BootstrapError(
      'NO_EMPLOYEE_CONFIG',
      `员工配置目录中没有 .json 文件: ${directory}`,
    );
  }

  const registry = new EmployeeRegistry();
  let loadedCount = 0;

  for (const file of jsonFiles) {
    const filePath = path.join(directory, file);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const config = parseEmployeeConfig(raw);
      // skip disabled
      if (config.employee.enabled === false) {
        log.info('员工 enabled=false,跳过', { file, id: config.employee.id });
        continue;
      }
      const agent = new EmployeeAgent(config, opts.deps);
      registry.register(agent);
      loadedCount++;
    } catch (err) {
      if (err instanceof BootstrapError && err.code === 'DUPLICATE_EMPLOYEE') {
        throw err; // 重复注册是配置错误,fail-fast
      }
      log.warn('员工 JSON 加载失败,跳过', { file, error: (err as Error).message });
    }
  }

  if (loadedCount === 0) {
    throw new BootstrapError(
      'NO_EMPLOYEE_CONFIG',
      `目录中没有可用员工配置: ${directory}`,
    );
  }

  // 3. 校验兜底员工(缺失或 disabled → BootstrapError)
  registry.defaultFallback();

  log.info('加载完成', {
    totalLoaded: loadedCount,
    employees: registry.list().map((a) => a.id),
  });

  return registry;
}