/**
 * Conversation Context Helper 测试
 *
 * 测试断点续执行时的上下文同步逻辑
 */
import { describe, it, expect } from 'bun:test';
import {
  checkQuestionHistoryConsistency,
  buildQuestionAnswerPairs,
  syncQuestionHistoryToContext,
  buildResumedContext,
  validateResumedContext,
} from '../src/memory/conversation-context-helper';
import { Message, QuestionHistoryEntry } from '../src/types';

describe('Conversation Context Helper', () => {
  describe('checkQuestionHistoryConsistency', () => {
    it('应该检测到完全一致的上下文', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'assistant', content: '请问您的岗位是财务岗吗？' },
        { role: 'user', content: '是的' },
      ];

      const questionHistory: QuestionHistoryEntry[] = [
        {
          question: { type: 'skill_question', content: '请问您的岗位是财务岗吗？' },
          answer: '是的',
          timestamp: new Date(),
        },
      ];

      const result = checkQuestionHistoryConsistency(messages, questionHistory);
      expect(result.isConsistent).toBe(true);
      expect(result.missingInContext).toHaveLength(0);
    });

    it('应该检测到缺失的问答对', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        // 缺少问答对
      ];

      const questionHistory: QuestionHistoryEntry[] = [
        {
          question: { type: 'skill_question', content: '请问您的岗位是财务岗吗？' },
          answer: '是的',
          timestamp: new Date(),
        },
      ];

      const result = checkQuestionHistoryConsistency(messages, questionHistory);
      expect(result.isConsistent).toBe(false);
      expect(result.missingInContext).toHaveLength(1);
    });

    it('应该检测到部分缺失的问答对', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'assistant', content: '请问您的岗位是财务岗吗？' },
        { role: 'user', content: '是的' },
        // 缺少第二个问答对
      ];

      const questionHistory: QuestionHistoryEntry[] = [
        {
          question: { type: 'skill_question', content: '请问您的岗位是财务岗吗？' },
          answer: '是的',
          timestamp: new Date(),
        },
        {
          question: { type: 'skill_question', content: '请提供公司名称' },
          answer: '海尔集团',
          timestamp: new Date(),
        },
      ];

      const result = checkQuestionHistoryConsistency(messages, questionHistory);
      expect(result.isConsistent).toBe(false);
      expect(result.missingInContext).toHaveLength(1);
      expect(result.missingInContext[0].question.content).toBe('请提供公司名称');
    });
  });

  describe('buildQuestionAnswerPairs', () => {
    it('应该正确构建问答对', () => {
      const questionHistory: QuestionHistoryEntry[] = [
        {
          question: { type: 'skill_question', content: '问题1' },
          answer: '回答1',
          timestamp: new Date(),
        },
        {
          question: { type: 'skill_question', content: '问题2' },
          answer: '回答2',
          timestamp: new Date(),
        },
      ];

      const pairs = buildQuestionAnswerPairs(questionHistory);

      expect(pairs).toHaveLength(4);
      expect(pairs[0]).toEqual({ role: 'assistant', content: '问题1' });
      expect(pairs[1]).toEqual({ role: 'user', content: '回答1' });
      expect(pairs[2]).toEqual({ role: 'assistant', content: '问题2' });
      expect(pairs[3]).toEqual({ role: 'user', content: '回答2' });
    });
  });

  describe('syncQuestionHistoryToContext', () => {
    it('应该保持已同步的上下文不变', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'assistant', content: '请问您的岗位是财务岗吗？' },
        { role: 'user', content: '是的' },
      ];

      const questionHistory: QuestionHistoryEntry[] = [
        {
          question: { type: 'skill_question', content: '请问您的岗位是财务岗吗？' },
          answer: '是的',
          timestamp: new Date(),
        },
      ];

      const result = syncQuestionHistoryToContext(messages, questionHistory);

      expect(result).toHaveLength(3);
      expect(result[0].role).toBe('system');
      expect(result[1].role).toBe('assistant');
      expect(result[2].role).toBe('user');
    });

    it('应该补充缺失的问答对', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'assistant', content: '请问您的岗位是财务岗吗？' },
        { role: 'user', content: '是的' },
      ];

      const questionHistory: QuestionHistoryEntry[] = [
        {
          question: { type: 'skill_question', content: '请问您的岗位是财务岗吗？' },
          answer: '是的',
          timestamp: new Date(),
        },
        {
          question: { type: 'skill_question', content: '请提供公司名称' },
          answer: '海尔集团',
          timestamp: new Date(),
        },
      ];

      const result = syncQuestionHistoryToContext(messages, questionHistory);

      expect(result).toHaveLength(5);
      // 原始消息 + 新增的问答对
      expect(result[3]).toEqual({ role: 'assistant', content: '请提供公司名称' });
      expect(result[4]).toEqual({ role: 'user', content: '海尔集团' });
    });

    it('应该在消息末尾追加问答对', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '我要申请权限' },
      ];

      const questionHistory: QuestionHistoryEntry[] = [
        {
          question: { type: 'skill_question', content: '请问您的岗位是财务岗吗？' },
          answer: '是的',
          timestamp: new Date(),
        },
      ];

      const result = syncQuestionHistoryToContext(messages, questionHistory);

      expect(result[0].role).toBe('system');
      expect(result[1].role).toBe('user'); // 原始用户消息
      expect(result[2].role).toBe('assistant'); // 追加的提问
      expect(result[3].role).toBe('user'); // 追加的回答
    });
  });

  describe('buildResumedContext', () => {
    it('应该构建精简的断点续执行上下文', () => {
      const originalContext: Message[] = [
        { role: 'system', content: 'original system' },
        { role: 'assistant', content: '请问您的岗位是财务岗吗？' },
        { role: 'user', content: '是的' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'tool result 1', tool_call_id: 'call_1' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'glob', arguments: '{}' } }] },
        { role: 'tool', content: 'tool result 2', tool_call_id: 'call_2' },
      ];

      const questionHistory: QuestionHistoryEntry[] = [
        {
          question: { type: 'skill_question', content: '请问您的岗位是财务岗吗？' },
          answer: '是的',
          timestamp: new Date(),
        },
      ];

      const systemPrompt = 'new system prompt';

      const result = buildResumedContext(originalContext, questionHistory, systemPrompt, {
        maxToolMessages: 5,
        addContinuationPrompt: true,
      });

      // 应该包含：新 system + 问答摘要 + assistant+tool 配对 + 继续提示
      expect(result[0]).toEqual({ role: 'system', content: systemPrompt });
      expect(result[1].role).toBe('system');
      expect(result[1].content).toContain('【已完成的对话步骤】');
      expect(result[1].content).toContain('请问您的岗位是财务岗吗？');
      // assistant+tool 配对必须保持合法的消息顺序
      expect(result[2].role).toBe('assistant');
      expect(result[3].role).toBe('tool');
      expect(result[4].role).toBe('assistant');
      expect(result[5].role).toBe('tool');
      expect(result[6].role).toBe('user');
      expect(result[6].content).toContain('继续执行任务');
    });

    it('应该处理空的 questionHistory', () => {
      const originalContext: Message[] = [
        { role: 'system', content: 'original system' },
        { role: 'user', content: '我要申请权限' },
      ];

      const systemPrompt = 'new system prompt';

      const result = buildResumedContext(originalContext, [], systemPrompt);

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe(systemPrompt);
      expect(result[1].role).toBe('user');
    });
  });

  describe('validateResumedContext', () => {
    it('应该验证有效的上下文', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'assistant', content: '请问您的岗位是财务岗吗？' },
        { role: 'user', content: '是的' },
      ];

      const questionHistory: QuestionHistoryEntry[] = [
        {
          question: { type: 'skill_question', content: '请问您的岗位是财务岗吗？' },
          answer: '是的',
          timestamp: new Date(),
        },
      ];

      const result = validateResumedContext(messages, questionHistory);

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('应该检测到缺少 system 消息', () => {
      const messages: Message[] = [
        { role: 'assistant', content: '请问您的岗位是财务岗吗？' },
        { role: 'user', content: '是的' },
      ];

      const questionHistory: QuestionHistoryEntry[] = [];

      const result = validateResumedContext(messages, questionHistory);

      expect(result.valid).toBe(false);
      expect(result.issues).toContain('缺少 system 消息');
    });

    it('应该检测到上下文以 assistant 结尾', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'assistant', content: '请问您的岗位是财务岗吗？' },
        // 缺少用户回答
      ];

      const questionHistory: QuestionHistoryEntry[] = [];

      const result = validateResumedContext(messages, questionHistory);

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('assistant 消息结尾'))).toBe(true);
    });
  });
});
