/**
 * Memory 数据迁移(启动时一次性)
 *
 * 检测 data/.memory-version:
 * - 不存在 → 执行迁移,写入 v2
 * - 已是 v2 → 跳过
 *
 * 迁移操作:
 * 1. 旧 data/memory/{userId}/{sessionId}/session.json 拆分:
 *    - 状态机部分 → data/memory/{userId}/session/{sessionId}.json
 *    - 消息流 → data/memory/{userId}/history/{sessionId}.json
 * 2. 旧 data/memory/{userId}/messages.json 按 sessionId 分组迁移到 history/{sessionId}.json
 * 3. 旧文件重命名 .bak(保留 1 周后删除)
 * 4. 旧 knowledge.json 不迁移(格式不同),保留
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'MemoryMigrate' });

const TARGET_VERSION = 'v2';
const BAK_SUFFIX = '.bak';

interface LegacyMessageEntry {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: string;
  skill?: string;
  metadata?: Record<string, unknown>;
}

interface LegacyMessageData {
  entries: LegacyMessageEntry[];
  updatedAt: string;
}

interface LegacySession {
  sessionId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  requests: any[];
  activeRequestId: string | null;
}

/**
 * 检测并执行迁移(如果需要)
 */
export async function migrateMemoryIfNeeded(dataDir: string = 'data'): Promise<void> {
  const versionPath = path.join(dataDir, '.memory-version');

  try {
    const version = await fs.readFile(versionPath, 'utf-8').catch(() => null);
    if (version?.trim() === TARGET_VERSION) {
      return; // 已迁移
    }

    log.info(`[Migrate] 开始迁移到 ${TARGET_VERSION}...`);
    const memoryDir = path.join(dataDir, 'memory');

    if (!await dirExists(memoryDir)) {
      // 无旧数据,直接写版本号
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(versionPath, TARGET_VERSION, 'utf-8');
      log.info(`[Migrate] 无旧数据,版本设为 ${TARGET_VERSION}`);
      return;
    }

    // 遍历每个用户目录
    const userDirs = await fs.readdir(memoryDir);
    for (const userId of userDirs) {
      const userDir = path.join(memoryDir, userId);
      const stat = await fs.stat(userDir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      await migrateUser(dataDir, userId);
    }

    // 写入版本号
    await fs.writeFile(versionPath, TARGET_VERSION, 'utf-8');
    log.info(`[Migrate] ✅ 迁移完成,版本: ${TARGET_VERSION}`);
  } catch (e) {
    log.error(`[Migrate] 迁移失败:`, { error: e });
    // 不阻塞启动
  }
}

async function migrateUser(dataDir: string, userId: string): Promise<void> {
  const userMemoryDir = path.join(dataDir, 'memory', userId);

  // 1. 迁移 messages.json → history/{sessionId}.json
  await migrateMessagesJson(userMemoryDir, userId);

  // 2. 迁移 {sessionId}/session.json → session/{sessionId}.json + history/{sessionId}.json
  await migrateSessionDirs(userMemoryDir, userId);
}

async function migrateMessagesJson(userMemoryDir: string, userId: string): Promise<void> {
  const messagesPath = path.join(userMemoryDir, 'messages.json');
  const data = await readJson<LegacyMessageData>(messagesPath).catch(() => null);
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) return;

  // 按 sessionId 分组
  const grouped = new Map<string, LegacyMessageEntry[]>();
  const orphans: LegacyMessageEntry[] = [];

  for (const entry of data.entries) {
    const sessionId = (entry.metadata as any)?.sessionId as string | undefined;
    if (sessionId) {
      if (!grouped.has(sessionId)) grouped.set(sessionId, []);
      grouped.get(sessionId)!.push(entry);
    } else {
      orphans.push(entry);
    }
  }

  // 写入 history/{sessionId}.json
  const historyDir = path.join(userMemoryDir, 'history');
  await fs.mkdir(historyDir, { recursive: true });

  for (const [sessionId, entries] of grouped) {
    await writeHistoryEntries(historyDir, userId, sessionId, entries);
  }

  // 无 sessionId 的归入 legacy session
  if (orphans.length > 0) {
    await writeHistoryEntries(historyDir, userId, 'legacy', orphans);
  }

  // 旧文件重命名 .bak
  await backupFile(messagesPath);
  log.info(`[Migrate] 用户 ${userId}: messages.json 迁移 ${data.entries.length} 条`);
}

