import { ProfessionalSkillRegistry } from '../skill-registry/professional-skill-registry';
import { LLMClient } from '../llm';
import { Task, CriticAnalysis, TaskError } from '../types';
import { createLogger } from '../observability/logger';

/**
 * CriticAgent - 智能体执行审查器
 * 
 * 核心功能：
 * - 审查智能体执行情况
 * - 识别幻觉和错误
 * - 分析错误根因
 * - 生成优化建议
 * - 生成审查报告
 */
export class CriticAgent {
  private professionalSkillRegistry: ProfessionalSkillRegistry;
  private llm: LLMClient;
  private logger;

  constructor(llm: LLMClient) {
    this.llm = llm;
    this.professionalSkillRegistry = new ProfessionalSkillRegistry();
    this.logger = createLogger({ module: 'CriticAgent' });
  }

  /**
   * 初始化Critic智能体
   * 加载专业技能
   */
  async initialize(): Promise<void> {
    this.logger.info('初始化Critic智能体');
    const skills = await this.professionalSkillRegistry.scanProfessionalSkills();
    this.logger.info(`加载了 ${skills.length} 个专业技能:`, skills);
  }

  /**
   * 审查单个任务
   * @param task 待审查的任务
   * @returns 审查分析结果
   */
  async reviewTask(task: Task): Promise<CriticAnalysis> {
    this.logger.info(`开始审查任务: ${task.id}`, { skillName: task.skillName });

    const analysis: CriticAnalysis = {
      taskId: task.id,
      agentType: task.skillName ? 'sub' : 'main',
      analysisTime: new Date(),
      issues: [],
      solutions: [],
      confidence: 0
    };

    // 1. 检查任务状态
    if (task.status === 'failed' && task.error) {
      await this.analyzeTaskError(task, analysis);
    }

    // 2. 检查任务结果（如果有）
    if (task.status === 'completed' && task.result) {
      await this.analyzeTaskResult(task, analysis);
    }

    // 3. 分析执行路径
    if (task.executionPath) {
      this.analyzeExecutionPath(task, analysis);
    }

    // 4. 生成优化建议
    this.generateSolutions(task, analysis);

    // 5. 计算置信度
    analysis.confidence = this.calculateConfidence(analysis);

    this.logger.info(`任务审查完成: ${task.id}`, {
      issues: analysis.issues.length,
      solutions: analysis.solutions.length,
      confidence: analysis.confidence
    });

    return analysis;
  }

  /**
   * 分析任务错误
   * @param task 任务
   * @param analysis 分析结果
   */
  private async analyzeTaskError(task: Task, analysis: CriticAnalysis): Promise<void> {
    this.logger.debug(`分析任务错误: ${task.error?.message}`);

    // 使用错误分析专业技能
    if (this.professionalSkillRegistry.hasProfessionalSkill('error-analyzer')) {
      const skill = await this.professionalSkillRegistry.loadFullProfessionalSkill('error-analyzer');
      if (skill) {
        // 构建分析输入
        const input = {
          taskId: task.id,
          error: task.error,
          skillName: task.skillName,
          executionPath: task.executionPath
        };

        // 执行错误分析
        try {
          const result = await this.executeProfessionalSkill(skill, input);
          if (result) {
            // 转换为标准格式
            if (result.impact && result.impact.severity) {
              analysis.issues.push({
                type: 'error',
                severity: this.mapSeverity(result.impact.severity),
                description: result.rootCause || task.error?.message || 'Unknown error',
                evidence: JSON.stringify(task.error)
              });

              // 添加建议
              if (result.recommendedActions) {
                analysis.solutions.push({
                  description: `解决 ${result.errorType || 'error'} 错误`,
                  priority: this.mapPriority(result.impact.severity),
                  implementationSteps: result.recommendedActions
                });
              }
            }
          }
        } catch (error) {
          this.logger.error('错误分析失败', error);
        }
      }
    } else {
      // 简单错误分析
      analysis.issues.push({
        type: 'error',
        severity: 'medium',
        description: task.error?.message || 'Unknown error',
        evidence: JSON.stringify(task.error)
      });
    }
  }

