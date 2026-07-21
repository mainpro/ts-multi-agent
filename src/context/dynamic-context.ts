import { MemoryService, UserMemory } from '../memory/memory-service';

/**
 * Dynamic Context Builder for Multi-Agent System
 * 
 * Focuses on user memory and conversation context (no CLAUDE.md or Git for non-coding agents)
 */
export class DynamicContextBuilder {
  private memoryService: MemoryService;

  constructor(memoryService: MemoryService) {
    this.memoryService = memoryService;
  }

  /**
   * Build dynamic context from user memory
   *
   * @param userInput - User's input for context awareness
   * @param userId - User identifier for memory lookup (default: 'default')
   * @param sessionId - Session identifier for conversation history lookup(可选)
   * @returns Formatted context string with user profile and conversation history
   */
  async build(userInput: string, userId: string = 'default', sessionId?: string): Promise<string> {
    const userMemory = await this.loadMemory(userId, sessionId);

    if (!userMemory) {
      return '';
    }

    return this.formatMemorySection(userMemory, userInput);
  }

  /**
   * Load user memory (profile + conversation history)
   */
  private async loadMemory(userId: string, sessionId?: string): Promise<UserMemory | null> {
    try {
      return await this.memoryService.loadUserMemory(userId, sessionId);
    } catch (error) {
      console.error('Error loading memory:', error);
      return null;
    }
  }

  /**
   * Format memory section with user profile and conversation history
   */
  private formatMemorySection(memory: UserMemory, _userInput: string): string {
    const lines: string[] = ['## 用户上下文'];

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

    if (memory.episodicEntries && memory.episodicEntries.length > 0) {
      lines.push('\n### 对话历史');
      const historyContext = this.memoryService.buildContextPrompt(memory);
      if (historyContext) {
        lines.push(historyContext);
      }
    }

    return lines.join('\n');
  }
}

export default DynamicContextBuilder;
