import { SystemSkillExecutor } from './types';
import { ILLMClient } from '../llm';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'ExecutorRegistry' });

type ExecutorConstructor = new (...args: any[]) => SystemSkillExecutor;

export class ExecutorRegistry {
  private executors = new Map<string, ExecutorConstructor>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    try {
      const { ImprovementAgent } = require('../agents/improvement-agent') as { ImprovementAgent: ExecutorConstructor };
      this.register('improvement-agent', ImprovementAgent);
    } catch {
      log.warn('无法加载 ImprovementAgent，跳过注册');
    }
  }

  register(type: string, executorClass: ExecutorConstructor): void {
    this.executors.set(type, executorClass);
    log.info('已注册执行器', { type });
  }

  getExecutor(type: string, llm: ILLMClient): SystemSkillExecutor | null {
    const ExecutorClass = this.executors.get(type);
    if (!ExecutorClass) return null;
    return new ExecutorClass(llm);
  }

  getTypes(): string[] {
    return Array.from(this.executors.keys());
  }
}
