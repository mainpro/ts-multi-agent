import { SystemSkillExecutor } from './types';
import { LLMClient } from '../llm';

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
      console.warn('[ExecutorRegistry] ⚠️ 无法加载 ImprovementAgent，跳过注册');
    }
  }

  register(type: string, executorClass: ExecutorConstructor): void {
    this.executors.set(type, executorClass);
    console.log(`[ExecutorRegistry] 已注册执行器: ${type}`);
  }

  getExecutor(type: string, llm: LLMClient): SystemSkillExecutor | null {
    const ExecutorClass = this.executors.get(type);
    if (!ExecutorClass) return null;
    return new ExecutorClass(llm);
  }

  getTypes(): string[] {
    return Array.from(this.executors.keys());
  }
}
