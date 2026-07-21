/**
 * L2: 用户结构化档案(JSON 单文件,永久,精确检索)
 *
 * - 写入触发:信息变更(部门识别、常用系统更新、会话计数+1、extensions 更新)
 * - 读取触发:会话开始
 * - 清理策略:永久(手动清除)
 * - 优先级:高
 *
 * 核心字段固定(向后兼容),extensions 字段支持深度 merge,用于未来扩展
 * (用户偏好风格、沟通方式、技术栈等)。
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { SkillMetadata } from '../types';
import type { L2UserProfile, L2BehaviorUpdate } from './types';

/**
 * L2ProfileService - 用户档案服务
 *
 * 由 src/user-profile/index.ts 迁移而来。新增:
 * - updateExtensions:深度 merge extensions,不覆盖
 * - incrementConversationCount:每次 processRequirement 入口调用
 * - updateBehavior:部门/常用系统变更
 */
export class L2ProfileService {
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

  private createDefaultProfile(userId: string): L2UserProfile {
    const now = new Date().toISOString();
    return {
      userId,
      department: '财务部',
      commonSystems: [],
      tags: [],
      conversationCount: 0,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
      extensions: {},
    };
  }

  async loadProfile(userId: string): Promise<L2UserProfile> {
    try {
      const fileStat = await fs.stat(this.profilePath).catch(() => null);

      if (!fileStat || !fileStat.isFile()) {
        this.logger.warn(`Profile file not found: ${this.profilePath}. Creating default profile.`);
        const profile = this.createDefaultProfile(userId);
        await this.saveProfile(profile);
        return profile;
      }

      const content = await fs.readFile(this.profilePath, 'utf-8');
      const profiles = JSON.parse(content) as Record<string, L2UserProfile>;

      if (profiles[userId]) {
        // 旧数据兼容:自动补 extensions 字段为空对象(便于后续 updateExtensions 深度 merge)
        if (profiles[userId].extensions === undefined) {
          profiles[userId].extensions = {};
        }
        return profiles[userId];
      }

      this.logger.warn(`Profile not found for userId: ${userId}. Creating new profile.`);
      const profile = this.createDefaultProfile(userId);
      await this.saveProfile(profile);
      return profile;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error loading profile for ${userId}: ${errorMsg}`);
      const profile = this.createDefaultProfile(userId);
      await this.saveProfile(profile).catch(err => {
        this.logger.error(`Error saving profile for ${userId}: ${err}`);
      });
      return profile;
    }
  }

  async createUserProfile(userId: string, initialData?: Partial<L2UserProfile>): Promise<L2UserProfile> {
    const now = new Date().toISOString();
    const profile: L2UserProfile = {
      userId,
      department: initialData?.department || '财务部',
      commonSystems: initialData?.commonSystems || [],
      tags: initialData?.tags || [],
      conversationCount: 0,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
      extensions: initialData?.extensions ?? {},
    };

    await this.saveProfile(profile);
    return profile;
  }

  /**
   * 更新用户行为(向后兼容旧 API)
   *
   * 合并 mentionedSystems 到 commonSystems,conversationCount++,刷新 lastActiveAt。
   */
  async updateUserBehavior(userId: string, behavior: L2BehaviorUpdate & { interactionType?: string }): Promise<void> {
    const profile = await this.loadProfile(userId);

    // 更新常用系统
    if (behavior.mentionedSystems) {
      for (const system of behavior.mentionedSystems) {
        if (!profile.commonSystems.includes(system)) {
          profile.commonSystems.push(system);
        }
      }
    }

    // 更新部门(如果传入)
    if (behavior.department) {
      profile.department = behavior.department;
    }

    // 更新交互次数
    profile.conversationCount++;
    profile.lastActiveAt = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();

    await this.saveProfile(profile);
  }

  /**
   * 增加会话计数(每次 processRequirement 入口调用)
   */
  async incrementConversationCount(userId: string): Promise<void> {
    const profile = await this.loadProfile(userId);
    profile.conversationCount++;
    profile.lastActiveAt = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();
    await this.saveProfile(profile);
  }

  /**
   * 更新行为(部门/常用系统变更)
   */
  async updateBehavior(userId: string, behavior: L2BehaviorUpdate): Promise<void> {
    const profile = await this.loadProfile(userId);

    if (behavior.mentionedSystems) {
      for (const system of behavior.mentionedSystems) {
        if (!profile.commonSystems.includes(system)) {
          profile.commonSystems.push(system);
        }
      }
    }

    if (behavior.department) {
      profile.department = behavior.department;
    }

    profile.updatedAt = new Date().toISOString();
    await this.saveProfile(profile);
  }

  /**
   * 更新扩展字段(深度 merge,不覆盖)
   *
   * 例:updateExtensions(userId, { communicationStyle: 'concise', techStack: ['ts', 'react'] })
   * 多次调用同一 key 会进行深合并,而不是替换。
   */
  async updateExtensions(userId: string, patch: Record<string, unknown>): Promise<L2UserProfile> {
    const profile = await this.loadProfile(userId);

    if (!profile.extensions) {
      profile.extensions = {};
    }

    profile.extensions = deepMerge(profile.extensions, patch);
    profile.updatedAt = new Date().toISOString();

    await this.saveProfile(profile);
    return profile;
  }

  /**
   * 读取扩展字段
   */
  getExtension<T = unknown>(profile: L2UserProfile, key: string): T | undefined {
    return profile.extensions?.[key] as T | undefined;
  }

  async saveProfile(profile: L2UserProfile): Promise<void> {
    try {
      const dir = path.dirname(this.profilePath);
      await fs.mkdir(dir, { recursive: true });

      let profiles: Record<string, L2UserProfile> = {};
      const fileStat = await fs.stat(this.profilePath).catch(() => null);

      if (fileStat && fileStat.isFile()) {
        const content = await fs.readFile(this.profilePath, 'utf-8');
        try {
          profiles = JSON.parse(content) as Record<string, L2UserProfile>;
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
    updates: Partial<L2UserProfile>
  ): Promise<L2UserProfile> {
    const profile = await this.loadProfile(userId);

    const { userId: _, ...safeUpdates } = updates;
    const updatedProfile: L2UserProfile = {
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

/**
 * 深度合并两个对象(用于 extensions 字段)
 *
 * - 普通对象递归合并
 * - 数组:不合并,直接替换(数组语义是覆盖)
 * - 基本类型:直接替换
 */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(patch)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

export default L2ProfileService;
