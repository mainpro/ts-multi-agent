import * as fs from 'fs';
import * as path from 'path';
import { CriticAnalysis } from '../types';
import { createLogger } from '../observability/logger';

/**
 * ReportGenerator - 审查报告生成器
 * 
 * 核心功能：
 * - 生成每日审查报告
 * - 生成每周审查报告
 * - 生成月度审查报告
 * - 支持报告的格式化和存储
 */
export class ReportGenerator {
  private baseDir: string;
  private logger;

  constructor() {
    this.baseDir = './data/reports';
    this.logger = createLogger({ module: 'ReportGenerator' });
    this.ensureDirectories();
  }

  /**
   * 确保报告目录存在
   */
  private ensureDirectories(): void {
    const dirs = [
      path.join(this.baseDir, 'critic', 'daily'),
      path.join(this.baseDir, 'critic', 'weekly'),
      path.join(this.baseDir, 'critic', 'monthly'),
      path.join(this.baseDir, 'performance'),
      path.join(this.baseDir, 'compliance'),
    ];
    
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * 生成每日审查报告
   * @param date 日期
   * @param analyses 审查分析结果
   * @returns 报告文件路径
   */
  async generateDailyCriticReport(date: Date, analyses: CriticAnalysis[]): Promise<string> {
    const dateStr = date.toISOString().split('T')[0];
    const reportFile = path.join(this.baseDir, 'critic', 'daily', `${dateStr}.md`);
    
    const reportData = this.prepareReportData(analyses);
    const markdownContent = this.generateCriticReportMarkdown(reportData, 'daily');
    
    fs.writeFileSync(reportFile, markdownContent);
    this.logger.info(`生成每日审查报告: ${reportFile}`);
    
    return reportFile;
  }

  /**
   * 生成每周审查报告
   * @param year 年份
   * @param week 周数
   * @param analyses 审查分析结果
   * @returns 报告文件路径
   */
  async generateWeeklyCriticReport(year: number, week: number, analyses: CriticAnalysis[]): Promise<string> {
    const reportFile = path.join(this.baseDir, 'critic', 'weekly', `${year}-W${week}.md`);
    
    const reportData = this.prepareReportData(analyses);
    const markdownContent = this.generateCriticReportMarkdown(reportData, 'weekly');
    
    fs.writeFileSync(reportFile, markdownContent);
    this.logger.info(`生成每周审查报告: ${reportFile}`);
    
    return reportFile;
  }

  /**
   * 生成月度审查报告
   * @param year 年份
   * @param month 月份
   * @param analyses 审查分析结果
   * @returns 报告文件路径
   */
  async generateMonthlyCriticReport(year: number, month: number, analyses: CriticAnalysis[]): Promise<string> {
    const monthStr = month.toString().padStart(2, '0');
    const reportFile = path.join(this.baseDir, 'critic', 'monthly', `${year}-${monthStr}.md`);
    
    const reportData = this.prepareReportData(analyses);
    const markdownContent = this.generateCriticReportMarkdown(reportData, 'monthly');
    
    fs.writeFileSync(reportFile, markdownContent);
    this.logger.info(`生成月度审查报告: ${reportFile}`);
    
    return reportFile;
  }

  /**
   * 准备报告数据
   * @param analyses 审查分析结果
   * @returns 报告数据
   */
  private prepareReportData(analyses: CriticAnalysis[]): any {
    const totalTasks = analyses.length;
    const totalIssues = analyses.reduce((sum, analysis) => sum + analysis.issues.length, 0);
    const highPriorityIssues = analyses.reduce((sum, analysis) => {
      return sum + analysis.issues.filter(issue => issue.severity === 'high').length;
    }, 0);
    
    // 分析问题类型分布
    const issueTypes = new Map<string, number>();
    const severityDistribution = new Map<string, number>();
    
    for (const analysis of analyses) {
      for (const issue of analysis.issues) {
        issueTypes.set(issue.type, (issueTypes.get(issue.type) || 0) + 1);
        severityDistribution.set(issue.severity, (severityDistribution.get(issue.severity) || 0) + 1);
      }
    }
    
    // 提取主要问题
    const topIssues = this.extractTopIssues(analyses, 5);
    
    // 提取优化建议
    const topSuggestions = this.extractTopSuggestions(analyses, 5);
    
    return {
      totalTasks,
      totalIssues,
      highPriorityIssues,
      issueTypes: Object.fromEntries(issueTypes),
      severityDistribution: Object.fromEntries(severityDistribution),
      topIssues,
      topSuggestions,
      analyses
    };
  }

  /**
   * 提取主要问题
   * @param analyses 审查分析结果
   * @param limit 限制数量
   * @returns 主要问题列表
   */
  private extractTopIssues(analyses: CriticAnalysis[], limit: number): any[] {
    const issueMap = new Map<string, {
      description: string;
      count: number;
      severity: string;
      evidence: string;
    }>();
    
    for (const analysis of analyses) {
      for (const issue of analysis.issues) {
        const key = issue.description;
        if (!issueMap.has(key)) {
          issueMap.set(key, {
            description: issue.description,
            count: 0,
            severity: issue.severity,
            evidence: issue.evidence
          });
        }
        issueMap.get(key)!.count++;
      }
    }
    
    return Array.from(issueMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * 提取优化建议
   * @param analyses 审查分析结果
   * @param limit 限制数量
   * @returns 优化建议列表
   */
  private extractTopSuggestions(analyses: CriticAnalysis[], limit: number): any[] {
    const suggestionMap = new Map<string, {
      description: string;
      count: number;
      priority: string;
      implementationSteps: string[];
    }>();
    
    for (const analysis of analyses) {
      for (const suggestion of analysis.solutions) {
        const key = suggestion.description;
        if (!suggestionMap.has(key)) {
          suggestionMap.set(key, {
            description: suggestion.description,
            count: 0,
            priority: suggestion.priority,
            implementationSteps: suggestion.implementationSteps
          });
        }
        suggestionMap.get(key)!.count++;
      }
    }
    
    return Array.from(suggestionMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * 生成审查报告Markdown
   * @param reportData 报告数据
   * @param reportType 报告类型
   * @returns Markdown内容
   */
  private generateCriticReportMarkdown(reportData: any, reportType: 'daily' | 'weekly' | 'monthly'): string {
    let markdown = `# 智能体审查报告

`;
    
    // 报告类型和时间
    const now = new Date();
    markdown += `## 报告信息
`;
    markdown += `- **报告类型**: ${reportType === 'daily' ? '每日' : reportType === 'weekly' ? '每周' : '月度'}
`;
    markdown += `- **生成时间**: ${now.toISOString()}
`;
    markdown += `- **审查任务数**: ${reportData.totalTasks}
`;
    markdown += `- **发现问题数**: ${reportData.totalIssues}
`;
    markdown += `- **高优先级问题**: ${reportData.highPriorityIssues}
`;
    markdown += `- **建议实施率**: 0% (待统计)

`;
    
    // 问题类型分布
    if (Object.keys(reportData.issueTypes).length > 0) {
      markdown += `## 问题类型分布
`;
      for (const [type, count] of Object.entries(reportData.issueTypes)) {
        markdown += `- **${type}**: ${count}个
`;
      }
      markdown += `
`;
    }
    
    // 严重程度分布
    if (Object.keys(reportData.severityDistribution).length > 0) {
      markdown += `## 严重程度分布
`;
      for (const [severity, count] of Object.entries(reportData.severityDistribution)) {
        markdown += `- **${severity}**: ${count}个
`;
      }
      markdown += `
`;
    }
    
    // 主要问题
    if (reportData.topIssues.length > 0) {
      markdown += `## 主要问题
`;
      reportData.topIssues.forEach((issue: any, index: number) => {
        markdown += `### ${index + 1}. ${issue.description}
`;
        markdown += `- **出现次数**: ${issue.count}
`;
        markdown += `- **严重程度**: ${issue.severity}
`;
        markdown += `- **证据**: ${issue.evidence}

`;
      });
    }
    
    // 优化建议
    if (reportData.topSuggestions.length > 0) {
      markdown += `## 优化建议
`;
      reportData.topSuggestions.forEach((suggestion: any, index: number) => {
        markdown += `### ${index + 1}. ${suggestion.description}
`;
        markdown += `- **出现次数**: ${suggestion.count}
`;
        markdown += `- **优先级**: ${suggestion.priority}
`;
        markdown += `- **实施步骤**:
`;
        suggestion.implementationSteps.forEach((step: string) => {
          markdown += `  - ${step}
`;
        });
        markdown += `
`;
      });
    }
    
    // 详细分析
    if (reportData.analyses.length > 0) {
      markdown += `## 详细分析
`;
      reportData.analyses.forEach((analysis: CriticAnalysis) => {
        markdown += `### 任务: ${analysis.taskId}
`;
        markdown += `- **智能体类型**: ${analysis.agentType}
`;
        markdown += `- **分析时间**: ${analysis.analysisTime}
`;
        markdown += `- **置信度**: ${(analysis.confidence * 100).toFixed(2)}%
`;
        
        if (analysis.issues.length > 0) {
          markdown += `- **问题**:
`;
          analysis.issues.forEach((issue) => {
            markdown += `  - ${issue.type} (${issue.severity}): ${issue.description}
`;
          });
        }
        
        if (analysis.solutions.length > 0) {
          markdown += `- **建议**:
`;
          analysis.solutions.forEach((solution) => {
            markdown += `  - ${solution.description} (${solution.priority})
`;
          });
        }
        markdown += `
`;
      });
    }
    
    return markdown;
  }

  /**
   * 生成性能报告
   * @param metrics 性能指标
   * @returns 报告文件路径
   */
  async generatePerformanceReport(metrics: any): Promise<string> {
    const dateStr = new Date().toISOString().split('T')[0];
    const reportFile = path.join(this.baseDir, 'performance', `${dateStr}.md`);
    
    let markdown = `# 性能报告

`;
    markdown += `## 报告信息
`;
    markdown += `- **生成时间**: ${new Date().toISOString()}

`;
    markdown += `## 性能指标
`;
    
    for (const [key, value] of Object.entries(metrics)) {
      markdown += `- **${key}**: ${value}
`;
    }
    
    fs.writeFileSync(reportFile, markdown);
    this.logger.info(`生成性能报告: ${reportFile}`);
    
    return reportFile;
  }

  /**
   * 生成合规报告
   * @param complianceData 合规数据
   * @returns 报告文件路径
   */
  async generateComplianceReport(complianceData: any): Promise<string> {
    const dateStr = new Date().toISOString().split('T')[0];
    const reportFile = path.join(this.baseDir, 'compliance', `${dateStr}.md`);
    
    let markdown = `# 合规报告

`;
    markdown += `## 报告信息
`;
    markdown += `- **生成时间**: ${new Date().toISOString()}

`;
    markdown += `## 合规状态
`;
    
    for (const [key, value] of Object.entries(complianceData)) {
      markdown += `- **${key}**: ${value}
`;
    }
    
    fs.writeFileSync(reportFile, markdown);
    this.logger.info(`生成合规报告: ${reportFile}`);
    
    return reportFile;
  }

  /**
   * 获取报告列表
   * @param reportType 报告类型
   * @returns 报告文件列表
   */
  getReportList(reportType: 'critic' | 'performance' | 'compliance', subType?: 'daily' | 'weekly' | 'monthly'): string[] {
    let reportDir = path.join(this.baseDir, reportType);
    if (subType) {
      reportDir = path.join(reportDir, subType);
    }
    
    if (!fs.existsSync(reportDir)) {
      return [];
    }
    
    const files = fs.readdirSync(reportDir);
    return files
      .filter(file => file.endsWith('.md'))
      .map(file => path.join(reportDir, file));
  }

  /**
   * 读取报告内容
   * @param reportPath 报告路径
   * @returns 报告内容
   */
  readReport(reportPath: string): string {
    if (!fs.existsSync(reportPath)) {
      throw new Error(`报告文件不存在: ${reportPath}`);
    }
    return fs.readFileSync(reportPath, 'utf-8');
  }
}

// 导出单例实例
export const reportGenerator = new ReportGenerator();
export default ReportGenerator;