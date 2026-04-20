import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../observability/logger';

/**
 * 优化建议状态
 */
export type SuggestionStatus = 'pending' | 'in_progress' | 'implemented' | 'rejected' | 'deferred';

/**
 * 优化建议优先级
 */
export type SuggestionPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * 优化建议类型
 */
export type SuggestionType = 'skill' | 'agent' | 'system' | 'process';

/**
 * 优化建议接口
 */
export interface OptimizationSuggestion {
  id: string;
  description: string;
  type: SuggestionType;
  priority: SuggestionPriority;
  status: SuggestionStatus;
  createdAt: Date;
  updatedAt: Date;
  implementationSteps: string[];
  relatedSkills?: string[];
  relatedAgents?: string[];
  evidence?: string;
  severity?: 'low' | 'medium' | 'high';
  impact?: string;
  implementationEstimate?: number; // 预计实施时间（小时）
  implementedBy?: string;
  implementedAt?: Date;
  rejectionReason?: string;
  deferralReason?: string;
  deferralDate?: Date;
}

/**
 * OptimizationRepository - 优化建议知识库
 * 
 * 核心功能：
 * - 存储和管理优化建议
 * - 支持建议的分类和优先级评估
 * - 跟踪建议的实施状态
 * - 提供建议查询和统计功能
 */
export class OptimizationRepository {
  private baseDir: string;
  private suggestionsFile: string;
  private logger;
  private suggestions: Map<string, OptimizationSuggestion> = new Map();

  constructor() {
    this.baseDir = './data/knowledge';
    this.suggestionsFile = path.join(this.baseDir, 'optimization-suggestions.json');
    this.logger = createLogger({ module: 'OptimizationRepository' });
    this.ensureDirectory();
    this.loadSuggestions();
  }

  /**
   * 确保目录存在
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * 加载建议
   */
  private loadSuggestions(): void {
    if (fs.existsSync(this.suggestionsFile)) {
      try {
        const content = fs.readFileSync(this.suggestionsFile, 'utf-8');
        const suggestions = JSON.parse(content);
        
        // 转换日期字符串为Date对象
        for (const suggestion of suggestions) {
          suggestion.createdAt = new Date(suggestion.createdAt);
          suggestion.updatedAt = new Date(suggestion.updatedAt);
          if (suggestion.implementedAt) {
            suggestion.implementedAt = new Date(suggestion.implementedAt);
          }
          if (suggestion.deferralDate) {
            suggestion.deferralDate = new Date(suggestion.deferralDate);
          }
          this.suggestions.set(suggestion.id, suggestion);
        }
        
        this.logger.info(`加载了 ${this.suggestions.size} 条优化建议`);
      } catch (error) {
        this.logger.error('加载优化建议失败', error);
        this.suggestions.clear();
      }
    }
  }

  /**
   * 保存建议
   */
  private saveSuggestions(): void {
    try {
      const suggestions = Array.from(this.suggestions.values());
      fs.writeFileSync(this.suggestionsFile, JSON.stringify(suggestions, null, 2));
      this.logger.debug(`保存了 ${suggestions.length} 条优化建议`);
    } catch (error) {
      this.logger.error('保存优化建议失败', error);
    }
  }

