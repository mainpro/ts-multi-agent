// 消息工厂，用于生成测试消息
import type { Message } from '../../src/types';

export function createTestMessage(overrides?: Partial<Message>): Message {
  return {
    role: 'user',
    content: 'test message',
    ...overrides,
  };
}
