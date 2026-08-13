import { z } from 'zod';
import { ILLMClient, LLMError } from '../llm';
import { BusinessError, SkillError, LlmError, AppError } from '../errors';
import { MemoryService } from '../memory/memory-service';
import { SessionStore } from '../memory/session-store';
import { fireAndForget } from '../utils/fire-and-forget';
import { taskEvents } from '../events/task-events';
import { getSkillData } from '../types';
import { createLogger } from '../observability/logger';
import type { ResultRewriter } from './employee/types';

const log = createLogger({ module: 'ResultAggregator' });
import {
  Task,
  TaskResult,
  Request,
  QAEntry,
  SkillExecutionResult,
} from '../types';

/**
 * ResultAggregator — 任务结果处理、QAEntry 创建、结果汇总
 *
 * 从 MainAgent 抽取，负责：
 * - handleTaskCompletion: 处理单个任务完成后的状态更新、询问创建、记忆持久化
 * - summarizeResults: 多任务结果汇总，LLM 判断是否完成
 * - createQAEntry: 统一 QAEntry 创建逻辑
 *
 * 注意：handleTaskCompletion 中遇到 needs_intent_reclassification 时需要回调
 * MainAgent.processNormalRequirement，通过构造函数注入的回调实现。
 */
export class ResultAggregator {
  private rewriter?: ResultRewriter;

  constructor(
    private llm: ILLMClient,
    private memoryService: MemoryService,
    private sessionStore: SessionStore,
    private onNeedsIntentReclassification: (
      request: Request, userId: string, sessionId: string,
    ) => Promise<TaskResult>,
    rewriter?: ResultRewriter,
  ) {
    this.rewriter = rewriter;
  }

  /**
   * 应用 ResultRewriter.transform。
   * 三种 transform:
   *  - append: text + value
   *  - passthrough: text 原样返回
   *  - replace: value 替换 text
   */
  private applyRewriter(text: string, rewriter: ResultRewriter): string {
    switch (rewriter.transform) {
      case 'append':
        return text + (rewriter.value ?? '');
      case 'passthrough':
        return text;
      case 'replace':
        return rewriter.value ?? text;
    }
  }

  /**
   * 处理任务完成
   *
   * @param planId 可选,用于 task_waiting 事件携带 planId 给前端做进度卡分组。
   *   不传时跳过 TaskEvent 发射(waiting 事件是可选的进度反馈)。
   */
  async handleTaskCompletion(
    task: Task,
    userId: string,
    sessionId: string,
    request: Request,
    planId?: string,
  ): Promise<TaskResult> {
    const taskResult = task.result || { success: true, data: {} };
    const skillData = getSkillData(taskResult);

    // 检查是否又产生了新的询问
    if (skillData?.status === 'waiting_user_input' && skillData.question) {
      const qaEntry = this.createQAEntry(skillData, task.id, task.skillName || null);

      await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, task.id, {
        currentQuestion: qaEntry,
        status: 'waiting',
        questions: [...(request.tasks.find(t => t.taskId === task.id)?.questions || []), qaEntry],
      });

      // 发射 task_waiting 事件供前端进度卡显示子智能体提问
      if (planId) {
        taskEvents.emit({
          type: 'task_waiting',
          requestId: request.requestId,
          planId,
          taskId: task.id,
          status: 'waiting',
          requirement: task.requirement,
          skillName: task.skillName ?? null,
          question: {
            content: skillData.question.content,
            metadata: skillData.question.metadata,
          },
        });
      }

      try {
        await this.memoryService.saveAssistantMessage(userId, sessionId, qaEntry.content, {
          skillName: qaEntry.skillName || undefined,
        });
      } catch (error) {
        if (error instanceof LLMError) {
          throw new LlmError(error.type, error.message, { cause: error });
        }
        if (error instanceof AppError) throw error;
        throw new BusinessError('QA_ENTRY_FAILED',
          error instanceof Error ? error.message : String(error),
          { cause: error });
      }

      return {
        success: true,
        data: { message: qaEntry.content, type: 'question', question: qaEntry, requestId: request.requestId },
      };
    }

    // 检查是否需要意图重分类
    if (skillData?.status === 'needs_intent_reclassification') {
      log.info('🔄 检测到用户回复与当前任务无关，重新识别意图');
      return this.onNeedsIntentReclassification(request, userId, sessionId);
    }

    // 正常完成 → 更新请求中的任务状态
    await this.sessionStore.updateTaskInRequest(userId, sessionId, request.requestId, task.id, {
      status: 'completed',
      result: skillData?.response || null,
    });

    if (task.skillName) {
      // 旧 remember/saveProceduralMemory 已由 L3 summarizeRequest 统一处理,不再单独调用
      // questionHistory 级别的语义提取也已由 L3 请求级摘要覆盖
    }