  /**
   * 分析任务结果
   * @param task 任务
   * @param analysis 分析结果
   */
  private async analyzeTaskResult(task: Task, analysis: CriticAnalysis): Promise<void> {
    this.logger.debug('分析任务结果');

    // 使用幻觉检测专业技能
    if (this.professionalSkillRegistry.hasProfessionalSkill('hallucination-detector')) {
      const skill = await this.professionalSkillRegistry.loadFullProfessionalSkill('hallucination-detector');
      if (skill) {
        // 构建分析输入
        const input = {
          taskId: task.id,
          result: task.result,
          skillName: task.skillName
        };

        // 执行幻觉检测
        try {
          const result = await this.executeProfessionalSkill(skill, input);
          if (result && result.hasHallucination) {
            // 添加幻觉问题
            if (result.issues) {
              for (const issue of result.issues) {
                analysis.issues.push({
                  type: 'hallucination',
                  severity: this.mapSeverity(issue.severity),
                  description: issue.description,
                  evidence: issue.evidence
                });
              }
            }

            // 添加建议
            if (result.suggestions) {
              analysis.solutions.push({
                description: '解决幻觉问题',
                priority: 'medium',
                implementationSteps: result.suggestions
              });
            }
          }
        } catch (error) {
          this.logger.error('幻觉检测失败', error);
        }
      }
    }
  }

  /**
   * 分析执行路径
   * @param task 任务
   * @param analysis 分析结果
   */
  private analyzeExecutionPath(task: Task, analysis: CriticAnalysis): void {
    if (!task.executionPath || task.executionPath.length === 0) return;

    this.logger.debug('分析执行路径');

    // 分析执行路径中的失败步骤
    const failedSteps = task.executionPath.filter(step => step.result === 'failure');
    if (failedSteps.length > 0) {
      analysis.issues.push({
        type: 'inefficiency',
        severity: 'low',
        description: `执行过程中有 ${failedSteps.length} 个失败步骤`,
        evidence: JSON.stringify(failedSteps.map(step => step.step))
      });

      analysis.solutions.push({
        description: '优化执行路径',
        priority: 'low',
        implementationSteps: [
          '分析失败步骤的原因',
          '优化执行顺序',
          '添加错误处理逻辑',
          '实现步骤重试机制'
        ]
      });
    }

    // 分析执行路径长度
    if (task.executionPath.length > 10) {
      analysis.issues.push({
        type: 'inefficiency',
        severity: 'low',
        description: '执行路径过长，可能存在冗余步骤',
        evidence: `执行步骤数: ${task.executionPath.length}`
      });

      analysis.solutions.push({
        description: '简化执行路径',
        priority: 'low',
        implementationSteps: [
          '识别并移除冗余步骤',
          '合并相关步骤',
          '优化工具调用顺序',
          '减少不必要的中间步骤'
        ]
      });
    }
  }

  /**
   * 生成优化建议
   * @param task 任务
   * @param analysis 分析结果
   */
  private generateSolutions(task: Task, analysis: CriticAnalysis): void {
    // 基于错误历史生成建议
    if (task.errorHistory && task.errorHistory.length > 0) {
      const commonErrors = this.analyzeErrorPatterns(task.errorHistory);
      if (commonErrors.length > 0) {
        for (const errorPattern of commonErrors) {
          analysis.solutions.push({
            description: `解决重复错误模式: ${errorPattern.error.message}`,
            priority: 'high',
            implementationSteps: [
              `识别并修复 ${errorPattern.error.type} 类型错误`,
              '添加专门的错误处理逻辑',
              '优化相关工具调用',
              '增加错误预防措施'
            ]
          });
        }
      }
    }

    // 基于技能类型生成通用建议
    if (task.skillName) {
      analysis.solutions.push({
        description: `优化 ${task.skillName} 技能执行`,
        priority: 'medium',
        implementationSteps: [
          '审查技能文档和提示词',
          '优化工具调用参数',
          '增加输入验证',
          '添加更多错误处理'
        ]
      });
    }
  }

