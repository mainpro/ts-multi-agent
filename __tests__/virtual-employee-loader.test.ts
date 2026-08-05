// __tests__/virtual-employee-loader.test.ts
/**
 * Loader 测试:
 *  - FileEmployeeConfigProvider 从目录加载 *.json
 *  - 加载合法 → register 到 registry
 *  - 加载非法 → fail-fast(throw)
 *  - enabled=false → 跳过
 *  - loadAndRegister 统一入口
 *  - Provider 接口的可替换性(未来 RemoteEmployeeConfigProvider 走同流程)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileEmployeeConfigProvider, loadAndRegister, EmployeeConfigProvider } from '../src/agents/virtual-employee/loader';
import { VirtualEmployeeRegistry } from '../src/agents/virtual-employee/registry';
import { JsonEmployeeConfig } from '../src/agents/virtual-employee/json-types';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `loader-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await fs.mkdir(tmpDir, { recursive: true });
  VirtualEmployeeRegistry._reset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeJson(name: string, content: object | string): Promise<string> {
  const fullPath = path.join(tmpDir, name);
  const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  await fs.writeFile(fullPath, data, 'utf-8');
  return fullPath;
}

const VALID_EMP = {
  id: 'test-emp',
  displayName: '测试员',
  intentKeywords: ['OA'],
  isDefault: true,
};

describe('FileEmployeeConfigProvider', () => {
  test('加载目录里所有 *.json 并 parse', async () => {
    await writeJson('a.json', VALID_EMP);
    await writeJson('b.json', { ...VALID_EMP, id: 'b', displayName: 'B', isDefault: false });

    const provider = new FileEmployeeConfigProvider(tmpDir);
    const configs = await provider.loadAll();
    expect(configs).toHaveLength(2);
    expect(configs.map(c => c.id).sort()).toEqual(['b', 'test-emp']);
  });

  test('目录为空 → 返回空数组', async () => {
    const provider = new FileEmployeeConfigProvider(tmpDir);
    const configs = await provider.loadAll();
    expect(configs).toEqual([]);
  });

  test('目录不存在 → 返回空数组(fail-soft,不启动失败)', async () => {
    const nonExist = path.join(tmpDir, 'nope');
    const provider = new FileEmployeeConfigProvider(nonExist);
    const configs = await provider.loadAll();
    expect(configs).toEqual([]);
  });

  test('JSON 字段缺失 → fail-fast(throw)', async () => {
    await writeJson('bad.json', { id: 'x' }); // 缺 displayName / intentKeywords
    const provider = new FileEmployeeConfigProvider(tmpDir);
    expect(provider.loadAll()).rejects.toThrow(/JSON 校验失败/);
  });

  test('JSON 语法错误 → fail-fast(throw)', async () => {
    await writeJson('syntax.json', '{ this is not json }');
    const provider = new FileEmployeeConfigProvider(tmpDir);
    expect(provider.loadAll()).rejects.toThrow();
  });

  test('enabled=false → 跳过,不进 registry', async () => {
    await writeJson('disabled.json', { ...VALID_EMP, id: 'disabled', enabled: false });
    await writeJson('on.json', { ...VALID_EMP, id: 'on' });

    const provider = new FileEmployeeConfigProvider(tmpDir);
    const configs = await provider.loadAll();
    expect(configs.map(c => c.id)).toEqual(['on']);
  });

  test('*.json 之外的扩展名 → 忽略', async () => {
    await writeJson('a.json', VALID_EMP);
    await writeJson('readme.md', '# readme');
    await writeJson('config.txt', 'not json');

    const provider = new FileEmployeeConfigProvider(tmpDir);
    const configs = await provider.loadAll();
    expect(configs).toHaveLength(1);
  });
});

describe('loadAndRegister(provider)', () => {
  test('从文件系统加载并注册到 registry', async () => {
    await writeJson('a.json', VALID_EMP);
    await writeJson('b.json', { ...VALID_EMP, id: 'b', isDefault: false });

    const provider = new FileEmployeeConfigProvider(tmpDir);
    await loadAndRegister(provider);

    expect(VirtualEmployeeRegistry.list().map(c => c.id).sort()).toEqual(['b', 'test-emp']);
  });

  test('provider 是可替换的抽象(未来 RemoteEmployeeConfigProvider 走同流程)', async () => {
    // 用 in-memory provider 模拟未来 Remote API
    const fakeConfigs: JsonEmployeeConfig[] = [{
      id: 'fake',
      displayName: 'Fake',
      intentKeywords: ['X'],
      enabled: true,
      isDefault: false,
    }];

    class FakeProvider implements EmployeeConfigProvider {
      async loadAll(): Promise<JsonEmployeeConfig[]> {
        return fakeConfigs;
      }
    }

    const provider = new FakeProvider();
    await loadAndRegister(provider);

    expect(VirtualEmployeeRegistry.list().map(c => c.id)).toEqual(['fake']);
  });

  test('loadAndRegister 之后 getInstance 能拿到员工', async () => {
    await writeJson('only.json', VALID_EMP);
    const provider = new FileEmployeeConfigProvider(tmpDir);
    await loadAndRegister(provider);

    const emp = VirtualEmployeeRegistry.getInstance('test-emp', null as any, null as any);
    expect(emp).toBeDefined();
    expect(emp!.config.id).toBe('test-emp');
    expect(emp!.config.displayName).toBe('测试员');
  });
});
