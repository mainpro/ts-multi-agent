import * as fs from 'fs';
import * as path from 'path';
import { createLogger, Logger } from './logger';

/**
 * 日志配置
 */
export const LOGGING_CONFIG = {
  // 日志级别
  level: process.env.LOG_LEVEL || 'info',
  
  // 日志存储配置
  storage: {
    enabled: process.env.LOG_STORAGE_ENABLED === 'true',
    baseDir: process.env.LOG_DIR || './data/logs',
    retentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '30'),
    maxFileSize: parseInt(process.env.LOG_MAX_FILE_SIZE || '10485760'), // 10MB
  },
  
  // 日志轮转配置
  rotation: {
    enabled: process.env.LOG_ROTATION_ENABLED === 'true',
    interval: process.env.LOG_ROTATION_INTERVAL || 'daily',
  },
};

/**
 * LogManager - 统一日志管理器
 * 
 * 核心功能：
 * - 管理不同模块的日志实例
 * - 实现日志的分类存储
 * - 支持日志轮转
 * - 集成到现有系统
 */
export class LogManager {
  private loggers: Map<string, Logger> = new Map();
  private storageEnabled: boolean;
  private baseDir: string;
  private retentionDays: number;
  private maxFileSize: number;
  private rotationEnabled: boolean;
  private rotationInterval: string;

  constructor() {
    this.storageEnabled = LOGGING_CONFIG.storage.enabled;
    this.baseDir = LOGGING_CONFIG.storage.baseDir;
    this.retentionDays = LOGGING_CONFIG.storage.retentionDays;
    this.maxFileSize = LOGGING_CONFIG.storage.maxFileSize;
    this.rotationEnabled = LOGGING_CONFIG.rotation.enabled;
    this.rotationInterval = LOGGING_CONFIG.rotation.interval;
    
    if (this.storageEnabled) {
      this.ensureDirectories();
      this.startCleanupTask();
    }
  }

  /**
   * 确保日志目录存在
   */
  private ensureDirectories(): void {
    const dirs = [
      path.join(this.baseDir, 'system'),
      path.join(this.baseDir, 'interaction'),
      path.join(this.baseDir, 'task'),
      path.join(this.baseDir, 'audit'),
    ];
    
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * 获取日志实例
   * @param context 上下文信息
   * @returns 日志实例
   */
  getLogger(context: { module: string; [key: string]: string }): Logger {
    const key = context.module;
    if (!this.loggers.has(key)) {
      const logger = createLogger(context);
      this.loggers.set(key, logger);
    }
    return this.loggers.get(key)!;
  }

  /**
   * 写入交互日志
   * @param userId 用户ID
   * @param logData 日志数据
   */
  async writeInteractionLog(userId: string, logData: any): Promise<void> {
    if (!this.storageEnabled) return;
    
    const today = new Date().toISOString().split('T')[0];
    const userDir = path.join(this.baseDir, 'interaction', `user-${userId}`);
    const logFile = path.join(userDir, `${today}.json`);
    
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    let existingLogs: any[] = [];
    if (fs.existsSync(logFile)) {
      try {
        const content = fs.readFileSync(logFile, 'utf-8');
        existingLogs = JSON.parse(content);
      } catch (error) {
        existingLogs = [];
      }
    }
    
    existingLogs.push({
      ...logData,
      timestamp: new Date().toISOString(),
    });
    
    // 检查文件大小
    if (this.checkFileSize(logFile)) {
      this.rotateLogFile(logFile);
    }
    
    fs.writeFileSync(logFile, JSON.stringify(existingLogs, null, 2));
  }

  /**
   * 写入任务执行日志
   * @param taskId 任务ID
   * @param logData 日志数据
   */
  async writeTaskLog(taskId: string, logData: any): Promise<void> {
    if (!this.storageEnabled) return;
    
    const today = new Date().toISOString().split('T')[0];
    const taskDir = path.join(this.baseDir, 'task', today);
    const logFile = path.join(taskDir, `${taskId}.json`);
    
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }
    
    // 检查文件大小
    if (this.checkFileSize(logFile)) {
      this.rotateLogFile(logFile);
    }
    
    fs.writeFileSync(logFile, JSON.stringify(logData, null, 2));
  }