    // 检查是否所有任务都已完成
    const updatedSession = await this.sessionStore.loadSession(userId, sessionId);
    const updatedRequest = updatedSession.requests.find(r => r.requestId === request.requestId);
    if (updatedRequest) {
      const allTasksDone = updatedRequest.tasks.every(t => t.status === 'completed' || t.status === 'failed');
      const noWaitingQuestions = !updatedRequest.tasks.some(t => t.status === 'waiting' && t.currentQuestion);
      if (allTasksDone && noWaitingQuestions) {
        const taskCount = updatedRequest.tasks.length;
        if (taskCount === 1) {
          const taskResult_text = skillData?.response || '';
          // L1+L4 同步写入助手最终回复(此前只在 main-agent 路径写,continueRequest 路径缺失)
          try {
            await this.memoryService.saveAssistantMessage(userId, sessionId, taskResult_text, {
              skillName: task.skillName || undefined,
              requestId: request.requestId,
            });
          } catch (error) {
            throw new SkillError('TASK_EXECUTION_FAILED',
              error instanceof Error ? error.message : String(error),
              { cause: error });
          }
          await this.sessionStore.completeRequest(userId, sessionId, request.requestId, taskResult_text);
          // L3 请求级摘要(异步,失败不阻塞)
          fireAndForget(
            this.memoryService.summarizeRequest({
              userId, sessionId, requestId: request.requestId,
              userMessage: request.content, assistantMessage: taskResult_text,
              skillName: task.skillName || undefined,
            }),
            'summarizeRequest (handleTaskCompletion)',
            (err) => log.error('请求摘要生成失败', { error: err }),
          );
        }
      }
    }

    return taskResult;
  }

  /**
   * 汇总任务结果，判断是否满足用户原始需求
   */
  async summarizeResults(
    originalRequirement: string,
    taskResults: Array<{ taskId: string; skillName: string; requirement: string; response: string; status?: string }>,
    userId: string,
    sessionId: string,
    request: Request,
  ): Promise<{ completed: boolean; summary: string }> {
    log.info(`📊 汇总 ${taskResults.length} 个任务结果...`);

    const resultsContext = taskResults
      .map((t, idx) => `任务${idx + 1} [${t.skillName}]: ${t.response}`)
      .join('\n\n');

    const prompt = `用户原始需求: ${originalRequirement}

以下是各子任务的执行结果:
${resultsContext}

请判断:
1. 所有子任务的结果是否已经完整满足了用户的需求？
2. 如果满足，请生成一段简洁自然的汇总回复（直接回复用户，不要说"根据执行结果"等机械用语）
3. 如果不满足，说明还需要执行什么操作

输出 JSON:
{
  "completed": true/false,
  "summary": "汇总文本（completed=true时）或 说明还需要什么（completed=false时）"
}`;

    try {
      const traceId = `agg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      log.info('llm.request', {
        traceId,
        type: 'aggregate',
        requestId: request.requestId,
        tasksCount: taskResults.length,
      });

      let judgment = await this.llm.generateStructured(prompt, z.object({
        completed: z.boolean(),
        summary: z.string(),
      }));

      log.info('llm.response', {
        traceId,
        completed: judgment.completed,
      });

      log.info(`📊 汇总判断: completed=${judgment.completed}`);

      // 应用 resultRewriter(若配置)——必须在持久化之前完成,保证落库的 summary 与
      // 返回给调用方的 summary 一致,避免重放丢失后缀(Final Review Minor #1 衍生)
      // 双重门控:既匹配 match.status(默认 'completed'),又显式排除 'waiting_user_input'
      // 后者复现 Task 7 删除的 SubAgent 守卫:防止给提问追加 "转人工" 后缀
      if (this.rewriter) {
        const targetStatus = this.rewriter.match?.status ?? 'completed';
        const lastTaskStatus = taskResults[0]?.status ?? 'completed';
        if (lastTaskStatus === targetStatus && lastTaskStatus !== 'waiting_user_input') {
          judgment = {
            ...judgment,
            summary: this.applyRewriter(judgment.summary, this.rewriter),
          };
        }
      }

      if (judgment.completed) {
        // L1+L4 同步写入助手最终回复(多任务汇总)
        // 此时 judgment.summary 已经是改写后的版本,确保落库与返回一致
        try {
          await this.memoryService.saveAssistantMessage(userId, sessionId, judgment.summary, {
            requestId: request.requestId,
          });
        } catch (error) {
          throw new SkillError('JUDGMENT_FAILED',
            error instanceof Error ? error.message : String(error),
            { cause: error });
        }
        await this.sessionStore.completeRequest(userId, sessionId, request.requestId, judgment.summary);
        // L3 请求级摘要(异步,失败不阻塞)
        fireAndForget(
          this.memoryService.summarizeRequest({
            userId, sessionId, requestId: request.requestId,
            userMessage: originalRequirement, assistantMessage: judgment.summary,
          }),
          'summarizeRequest (summarizeResults)',
          (err) => log.error('请求摘要生成失败', { error: err }),
        );
      }

      return judgment;
    } catch (error) {
      if (error instanceof LLMError) {
        throw new LlmError(error.type, error.message, { cause: error });
      }
      if (error instanceof AppError) throw error;
      throw new BusinessError('SUMMARIZATION_FAILED',
        error instanceof Error ? error.message : String(error),
        { cause: error });
    }
  }

  /**
   * 统一创建 QAEntry
   */
  createQAEntry(
    skillData: SkillExecutionResult,
    taskId: string,
    skillName: string | null,
  ): QAEntry {
    const questionId = `q-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    return {
      questionId,
      content: skillData.question!.content,
      source: 'sub_agent',
      taskId,
      skillName,
      answer: null,
      answeredAt: null,
      createdAt: new Date().toISOString(),
      metadata: skillData.question!.metadata ?? undefined,
    } as QAEntry;
  }
}

export default ResultAggregator;
