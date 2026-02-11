import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { Skill, SkillMetadata } from '../types';

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
            this.logger.warn(
              `Duplicate skill name "${metadata.name}" found. ` +
                `Existing: ${existing.skillFilePath}, New: ${skillFilePath}. ` +
                `Skipping new entry.`
            );
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
    return Array.from(this.metadataCache.values()).map((entry) => ({
      ...entry.metadata,
    }));
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

      // Check for optional directories
      const scriptsDir = path.join(entry.skillDir, 'scripts');
      const referencesDir = path.join(entry.skillDir, 'references');
      const assetsDir = path.join(entry.skillDir, 'assets');

      // Only add directory paths if they exist
      try {
        const scriptsStat = await fs.stat(scriptsDir);
        if (scriptsStat.isDirectory()) {
          skill.scriptsDir = scriptsDir;
        }
      } catch {
        // Directory doesn't exist, don't add
      }

      try {
        const referencesStat = await fs.stat(referencesDir);
        if (referencesStat.isDirectory()) {
          skill.referencesDir = referencesDir;
        }
      } catch {
        // Directory doesn't exist, don't add
      }

      try {
        const assetsStat = await fs.stat(assetsDir);
        if (assetsStat.isDirectory()) {
          skill.assetsDir = assetsDir;
        }
      } catch {
        // Directory doesn't exist, don't add
      }

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
}

export default SkillRegistry;
