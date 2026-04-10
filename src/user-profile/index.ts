import { promises as fs } from 'fs';
import * as path from 'path';
import type { UserProfile, SkillMetadata } from '../types';

export class UserProfileService {
  private profilePath: string;
  private logger: { warn: (msg: string) => void; error: (msg: string) => void };
  private skillsMetadata: SkillMetadata[] = [];

  constructor(
    dataDir: string = 'data',
    logger: { warn: (msg: string) => void; error: (msg: string) => void } = console
  ) {
    this.profilePath = path.join(dataDir, 'user-profile.json');
    this.logger = logger;
  }

  setSkillsMetadata(skills: SkillMetadata[]): void {
    this.skillsMetadata = skills;
  }

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

  async loadProfile(userId: string): Promise<UserProfile> {
    try {
      const fileStat = await fs.stat(this.profilePath).catch(() => null);

      if (!fileStat || !fileStat.isFile()) {
        this.logger.warn(`Profile file not found: ${this.profilePath}. Returning default profile.`);
        return this.createDefaultProfile(userId);
      }

      const content = await fs.readFile(this.profilePath, 'utf-8');
      const profiles = JSON.parse(content) as Record<string, UserProfile>;

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

  async saveProfile(profile: UserProfile): Promise<void> {
    try {
      const dir = path.dirname(this.profilePath);
      await fs.mkdir(dir, { recursive: true });

      let profiles: Record<string, UserProfile> = {};
      const fileStat = await fs.stat(this.profilePath).catch(() => null);

      if (fileStat && fileStat.isFile()) {
        const content = await fs.readFile(this.profilePath, 'utf-8');
        try {
          profiles = JSON.parse(content) as Record<string, UserProfile>;
        } catch {
          profiles = {};
        }
      }

      profiles[profile.userId] = profile;

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

  async updateProfile(
    userId: string,
    updates: Partial<UserProfile>
  ): Promise<UserProfile> {
    const profile = await this.loadProfile(userId);

    const { userId: _, ...safeUpdates } = updates;
    const updatedProfile: UserProfile = {
      ...profile,
      ...safeUpdates,
      userId,
      updatedAt: new Date().toISOString(),
    };

    if (!updates.lastActiveAt) {
      updatedProfile.lastActiveAt = new Date().toISOString();
    }

    await this.saveProfile(updatedProfile);

    return updatedProfile;
  }

  inferSystemFromText(text: string): string | null {
    for (const skill of this.skillsMetadata) {
      const keywords = (skill.metadata?.keywords as string[]) || [];
      for (const kw of keywords) {
        if (text.includes(kw)) {
          return skill.metadata?.systemName as string || skill.name;
        }
      }
    }
    return null;
  }

  getKnownSystems(): string[] {
    return this.skillsMetadata
      .map(s => s.metadata?.systemName as string || s.name)
      .filter(Boolean);
  }
}

export async function loadProfile(
  userId: string,
  dataDir: string = 'data'
): Promise<UserProfile> {
  const service = new UserProfileService(dataDir);
  return service.loadProfile(userId);
}

export async function saveProfile(
  profile: UserProfile,
  dataDir: string = 'data'
): Promise<void> {
  const service = new UserProfileService(dataDir);
  return service.saveProfile(profile);
}

export async function updateProfile(
  userId: string,
  updates: Partial<UserProfile>,
  dataDir: string = 'data'
): Promise<UserProfile> {
  const service = new UserProfileService(dataDir);
  return service.updateProfile(userId, updates);
}

export default UserProfileService;
