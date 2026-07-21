/**
 * 配置加载器
 *
 * 支持三层优先级：CLI 参数 > 环境变量 > 默认值
 *
 * 使用方式：
 *   import { config } from './config/config-loader';
 *   config.get('LLM_MODEL');     // 优先 CLI，其次 env，最后默认值
 *   config.get('PORT', 3000);    // 带默认值
 *
 * CLI 参数通过 process.argv 传递，格式：--key=value
 */

import { resolveResource } from '../utils/app-root';

interface ConfigOptions {
  cliArgs?: string[];
  env?: Record<string, string | undefined>;
  defaultValues?: Record<string, unknown>;
}

const DEFAULTS = {
  MAX_CONCURRENT_SUBAGENTS: 5,
  MAX_QUEUE_SIZE: 100,
  MAX_REPLAN_ATTEMPTS: 3,
  TASK_TIMEOUT_MS: 400000,
  TOTAL_TIMEOUT_MS: 600000,
  LLM_TIMEOUT_MS: 120000,
  SCRIPT_TIMEOUT_MS: 180000,
  SKILL_DIRECTORY: resolveResource('skills') + '/',
  LLM_PROVIDER: 'openrouter',
  LLM_MODEL: 'minimax/minimax-m2.5:free',
  LLM_BASE_URL: 'https://openrouter.ai/api/v1',
  LLM_TEMPERATURE: 0.7,
  LLM_MAX_TOKENS: 4096,
  TASK_CLEANUP_INTERVAL_MS: 300000,
  TASK_RETENTION_TIME_MS: 3600000,
  VISION_MODEL: 'glm-4v-flash',
  VISION_TIMEOUT_MS: 60000,
  VISION_MAX_RETRIES: 3,
  LLM_MAX_CONCURRENT_REQUESTS: 20,
  LLM_CONNECTION_POOL_SIZE: 100,
  LLM_CONNECTION_KEEP_ALIVE_MS: 60000,
  INTENT_ROUTER_CONFIG_PATH: resolveResource('config', 'intent-router.json'),
  EMBEDDING_BASE_URL: '',
  EMBEDDING_API_KEY: '',
  EMBEDDING_MODEL: 'BAAI/bge-large-zh-v1.5',
  EMBEDDING_DIMENSION: 1024,
  EMBEDDING_CACHE_SIZE: 1000,
} as const;

type ConfigKey = keyof typeof DEFAULTS;

/** 从 CLI 参数解析值，格式：--KEY=VALUE */
function parseCliValue(key: string, cliArgs: string[]): string | undefined {
  const normalized = key.toUpperCase().replace(/_/g, '-');
  const prefix = `--${normalized}=`;
  const arg = cliArgs.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

/** 从环境变量解析值 */
function parseEnvValue(key: string, env: Record<string, string | undefined>): string | undefined {
  return env[key] ?? env[key.toUpperCase()] ?? undefined;
}

/** 类型守卫：判断值是否为数字 */
function isNumeric(s: string | undefined): boolean {
  return s !== undefined && !isNaN(Number(s));
}

/** 类型守卫：判断值是否为布尔值 */
function isBoolean(s: string | undefined): boolean {
  return s === 'true' || s === 'false';
}

export class ConfigLoader {
  private cliArgs: string[];
  private env: Record<string, string | undefined>;
  private defaults: Record<string, unknown>;

  constructor(options: ConfigOptions = {}) {
    this.cliArgs = options.cliArgs ?? process.argv;
    this.env = options.env ?? process.env;
    this.defaults = { ...DEFAULTS, ...options.defaultValues };
  }

  /**
   * 获取配置值（自动类型转换）
   */
  get<K extends ConfigKey>(key: K): (typeof DEFAULTS)[K];
  get<K extends string>(key: K, defaultValue: unknown): unknown;
  get(key: string, defaultValue?: unknown): unknown {
    const cliValue = parseCliValue(key, this.cliArgs);
    if (cliValue !== undefined) return this.cast(key, cliValue);

    const envValue = parseEnvValue(key, this.env);
    if (envValue !== undefined) return this.cast(key, envValue);

    return defaultValue ?? this.defaults[key];
  }

  /** 检查是否设置了 CLI 参数 */
  hasCliArg(key: string): boolean {
    return parseCliValue(key, this.cliArgs) !== undefined;
  }

  /** 获取所有环境变量前缀匹配的配置（用于测试） */
  getSnapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(this.defaults)) {
      result[key] = this.get(key as ConfigKey);
    }
    return result;
  }

  private cast(key: string, value: string): unknown {
    const defaultVal = this.defaults[key];
    if (typeof defaultVal === 'number') {
      if (isNumeric(value)) return parseInt(value, 10);
    }
    if (typeof defaultVal === 'boolean') {
      if (isBoolean(value)) return value === 'true';
    }
    return value;
  }
}

/** 全局配置实例（默认，支持测试覆写） */
export const config = new ConfigLoader();

/** 向后兼容：静态 CONFIG 对象（已废弃，推荐使用 config.get()） */
export const CONFIG = new Proxy({} as Record<string, unknown>, {
  get(_target, key: string) {
    console.warn(`[ConfigLoader] CONFIG.${key} 已废弃，请使用 config.get('${key}')`);
    return config.get(key as ConfigKey);
  },
});

export default config;