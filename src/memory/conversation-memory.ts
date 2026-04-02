import { promises as fs } from 'fs';
import * as path from 'path';
import { ConversationMessage, MemoryConfig, DEFAULT_MEMORY_CONFIG } from './types';

/**
 * ConversationMemoryService - Manages conversation history persistence
 *
 * Features:
 * - Load/save conversation history to JSON file
 * - Return empty array if file doesn't exist
 * - Automatic sliding window trimming (maxRounds * 2 messages)
 * - Get recent N messages for context
 */
export class ConversationMemoryService {
  /** Memory configuration */
  private config: MemoryConfig;

  /** Logger function for warnings and errors */
  private logger: { warn: (msg: string) => void; error: (msg: string) => void };

  /**
   * Create a new ConversationMemoryService instance
   * @param config - Partial memory configuration (merged with defaults)
   * @param logger - Logger for warnings and errors (default: console)
   */
  constructor(
    config: Partial<MemoryConfig> = {},
    logger: { warn: (msg: string) => void; error: (msg: string) => void } = console
  ) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Get the file path for user's conversation history
   * @param userId - User identifier
   * @returns Full path to conversations.json file
   */
  private getHistoryPath(userId: string): string {
    return path.join(this.config.storagePath, userId, 'conversations.json');
  }

  /**
   * Load user conversation history from JSON file
   * Returns empty array if file doesn't exist
   *
   * @param userId - User identifier
   * @returns Array of ConversationMessage
   */
  async loadHistory(userId: string): Promise<ConversationMessage[]> {
    const historyPath = this.getHistoryPath(userId);

    try {
      // Check if file exists
      const fileStat = await fs.stat(historyPath).catch(() => null);

      if (!fileStat || !fileStat.isFile()) {
        // File doesn't exist, return empty array
        this.logger.warn(`History file not found: ${historyPath}. Returning empty array.`);
        return [];
      }

      // Read and parse JSON
      const content = await fs.readFile(historyPath, 'utf-8');
      const messages = JSON.parse(content) as ConversationMessage[];

      return messages;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error loading history for ${userId}: ${errorMsg}`);
      return [];
    }
  }

  /**
   * Save a single message to conversation history
   * Automatically applies sliding window trimming
   *
   * @param userId - User identifier
   * @param message - ConversationMessage to save
   */
  async saveMessage(userId: string, message: ConversationMessage): Promise<void> {
    // 1. Load existing history
    const history = await this.loadHistory(userId);

    // 2. Append new message
    history.push(message);

    // 3. Apply sliding window trimming (maxRounds * 2 = N user + N assistant)
    const maxMessages = this.config.maxRounds * 2;
    if (history.length > maxMessages) {
      // Keep only the most recent maxMessages
      history.splice(0, history.length - maxMessages);
    }

    // 4. Save to file
    await this.saveHistory(userId, history);
  }

  /**
   * Get recent N messages from conversation history
   *
   * @param userId - User identifier
   * @param count - Number of messages to return (default: config.maxRounds)
   * @returns Array of recent ConversationMessage
   */
  async getRecentMessages(userId: string, count?: number): Promise<ConversationMessage[]> {
    const limit = count ?? this.config.maxRounds;
    const history = await this.loadHistory(userId);

    // Return the most recent 'limit' messages
    if (history.length <= limit) {
      return history;
    }

    return history.slice(-limit);
  }

  /**
   * Clear user conversation history
   * Deletes the conversations.json file
   *
   * @param userId - User identifier
   */
  async clearHistory(userId: string): Promise<void> {
    const historyPath = this.getHistoryPath(userId);

    try {
      await fs.unlink(historyPath).catch(() => {
        // File doesn't exist, nothing to delete
        this.logger.warn(`No history file to delete for ${userId}`);
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error clearing history for ${userId}: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Internal method: Save conversation history to file
   *
   * @param userId - User identifier
   * @param messages - Array of ConversationMessage to save
   */
  private async saveHistory(userId: string, messages: ConversationMessage[]): Promise<void> {
    const historyPath = this.getHistoryPath(userId);

    try {
      // Ensure directory exists
      const dir = path.dirname(historyPath);
      await fs.mkdir(dir, { recursive: true });

      // Write with pretty formatting
      await fs.writeFile(
        historyPath,
        JSON.stringify(messages, null, 2),
        'utf-8'
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error saving history for ${userId}: ${errorMsg}`);
      throw error;
    }
  }
}

export default ConversationMemoryService;
