// 测试环境配置
import { beforeAll, afterAll } from 'bun:test';

beforeAll(() => {
  // 全局测试设置
  process.env.NODE_ENV = 'test';
});

afterAll(() => {
  // 全局测试清理
});
