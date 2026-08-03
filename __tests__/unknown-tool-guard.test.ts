import { describe, it, expect } from 'bun:test';
import { UnknownToolLoopGuard } from '../src/agents/unknown-tool-guard';

describe('UnknownToolLoopGuard', () => {
  describe('default threshold = 3', () => {
    it('case 1: 第一次调用未知工具 → 返回 null', () => {
      const guard = new UnknownToolLoopGuard();
      const result = guard.check('nonexistent_tool');
      expect(result).toBeNull();
    });

    it('case 2: 同一未知工具连续 3 次内 → 都返回 null', () => {
      const guard = new UnknownToolLoopGuard();
      expect(guard.check('nonexistent_tool')).toBeNull();
      expect(guard.check('nonexistent_tool')).toBeNull();
      expect(guard.check('nonexistent_tool')).toBeNull();
    });

    it('case 3: 同一未知工具第 4 次起 → 返回改写文本(英文)', () => {
      const guard = new UnknownToolLoopGuard();
      guard.check('nope'); // 1
      guard.check('nope'); // 2
      guard.check('nope'); // 3
      const result = guard.check('nope'); // 4 (count > 3)
      expect(result).not.toBeNull();
      expect(result).toContain("I can't use the tool 'nope'");
      expect(result).toContain("doesn't exist");
    });

    it('case 4: 切换工具名 → 计数器重置', () => {
      const guard = new UnknownToolLoopGuard();
      guard.check('a'); // 1
      guard.check('a'); // 2
      guard.check('a'); // 3
      expect(guard.check('b')).toBeNull(); // 切换 → count 重新计 1
      expect(guard.check('b')).toBeNull(); // 2
      expect(guard.check('b')).toBeNull(); // 3
      // 第 4 次触发熔断
      const result = guard.check('b');
      expect(result).not.toBeNull();
      expect(result).toContain("I can't use the tool 'b'");
    });

    it('case 5: reset() 后状态完全清空', () => {
      const guard = new UnknownToolLoopGuard();
      guard.check('x'); // 1
      guard.check('x'); // 2
      guard.check('x'); // 3
      guard.reset();
      // 重置后, 第一次应返回 null
      expect(guard.check('x')).toBeNull();
      expect(guard.check('x')).toBeNull();
      expect(guard.check('x')).toBeNull();
      // 第 4 次才熔断
      const result = guard.check('x');
      expect(result).not.toBeNull();
    });
  });

  describe('custom threshold', () => {
    it('threshold=2: 第 3 次触发熔断', () => {
      const guard = new UnknownToolLoopGuard(2);
      expect(guard.check('foo')).toBeNull(); // 1
      expect(guard.check('foo')).toBeNull(); // 2
      const result = guard.check('foo');    // 3 (>2)
      expect(result).not.toBeNull();
      expect(result).toContain("'foo'");
      expect(result).toContain("doesn't exist");
    });

    it('threshold=5: 第 6 次触发熔断', () => {
      const guard = new UnknownToolLoopGuard(5);
      for (let i = 0; i < 5; i++) {
        expect(guard.check('bar')).toBeNull();
      }
      const result = guard.check('bar');
      expect(result).not.toBeNull();
    });
  });

  describe('reset() 在中间调用', () => {
    it('reset 后即使之前已经接近阈值, 计数也清零', () => {
      const guard = new UnknownToolLoopGuard(3);
      guard.check('z'); // 1
      guard.check('z'); // 2
      guard.reset();
      // 切换到相同工具名, 但因为 reset, 应该是新一次计数
      expect(guard.check('z')).toBeNull(); // 1
      expect(guard.check('z')).toBeNull(); // 2
      expect(guard.check('z')).toBeNull(); // 3
      const result = guard.check('z');     // 4
      expect(result).not.toBeNull();
    });

    it('reset 后切换工具名, 应该用新名字重新计数', () => {
      const guard = new UnknownToolLoopGuard(3);
      guard.check('p'); // 1
      guard.check('p'); // 2
      guard.reset();
      expect(guard.check('q')).toBeNull(); // 1
      expect(guard.check('q')).toBeNull(); // 2
      expect(guard.check('q')).toBeNull(); // 3
      expect(guard.check('q')).not.toBeNull(); // 4
    });
  });

  describe('改写文本格式', () => {
    it('返回的文本应包含引导 LLM 换路径的内容', () => {
      const guard = new UnknownToolLoopGuard(1);
      guard.check('test'); // 1
      const result = guard.check('test'); // 2 (>1)
      expect(result).not.toBeNull();
      expect(result!.toLowerCase()).toContain('stop');
      expect(result!.toLowerCase()).toContain('answer');
    });
  });
});
