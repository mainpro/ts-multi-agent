import { describe, expect, test, beforeEach } from 'bun:test';
import { IntentRouter } from '../src/routers/intent-router';
import { SkillRegistry } from '../src/skill-registry';
import type { ILLMClient } from '../src/llm';

const mockSkillRegistry = {
  getAllMetadata: () => [],
} as unknown as SkillRegistry;

describe('IntentRouter.classify — persona 参数', () => {
  let capturedSystemPrompt: string | undefined;

  const mockLlm: ILLMClient = {
    generateStructured: async (_prompt: string, _schema: any, systemPrompt?: string) => {
      capturedSystemPrompt = systemPrompt;
      return { intent: 'small_talk', tasks: [], question: { content: '你好' } };
    },
    generateText: async () => '',
    generateWithTools: async () => ({ content: '', toolCalls: [], messages: [] }),
  } as unknown as ILLMClient;

  beforeEach(() => {
    capturedSystemPrompt = undefined;
  });

  test('persona 不传 → systemPrompt 不含 persona prefix', async () => {
    const router = new IntentRouter(mockLlm, mockSkillRegistry);
    await router.classify('你好');
    expect(capturedSystemPrompt ?? '').not.toContain('法务助理');
  });

  test('persona.prefix 传入 → systemPrompt 包含 persona prefix', async () => {
    const router = new IntentRouter(mockLlm, mockSkillRegistry);
    await router.classify('你好', undefined, undefined, undefined, undefined, undefined, {
      prefix: '你是「法务助理·小法」',
      style: '严谨',
      boundaries: '诉讼请转人工',
    });
    expect(capturedSystemPrompt).toContain('法务助理·小法');
    expect(capturedSystemPrompt).toContain('严谨');
    expect(capturedSystemPrompt).toContain('诉讼请转人工');
  });

  test('persona 只有 prefix → style/boundaries 不出现', async () => {
    const router = new IntentRouter(mockLlm, mockSkillRegistry);
    await router.classify('你好', undefined, undefined, undefined, undefined, undefined, {
      prefix: 'minimal persona',
    });
    expect(capturedSystemPrompt).toContain('minimal persona');
  });

  test('persona.template 变量 ${displayName} → 在拼 systemPrompt 前替换', async () => {
    const router = new IntentRouter(mockLlm, mockSkillRegistry);
    await router.classify('你好', undefined, undefined, undefined, undefined, undefined, {
      prefix: '我是 ${displayName}',
    }, '法务助理·小法');
    expect(capturedSystemPrompt).toContain('我是 法务助理·小法');
    expect(capturedSystemPrompt).not.toContain('${displayName}');
  });
});