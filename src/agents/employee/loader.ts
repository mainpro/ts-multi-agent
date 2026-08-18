// src/agents/employee/loader.ts
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseEmployeeConfig, type EmployeeConfig } from './json-types';
import { BootstrapError } from '../../errors/bootstrap-error';
import { resolveResource } from '../../utils/app-root';
import { createLogger } from '../../observability/logger';

const log = createLogger({ module: 'EmployeeLoader' });

export interface LoadEmployeeOptions {
  /** 显式指定的员工 id(来自 --employee=<id>) */
  explicitId?: string;
  /** 员工 JSON 目录(默认 resolveResource('employees')) */
  directory?: string;
}

/**
 * 加载 1 份数字员工配置。
 *
 * 行为:
 *   - explicitId 存在 → 读 `<directory>/<explicitId>.json`
 *   - explicitId 缺失 → 读 directory 中第一个 enabled 的 JSON(按文件名排序)
 *
 * 错误(抛 BootstrapError):
 *   - EMPLOYEE_NOT_FOUND     explicitId 给定但文件不存在
 *   - NO_EMPLOYEE_CONFIG     目录空 / 全 disabled / 目录不存在
 *   - EMPLOYEE_CONFIG_INVALID JSON 解析失败 / zod 校验失败
 *
 * @deprecated 自 2026-08-17 multi-employee 改造起,请改用 `loadAllEnabledEmployees`。
 * 本函数仅保留供测试 fixture 使用。
 */
export async function loadEmployeeConfig(
  opts: LoadEmployeeOptions = {},
): Promise<EmployeeConfig> {
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

  // 2. 收集所有 enabled 的 JSON 文件路径
  const jsonFiles = entries.filter((f) => f.endsWith('.json')).sort();

  // 3. 显式 id 路径
  if (opts.explicitId) {
    const target = `${opts.explicitId}.json`;
    const filePath = path.join(directory, target);
    if (!jsonFiles.includes(target)) {
      throw new BootstrapError(
        'EMPLOYEE_NOT_FOUND',
        `员工 '${opts.explicitId}' 不存在(目录: ${directory})`,
      );
    }
    return readAndParse(filePath, target);
  }

  // 4. 兜底:遍历找第一个 enabled 的
  for (const file of jsonFiles) {
    const filePath = path.join(directory, file);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.employee?.enabled === false) continue;
      const config = parseEmployeeConfig(raw);
      log.info('已选员工(兜底)', { file, id: config.employee.id });
      return config;
    } catch (err) {
      // 单个文件坏不让 boot 失败 — 让其他文件有机会被选。
      // 显式 id 路径才 fail-fast(上面已经返回了),兜底路径只 warn。
      log.warn('员工 JSON 解析失败(兜底路径,跳过)', { file, error: (err as Error).message });
    }
  }

  throw new BootstrapError(
    'NO_EMPLOYEE_CONFIG',
    `目录中没有可用员工配置: ${directory}`,
  );
}

async function readAndParse(filePath: string, file: string): Promise<EmployeeConfig> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return parseEmployeeConfig(raw);
  } catch (err) {
    throw new BootstrapError(
      'EMPLOYEE_CONFIG_INVALID',
      `员工 JSON 校验失败 [${file}]: ${(err as Error).message}`,
      { cause: err },
    );
  }
}
