import { z } from 'zod';
import { ILLMClient } from '../llm';
import { MemoryService } from '../memory/memory-service';
import { SessionStore } from '../memory/session-store';
import { fireAndForget } from '../utils/fire-and-forget';
import { getSkillData } from '../types';
import { createLogger } from '../observability/logger';

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
  constructor(
    private llm: ILLMClient,
    private memoryService: MemoryService,
    private sessionStore: SessionStore,
    private onNeedsIntentReclassification: (
      request: Request, userId: string, sessionId: string,
    ) => Promise<TaskResult>,
  ) {}

  /**
   * 处理任务完成
   */
  async handleTaskCompletion(
    task: Task,
    userId: string,
    sessionId: string,
    request: Request,
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

      try {
        await this.memoryService.saveAssistantMessage(userId, sessionId, qaEntry.content, {
          skillName: qaEntry.skillName || undefined,
        });
      } catch (e) { log.error('[ResultAggregator] Failed to save assistant message to memory', { error: e }); }

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
          } catch (e) { log.error('[ResultAggregator] Failed to save final assistant message', { error: e }); }
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
    taskResults: Array<{ taskId: string; skillName: string; requirement: string; response: string }>,
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

      const judgment = await this.llm.generateStructured(prompt, z.object({
        completed: z.boolean(),
        summary: z.string(),
      }));

      log.info('llm.response', {
        traceId,
        completed: judgment.completed,
      });

      log.info(`📊 汇总判断: completed=${judgment.completed}`);

      if (judgment.completed) {
        // L1+L4 同步写入助手最终回复(多任务汇总)
        try {
          await this.memoryService.saveAssistantMessage(userId, sessionId, judgment.summary, {
            requestId: request.requestId,
          });
        } catch (e) { log.error('[ResultAggregator] Failed to save final assistant message', { error: e }); }
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
      log.error(`⚠️ 汇总判断失败，使用默认拼接`, { error });
      const fallback = taskResults.map(t => t.response).filter(r => r).join('\n\n');
      // L1+L4 同步写入兜底回复
      try {
        await this.memoryService.saveAssistantMessage(userId, sessionId, fallback, {
          requestId: request.requestId,
        });
      } catch (e) { log.error('[ResultAggregator] Failed to save fallback assistant message', { error: e }); }
      await this.sessionStore.completeRequest(userId, sessionId, request.requestId, fallback);
      // L3 请求级摘要(异步,失败不阻塞)
      fireAndForget(
        this.memoryService.summarizeRequest({
          userId, sessionId, requestId: request.requestId,
          userMessage: originalRequirement, assistantMessage: fallback,
        }),
        'summarizeRequest (summarizeResults fallback)',
        (err) => log.error('请求摘要生成失败', { error: err }),
      );
      return { completed: true, summary: fallback };
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
