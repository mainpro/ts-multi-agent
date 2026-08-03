import { describe, test, expect, beforeEach } from 'bun:test';
import { steeringBuffer } from '../src/memory/steering-buffer';

describe('SteeringBuffer', () => {
  beforeEach(() => {
    steeringBuffer.clear('s1');
    steeringBuffer.clear('s2');
  });

  test('enqueue: 消息按顺序入队,peek 不消费', () => {
    steeringBuffer.enqueue('s1', { content: '改口一', enqueuedAt: '2026-08-03T00:00:00.000Z' });
    steeringBuffer.enqueue('s1', { content: '改口二', enqueuedAt: '2026-08-03T00:00:01.000Z' });

    expect(steeringBuffer.peek('s1').map(m => m.content)).toEqual(['改口一', '改口二']);
    // peek 是快照,再 peek 依然拿得到
    expect(steeringBuffer.peek('s1')).toHaveLength(2);
    // peek 返回副本,外部改动不影响内部
    const snapshot = steeringBuffer.peek('s1');
    snapshot.pop();
    expect(steeringBuffer.peek('s1')).toHaveLength(2);
  });

  test('consume: 取出全部并清空,二次 consume 为空', () => {
    steeringBuffer.enqueue('s1', { content: '换成上海', enqueuedAt: '2026-08-03T00:00:00.000Z' });

    const first = steeringBuffer.consume('s1');
    expect(first).toHaveLength(1);
    expect(first[0].content).toBe('换成上海');

    expect(steeringBuffer.consume('s1')).toEqual([]);
    expect(steeringBuffer.peek('s1')).toEqual([]);
  });

  test('隔离: 不同 sessionId 的队列互不影响', () => {
    steeringBuffer.enqueue('s1', { content: 'A', enqueuedAt: 'x' });
    steeringBuffer.enqueue('s2', { content: 'B', enqueuedAt: 'x' });

    expect(steeringBuffer.consume('s1').map(m => m.content)).toEqual(['A']);
    // s2 不受 s1 的 consume 影响
    expect(steeringBuffer.peek('s2').map(m => m.content)).toEqual(['B']);
    expect(steeringBuffer.consume('s2').map(m => m.content)).toEqual(['B']);
  });

  test('clear: 清空指定 session 且未知 session 安全返回空', () => {
    steeringBuffer.enqueue('s1', { content: 'A', enqueuedAt: 'x' });
    steeringBuffer.clear('s1');

    expect(steeringBuffer.peek('s1')).toEqual([]);
    expect(steeringBuffer.consume('s1')).toEqual([]);
    // 从未出现过的 session
    expect(steeringBuffer.peek('never-seen')).toEqual([]);
    expect(steeringBuffer.consume('never-seen')).toEqual([]);
    expect(() => steeringBuffer.clear('never-seen')).not.toThrow();
  });
});
