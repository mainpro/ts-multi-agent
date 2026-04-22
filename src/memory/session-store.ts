import { promises as fs } from 'fs';
import * as path from 'path';
import { Session, Request, QAEntry, RequestTask } from '../types';

/**
 * SessionStore — 会话持久化存储
 *
 * 负责 data/memory/{userId}/{sessionId}/session.json 的读写
 * 使用内存缓存 + 防抖写入策略
 */
export class SessionStore {
  private cache: Map<string, Session> = new Map();
  private writeTimers: Map<string, NodeJS.Timeout> = new Map();
  private debounceMs: number;

  constructor(debounceMs: number = 100) {
    this.debounceMs = debounceMs;
  }

  private getFilePath(userId: string, sessionId: string): string {
    return path.join('data', 'memory', userId, sessionId, 'session.json');
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
      this.cache.set(cacheKey, session);
      console.log(`[SessionStore] 📂 加载会话: ${cacheKey} (${session.requests.length}个请求)`);
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
      await this.flushToDisk(userId, sessionId, session);
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
    console.log(`[SessionStore] 📝 创建请求: ${requestId} "${content.substring(0, 50)}..."`);
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
    console.log(`[SessionStore] ❓ 添加询问: ${question.questionId} "${question.content.substring(0, 60)}..."`);
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

    // 先在请求级查找
    const question = request.questions.find(q => q.questionId === questionId);

    if (question) {
      // 主智能体问题：更新请求级
      question.answer = answer;
      question.answeredAt = new Date().toISOString();
      request.currentQuestion = null;
      request.status = 'processing';
    } else {
      // 子智能体问题：在任务级查找
      let found = false;
      for (const task of request.tasks) {
        const taskQuestion = task.questions.find(q => q.questionId === questionId);
        if (taskQuestion) {
          taskQuestion.answer = answer;
          taskQuestion.answeredAt = new Date().toISOString();
          task.currentQuestion = null;
          task.status = 'pending';
          found = true;
          break; // 只会有一个匹配
        }
      }
      if (!found) {
        // 问题不存在，静默返回
        return request;
      }
      // 通过 syncRequestStatus 重新计算请求状态
      this.syncRequestStatus(request);
    }

    request.updatedAt = new Date().toISOString();

    await this.saveSession(userId, sessionId, session);
    console.log(`[SessionStore] 💬 回答问题: ${questionId} "${answer}"`);
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
    console.log(`[SessionStore] 📌 挂起请求: ${requestId} 原因: ${reason}`);
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
    console.log(`[SessionStore] 🔄 召回请求: ${requestId}`);
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
    console.log(`[SessionStore] 📋 添加任务: ${task.taskId} [${task.skillName}]`);
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

    request.status = 'completed';
    request.result = result;
    request.updatedAt = new Date().toISOString();

    if (session.activeRequestId === requestId) {
      session.activeRequestId = null;
    }

    await this.saveSession(userId, sessionId, session);
    console.log(`[SessionStore] ✅ 完成请求: ${requestId}`);
  }

  /**
   * 请求失败
   */
  async failRequest(userId: string, sessionId: string, requestId: string, result: string): Promise<void> {
    const session = await this.loadSession(userId, sessionId);
    const request = session.requests.find(r => r.requestId === requestId);
    if (!request) return;

    request.status = 'failed';
    request.result = result;
    request.updatedAt = new Date().toISOString();

    if (session.activeRequestId === requestId) {
      session.activeRequestId = null;
    }

    await this.saveSession(userId, sessionId, session);
    console.log(`[SessionStore] ❌ 请求失败: ${requestId}`);
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
   * 序列化时过滤内部字段（断点续执行上下文不持久化）
   */
  private stripInternalFields(session: Session): Session {
    return {
      ...session,
      requests: session.requests.map(r => ({
        ...r,
        tasks: r.tasks.map(t => {
          const { conversationContext, completedToolCalls, ...rest } = t as any;
          return rest;
        }),
      })),
    };
  }
}

export const sessionStore = new SessionStore();