  /**
   * 创建优化建议
   * @param suggestion 建议数据
   * @returns 建议ID
   */
  createSuggestion(suggestion: Omit<OptimizationSuggestion, 'id' | 'createdAt' | 'updatedAt' | 'status'>): string {
    const id = `suggestion-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const newSuggestion: OptimizationSuggestion = {
      ...suggestion,
      id,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    this.suggestions.set(id, newSuggestion);
    this.saveSuggestions();
    this.logger.info(`创建了新的优化建议: ${id}`);
    
    return id;
  }

  /**
   * 获取建议
   * @param id 建议ID
   * @returns 建议对象
   */
  getSuggestion(id: string): OptimizationSuggestion | undefined {
    return this.suggestions.get(id);
  }

  /**
   * 获取所有建议
   * @returns 建议列表
   */
  getAllSuggestions(): OptimizationSuggestion[] {
    return Array.from(this.suggestions.values());
  }

  /**
   * 按状态获取建议
   * @param status 状态
   * @returns 建议列表
   */
  getSuggestionsByStatus(status: SuggestionStatus): OptimizationSuggestion[] {
    return Array.from(this.suggestions.values()).filter(s => s.status === status);
  }

  /**
   * 按优先级获取建议
   * @param priority 优先级
   * @returns 建议列表
   */
  getSuggestionsByPriority(priority: SuggestionPriority): OptimizationSuggestion[] {
    return Array.from(this.suggestions.values()).filter(s => s.priority === priority);
  }

  /**
   * 按类型获取建议
   * @param type 类型
   * @returns 建议列表
   */
  getSuggestionsByType(type: SuggestionType): OptimizationSuggestion[] {
    return Array.from(this.suggestions.values()).filter(s => s.type === type);
  }

  /**
   * 按技能获取建议
   * @param skillName 技能名称
   * @returns 建议列表
   */
  getSuggestionsBySkill(skillName: string): OptimizationSuggestion[] {
    return Array.from(this.suggestions.values()).filter(s => 
      s.relatedSkills?.includes(skillName)
    );
  }

  /**
   * 更新建议状态
   * @param id 建议ID
   * @param status 新状态
   * @param metadata 附加元数据
   * @returns 是否成功
   */
  updateSuggestionStatus(id: string, status: SuggestionStatus, metadata?: any): boolean {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) {
      this.logger.warn(`建议不存在: ${id}`);
      return false;
    }
    
    suggestion.status = status;
    suggestion.updatedAt = new Date();
    
    if (metadata) {
      if (status === 'implemented' && metadata.implementedBy) {
        suggestion.implementedBy = metadata.implementedBy;
        suggestion.implementedAt = new Date();
      } else if (status === 'rejected' && metadata.rejectionReason) {
        suggestion.rejectionReason = metadata.rejectionReason;
      } else if (status === 'deferred' && metadata.deferralReason) {
        suggestion.deferralReason = metadata.deferralReason;
        suggestion.deferralDate = new Date();
      }
    }
    
    this.suggestions.set(id, suggestion);
    this.saveSuggestions();
    this.logger.info(`更新建议状态: ${id} -> ${status}`);
    
    return true;
  }

  /**
   * 更新建议
   * @param id 建议ID
   * @param updates 更新内容
   * @returns 是否成功
   */
  updateSuggestion(id: string, updates: Partial<OptimizationSuggestion>): boolean {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) {
      this.logger.warn(`建议不存在: ${id}`);
      return false;
    }
    
    Object.assign(suggestion, updates);
    suggestion.updatedAt = new Date();
    
    this.suggestions.set(id, suggestion);
    this.saveSuggestions();
    this.logger.info(`更新建议: ${id}`);
    
    return true;
  }

  /**
   * 删除建议
   * @param id 建议ID
   * @returns 是否成功
   */
  deleteSuggestion(id: string): boolean {
    const removed = this.suggestions.delete(id);
    if (removed) {
      this.saveSuggestions();
      this.logger.info(`删除建议: ${id}`);
    } else {
      this.logger.warn(`建议不存在: ${id}`);
    }
    return removed;
  }

  /**
   * 获取建议统计信息
   * @returns 统计信息
   */
  getSuggestionStats(): any {
    const stats = {
      total: this.suggestions.size,
      byStatus: {} as Record<SuggestionStatus, number>,
      byPriority: {} as Record<SuggestionPriority, number>,
      byType: {} as Record<SuggestionType, number>,
      implementationRate: 0,
      averageAge: 0,
    };
    
    // 初始化统计对象
    const statuses: SuggestionStatus[] = ['pending', 'in_progress', 'implemented', 'rejected', 'deferred'];
    statuses.forEach(status => {
      stats.byStatus[status] = 0;
    });
    const priorities: SuggestionPriority[] = ['low', 'medium', 'high', 'critical'];
    priorities.forEach(priority => {
      stats.byPriority[priority] = 0;
    });
    const types: SuggestionType[] = ['skill', 'agent', 'system', 'process'];
    types.forEach(type => {
      stats.byType[type] = 0;
    });
    
    let totalAge = 0;
    let implementedCount = 0;
    
    for (const suggestion of this.suggestions.values()) {
      stats.byStatus[suggestion.status]++;
      stats.byPriority[suggestion.priority]++;
      stats.byType[suggestion.type]++;
      
      if (suggestion.status === 'implemented') {
        implementedCount++;
      }
      
      const age = Date.now() - suggestion.createdAt.getTime();
      totalAge += age;
    }
    
    stats.implementationRate = this.suggestions.size > 0 
      ? (implementedCount / this.suggestions.size) * 100 
      : 0;
    stats.averageAge = this.suggestions.size > 0 
      ? totalAge / this.suggestions.size / (1000 * 60 * 60 * 24) // 转换为天
      : 0;
    
    return stats;
  }

  /**
   * 批量导入建议
   * @param suggestions 建议列表
   * @returns 导入数量
   */
  importSuggestions(suggestions: Array<Omit<OptimizationSuggestion, 'id' | 'createdAt' | 'updatedAt' | 'status'>>): number {
    let count = 0;
    for (const suggestionData of suggestions) {
      this.createSuggestion(suggestionData);
      count++;
    }
    return count;
  }

  /**
   * 导出建议
   * @param filter 过滤条件
   * @returns 建议列表
   */
  exportSuggestions(filter?: {
    status?: SuggestionStatus;
    priority?: SuggestionPriority;
    type?: SuggestionType;
  }): OptimizationSuggestion[] {
    let suggestions = Array.from(this.suggestions.values());
    
    if (filter) {
      if (filter.status) {
        suggestions = suggestions.filter(s => s.status === filter.status);
      }
      if (filter.priority) {
        suggestions = suggestions.filter(s => s.priority === filter.priority);
      }
      if (filter.type) {
        suggestions = suggestions.filter(s => s.type === filter.type);
      }
    }
    
    return suggestions;
  }

  /**
   * 清理过期建议
   * @param days 过期天数
   * @returns 清理数量
   */
  cleanupOldSuggestions(days: number = 90): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    let count = 0;
    const toDelete: string[] = [];
    
    for (const [id, suggestion] of this.suggestions.entries()) {
      if (suggestion.createdAt < cutoffDate && 
          (suggestion.status === 'implemented' || suggestion.status === 'rejected')) {
        toDelete.push(id);
      }
    }
    
    for (const id of toDelete) {
      this.suggestions.delete(id);
      count++;
    }
    
    if (count > 0) {
      this.saveSuggestions();
      this.logger.info(`清理了 ${count} 条过期建议`);
    }
    
    return count;
  }
}

// 导出单例实例
export const optimizationRepository = new OptimizationRepository();
export default OptimizationRepository;