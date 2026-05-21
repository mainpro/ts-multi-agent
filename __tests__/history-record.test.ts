/**
 * 历史记录完整性测试
 * 验证 Bug 修复：用户多次对话的记录不完整问题
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/memory/session-store';
import { promises as fs } from 'fs';
import * as path from 'path';

const TEST_DATA_DIR = 'data/memory';
const TEST_USER_ID = 'test-user-history';
const TEST_SESSION_ID = 'test-session-history';

describe('历史记录完整性测试', () => {
  let sessionStore: SessionStore;

  beforeEach(async () => {
    sessionStore = new SessionStore(0); // 无防抖，立即写入
    // 清理测试数据
    try {
      await fs.rm(path.join(TEST_DATA_DIR, TEST_USER_ID), { recursive: true, force: true });
    } catch (e) {
      // 忽略清理错误
    }
  });

  afterEach(async () => {
    // 等待防抖写入完成
    await new Promise(resolve => setTimeout(resolve, 200));
    // 清理测试数据
    try {
      await fs.rm(path.join(TEST_DATA_DIR, TEST_USER_ID), { recursive: true, force: true });
    } catch (e) {
      // 忽略清理错误
    }
  });

  it('应该正确保存和检索简单对话（small_talk）的历史记录', async () => {
    // 模拟用户连续发送多条简单消息
    const conversations = [
      { user: '你好，你是谁啊', assistant: '您好！我是您的智能助手，有什么可以帮助您的吗？' },
      { user: '你用的什么模型，具体的型号', assistant: '我基于大语言模型技术，具体版本信息暂时无法提供。' },
      { user: '关于特朗普访华你怎么看', assistant: '我专注于运维和技术支持领域，对政治话题不太了解。请问有什么技术问题我可以帮您解决吗？' },
    ];

    // 创建请求并保存助手回复
    for (const conv of conversations) {
      const request = await sessionStore.createRequest(TEST_USER_ID, TEST_SESSION_ID, conv.user);
      // 模拟 completeRequest 保存助手回复
      await sessionStore.completeRequest(TEST_USER_ID, TEST_SESSION_ID, request.requestId, conv.assistant);
    }

    // 加载会话并验证历史记录
    const session = await sessionStore.loadSession(TEST_USER_ID, TEST_SESSION_ID);

    expect(session.requests.length).toBe(3);

    // 验证每条请求都有正确的用户消息和助手回复
    for (let i = 0; i < conversations.length; i++) {
      const req = session.requests[i];
      const expected = conversations[i];

      expect(req.content).toBe(expected.user);
      expect(req.result).toBe(expected.assistant);
      expect(req.status).toBe('completed');
    }
  });

  it('应该正确处理有询问的对话历史', async () => {
    // 创建第一个请求（用户提问）
    const request1 = await sessionStore.createRequest(TEST_USER_ID, TEST_SESSION_ID, '你好');
    await sessionStore.completeRequest(TEST_USER_ID, TEST_SESSION_ID, request1.requestId, '您好！有什么可以帮助您的吗？');

    // 创建第二个请求（需要询问的）
    const request2 = await sessionStore.createRequest(TEST_USER_ID, TEST_SESSION_ID, '帮我申请权限');

    // 添加询问
    const questionId = `q-${Date.now()}-1`;
    await sessionStore.addQuestionToRequest(TEST_USER_ID, TEST_SESSION_ID, request2.requestId, {
      questionId,
      content: '您要申请哪个系统的权限？',
      source: 'main_agent',
      taskId: null,
      skillName: null,
      answer: null,
      answeredAt: null,
      createdAt: new Date().toISOString(),
    });

    // 用户回答
    await sessionStore.answerQuestion(TEST_USER_ID, TEST_SESSION_ID, request2.requestId, questionId, 'GEAM系统');

    // 完成请求
    await sessionStore.completeRequest(TEST_USER_ID, TEST_SESSION_ID, request2.requestId, '好的，已为您申请GEAM系统权限。');

    // 验证历史记录
    const session = await sessionStore.loadSession(TEST_USER_ID, TEST_SESSION_ID);

    expect(session.requests.length).toBe(2);

    // 第一个请求
    expect(session.requests[0].content).toBe('你好');
    expect(session.requests[0].result).toBe('您好！有什么可以帮助您的吗？');

    // 第二个请求（有问答）
    expect(session.requests[1].content).toBe('帮我申请权限');
    expect(session.requests[1].questions.length).toBe(1);
    expect(session.requests[1].questions[0].content).toBe('您要申请哪个系统的权限？');
    expect(session.requests[1].questions[0].answer).toBe('GEAM系统');
    expect(session.requests[1].result).toBe('好的，已为您申请GEAM系统权限。');
  });

  it('应该正确处理失败的请求', async () => {
    // 创建请求并标记为失败
    const request = await sessionStore.createRequest(TEST_USER_ID, TEST_SESSION_ID, '执行一个失败的任务');
    await sessionStore.failRequest(TEST_USER_ID, TEST_SESSION_ID, request.requestId, '任务执行失败：系统错误');

    // 验证历史记录包含失败结果
    const session = await sessionStore.loadSession(TEST_USER_ID, TEST_SESSION_ID);

    expect(session.requests.length).toBe(1);
    expect(session.requests[0].content).toBe('执行一个失败的任务');
    expect(session.requests[0].result).toBe('任务执行失败：系统错误');
    expect(session.requests[0].status).toBe('failed');
  });

  it('getSessionHistory 应该返回所有消息（包括非 completed 状态但有 result 的）', async () => {
    // 模拟 getSessionHistory 的逻辑
    const conversations = [
      { user: '消息1', assistant: '回复1', status: 'completed' as const },
      { user: '消息2', assistant: '回复2', status: 'completed' as const },
      { user: '消息3', assistant: '回复3', status: 'failed' as const }, // 失败状态
    ];

    for (const conv of conversations) {
      const request = await sessionStore.createRequest(TEST_USER_ID, TEST_SESSION_ID, conv.user);
      if (conv.status === 'completed') {
        await sessionStore.completeRequest(TEST_USER_ID, TEST_SESSION_ID, request.requestId, conv.assistant);
      } else {
        await sessionStore.failRequest(TEST_USER_ID, TEST_SESSION_ID, request.requestId, conv.assistant);
      }
    }

    // 加载会话并构建历史消息
    const session = await sessionStore.loadSession(TEST_USER_ID, TEST_SESSION_ID);
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const req of session.requests) {
      // 用户原始请求
      messages.push({ role: 'user', content: req.content });

      // 问答历史
      for (const qa of req.questions) {
        if (qa.content) {
          messages.push({ role: 'assistant', content: qa.content });
        }
        if (qa.answer) {
          messages.push({ role: 'user', content: qa.answer });
        }
      }

      // 最终结果（修复后的逻辑：只要有 result 就显示，不限制状态）
      if (req.result) {
        messages.push({ role: 'assistant', content: req.result });
      }
    }

    // 验证消息数量：3 用户消息 + 3 助手回复 = 6 条
    expect(messages.length).toBe(6);

    // 验证消息顺序和内容
    expect(messages[0]).toEqual({ role: 'user', content: '消息1' });
    expect(messages[1]).toEqual({ role: 'assistant', content: '回复1' });
    expect(messages[2]).toEqual({ role: 'user', content: '消息2' });
    expect(messages[3]).toEqual({ role: 'assistant', content: '回复2' });
    expect(messages[4]).toEqual({ role: 'user', content: '消息3' });
    expect(messages[5]).toEqual({ role: 'assistant', content: '回复3' });
  });
});
