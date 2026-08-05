// src/guardrail/audit-logger.ts
import { promises as fs } from 'fs';
import * as path from 'path';
import { createLogger } from '../observability/logger';
import type { GuardrailAction, GuardrailDecision } from './types';

const log = createLogger({ module: 'GuardrailAudit' });

export interface AuditLogEntry {
  userId: string;
  action: GuardrailAction;
  ruleName: string;
  reason: string;
  contentPreview: string;
  profile: { role: string; permissions: string[] };
  decision: GuardrailDecision;
}

export interface AuditLogRecord extends AuditLogEntry {
  timestamp: string;
  traceId: string;
}

export interface AuditLogConfig {
  dataDir: string;
}

export interface AuditQueryOptions {
  date?: string;
  userId?: string;
}

const PREVIEW_MAX = 200;
const DEFAULT_DATA_DIR = 'data';

class AuditLogger {
  private config: AuditLogConfig = { dataDir: DEFAULT_DATA_DIR };
  private writeQueue: Promise<void> = Promise.resolve();

  configure(config: Partial<AuditLogConfig>): void {
    if (config.dataDir) this.config.dataDir = config.dataDir;
  }

  async log(entry: AuditLogEntry): Promise<void> {
    const record: AuditLogRecord = {
      timestamp: new Date().toISOString(),
      traceId: this.generateTraceId(),
      ...entry,
      contentPreview: entry.contentPreview.slice(0, PREVIEW_MAX),
    };
    const line = JSON.stringify(record) + '\n';
    const filePath = this.datedFilePath();

    // 串行化写,避免并发漏写
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, line, 'utf-8');
      } catch (err) {
        log.error('audit log write failed', { filePath, error: err });
      }
    });
    await this.writeQueue;
  }

  async query(opts: AuditQueryOptions = {}): Promise<AuditLogRecord[]> {
    const filePath = this.datedFilePath(opts.date);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const entries = lines.map((line) => JSON.parse(line) as AuditLogRecord);
      if (opts.userId) return entries.filter((e) => e.userId === opts.userId);
      return entries;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private datedFilePath(date?: string): string {
    const d = date ?? new Date().toISOString().slice(0, 10);
    return path.join(this.config.dataDir, 'audit', `${d}.jsonl`);
  }

  private generateTraceId(): string {
    return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export const auditLogger = new AuditLogger();
