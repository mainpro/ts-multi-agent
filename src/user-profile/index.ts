import { promises as fs } from 'fs';
import * as path from 'path';
import type { UserProfile, SkillMetadata } from '../types';

export class UserProfileService {
  private profilePath: string;
  private logger: { warn: (msg: string) => void; error: (msg: string) => void };
  private skillsMetadata: SkillMetadata[] = [];
  // 首次加载的并发去重:3 路并发请求时只有第一个真正去读文件,其余 await 同一 promise
  private initPromise: Promise<void> | null = null;
  // 写操作串行化:防止 read-modify-write 丢更新
  private writeQueue: Promise<void> = Promise.resolve();

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

  /**
   * 确保 profile 文件已存在且至少包含给定 userId。
   * 并发安全:多路同时调用只会触发一次 file 读取 + 一次默认 profile 创建。
   */
  private ensureInitialized(userId: string): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit(userId);
    }
    // 已 reject 的 promise 不会自动重置,允许重试
    this.initPromise.catch(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async doInit(userId: string): Promise<void> {
    const fileStat = await fs.stat(this.profilePath).catch(() => null);
    if (fileStat && fileStat.isFile()) {
      return; // 文件已存在,无需初始化
    }
    this.logger.warn(`Profile file not found: ${this.profilePath}. Creating default profile.`);
    const profile = this.createDefaultProfile(userId);
    await this.enqueueWrite(profile);
  }

  /**
   * 串行化所有写操作(读改写链)。避免并发 saveProfile 互相覆盖。
   */
  private enqueueWrite(profile: UserProfile): Promise<void> {
    const next = this.writeQueue.then(async () => {
      await this.saveProfile(profile);
    });
    // 即使某个写失败,链不能断(用 catch 把错误吞掉放到 promise 自身)
    this.writeQueue = next.catch(() => {});
    return next;
  }

  private createDefaultProfile(userId: string): UserProfile {
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
      role: 'employee',
      permissions: [],
      history: [],
      preferences: [],
    };
  }

  async loadProfile(userId: string): Promise<UserProfile> {
    try {
      // 首次冷启动并发去重:多路同时调用,只有第一个真的去 stat 文件
      await this.ensureInitialized(userId);

      const content = await fs.readFile(this.profilePath, 'utf-8');
      // 文件存在但内容为空 / 解析失败(并发 saveProfile 可能产生竞态)
      // → 静默回退默认 profile,不打印 error 日志(避免误导)
      let profiles: Record<string, UserProfile>;
      try {
        profiles = content.trim() ? JSON.parse(content) : {};
      } catch {
        profiles = {};
      }

      if (profiles[userId]) {
        // 缺失字段补全（向后兼容）：老 JSON 缺 role / permissions / history / preferences 时自动填默认值
        return {
          ...profiles[userId],
          role: profiles[userId].role ?? 'employee',
          permissions: profiles[userId].permissions ?? [],
          history: profiles[userId].history ?? [],
          preferences: profiles[userId].preferences ?? [],
        };
      }

      this.logger.warn(`Profile not found for userId: ${userId}. Creating new profile.`);
      const profile = this.createDefaultProfile(userId);
      await this.enqueueWrite(profile);
      return profile;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error loading profile for ${userId}: ${errorMsg}`);
      const profile = this.createDefaultProfile(userId);
      await this.enqueueWrite(profile).catch(err => {
        this.logger.error(`Error saving profile for ${userId}: ${err}`);
      });
      return profile;
    }
  }

  async createUserProfile(userId: string, initialData?: Partial<UserProfile>): Promise<UserProfile> {
    const now = new Date().toISOString();
    const profile: UserProfile = {
      userId,
      department: initialData?.department || '财务部',
      commonSystems: initialData?.commonSystems || [],
      tags: initialData?.tags || [],
      conversationCount: 0,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
      role: initialData?.role || 'employee',
      permissions: initialData?.permissions || [],
      history: initialData?.history || [],
      preferences: initialData?.preferences || [],
    };

    await this.saveProfile(profile);
    return profile;
  }

  async updateUserBehavior(userId: string, behavior: {
    mentionedSystems?: string[];
    interactionType?: string;
  }): Promise<void> {
    const profile = await this.loadProfile(userId);
    
    // 更新常用系统
    if (behavior.mentionedSystems) {
      for (const system of behavior.mentionedSystems) {
        if (!profile.commonSystems.includes(system)) {
          profile.commonSystems.push(system);
        }
      }
    }
    
    // 更新交互次数
    profile.conversationCount++;
    profile.lastActiveAt = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();
    
    await this.enqueueWrite(profile);
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

    await this.enqueueWrite(updatedProfile);

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

export default UserProfileService;
