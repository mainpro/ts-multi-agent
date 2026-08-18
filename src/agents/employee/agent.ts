import { createLogger } from '../../observability/logger';
import { SubAgent } from '../sub-agent';
import type {
  EmployeeConfig,
  PersonaConfig,
  ExecutionConfig,
  ResultRewriter,
} from './json-types';
import type { ILLMClient } from '../../llm';
import type { MemoryService } from '../../memory/memory-service';
import type { SessionStore } from '../../memory/session-store';
import type { SkillRegistry } from '../../skill-registry';
import type { Task, TaskResult } from '../../types';
import { SkillError } from '../../errors';
import { computeAllowedTools as computeAllowedToolsSet } from './tools';

const log = createLogger({ module: 'EmployeeAgent' });

export interface EmployeeAgentDeps {
  llm: ILLMClient;
  memoryService: MemoryService;
  sessionStore: SessionStore;
  skillRegistry: SkillRegistry;
}

export interface SubTaskContext {
  sessionId: string;
  userId: string;
  traceId: string;
}

/**
 * 数字员工 = EmployeeConfig + SubAgent 实例的封装。
 *
 * 职责:
 *   - 暴露 persona/tools/skills/planning/rewriter/execution 的只读访问
 *   - 委托内部 SubAgent 执行 task
 *   - skill 白名单校验 + 工具 3 段过滤
 *
 * 不负责:
 *   - 意图识别(MainAgent 的 IntentRouter 负责)
 *   - 任务规划(UnifiedPlanner 负责)
 *   - 任务图调度(TaskGraphExecutor 负责)
 *   - 结果汇总(ResultAggregator 负责)
 */
export class EmployeeAgent {
  constructor(
    public readonly config: EmployeeConfig,
    private deps: EmployeeAgentDeps,
  ) {}

  get id(): string {
    return this.config.employee.id;
  }

  get displayName(): string {
    return this.config.employee.displayName;
  }

  get isEnabled(): boolean {
    return this.config.employee.enabled !== false; // default true
  }

  get persona(): PersonaConfig | undefined {
    return this.config.persona;
  }

  /** persona.prefix,${displayName} 模板变量已替换 */
  get personaPrefix(): string | undefined {
    if (!this.config.persona?.prefix) return undefined;
    return this.config.persona.prefix.replace(/\$\{displayName\}/g, this.displayName);
  }

  get decompositionHint(): string | undefined {
    return this.config.planning?.decompositionHint;
  }

  get maxParallelTasks(): number | undefined {
    return this.config.planning?.maxParallelTasks;
  }

  get execution(): ExecutionConfig | undefined {
    return this.config.capabilities.execution;
  }

  get resultRewriter(): ResultRewriter | undefined {
    return this.config.outputBehavior?.resultRewriter;
  }

  isSkillAllowed(skillName: string): boolean {
    const wl = this.config.capabilities.skillWhitelist;
    if (!wl) return true; // 无白名单 = 全部允许
    if (wl.type === 'unrestricted') return true;
    return wl.skills.includes(skillName);
  }

  /**
   * 工具 3 段过滤:skill.allowedTools ∩ employee.tools.enabled − employee.tools.denied
   * 如果 employee.tools 未配置,返回 skill.allowedTools 原样。
   *
   * 返回 string[](本类对外 API),底层复用 src/agents/employee/tools.ts 的 Set 实现。
   */
  computeAllowedTools(skillAllowedTools: string[]): string[] {
    return Array.from(computeAllowedToolsSet(skillAllowedTools, this.config.capabilities.tools));
  }

  /**
   * 委托内部 SubAgent 执行 sub-task。
   * 每次调用构造新的 SubAgent 实例(task 上下文独立,沿用 P3 race fix 模式)。
   *
   * @throws SkillError(SKILL_NOT_ALLOWED) 如果 task.skillName 不在员工白名单
   */
  async executeSubTask(task: Task, context: SubTaskContext): Promise<TaskResult> {
    // 保留 context 参数供上层传 traceId/sessionId(目前 SubAgent 直接从 task 字段读取)
    void context;
    if (task.skillName && !this.isSkillAllowed(task.skillName)) {
      throw new SkillError(
        'SKILL_NOT_ALLOWED',
        `skill "${task.skillName}" 不在员工 "${this.id}" 的白名单中`,
      );
    }

    // 加载 skill 的 allowedTools(从 registry),3 段过滤后写入 task.allowedTools
    const skill = task.skillName ? this.deps.skillRegistry.getSkillMetadata(task.skillName) : undefined;
    const skillAllowedTools = skill?.allowedTools ?? [];
    task.allowedTools = this.computeAllowedTools(skillAllowedTools);

    // 每次构造新 SubAgent(task 上下文独立)
    const subAgent = new SubAgent(
      this.deps.skillRegistry,
      this.deps.llm,
      this.deps.memoryService,
    );

    log.info('executeSubTask', {
      employeeId: this.id,
      taskId: task.id,
      skillName: task.skillName,
      allowedTools: task.allowedTools,
    });

    return subAgent.execute(task);
  }
}
