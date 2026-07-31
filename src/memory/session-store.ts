import { promises as fs } from 'fs';
import * as path from 'path';
import { Session, Request, QAEntry, RequestTask, ExecutionProgress } from '../types';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'SessionStore' });

/**
 * SessionStore — 会话持久化存储(state machine,不是 4 层记忆之一)
 *
 * 负责 data/memory/{userId}/session/{sessionId}.json 的读写
 * - 状态机:requests/tasks/qa/questions/activeRequestId 等
 * - 消息流存储在 L4 (history/{sessionId}.json),由 L4HistoryStore 负责
 *
 * 使用内存缓存 + 防抖写入策略
 */
export class SessionStore {
  private cache: Map<string, Session> = new Map();
  private writeTimers: Map<string, NodeJS.Timeout> = new Map();
  private debounceMs: number;
  private dataDir: string;

  constructor(debounceMs: number = 100, dataDir: string = 'data') {
    this.debounceMs = debounceMs;
    this.dataDir = dataDir;
  }

  private getFilePath(userId: string, sessionId: string): string {
    return path.join(this.dataDir, 'memory', userId, 'session', `${sessionId}.json`);
  }

  /**
   * 加载会话（优先从缓存读取）
   */
  async loadSession(userId: string, sessionId: string): Promise<Session> {
    const cacheKey = `${userId}:${sessionId}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const filePath = this.getFilePath(userId, sessionId);

    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const session: Session = JSON.parse(data);
      // Backward compat: legacy session.json files predate pendingRequests.
      if (!Array.isArray(session.pendingRequests)) {
        session.pendingRequests = [];
      }
      this.cache.set(cacheKey, session);
      log.info('加载会话', { cacheKey, requestCount: session.requests.length });
      return session;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // 创建新会话
        const session: Session = {
          sessionId,
          userId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          requests: [],
          activeRequestId: null,
          pendingRequests: [],
        };
        this.cache.set(cacheKey, session);
        return session;
      }
      throw error;
    }
  }

  /**
   * 保存会话（防抖写入磁盘）
   */
  async saveSession(userId: string, sessionId: string, session: Session): Promise<void> {
    const cacheKey = `${userId}:${sessionId}`;
    session.updatedAt = new Date().toISOString();
    this.cache.set(cacheKey, session);

    // 防抖写入
    if (this.writeTimers.has(cacheKey)) {
      clearTimeout(this.writeTimers.get(cacheKey)!);
    }

    this.writeTimers.set(cacheKey, setTimeout(async () => {
      this.writeTimers.delete(cacheKey);
      // 从缓存读取最新数据，避免防抖期间被覆盖的旧数据被写入
      const latest = this.cache.get(cacheKey);
      if (latest) {
        await this.flushToDisk(userId, sessionId, latest);
      }
    }, this.debounceMs));
  }

  /**
   * 立即写入磁盘（不防抖）
   */
  async flushToDisk(userId: string, sessionId: string, session: Session): Promise<void> {
    const filePath = this.getFilePath(userId, sessionId);
    const dir = path.dirname(filePath);

    await fs.mkdir(dir, { recursive: true });

    // 序列化时过滤掉断点续执行上下文（仅内存使用）
    const serializable = this.stripInternalFields(session);
    await fs.writeFile(filePath, JSON.stringify(serializable, null, 2), 'utf-8');
  }

  /**
   * 获取活跃请求
   */
  async getActiveRequest(userId: string, sessionId: string): Promise<Request | null> {
    const session = await this.loadSession(userId, sessionId);
    if (!session.activeRequestId) return null;
    return session.requests.find(r => r.requestId === session.activeRequestId) || null;
  }

  /**
   * 获取等待中的请求
   *
   * 等待来源有两种：
   * 1. 主智能体询问 → request.currentQuestion 有值
   * 2. 子智能体询问 → request.tasks 中有 status='waiting' 的任务
   */
  async getWaitingRequest(userId: string, sessionId: string): Promise<Request | null> {
    const session = await this.loadSession(userId, sessionId);
    return session.requests.find(r => {
      if (r.status !== 'waiting') return false;
      // 主智能体询问
      if (r.currentQuestion) return true;
      // 子智能体询问（任务级 waiting）
      return r.tasks.some(t => t.status === 'waiting' && t.currentQuestion);
    }) || null;
  }

  /**
   * 获取请求中当前等待的问题
   *
   * 优先返回主智能体的问题（request.currentQuestion），
   * 其次返回子智能体的问题（第一个 waiting 状态任务的 currentQuestion）
   */
  async getCurrentQuestion(userId: string, sessionId: string, requestId: string): Promise<QAEntry | null> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return null;

    // 主智能体询问
    if (request.currentQuestion) return request.currentQuestion;

    // 子智能体询问（取第一个 waiting 任务的问题）
    const waitingTask = request.tasks.find(t => t.status === 'waiting' && t.currentQuestion);
    return waitingTask?.currentQuestion || null;
  }

  /**
   * 获取挂起的请求（按时间倒序）
   */
  async getSuspendedRequests(userId: string, sessionId: string): Promise<Request[]> {
    const session = await this.loadSession(userId, sessionId);
    return session.requests
      .filter(r => r.status === 'suspended')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * 获取请求
   */
  async getRequest(userId: string, sessionId: string, requestId: string): Promise<Request | null> {
    const session = await this.loadSession(userId, sessionId);
    return session.requests.find(r => r.requestId === requestId) || null;
  }

  /**
   * 创建新请求
   */
  async createRequest(userId: string, sessionId: string, content: string): Promise<Request> {
    const session = await this.loadSession(userId, sessionId);
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const request: Request = {
      requestId,
      content,
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      suspendedAt: null,
      suspendedReason: null,
      questions: [],
      currentQuestion: null,
      tasks: [],
      result: null,
    };

    session.requests.push(request); // 按发生顺序追加
    session.activeRequestId = requestId;

    await this.saveSession(userId, sessionId, session);
    log.info('创建请求', { requestId, content: content.substring(0, 50) });
    return request;
  }

  /**
   * 更新请求
   */
  async updateRequest(userId: string, sessionId: string, requestId: string, updates: Partial<Request>): Promise<Request | null> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return null;

    Object.assign(request, updates, { updatedAt: new Date().toISOString() });
    await this.saveSession(userId, sessionId, session);
    return request;
  }

  /**
   * 添加询问到请求
   */
  async addQuestionToRequest(userId: string, sessionId: string, requestId: string, question: QAEntry): Promise<void> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return;

    request.questions.push(question);
    request.currentQuestion = question;
    request.status = 'waiting';
    request.updatedAt = new Date().toISOString();

    await this.saveSession(userId, sessionId, session);
    log.info('添加询问', { questionId: question.questionId, content: question.content.substring(0, 60) });
  }

  /**
   * 回答请求中的问题
   *
   * 支持两种来源：
   * 1. 主智能体问题 → 在 request.questions 中查找
   * 2. 子智能体问题 → 在 task.questions 中查找（通过 taskId 关联）
   */
  async answerQuestion(userId: string, sessionId: string, requestId: string, questionId: string, answer: string): Promise<Request | null> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return null;

    // 先在请求级查找（主智能体问题）
    let foundQuestion = request.questions.find(q => q.questionId === questionId);
    if (foundQuestion) {
      foundQuestion.answer = answer;
      foundQuestion.answeredAt = new Date().toISOString();
      request.currentQuestion = null;
      request.status = 'processing';
    } else {
      // 子智能体问题：在任务级查找
      const targetTask = request.tasks.find(t => t.questions.some(q => q.questionId === questionId));
      if (!targetTask) {
        log.warn('问题不存在，跳过', { questionId });
        return request;
      }

      const taskQuestion = targetTask.questions.find(q => q.questionId === questionId)!;
      taskQuestion.answer = answer;
      taskQuestion.answeredAt = new Date().toISOString();
      targetTask.currentQuestion = null;
      targetTask.status = 'pending';
      this.syncRequestStatus(request);
    }

    request.updatedAt = new Date().toISOString();
    await this.saveSession(userId, sessionId, session);
    log.info('回答问题', { questionId, answer });
    return request;
  }

  /**
   * 挂起请求及其所有进行中的任务
   */
  async suspendRequest(userId: string, sessionId: string, requestId: string, reason: string): Promise<Request | null> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return null;

    request.status = 'suspended';
    request.suspendedAt = new Date().toISOString();
    request.suspendedReason = reason;
    request.currentQuestion = null;
    request.updatedAt = new Date().toISOString();

    // 挂起所有进行中的任务
    for (const task of request.tasks) {
      if (task.status === 'pending' || task.status === 'running' || task.status === 'waiting') {
        task.status = 'suspended';
        task.currentQuestion = null;
        task.updatedAt = new Date().toISOString();
      }
    }

    // 如果挂起的是活跃请求，清除 activeRequestId
    if (session.activeRequestId === requestId) {
      session.activeRequestId = null;
    }

    await this.saveSession(userId, sessionId, session);
    log.info('挂起请求', { requestId, reason });
    return request;
  }

  /**
   * 召回挂起的请求
   */
  async recallRequest(userId: string, sessionId: string, requestId: string): Promise<Request | null> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return null;

    request.status = 'processing';
    request.suspendedAt = null;
    request.suspendedReason = null;
    request.updatedAt = new Date().toISOString();

    // 恢复所有挂起的任务
    for (const task of request.tasks) {
      if (task.status === 'suspended') {
        task.status = 'pending';
        task.updatedAt = new Date().toISOString();
      }
    }

    session.activeRequestId = requestId;

    await this.saveSession(userId, sessionId, session);
    log.info('召回请求', { requestId });
    return request;
  }

  /**
   * 添加任务到请求
   */
  async addTaskToRequest(userId: string, sessionId: string, requestId: string, task: RequestTask): Promise<void> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return;

    request.tasks.push(task);
    request.updatedAt = new Date().toISOString();

    await this.saveSession(userId, sessionId, session);
    log.info('添加任务', { taskId: task.taskId, skillName: task.skillName });
  }

  /**
   * 更新请求中的任务
   */
  async updateTaskInRequest(userId: string, sessionId: string, requestId: string, taskId: string, updates: Partial<RequestTask>): Promise<RequestTask | null> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return null;

    const task = request.tasks.find(t => t.taskId === taskId);
    if (!task) return null;

    Object.assign(task, updates, { updatedAt: new Date().toISOString() });

    // 同步请求状态
    this.syncRequestStatus(request);

    await this.saveSession(userId, sessionId, session);
    return task;
  }

  /**
   * 完成请求
   */
  async completeRequest(userId: string, sessionId: string, requestId: string, result: string): Promise<void> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return;

    request.result = result;
    request.updatedAt = new Date().toISOString();

    // Use syncRequestStatus to derive status from tasks instead of hardcoding 'completed'.
    // This prevents race conditions where a task was set to waiting_user_input
    // (with currentQuestion) but completeRequest overwrote it to 'completed',
    // causing subsequent user messages to not find the waiting request.
    if (request.tasks.length > 0) {
      this.syncRequestStatus(request);
    } else {
      request.status = 'completed';
    }

    if (request.status === 'completed' && session.activeRequestId === requestId) {
      session.activeRequestId = null;
    }

    await this.saveSession(userId, sessionId, session);
    log.info('完成请求', { requestId, status: request.status });
  }

  /**
   * 持久化 executionProgress 到完成态
   *
   * 不仅 waiting 状态,success/failure 完成态也保存完整 DAG 快照,
   * 这样运维复盘时可以通过 `request.executionProgress.taskGraph`
   * 重建完整的多任务拓扑,与 traceId 配合定位任意失败 task 的根因。
   *
   * 立即刷盘(不走防抖),完成态是断点关键点。
   */
  async saveExecutionProgress(
    userId: string,
    sessionId: string,
    requestId: string,
    progress: ExecutionProgress,
  ): Promise<void> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return;

    request.executionProgress = progress;
    request.updatedAt = new Date().toISOString();
    await this.flushToDisk(userId, sessionId, session);
    log.info('持久化 executionProgress', {
      requestId,
      currentLayerIndex: progress.currentLayerIndex,
      taskGraphNodes: progress.taskGraph?.nodes?.length ?? 0,
    });
  }

  /**
   * 请求失败
   */
  async failRequest(userId: string, sessionId: string, requestId: string, result: string): Promise<void> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return;

    request.result = result;
    request.updatedAt = new Date().toISOString();

    // 如果有等待中的问题，保持 waiting 状态，让用户刷新后仍可回答
    const hasWaitingQuestion = request.currentQuestion ||
      request.tasks.some(t => t.status === 'waiting' && t.currentQuestion);

    if (hasWaitingQuestion) {
      // 保留 waiting 状态和 activeRequestId，仅记录错误信息
      log.warn('请求出错但保留等待状态', { requestId, reason: result.substring(0, 80) });
    } else {
      request.status = 'failed';
      if (session.activeRequestId === requestId) {
        session.activeRequestId = null;
      }
      log.error('请求失败', { requestId });
    }

    await this.saveSession(userId, sessionId, session);
  }

  /**
   * 启动时清理陈旧 session
   *
   * 触发场景:
   *  - 进程崩溃 / 被 kill / dev server 重启
   *  - activeRequestId 指向 'processing' request,但 TaskQueue(内存)已被清空
   *  - 如果不清,新请求会被 gate 永远拦截(decision.type === 'queue')
   *
   * 清理策略:
   *  - dangling activeRequestId(指向不存在的 request)→ 直接清 null
   *  - 'processing' request 在启动时必然是中断的(进程刚启动,旧 processing 不可能还在跑)
   *    → 标记为 'failed',清 activeRequestId
   *
   * 不会动 'waiting' / 'suspended' / 'checkpoint_reached',这些是合法的中间态。
   */
  async cleanupStaleSessions(): Promise<{
    cleaned: number;
    details: Array<{ sessionId: string; requestId: string; action: string }>;
  }> {
    const details: Array<{ sessionId: string; requestId: string; action: string }> = [];
    const memoryDir = path.join(this.dataDir, 'memory');
    if (!await fs.stat(memoryDir).catch(() => null)) {
      return { cleaned: 0, details };
    }

    const userDirs = await fs.readdir(memoryDir, { withFileTypes: true });
    for (const userDir of userDirs) {
      if (!userDir.isDirectory()) continue;
      const userId = userDir.name;
      const sessionDir = path.join(memoryDir, userId, 'session');
      if (!await fs.stat(sessionDir).catch(() => null)) continue;

      const files = await fs.readdir(sessionDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const sessionId = file.replace(/\.json$/, '');
        const session = await this.loadSession(userId, sessionId);
        if (!session.activeRequestId) continue;

        const activeReq = session.requests.find(r => r.requestId === session.activeRequestId);
        if (!activeReq) {
          // dangling activeRequestId(指向不存在的 request,defensive)
          session.activeRequestId = null;
          await this.saveSession(userId, sessionId, session);
          details.push({ sessionId, requestId: 'dangling', action: 'cleared' });
          log.warn('启动清理: dangling activeRequestId 已清', { userId, sessionId });
          continue;
        }

        // 'processing' 在进程重启后必然是中断的
        if (activeReq.status === 'processing') {
          activeReq.status = 'failed';
          activeReq.result = activeReq.result || '请求被中断(进程重启)';
          activeReq.updatedAt = new Date().toISOString();
          session.activeRequestId = null;
          await this.saveSession(userId, sessionId, session);
          details.push({ sessionId, requestId: activeReq.requestId, action: 'marked-failed' });
          log.warn('启动清理: processing request 标记为 failed', {
            userId, sessionId, requestId: activeReq.requestId,
          });
        }
      }
    }

    log.info('启动清理完成', { cleaned: details.length });
    return { cleaned: details.length, details };
  }

  /**
   * 同步请求状态（根据子任务状态聚合）
   */
  private syncRequestStatus(request: Request): void {
    if (request.tasks.length === 0) return;

    const statuses = request.tasks.map(t => t.status);

    if (statuses.some(s => s === 'waiting')) {
      request.status = 'waiting';
    } else if (statuses.every(s => s === 'completed')) {
      request.status = 'completed';
    } else if (statuses.some(s => s === 'failed')) {
      request.status = 'failed';
    } else if (statuses.some(s => s === 'running' || s === 'pending')) {
      request.status = 'processing';
    }
    // suspended 状态由外部显式设置，不自动聚合
  }

  /**
   * 序列化时过滤内部字段
   *
   * ⚠️ 重要:目前函数是 identity(不过滤任何字段),依靠外层 JSON.stringify 来保留
   * 所有 session 字段。如果将来把它改成基于白名单的过滤实现,必须显式包含
   * `pendingRequests`(由 request-queue/merge 特性在 2026-07-29 引入,用于在
   * R1 运行时暂存用户输入,等检查点合并到 R2)。漏掉这个字段会导致 pending 队列
   * 被静默丢弃,用户消息丢失。
   *
   * 同样需要保留的字段已经在这:`conversationContext`、`completedToolCalls`、
   * `executionProgress` —— 这些是断点续执行的关键上下文,必须在 waiting 状态时
   * 持久化到磁盘,以便进程重启后能恢复执行进度。
   */
  private stripInternalFields(session: Session): Session {
    return session;
  }
}
