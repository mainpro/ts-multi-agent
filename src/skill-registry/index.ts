import { promises as fs } from 'fs';
import { watch } from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { Skill, SkillMetadata } from '../types';
import { CONFIG } from '../types';

/**
 * Internal cache entry for skill metadata and file path
 */
interface SkillCacheEntry {
  metadata: SkillMetadata;
  skillDir: string;
  skillFilePath: string;
}

/**
 * SkillRegistry - Manages skill discovery and loading with progressive disclosure
 *
 * Features:
 * - Scans directories for SKILL.md files
 * - Parses YAML frontmatter for metadata (cached)
 * - Lazy loads full skill body on demand
 * - Handles errors gracefully (logs warnings, continues scanning)
 */
export class SkillRegistry {
  /** Cache of skill metadata keyed by skill name */
  private metadataCache: Map<string, SkillCacheEntry> = new Map();

  /** Logger function for warnings and errors */
  private logger: { warn: (msg: string) => void; error: (msg: string) => void };

  // P2-3: 热重载
  private watcher: ReturnType<typeof watch> | null = null;
  private rescanDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    logger: { warn: (msg: string) => void; error: (msg: string) => void } = console
  ) {
    this.logger = logger;
  }

  /**
   * Scan a directory for skills
   * Parses only YAML frontmatter (metadata), body is loaded on-demand
   *
   * @param directory - Directory to scan (e.g., './skills/')
   * @returns Array of successfully loaded skill names
   */
  async scanSkills(directory: string): Promise<string[]> {
    const loadedSkills: string[] = [];

    try {
      // Check if directory exists
      const dirStat = await fs.stat(directory).catch(() => null);
      if (!dirStat || !dirStat.isDirectory()) {
        this.logger.warn(`Skill directory not found or not a directory: ${directory}`);
        return loadedSkills;
      }

      // Read all entries in the directory
      const entries = await fs.readdir(directory, { withFileTypes: true });

      // Process each subdirectory that might contain a SKILL.md
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(directory, entry.name);
        const skillFilePath = path.join(skillDir, 'SKILL.md');

        try {
          // Check if SKILL.md exists
          const fileStat = await fs.stat(skillFilePath).catch(() => null);
          if (!fileStat || !fileStat.isFile()) {
            this.logger.warn(`SKILL.md not found in: ${skillDir}`);
            continue;
          }

          // Read and parse only frontmatter (metadata)
          const metadata = await this.parseFrontmatterOnly(skillFilePath);

          if (!metadata) {
            this.logger.warn(`Failed to parse frontmatter in: ${skillFilePath}`);
            continue;
          }

          // Validate required fields
          if (!metadata.name || !metadata.description) {
            this.logger.warn(
              `SKILL.md missing required fields (name/description): ${skillFilePath}`
            );
            continue;
          }

          // Check for duplicate names
          if (this.metadataCache.has(metadata.name)) {
            const existing = this.metadataCache.get(metadata.name)!;
            // this.logger.warn(
            //   `Duplicate skill name "${metadata.name}" found. ` +
            //     `Existing: ${existing.skillFilePath}, New: ${skillFilePath}. ` +
            //     `Skipping new entry.`
            // );
            continue;
          }

          // Cache the metadata with file path for lazy loading
          this.metadataCache.set(metadata.name, {
            metadata,
            skillDir,
            skillFilePath,
          });

          loadedSkills.push(metadata.name);
        } catch (error) {
          // Log error but continue scanning other skills
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Error processing skill at ${skillDir}: ${errorMsg}`);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error scanning skill directory ${directory}: ${errorMsg}`);
    }

    return loadedSkills;
  }

  /**
   * Parse only the YAML frontmatter from a SKILL.md file
   * Does NOT load the body content (progressive disclosure)
   *
   * @param filePath - Path to SKILL.md file
   * @returns Parsed metadata or null if parsing fails
   */
  private async parseFrontmatterOnly(filePath: string): Promise<SkillMetadata | null> {
    try {
      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');

      // Parse frontmatter (content between --- delimiters)
      const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);

      if (!frontmatterMatch) {
        this.logger.warn(`No YAML frontmatter found in: ${filePath}`);
        return null;
      }

      const frontmatterContent = frontmatterMatch[1];

      // Parse YAML
      const parsed = yaml.parse(frontmatterContent) as Record<string, unknown>;

      // Extract and validate required fields
      if (!parsed.name || typeof parsed.name !== 'string') {
        this.logger.warn(`Missing or invalid 'name' in frontmatter: ${filePath}`);
        return null;
      }

      if (!parsed.description || typeof parsed.description !== 'string') {
        this.logger.warn(`Missing or invalid 'description' in frontmatter: ${filePath}`);
        return null;
      }

      // Build metadata object
      const metadata: SkillMetadata = {
        name: parsed.name,
        description: parsed.description,
      };

  // Add optional fields
    if (parsed.license && typeof parsed.license === 'string') {
      metadata.license = parsed.license;
    }

    if (parsed.compatibility && typeof parsed.compatibility === 'string') {
      metadata.compatibility = parsed.compatibility;
    }

    if (parsed.hidden === true) {
      metadata.hidden = true;
    }

      if (parsed.metadata && typeof parsed.metadata === 'object') {
        metadata.metadata = parsed.metadata as Record<string, unknown>;
      }

      if (parsed.allowedTools && Array.isArray(parsed.allowedTools)) {
        metadata.allowedTools = parsed.allowedTools.filter(
          (t): t is string => typeof t === 'string'
        );
      }

      return metadata;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`YAML parsing error in ${filePath}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get all registered skill names
   * @returns Array of skill names
   */
  getSkillNames(): string[] {
    return Array.from(this.metadataCache.keys());
  }

  /**
   * Get metadata for a specific skill
   * Returns cached metadata (does not load body)
   *
   * @param name - Skill name
   * @returns SkillMetadata or undefined if not found
   */
  getSkillMetadata(name: string): SkillMetadata | undefined {
    const entry = this.metadataCache.get(name);
    return entry ? { ...entry.metadata } : undefined;
  }

  /**
   * Get metadata for all skills
   * @returns Array of all skill metadata
   */
  getAllMetadata(): SkillMetadata[] {
    return Array.from(this.metadataCache.values())
      .filter(entry => !entry.metadata.hidden)
      .map((entry) => ({ ...entry.metadata }));
  }

  /**
   * Load full skill including body content
   * Progressive disclosure: body is only loaded when needed
   *
   * @param name - Skill name
   * @returns Complete Skill object or null if not found/error
   */
  async loadFullSkill(name: string): Promise<Skill | null> {
    const entry = this.metadataCache.get(name);

    if (!entry) {
      this.logger.warn(`Skill not found: ${name}`);
      return null;
    }

    try {
      // Read full file content
      const content = await fs.readFile(entry.skillFilePath, 'utf-8');

      // Extract body (everything after frontmatter)
      const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
      const body = bodyMatch ? bodyMatch[1].trim() : '';

      // Build complete skill object
      const skill: Skill = {
        ...entry.metadata,
        body,
      };

      return skill;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error loading full skill "${name}": ${errorMsg}`);
      return null;
    }
  }

  /**
   * Clear the metadata cache
   * Useful for reloading skills
   */
  clearCache(): void {
    this.metadataCache.clear();
  }

  /**
   * Check if a skill is registered
   * @param name - Skill name
   * @returns true if skill exists in cache
   */
  hasSkill(name: string): boolean {
    return this.metadataCache.has(name);
  }

  /**
   * Get the number of registered skills
   * @returns Count of cached skills
   */
  getSkillCount(): number {
    return this.metadataCache.size;
  }

  // P2-3: 技能热重载（基于 fs.watch，事件驱动，零轮询开销）
  startWatch(): void {
    const skillsDir = CONFIG.SKILL_DIRECTORY;
    try {
      this.watcher = watch(skillsDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (filename.endsWith('SKILL.md') || filename.endsWith('skill.md')) {
          console.log(`[SkillRegistry] 检测到技能文件变更: ${filename}`);
          if (this.rescanDebounceTimer) clearTimeout(this.rescanDebounceTimer);
          this.rescanDebounceTimer = setTimeout(() => {
            this.rescanSkill(filename);
          }, 500);
        }
      });
      console.log(`[SkillRegistry] 已启动技能目录监听: ${skillsDir}`);
    } catch (error) {
      console.warn(`[SkillRegistry] 无法启动目录监听:`, error);
    }
  }

  stopWatch(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.rescanDebounceTimer) { clearTimeout(this.rescanDebounceTimer); this.rescanDebounceTimer = null; }
  }

  async rescanSkill(filename: string): Promise<void> {
    const parts = filename.replace(/\\/g, '/').split('/');
    const skillDirIndex = parts.indexOf('skills');
    if (skillDirIndex === -1 || skillDirIndex + 1 >= parts.length) return;
    const skillName = parts[skillDirIndex + 1];

    const skillDir = path.join(CONFIG.SKILL_DIRECTORY, skillName);
    const skillFilePath = path.join(skillDir, 'SKILL.md');

    // 清除旧缓存
    this.metadataCache.delete(skillName);

    // 检查文件是否仍存在（可能被删除）
    const fileStat = await fs.stat(skillFilePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      console.log(`[SkillRegistry] 技能 ${skillName} 已移除`);
      return;
    }

    // 重新解析并缓存
    const metadata = await this.parseFrontmatterOnly(skillFilePath);
    if (metadata && metadata.name && metadata.description) {
      this.metadataCache.set(metadata.name, {
        metadata,
        skillDir,
        skillFilePath,
      });
      console.log(`[SkillRegistry] 技能 ${metadata.name} 已重新加载`);
    } else {
      console.warn(`[SkillRegistry] 技能 ${skillName} 重新加载失败：解析元数据出错`);
    }
  }
}

export default SkillRegistry;