  /**
   * 写入系统日志
   * @param logData 日志数据
   */
  async writeSystemLog(logData: any): Promise<void> {
    if (!this.storageEnabled) return;
    
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.baseDir, 'system', `app-${today}.log`);
    
    // 检查文件大小
    if (this.checkFileSize(logFile)) {
      this.rotateLogFile(logFile);
    }
    
    const logEntry = {
      ...logData,
      timestamp: new Date().toISOString(),
    };
    
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  }

  /**
   * 写入审计日志
   * @param logData 日志数据
   */
  async writeAuditLog(logData: any): Promise<void> {
    if (!this.storageEnabled) return;
    
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.baseDir, 'audit', `${today}.json`);
    
    let existingLogs: any[] = [];
    if (fs.existsSync(logFile)) {
      try {
        const content = fs.readFileSync(logFile, 'utf-8');
        existingLogs = JSON.parse(content);
      } catch (error) {
        existingLogs = [];
      }
    }
    
    existingLogs.push({
      ...logData,
      timestamp: new Date().toISOString(),
    });
    
    // 检查文件大小
    if (this.checkFileSize(logFile)) {
      this.rotateLogFile(logFile);
    }
    
    fs.writeFileSync(logFile, JSON.stringify(existingLogs, null, 2));
  }

  /**
   * 检查文件大小
   * @param filePath 文件路径
   * @returns 是否需要轮转
   */
  private checkFileSize(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    
    const stats = fs.statSync(filePath);
    return stats.size > this.maxFileSize;
  }

  /**
   * 轮转日志文件
   * @param filePath 文件路径
   */
  private rotateLogFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const ext = path.extname(baseName);
    const name = path.basename(baseName, ext);
    
    const rotatedPath = path.join(dir, `${name}-${timestamp}${ext}`);
    fs.renameSync(filePath, rotatedPath);
  }

  /**
   * 启动清理任务
   */
  private startCleanupTask(): void {
    // 每天清理一次过期日志
    setInterval(() => {
      this.cleanupExpiredLogs();
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * 清理过期日志
   */
  private cleanupExpiredLogs(): void {
    const now = new Date().getTime();
    const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
    
    const cleanupDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          cleanupDir(fullPath);
        } else {
          const stats = fs.statSync(fullPath);
          if (now - stats.mtime.getTime() > retentionMs) {
            fs.unlinkSync(fullPath);
          }
        }
      }
    };
    
    cleanupDir(this.baseDir);
  }

  /**
   * 获取日志统计信息
   * @returns 统计信息
   */
  getLogStats(): any {
    const stats = {
      directories: {
        system: 0,
        interaction: 0,
        task: 0,
        audit: 0,
      },
      totalFiles: 0,
      totalSize: 0,
    };
    
    if (!this.storageEnabled) return stats;
    
    const calculateStats = (dir: string, type: keyof typeof stats.directories) => {
      if (!fs.existsSync(dir)) return;
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          calculateStats(fullPath, type);
        } else {
          stats.directories[type]++;
          stats.totalFiles++;
          const fileStats = fs.statSync(fullPath);
          stats.totalSize += fileStats.size;
        }
      }
    };
    
    calculateStats(path.join(this.baseDir, 'system'), 'system');
    calculateStats(path.join(this.baseDir, 'interaction'), 'interaction');
    calculateStats(path.join(this.baseDir, 'task'), 'task');
    calculateStats(path.join(this.baseDir, 'audit'), 'audit');
    
    return stats;
  }
}

// 导出单例实例
export const logManager = new LogManager();
export default LogManager;