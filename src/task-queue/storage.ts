/**
 * 任务队列持久化存储
 * P0-3: 任务状态持久化
 */
import * as fs from 'fs';
import * as path from 'path';
import { Task } from '../types';

export class TaskQueueStorage {
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 1000;

  constructor(dataDir: string = 'data/task-queue') {
    this.filePath = path.join(dataDir, 'tasks.json');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /**
   * 保存任务快照（防抖）
   */
  save(tasks: Map<string, Task>): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.persist(tasks);
    }, this.DEBOUNCE_MS);
  }

  private persist(tasks: Map<string, Task>): void {
    try {
      const snapshot = Array.from(tasks.entries()).map(([id, task]) => {
        // 排除 imageAttachment（Buffer 无法 JSON 序列化）
        const { imageAttachment, ...rest } = task as any;
        return { id, ...rest };
      });
      // 原子写入：先写临时文件再 rename
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (error) {
      console.error('[TaskQueueStorage] 持久化失败:', error);
    }
  }

  /**
   * 加载任务快照
   */
  load(): Map<string, Task> {
    const tasks = new Map<string, Task>();
    try {
      if (!fs.existsSync(this.filePath)) {
        return tasks;
      }
      const data = fs.readFileSync(this.filePath, 'utf-8');
      const snapshot: any[] = JSON.parse(data);
      for (const item of snapshot) {
        const { id, ...task } = item;
        // 恢复 Date 对象
        if (task.createdAt) task.createdAt = new Date(task.createdAt);
        if (task.startedAt) task.startedAt = new Date(task.startedAt);
        if (task.completedAt) task.completedAt = new Date(task.completedAt);
        // running 状态重置为 pending
        if (task.status === 'running') {
          task.status = 'pending';
          console.log(`[TaskQueueStorage] 任务 ${id} 状态从 running 重置为 pending`);
        }
        // 确保任务对象有 id 字段
        task.id = id;
        tasks.set(id, task as Task);
      }
      console.log(`[TaskQueueStorage] 恢复了 ${tasks.size} 个任务`);
    } catch (error) {
      console.error('[TaskQueueStorage] 加载失败:', error);
    }
    return tasks;
  }
}
