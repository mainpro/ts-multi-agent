import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * CLAUDE.md 文件加载器
 * 
 * 支持多层级配置文件查找和加载：
 * - 全局: /etc/claude-code/CLAUDE.md
 * - 用户: ~/.claude/CLAUDE.md
 * - 项目: ./CLAUDE.md
 * - 项目配置: ./.claude/CLAUDE.md
 * - 本地: ./CLAUDE.local.md
 */
export class ClaudeMdLoader {
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * 查找所有层级的 CLAUDE.md 文件
   * 按优先级从低到高返回（全局 → 用户 → 项目 → 项目配置 → 本地）
   */
  async findClaudeMdFiles(): Promise<string[]> {
    const files: string[] = [];

    // 1. 全局配置: /etc/claude-code/CLAUDE.md
    const globalPath = '/etc/claude-code/CLAUDE.md';
    if (await this.fileExists(globalPath)) {
      files.push(globalPath);
    }

    // 2. 用户配置: ~/.claude/CLAUDE.md
    const userPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    if (await this.fileExists(userPath)) {
      files.push(userPath);
    }

    // 3. 项目根目录: ./CLAUDE.md
    const projectPath = path.join(this.projectRoot, 'CLAUDE.md');
    if (await this.fileExists(projectPath)) {
      files.push(projectPath);
    }

    // 4. 项目配置目录: ./.claude/CLAUDE.md
    const projectConfigPath = path.join(this.projectRoot, '.claude', 'CLAUDE.md');
    if (await this.fileExists(projectConfigPath)) {
      files.push(projectConfigPath);
    }

    // 5. 本地配置: ./CLAUDE.local.md
    const localPath = path.join(this.projectRoot, 'CLAUDE.local.md');
    if (await this.fileExists(localPath)) {
      files.push(localPath);
    }

    return files;
  }

  /**
   * 异步读取单个文件内容
   */
  async loadFile(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      throw new Error(`Failed to load CLAUDE.md file: ${filePath}. Error: ${error}`);
    }
  }

  /**
   * 加载并合并所有 CLAUDE.md 内容
   * 按优先级从低到高合并（后面的配置覆盖前面的）
   */
  async loadAll(): Promise<string> {
    const files = await this.findClaudeMdFiles();
    
    if (files.length === 0) {
      return '';
    }

    const contents: string[] = [];

    for (const file of files) {
      try {
        const content = await this.loadFile(file);
        if (content.trim()) {
          contents.push(`<!-- From: ${file} -->\n${content}`);
        }
      } catch (error) {
        // 记录错误但继续处理其他文件
        console.error(`Error loading ${file}:`, error);
      }
    }

    return contents.join('\n\n---\n\n');
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
