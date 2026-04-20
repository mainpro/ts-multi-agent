import { createLogger } from '../observability/logger';

/**
 * Critic 审计架构配置接口
 */
export interface CriticConfig {
  /**
   * 是否启用 Critic 审计机制
   */
  enabled: boolean;
  
  /**
   * 专业技能目录路径
   */
  professionalSkillsDir: string;
  
  /**
   * 审查触发机制配置
   */
  triggers: {
    /**
     * 任务完成后自动触发审查
     */
    onTaskComplete: boolean;
    
    /**
     * 定期审查配置
     */
    scheduled: {
      /**
       * 是否启用定期审查
       */
      enabled: boolean;
      
      /**
       * 审查频率（cron表达式）
       */
      cronExpression: string;
      
      /**
       * 批量审查的最大任务数
       */
      batchSize: number;
    };
  };
  
  /**
   * 报告生成配置
   */
  reports: {
    /**
     * 每日报告配置
     */
    daily: {
      /**
       * 是否启用每日报告
       */
      enabled: boolean;
      
      /**
       * 生成时间（HH:MM格式）
       */
      generateTime: string;
    };
    
    /**
     * 每周报告配置
     */
    weekly: {
      /**
       * 是否启用每周报告
       */
      enabled: boolean;
      
      /**
       * 生成时间（HH:MM格式）
       */
      generateTime: string;
      
      /**
       * 生成星期（0-6，0表示周日）
       */
      dayOfWeek: number;
    };
    
    /**
     * 每月报告配置
     */
    monthly: {
      /**
       * 是否启用每月报告
       */
      enabled: boolean;
      
      /**
       * 生成时间（HH:MM格式）
       */
      generateTime: string;
      
      /**
       * 生成日期（1-31）
       */
      dayOfMonth: number;
    };
  };
  
  /**
   * 性能配置
   */
  performance: {
    /**
     * 审查超时时间（毫秒）
     */
    timeoutMs: number;
    
    /**
     * 最大并发审查任务数
     */
    maxConcurrentReviews: number;
    
    /**
     * 审查频率限制（毫秒）
     */
    rateLimitMs: number;
  };
  
  /**
   * 专业技能执行配置
   */
  skills: {
    /**
     * 技能执行超时时间（毫秒）
     */
    executionTimeoutMs: number;
    
    /**
     * 技能执行重试次数
     */
    maxRetries: number;
    
    /**
     * 启用的专业技能列表
     */
    enabledSkills: string[];
  };
  
  /**
   * 错误处理配置
   */
  errorHandling: {
    /**
     * 专业技能执行失败时是否继续审查
     */
    continueOnSkillFailure: boolean;
    
    /**
     * LLM调用失败时是否使用降级方案
     */
    useFallbackOnLLMFailure: boolean;
    
    /**
     * 审查失败时是否通知管理员
     */
    notifyOnFailure: boolean;
  };
  
  /**
   * 日志配置
   */
  logging: {
    /**
     * 日志级别
     */
    level: string;
    
    /**
     * 是否启用详细日志
     */
    detailed: boolean;
    
    /**
     * 日志文件路径
     */
    logFile: string;
  };
}

/**
 * 从环境变量加载配置
 */
function loadConfigFromEnv(): CriticConfig {
  const logger = createLogger({ module: 'CriticConfig' });
  
  try {
    return {
      enabled: process.env.CRITIC_ENABLED !== 'false',
      professionalSkillsDir: './professional-skills/',
      triggers: {
        onTaskComplete: true,
        scheduled: {
          enabled: true,
          cronExpression: '0 2 * * *',
          batchSize: 50
        }
      },
      reports: {
        daily: {
          enabled: true,
          generateTime: '03:00'
        },
        weekly: {
          enabled: true,
          generateTime: '03:30',
          dayOfWeek: 1
        },
        monthly: {
          enabled: true,
          generateTime: '04:00',
          dayOfMonth: 1
        }
      },
      performance: {
        timeoutMs: 30000,
        maxConcurrentReviews: 5,
        rateLimitMs: 1000
      },
      skills: {
        executionTimeoutMs: 15000,
        maxRetries: 2,
        enabledSkills: []
      },
      errorHandling: {
        continueOnSkillFailure: true,
        useFallbackOnLLMFailure: true,
        notifyOnFailure: false
      },
      logging: {
        level: 'info',
        detailed: false,
        logFile: './logs/critic.log'
      }
    };
  } catch (error) {
    logger.error('加载Critic配置失败，使用默认配置', error);
    return getDefaultConfig();
  }
}

/**
 * 获取默认配置
 */
function getDefaultConfig(): CriticConfig {
  return {
    enabled: true,
    professionalSkillsDir: './professional-skills/',
    triggers: {
      onTaskComplete: true,
      scheduled: {
        enabled: true,
        cronExpression: '0 2 * * *',
        batchSize: 50
      }
    },
    reports: {
      daily: {
        enabled: true,
        generateTime: '03:00'
      },
      weekly: {
        enabled: true,
        generateTime: '03:30',
        dayOfWeek: 1
      },
      monthly: {
        enabled: true,
        generateTime: '04:00',
        dayOfMonth: 1
      }
    },
    performance: {
      timeoutMs: 30000,
      maxConcurrentReviews: 5,
      rateLimitMs: 1000
    },
    skills: {
      executionTimeoutMs: 15000,
      maxRetries: 2,
      enabledSkills: []
    },
    errorHandling: {
      continueOnSkillFailure: true,
      useFallbackOnLLMFailure: true,
      notifyOnFailure: false
    },
    logging: {
      level: 'info',
      detailed: false,
      logFile: './logs/critic.log'
    }
  };
}

/**
 * Critic 配置
 */
export const criticConfig = loadConfigFromEnv();

/**
 * 检查Critic是否启用
 */
export function isCriticEnabled(): boolean {
  return criticConfig.enabled;
}

/**
 * 重新加载Critic配置
 */
export function reloadCriticConfig(): CriticConfig {
  return loadConfigFromEnv();
}

export default criticConfig;