// src/agents/virtual-employee/loader.ts

import { promises as fs } from 'fs';
import * as path from 'path';
import { parseJsonEmployeeConfig, type JsonEmployeeConfig } from './json-types';
import { VirtualEmployeeRegistry } from './registry';
import { createLogger } from '../../observability/logger';

const log = createLogger({ module: 'VirtualEmployeeLoader' });

/**
 * 虚拟员工配置源抽象。
 *
 * 不同数据源(文件系统 / 远程 API / 数据库)实现这个接口,
 * core 加载流程(load → validate → register)就可以复用。
 *
 * 未来切换数据源时只需:
 *   const provider = new RemoteEmployeeConfigProvider('https://api.example.com/employees');
 *   await loadAndRegister(provider);
 */
export interface EmployeeConfigProvider {
  /** 加载所有员工配置(已 enabled 的) */
  loadAll(): Promise<JsonEmployeeConfig[]>;
}

/**
 * 文件系统实现:从目录读 *.json 文件。
 *
 * 假设:每个 .json 文件 = 一个虚拟员工(文件内容是 JsonEmployeeConfig)。
 * 命名不影响逻辑(id 字段才是唯一标识)。
 */
export class FileEmployeeConfigProvider implements EmployeeConfigProvider {
  constructor(private readonly directory: string) {}

  async loadAll(): Promise<JsonEmployeeConfig[]> {
    const entries = await fs.readdir(this.directory).catch((err) => {
      log.warn('读员工目录失败', { directory: this.directory, error: (err as Error).message });
      return [];
    });
    const jsonFiles = entries.filter((f) => f.endsWith('.json'));

    const configs: JsonEmployeeConfig[] = [];
    for (const file of jsonFiles) {
      const fullPath = path.join(this.directory, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const config = parseJsonEmployeeConfig(content);
        if (config.enabled === false) {
          log.info('跳过 disabled 员工', { file, id: config.id });
          continue;
        }
        configs.push(config);
      } catch (err) {
        // fail-fast:单个 JSON 坏就启动失败,避免坏 config 进生产
        log.error('虚拟员工 JSON 校验失败', { file, error: (err as Error).message });
        throw new Error(
          `虚拟员工 JSON 校验失败 [${file}]: ${(err as Error).message}`,
        );
      }
    }
    return configs;
  }
}

/**
 * 远程 API 实现(stub):未来可实现,当前只占接口位置。
 *
 * 未来实现要点:
 *  - GET {baseUrl}/employees → 返回 JsonEmployeeConfig[]
 *  - 支持可选缓存 / 轮询 / 鉴权
 *  - 网络失败时根据策略决定 fail-fast / 用上一份缓存
 */
export class RemoteEmployeeConfigProvider implements EmployeeConfigProvider {
  constructor(private readonly baseUrl: string, private readonly authToken?: string) {}

  async loadAll(): Promise<JsonEmployeeConfig[]> {
    // 字段保留供未来实现使用(stub)。
    void this.baseUrl;
    void this.authToken;
    throw new Error('RemoteEmployeeConfigProvider 尚未实现(预留未来扩展)');
  }
}

/**
 * 统一入口:从 provider 加载 → 校验 → 注册到 Registry。
 *
 * 任何实现 EmployeeConfigProvider 的数据源都能用这条流程。
 * 重复注册同一 id 抛错(由 registry 保证)。
 */
export async function loadAndRegister(provider: EmployeeConfigProvider): Promise<void> {
  const configs = await provider.loadAll();
  for (const json of configs) {
    VirtualEmployeeRegistry.registerFromJson(json);
  }
  log.info('虚拟员工加载完成', { count: configs.length });
}

