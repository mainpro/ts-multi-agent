import { promises as fs } from 'fs';
import * as path from 'path';
import type { UserProfile } from '../types';

/**
 * Known system names for inference
 */
const KNOWN_SYSTEMS = [
  'GEAM',
  '报销系统',
  '差旅系统',
  '预算系统',
  '凭证影像',
];

/**
 * Regex patterns for system name extraction
 */
const SYSTEM_PATTERNS = [
  /\bGEAM\b/i,
  /报销系统/g,
  /差旅系统/g,
  /预算系统/g,
  /凭证影像/g,
];

/**
 * UserProfileService - Manages user profile persistence and inference
 *
 * Features:
 * - Load/save user profiles to JSON file
 * - Return default profile if file doesn't exist
 * - Update profile fields with automatic timestamp management
 * - Infer system names from text using regex patterns
 */
export class UserProfileService {
  /** Path to the user profile JSON file */
  private profilePath: string;

  /** Logger function for warnings and errors */
  private logger: { warn: (msg: string) => void; error: (msg: string) => void };

  /**
   * Create a new UserProfileService instance
   * @param dataDir - Directory to store profile data (default: 'data')
   * @param logger - Logger for warnings and errors (default: console)
   */
  constructor(
    dataDir: string = 'data',
    logger: { warn: (msg: string) => void; error: (msg: string) => void } = console
  ) {
    this.profilePath = path.join(dataDir, 'user-profile.json');
    this.logger = logger;
  }

  /**
   * Create a default user profile
   * @param userId - User identifier
   * @returns Default UserProfile object
   */
  private createDefaultProfile(userId: string): UserProfile {
    const now = new Date().toISOString();
    return {
      userId,
      department: '市场部',
      commonSystems: ['报销系统', '差旅系统'],
      tags: [],
      conversationCount: 0,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Load user profile from JSON file
   * Returns default profile if file doesn't exist
   *
   * @param userId - User identifier
   * @returns UserProfile object
   */
  async loadProfile(userId: string): Promise<UserProfile> {
    try {
      // Check if file exists
      const fileStat = await fs.stat(this.profilePath).catch(() => null);
      
      if (!fileStat || !fileStat.isFile()) {
        // File doesn't exist, return default profile
        this.logger.warn(`Profile file not found: ${this.profilePath}. Returning default profile.`);
        return this.createDefaultProfile(userId);
      }

      // Read and parse JSON
      const content = await fs.readFile(this.profilePath, 'utf-8');
      const profiles = JSON.parse(content) as Record<string, UserProfile>;

      // Return profile for userId or default
      if (profiles[userId]) {
        return profiles[userId];
      }

      this.logger.warn(`Profile not found for userId: ${userId}. Returning default profile.`);
      return this.createDefaultProfile(userId);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error loading profile for ${userId}: ${errorMsg}`);
      return this.createDefaultProfile(userId);
    }
  }

  /**
   * Save user profile to JSON file
   * Writes with pretty formatting (indent: 2)
   *
   * @param profile - UserProfile object to save
   */
  async saveProfile(profile: UserProfile): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.profilePath);
      await fs.mkdir(dir, { recursive: true });

      // Load existing profiles or create new object
      let profiles: Record<string, UserProfile> = {};
      const fileStat = await fs.stat(this.profilePath).catch(() => null);
      
      if (fileStat && fileStat.isFile()) {
        const content = await fs.readFile(this.profilePath, 'utf-8');
        try {
          profiles = JSON.parse(content) as Record<string, UserProfile>;
        } catch {
          // Invalid JSON, start fresh
          profiles = {};
        }
      }

      // Update profile
      profiles[profile.userId] = profile;

      // Write with pretty formatting
      await fs.writeFile(
        this.profilePath,
        JSON.stringify(profiles, null, 2),
        'utf-8'
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error saving profile for ${profile.userId}: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Update user profile with partial updates
   * Loads profile, merges updates, updates timestamps, and saves
   *
   * @param userId - User identifier
   * @param updates - Partial UserProfile fields to update
   * @returns Updated UserProfile object
   */
  async updateProfile(
    userId: string,
    updates: Partial<UserProfile>
  ): Promise<UserProfile> {
    // Load existing profile
    const profile = await this.loadProfile(userId);

    // Merge updates (excluding userId which should not be changed)
    const { userId: _, ...safeUpdates } = updates;
    const updatedProfile: UserProfile = {
      ...profile,
      ...safeUpdates,
      userId, // Ensure userId is preserved
      updatedAt: new Date().toISOString(),
    };

    // Update lastActiveAt if not explicitly provided
    if (!updates.lastActiveAt) {
      updatedProfile.lastActiveAt = new Date().toISOString();
    }

    // Save updated profile
    await this.saveProfile(updatedProfile);

    return updatedProfile;
  }

  /**
   * Infer system name from text using regex patterns
   * Extracts known system names from text content
   *
   * @param text - Text to analyze
   * @returns First matched system name or null if no match
   */
  inferSystemFromText(text: string): string | null {
    for (const pattern of SYSTEM_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        return match[0];
      }
    }
    return null;
  }

  /**
   * Extract all system names mentioned in text
   * Returns all unique system names found
   *
   * @param text - Text to analyze
   * @returns Array of matched system names
   */
  extractAllSystemsFromText(text: string): string[] {
    const foundSystems = new Set<string>();
    
    for (const pattern of SYSTEM_PATTERNS) {
      const matches = Array.from(text.matchAll(pattern));
      for (const match of matches) {
        foundSystems.add(match[0]);
      }
    }

    return Array.from(foundSystems);
  }

  /**
   * Get list of known system names
   * @returns Array of known system names
   */
  getKnownSystems(): string[] {
    return [...KNOWN_SYSTEMS];
  }
}

// Export standalone functions for convenience

/**
 * Load user profile (standalone function)
 * @param userId - User identifier
 * @param dataDir - Data directory (default: 'data')
 * @returns UserProfile object
 */
export async function loadProfile(
  userId: string,
  dataDir: string = 'data'
): Promise<UserProfile> {
  const service = new UserProfileService(dataDir);
  return service.loadProfile(userId);
}

/**
 * Save user profile (standalone function)
 * @param profile - UserProfile object to save
 * @param dataDir - Data directory (default: 'data')
 */
export async function saveProfile(
  profile: UserProfile,
  dataDir: string = 'data'
): Promise<void> {
  const service = new UserProfileService(dataDir);
  return service.saveProfile(profile);
}

/**
 * Update user profile (standalone function)
 * @param userId - User identifier
 * @param updates - Partial UserProfile fields to update
 * @param dataDir - Data directory (default: 'data')
 * @returns Updated UserProfile object
 */
export async function updateProfile(
  userId: string,
  updates: Partial<UserProfile>,
  dataDir: string = 'data'
): Promise<UserProfile> {
  const service = new UserProfileService(dataDir);
  return service.updateProfile(userId, updates);
}

/**
 * Infer system name from text (standalone function)
 * @param text - Text to analyze
 * @returns First matched system name or null
 */
export function inferSystemFromText(text: string): string | null {
  const service = new UserProfileService();
  return service.inferSystemFromText(text);
}

export default UserProfileService;