async function migrateSessionDirs(userMemoryDir: string, userId: string): Promise<void> {
  const entries = await fs.readdir(userMemoryDir).catch(() => []);
  const sessionDir = path.join(userMemoryDir, 'session');
  const historyDir = path.join(userMemoryDir, 'history');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(historyDir, { recursive: true });

  for (const entry of entries) {
    if (entry === 'history' || entry === 'session' || entry === 'summaries.json' || entry === 'knowledge.json' || entry.endsWith('.bak')) continue;

    const sessionSubdir = path.join(userMemoryDir, entry);
    const stat = await fs.stat(sessionSubdir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const sessionFile = path.join(sessionSubdir, 'session.json');
    const session = await readJson<LegacySession>(sessionFile).catch(() => null);
    if (!session) continue;

    // 1. 状态机部分 → session/{sessionId}.json
    //    (保持原样,但确保不包含 conversationContext 等内存字段)
    const newSessionPath = path.join(sessionDir, `${entry}.json`);
    await fs.writeFile(newSessionPath, JSON.stringify(session, null, 2), 'utf-8');

    // 2. 消息流 → history/{sessionId}.json
    //    从 requests[].content + questions + tasks.questions + result 提取
    const historyEntries = extractHistoryFromSession(session);
    if (historyEntries.length > 0) {
      await writeHistoryEntries(historyDir, userId, entry, historyEntries);
    }

    // 3. 旧目录重命名 .bak
    await backupFile(sessionSubdir);
    log.info(`[Migrate] 用户 ${userId}: session ${entry} 迁移完成`);
  }
}

function extractHistoryFromSession(session: LegacySession): LegacyMessageEntry[] {
  const entries: LegacyMessageEntry[] = [];
  const now = Date.now();

  for (const req of session.requests || []) {
    // 用户消息
    if (req.content) {
      entries.push({
        id: `mig-${now}-${Math.random().toString(36).substring(2, 7)}`,
        content: req.content,
        role: 'user',
        timestamp: req.createdAt || new Date().toISOString(),
        metadata: { sessionId: session.sessionId, requestId: req.requestId },
      });
    }

    // 请求级问答
    for (const qa of req.questions || []) {
      if (qa.content) {
        entries.push({
          id: `mig-${now}-${Math.random().toString(36).substring(2, 7)}`,
          content: qa.content,
          role: 'assistant',
          timestamp: qa.createdAt || new Date().toISOString(),
          skill: qa.skillName,
          metadata: { sessionId: session.sessionId, requestId: req.requestId },
        });
      }
      if (qa.answer) {
        entries.push({
          id: `mig-${now}-${Math.random().toString(36).substring(2, 7)}`,
          content: qa.answer,
          role: 'user',
          timestamp: qa.answeredAt || new Date().toISOString(),
          metadata: { sessionId: session.sessionId, requestId: req.requestId },
        });
      }
    }

    // 任务级问答
    for (const task of req.tasks || []) {
      for (const qa of task.questions || []) {
        if (qa.content) {
          entries.push({
            id: `mig-${now}-${Math.random().toString(36).substring(2, 7)}`,
            content: qa.content,
            role: 'assistant',
            timestamp: qa.createdAt || new Date().toISOString(),
            skill: qa.skillName || task.skillName,
            metadata: { sessionId: session.sessionId, requestId: req.requestId, taskId: task.taskId },
          });
        }
        if (qa.answer) {
          entries.push({
            id: `mig-${now}-${Math.random().toString(36).substring(2, 7)}`,
            content: qa.answer,
            role: 'user',
            timestamp: qa.answeredAt || new Date().toISOString(),
            metadata: { sessionId: session.sessionId, requestId: req.requestId, taskId: task.taskId },
          });
        }
      }
    }

    // 最终结果
    if (req.result && req.status === 'completed') {
      entries.push({
        id: `mig-${now}-${Math.random().toString(36).substring(2, 7)}`,
        content: req.result,
        role: 'assistant',
        timestamp: req.updatedAt || new Date().toISOString(),
        metadata: { sessionId: session.sessionId, requestId: req.requestId },
      });
    }
  }

  return entries;
}

async function writeHistoryEntries(historyDir: string, userId: string, sessionId: string, entries: LegacyMessageEntry[]): Promise<void> {
  const filePath = path.join(historyDir, `${sessionId}.json`);
  const now = new Date().toISOString();

  // 如果已存在,合并并按 (role, content, timestamp) 去重
  const existing = await readJson<any>(filePath).catch(() => null);
  const allEntries = existing?.entries ? [...existing.entries, ...entries] : entries;
  const deduped = dedupeEntries(allEntries);

  const file = {
    userId,
    sessionId,
    entries: deduped,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await fs.writeFile(filePath, JSON.stringify(file, null, 2), 'utf-8');
}

/**
 * 按 (role, content) 去重。
 * 同一条消息可能同时存在于新代码写的 L4 文件和旧 session.json 提取出的 entries 中,
 * 迁移时合并会产生重复。时间戳会有微秒级差异(写入时刻不同),不能作为去重键,
 * 改用 (role, content) — 同会话内同一角色的相同内容视为同一条消息。
 */
function dedupeEntries(entries: any[]): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const entry of entries) {
    const key = `${entry.role}|${entry.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

async function backupFile(filePath: string): Promise<void> {
  try {
    await fs.rename(filePath, filePath + BAK_SUFFIX);
  } catch (e) {
    // ignore
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export default { migrateMemoryIfNeeded };
