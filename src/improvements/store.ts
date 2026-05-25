import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { ImprovementEntry, ImprovementStatus } from './types';

const DEFAULT_DIR = join(process.cwd(), 'improvements');

export class ImprovementStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || DEFAULT_DIR;
  }

  async create(entry: ImprovementEntry): Promise<void> {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
    const filePath = join(this.baseDir, `${entry.id}.json`);
    writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
  }

  getById(id: string): ImprovementEntry | null {
    const filePath = join(this.baseDir, `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  getAll(): ImprovementEntry[] {
    if (!existsSync(this.baseDir)) return [];
    try {
      const files = readdirSync(this.baseDir).filter(f => f.endsWith('.json'));
      return files.map(f => {
        try {
          return JSON.parse(readFileSync(join(this.baseDir, f), 'utf-8'));
        } catch {
          return null;
        }
      }).filter((e): e is ImprovementEntry => e !== null);
    } catch {
      return [];
    }
  }

  getPending(opts?: { skill?: string; limit?: number }): ImprovementEntry[] {
    const all = this.getAll();
    const filtered = all.filter(e =>
      e.status === 'pending' &&
      (!opts?.skill || e.skill === opts.skill || e.skill === 'general')
    );
    const prioOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
    filtered.sort((a, b) => (prioOrder[a.priority] ?? 2) - (prioOrder[b.priority] ?? 2));
    return opts?.limit ? filtered.slice(0, opts.limit) : filtered;
  }

  updateStatus(id: string, newStatus: ImprovementStatus): boolean {
    const entry = this.getById(id);
    if (!entry) return false;
    entry.status = newStatus;
    const filePath = join(this.baseDir, `${id}.json`);
    writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    return true;
  }
}
