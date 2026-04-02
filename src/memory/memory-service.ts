import { UserProfileService } from '../user-profile';
import { ConversationMemoryService } from './conversation-memory';
import { ConversationMessage, MemoryConfig } from './types';
import { UserProfile } from '../types';

/**
 * User memory combining profile and conversation history
 */
export interface UserMemory {
  profile: UserProfile;
  conversationHistory: ConversationMessage[];
}

/**
 * MemoryService - Unified memory interface
 * 
 * Integrates UserProfileService (user profile) and ConversationMemoryService (conversation history)
 * to provide a single interface for loading and managing user memory.
 */
export class MemoryService {
  private userProfileService: UserProfileService;
  private conversationMemoryService: ConversationMemoryService;

  /**
   * Create a new MemoryService instance
   * @param dataDir - Directory to store profile data (default: 'data')
   * @param config - Partial memory configuration (merged with defaults)
   */
  constructor(
    dataDir: string = 'data',
    config: Partial<MemoryConfig> = {}
  ) {
    this.userProfileService = new UserProfileService(dataDir);
    this.conversationMemoryService = new ConversationMemoryService(config);
  }

  /**
   * Load user complete memory (profile + conversationHistory)
   * Uses Promise.all for parallel loading
   * 
   * @param userId - User identifier
   * @returns UserMemory object with profile and conversationHistory
   */
  async loadMemory(userId: string): Promise<UserMemory> {
    // Parallel load profile and conversation history
    const [profile, conversationHistory] = await Promise.all([
      this.userProfileService.loadProfile(userId),
      this.conversationMemoryService.loadHistory(userId),
    ]);

    return {
      profile,
      conversationHistory,
    };
  }

  /**
   * Save interaction (user message + AI response)
   * Saves two messages: user message and assistant response
   *
   * @param userId - User identifier
   * @param userMessage - User's message content
   * @param assistantResponse - AI assistant's response content
   * @param options - Optional metadata (system, skill, references)
   */
  async saveInteraction(
    userId: string,
    userMessage: string,
    assistantResponse: string,
    options?: {
      system?: string;
      skill?: string;
      references?: string[];
    }
  ): Promise<void> {
    const now = new Date().toISOString();

    // Save user message
    const userMsg: ConversationMessage = {
      role: 'user',
      content: userMessage,
      timestamp: now,
    };

    // Save assistant response (with metadata)
    const assistantMsg: ConversationMessage = {
      role: 'assistant',
      content: assistantResponse,
      timestamp: now,
      system: options?.system,
      skill: options?.skill,
      references: options?.references,
    };

    // Save both messages sequentially (order matters for conversation history)
    await this.conversationMemoryService.saveMessage(userId, userMsg);
    await this.conversationMemoryService.saveMessage(userId, assistantMsg);
  }

  /**
   * Build context prompt with memory
   * Formats conversation history for LLM context injection
   * 
   * @param memory - UserMemory object
   * @returns Formatted conversation history string, or empty string if no history
   */
  buildContextPrompt(memory: UserMemory): string {
    // Return empty string if no conversation history
    if (!memory.conversationHistory || memory.conversationHistory.length === 0) {
      return '';
    }

    // Build formatted conversation history
    const lines: string[] = ['[对话历史]'];

    for (const msg of memory.conversationHistory) {
      const roleLabel = msg.role === 'user' ? '用户' : '助手';
      lines.push(`${roleLabel}: ${msg.content}`);
    }

    return lines.join('\n');
  }

  /**
   * Clear all user memory
   * Clears conversation history (profile is retained)
   * 
   * @param userId - User identifier
   */
  async clearMemory(userId: string): Promise<void> {
    await this.conversationMemoryService.clearHistory(userId);
  }
}

export default MemoryService;
