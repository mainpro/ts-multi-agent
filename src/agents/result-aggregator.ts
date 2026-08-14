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
export type TransferToHumanHook = (taskResults: TaskResult[]) => boolean;

export class ResultAggregator {
  private rewriter?: ResultRewriter;
  private transferHook: TransferToHumanHook;

  constructor(
    private llm: ILLMClient,
    private memoryService: MemoryService,
    private sessionStore: SessionStore,
    private onNeedsIntentReclassification: (
      request: Request, userId: string, sessionId: string,
    ) => Promise<TaskResult>,
    rewriter?: ResultRewriter,
    transferHook?: TransferToHumanHook,
  ) {
    this.rewriter = rewriter;
    this.transferHook = transferHook ?? (() => false);  // 默认 noop
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
  ): Promise<{ completed: boolean; summary: string; failedTaskIds: string[]; transferTriggered: boolean }> {
    log.info(`📊 汇总 ${taskResults.length} 个任务结果...`);

    // P5: 拆分状态
    const completedTasks = taskResults.filter(t => t.status === 'completed');
    const failedTasks = taskResults.filter(t => t.status === 'failed');
    const waitingTasks = taskResults.filter(t => t.status === 'waiting_user_input');

    const resultsContext = [
      ...completedTasks.map((t, idx) => `任务${idx + 1} [${t.skillName}]: ✅ ${t.response}`),
      ...failedTasks.map((t, idx) => `任务${completedTasks.length + idx + 1} [${t.skillName}]: ❌ ${t.response || '执行失败'}`),
      ...(waitingTasks.length > 0 ? [`⏸ 等待用户输入: ${waitingTasks.map(t => t.skillName).join(', ')}`] : []),
    ].join('\n\n');

    const prompt = `用户原始需求: ${originalRequirement}

以下是各子任务的执行结果:
${resultsContext}

请判断:
1. 所有子任务的结果是否已经完整满足了用户的需求？
2. 如果满足，请生成一段简洁自然的汇总回复
3. 如果有失败任务，明确告知用户哪些成功、哪些失败，并建议回复"转人工"获取人工协助

输出 JSON:
{
  "completed": true/false,
  "summary": "汇总文本"
}`;

    try {
      const traceId = `agg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      log.info('llm.request', {
        traceId,
        type: 'aggregate',
        requestId: request.requestId,
        tasksCount: taskResults.length,
        failedCount: failedTasks.length,
      });

      let judgment = await this.llm.generateStructured(prompt, z.object({
        completed: z.boolean(),
        summary: z.string(),
      }));

      log.info('llm.response', { traceId, completed: judgment.completed });
      log.info(`📊 汇总判断: completed=${judgment.completed}, failed=${failedTasks.length}`);

      // P5: 防御纵深 —— 有失败 task 时强制 completed=false
      // (即使 LLM 误判 completed=true 也覆盖,避免标"完成")
      if (failedTasks.length > 0 && judgment.completed) {
        log.warn('LLM 把部分失败误判为 completed,已修正', {
          failedCount: failedTasks.length,
          llmJudgment: judgment.completed,
        });
        judgment = { ...judgment, completed: false };
      }

      // P5: Transfer hook(预留)
      let transferTriggered = false;
      if (failedTasks.length > 0 && this.transferHook) {
        transferTriggered = this.transferHook(taskResults as unknown as TaskResult[]);
        if (transferTriggered) {
          judgment = {
            ...judgment,
            summary: `${judgment.summary}\n\n> 💡 检测到部分任务执行失败,如需人工协助请回复"转人工"。`,
          };
        }
      }

      // P5: Rewriter gate 修复 —— 必须基于 every(completed),不再用 taskResults[0] 或 [N-1]
      // 旧行为(B-1 bug):taskResults[0]?.status === 'completed'
      // 新行为:全成功 + 无 waiting 才追加
      const allCompleted = completedTasks.length === taskResults.length && waitingTasks.length === 0;
      if (this.rewriter && allCompleted) {
        const targetStatus = this.rewriter.match?.status ?? 'completed';
        if (targetStatus === 'completed') {
          judgment = {
            ...judgment,
            summary: this.applyRewriter(judgment.summary, this.rewriter),
          };
        }
      }

      if (judgment.completed) {
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
        fireAndForget(
          this.memoryService.summarizeRequest({
            userId, sessionId, requestId: request.requestId,
            userMessage: originalRequirement, assistantMessage: judgment.summary,
          }),
          'summarizeRequest (summarizeResults)',
          (err) => log.error('请求摘要生成失败', { error: err }),
        );
      }

      return {
        completed: judgment.completed,
        summary: judgment.summary,
        failedTaskIds: failedTasks.map(t => t.taskId),
        transferTriggered,
      };
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