  /**
   * 分析错误模式
   * @param errorHistory 错误历史
   * @returns 常见错误模式
   */
  private analyzeErrorPatterns(errorHistory: Array<{
    error: TaskError;
    attemptedSolutions: Array<{
      solution: string;
      timestamp: Date;
      success: boolean;
    }>;
    timestamp: Date;
  }>): Array<{
    error: TaskError;
    count: number;
  }> {
    const errorMap = new Map<string, {
      error: TaskError;
      count: number;
    }>();

    for (const errorRecord of errorHistory) {
      const errorKey = errorRecord.error.message || errorRecord.error.type || 'unknown';
      if (!errorMap.has(errorKey)) {
        errorMap.set(errorKey, {
          error: errorRecord.error,
          count: 0
        });
      }
      errorMap.get(errorKey)!.count++;
    }

    // 返回出现次数大于1的错误
    return Array.from(errorMap.values())
      .filter(item => item.count > 1)
      .sort((a, b) => b.count - a.count);
  }

  /**
   * 执行专业技能
   * @param skill 专业技能
   * @param input 输入数据
   * @returns 执行结果
   */
  private async executeProfessionalSkill(skill: any, input: any): Promise<any> {
    try {
      // 构建提示词
      const prompt = `
你是一个专业的 ${skill.name} 技能执行者，负责 ${skill.description}。

${skill.body}

请分析以下输入数据并返回分析结果：

${JSON.stringify(input, null, 2)}

请严格按照技能定义的输出格式返回结果。
`;

      // 调用LLM
      const content = await this.llm.generateText(
        prompt,
        '你是一个专业的技能执行者，严格按照技能定义执行任务。'
      );
      
      const response = { content };

      // 解析结果
      if (response.content) {
        // 提取JSON部分
        const jsonMatch = response.content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[1]);
        }
        // 尝试直接解析
        try {
          return JSON.parse(response.content);
        } catch {
          // 解析失败，返回原始内容
          return { error: response.content };
        }
      }
    } catch (error) {
      this.logger.error('执行专业技能失败', {
        skillName: skill?.name,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
    return null;
  }

  /**
   * 计算分析置信度
   * @param analysis 分析结果
   * @returns 置信度 (0-1)
   */
  private calculateConfidence(analysis: CriticAnalysis): number {
    let confidence = 0.5; // 基础置信度

    // 根据问题数量调整
    if (analysis.issues.length > 0) {
      confidence += 0.3;
    }

    // 根据解决方案数量调整
    if (analysis.solutions.length > 0) {
      confidence += 0.2;
    }

    // 限制在0-1之间
    return Math.min(1, Math.max(0, confidence));
  }

  /**
   * 映射严重程度
   * @param severity 原始严重程度
   * @returns 标准严重程度
   */
  private mapSeverity(severity: string): 'low' | 'medium' | 'high' {
    const severityMap: Record<string, 'low' | 'medium' | 'high'> = {
      'low': 'low',
      'medium': 'medium',
      'high': 'high',
      'critical': 'high'
    };
    return severityMap[severity] || 'medium';
  }

  /**
   * 映射优先级
   * @param severity 严重程度
   * @returns 优先级
   */
  private mapPriority(severity: string): 'low' | 'medium' | 'high' {
    const priorityMap: Record<string, 'low' | 'medium' | 'high'> = {
      'low': 'low',
      'medium': 'medium',
      'high': 'high',
      'critical': 'high'
    };
    return priorityMap[severity] || 'medium';
  }

  /**
   * 批量审查任务
   * @param tasks 任务列表
   * @returns 审查分析结果列表
   */
  async reviewTasks(tasks: Task[]): Promise<CriticAnalysis[]> {
    const analyses: CriticAnalysis[] = [];
    for (const task of tasks) {
      try {
        const analysis = await this.reviewTask(task);
        analyses.push(analysis);
      } catch (error) {
        this.logger.error(`审查任务失败: ${task.id}`, error);
      }
    }
    return analyses;
  }
}

export default CriticAgent;