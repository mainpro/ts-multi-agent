import { ClaudeMdLoader } from './claude-md-loader';
import { MemoryService, UserMemory } from '../memory/memory-service';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitStatus {
  branch: string | null;
  lastCommit: string | null;
}

export interface DynamicContextConfig {
  projectRoot?: string;
  memoryDataDir?: string;
}

export class DynamicContextBuilder {
  private claudeMdLoader: ClaudeMdLoader;
  private memoryService: MemoryService;
  private projectRoot: string;

  constructor(config: DynamicContextConfig = {}) {
    this.projectRoot = config.projectRoot || process.cwd();
    this.claudeMdLoader = new ClaudeMdLoader(this.projectRoot);
    const memoryDir = config.memoryDataDir || 'data';
    this.memoryService = new MemoryService(memoryDir, {
      storagePath: `${memoryDir}/memory`,
    });
  }

  /**
   * Build dynamic context string from all sources
   *
   * @param userInput - User's input for memory recall
   * @param userId - User identifier for memory lookup (default: 'default')
   * @returns Formatted context string
   */
  async build(userInput: string, userId: string = 'default'): Promise<string> {
    // Load all sources in parallel for efficiency
    const [claudeMdContent, gitStatus, userMemory] = await Promise.all([
      this.loadClaudeMd(),
      this.getGitStatus(),
      this.loadMemory(userId),
    ]);

    // Build structured context string
    const sections: string[] = [];

    // 1. CLAUDE.md Configuration
    if (claudeMdContent) {
      sections.push(this.formatClaudeMdSection(claudeMdContent));
    }

    // 2. Git Status
    if (gitStatus.branch || gitStatus.lastCommit) {
      sections.push(this.formatGitSection(gitStatus));
    }

    // 3. Memory Recall
    if (userMemory) {
      sections.push(this.formatMemorySection(userMemory, userInput));
    }

    return sections.join('\n\n');
  }

  /**
   * Load CLAUDE.md content from all hierarchy levels
   */
  private async loadClaudeMd(): Promise<string> {
    try {
      return await this.claudeMdLoader.loadAll();
    } catch (error) {
      // Return empty string on error (graceful degradation)
      console.error('Error loading CLAUDE.md:', error);
      return '';
    }
  }

  /**
   * Get Git repository status
   * Returns null values if not in a Git repository
   */
  private async getGitStatus(): Promise<GitStatus> {
    const status: GitStatus = {
      branch: null,
      lastCommit: null,
    };

    try {
      // Get current branch
      const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectRoot,
        timeout: 5000, // 5 second timeout
      });
      status.branch = branch.trim();

      // Get last commit
      const { stdout: lastCommit } = await execAsync('git log -1 --oneline', {
        cwd: this.projectRoot,
        timeout: 5000,
      });
      status.lastCommit = lastCommit.trim();
    } catch (error) {
      // Not a Git repository or Git command failed
      // Return null values (graceful handling)
      console.error('Error getting Git status:', error);
    }

    return status;
  }

  /**
   * Load user memory (profile + conversation history)
   */
  private async loadMemory(userId: string): Promise<UserMemory | null> {
    try {
      return await this.memoryService.loadMemory(userId);
    } catch (error) {
      // Return null on error (graceful degradation)
      console.error('Error loading memory:', error);
      return null;
    }
  }

  /**
   * Format CLAUDE.md section
   */
  private formatClaudeMdSection(content: string): string {
    return `## 项目配置 (CLAUDE.md)

${content}`;
  }

  /**
   * Format Git status section
   */
  private formatGitSection(status: GitStatus): string {
    const lines: string[] = ['## Git 状态'];

    if (status.branch) {
      lines.push(`- **当前分支**: ${status.branch}`);
    }

    if (status.lastCommit) {
      lines.push(`- **最近提交**: ${status.lastCommit}`);
    }

    return lines.join('\n');
  }

  /**
   * Format memory section with context-aware recall
   */
  private formatMemorySection(memory: UserMemory, _userInput: string): string {
    const lines: string[] = ['## 用户记忆'];

    // Add user profile information
    if (memory.profile) {
      lines.push('\n### 用户画像');
      lines.push(`- **用户ID**: ${memory.profile.userId}`);

      if (memory.profile.department) {
        lines.push(`- **部门**: ${memory.profile.department}`);
      }

      if (memory.profile.commonSystems && memory.profile.commonSystems.length > 0) {
        lines.push(`- **常用系统**: ${memory.profile.commonSystems.join(', ')}`);
      }

      if (memory.profile.tags && memory.profile.tags.length > 0) {
        lines.push(`- **标签**: ${memory.profile.tags.join(', ')}`);
      }

      lines.push(`- **对话次数**: ${memory.profile.conversationCount}`);
    }

    // Add relevant conversation history
    if (memory.conversationHistory && memory.conversationHistory.length > 0) {
      lines.push('\n### 对话历史');

      // Use MemoryService's buildContextPrompt for formatting
      const historyContext = this.memoryService.buildContextPrompt(memory);
      if (historyContext) {
        lines.push(historyContext);
      }
    }

    return lines.join('\n');
  }
}

export default DynamicContextBuilder;
