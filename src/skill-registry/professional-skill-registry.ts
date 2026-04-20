import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { Skill, SkillMetadata, ProfessionalSkill } from '../types';

/**
 * Internal cache entry for professional skill metadata and file path
 */
interface ProfessionalSkillCacheEntry {
  metadata: SkillMetadata;
  skillDir: string;
  skillFilePath: string;
}

/**
 * ProfessionalSkillRegistry - Manages professional skill discovery and loading
 * 
 * Features:
 * - Scans professional-skills directory for SKILL.md files
 * - Parses YAML frontmatter for metadata (cached)
 * - Lazy loads full skill body on demand
 * - Handles errors gracefully (logs warnings, continues scanning)
 */
export class ProfessionalSkillRegistry {
  /** Cache of professional skill metadata keyed by skill name */
  private metadataCache: Map<string, ProfessionalSkillCacheEntry> = new Map();
  
  /** Logger function for warnings and errors */
  private logger: { warn: (msg: string) => void; error: (msg: string) => void };
  
  /** Professional skills directory path */
  private readonly PROFESSIONAL_SKILLS_DIR = './professional-skills/';

  constructor(
    logger: { warn: (msg: string) => void; error: (msg: string) => void } = console
  ) {
    this.logger = logger;
  }

  /**
   * Scan professional skills directory for skills
   * Parses only YAML frontmatter (metadata), body is loaded on-demand
   * 
   * @returns Array of successfully loaded professional skill names
   */
  async scanProfessionalSkills(): Promise<string[]> {
    const loadedSkills: string[] = [];
    
    try {
      // Check if directory exists
      const dirStat = await fs.stat(this.PROFESSIONAL_SKILLS_DIR).catch(() => null);
      if (!dirStat || !dirStat.isDirectory()) {
        this.logger.warn(`Professional skills directory not found: ${this.PROFESSIONAL_SKILLS_DIR}`);
        return loadedSkills;
      }

      // Read all entries in the directory
      const entries = await fs.readdir(this.PROFESSIONAL_SKILLS_DIR, { withFileTypes: true });
      
      // Process each subdirectory that might contain a SKILL.md
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const skillDir = path.join(this.PROFESSIONAL_SKILLS_DIR, entry.name);
        const skillFilePath = path.join(skillDir, 'SKILL.md');
        
        try {
          // Check if SKILL.md exists
          const fileStat = await fs.stat(skillFilePath).catch(() => null);
          if (!fileStat || !fileStat.isFile()) {
            this.logger.warn(`SKILL.md not found in professional skill: ${skillDir}`);
            continue;
          }

          // Read and parse only frontmatter (metadata)
          const metadata = await this.parseFrontmatterOnly(skillFilePath);
          
          if (!metadata) {
            this.logger.warn(`Failed to parse frontmatter in professional skill: ${skillFilePath}`);
            continue;
          }

          // Validate required fields
          if (!metadata.name || !metadata.description) {
            this.logger.warn(
              `Professional skill missing required fields (name/description): ${skillFilePath}`
            );
            continue;
          }

          // Set type to professional if not specified
          if (!metadata.type) {
            metadata.type = 'professional';
          }

          // Check for duplicate names
          if (this.metadataCache.has(metadata.name)) {
            const existing = this.metadataCache.get(metadata.name)!;
            this.logger.warn(
              `Duplicate professional skill name "${metadata.name}" found. ` +
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
          this.logger.error(`Error processing professional skill at ${skillDir}: ${errorMsg}`);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error scanning professional skills directory ${this.PROFESSIONAL_SKILLS_DIR}: ${errorMsg}`);
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
        this.logger.warn(`No YAML frontmatter found in professional skill: ${filePath}`);
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
        type: parsed.type as 'business' | 'professional' || 'professional',
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
      this.logger.error(`YAML parsing error in professional skill ${filePath}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get all registered professional skill names
   * @returns Array of professional skill names
   */
  getProfessionalSkillNames(): string[] {
    return Array.from(this.metadataCache.keys());
  }

  /**
   * Get metadata for a specific professional skill
   * Returns cached metadata (does not load body)
   * 
   * @param name - Professional skill name
   * @returns SkillMetadata or undefined if not found
   */
  getProfessionalSkillMetadata(name: string): SkillMetadata | undefined {
    const entry = this.metadataCache.get(name);
    return entry ? { ...entry.metadata } : undefined;
  }

  /**
   * Get metadata for all professional skills
   * @returns Array of all professional skill metadata
   */
  getAllProfessionalMetadata(): SkillMetadata[] {
    return Array.from(this.metadataCache.values())
      .filter(entry => !entry.metadata.hidden)
      .map((entry) => ({ ...entry.metadata }));
  }

  /**
   * Load full professional skill including body content
   * Progressive disclosure: body is only loaded when needed
   * 
   * @param name - Professional skill name
   * @returns Complete ProfessionalSkill object or null if not found/error
   */
  async loadFullProfessionalSkill(name: string): Promise<ProfessionalSkill | null> {
    const entry = this.metadataCache.get(name);

    if (!entry) {
      this.logger.warn(`Professional skill not found: ${name}`);
      return null;
    }

    try {
      // Read full file content
      const content = await fs.readFile(entry.skillFilePath, 'utf-8');

      // Extract body (everything after frontmatter)
      const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
      const body = bodyMatch ? bodyMatch[1].trim() : '';

      // Build complete professional skill object
      const skill: ProfessionalSkill = {
        ...entry.metadata,
        type: 'professional',
        body,
        targetAgent: (entry.metadata.metadata?.targetAgent as 'reflector' | 'optimizer') || 'reflector',
      };

      return skill;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error loading full professional skill "${name}": ${errorMsg}`);
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
   * Check if a professional skill is registered
   * @param name - Professional skill name
   * @returns true if professional skill exists in cache
   */
  hasProfessionalSkill(name: string): boolean {
    return this.metadataCache.has(name);
  }

  /**
   * Get the number of registered professional skills
   * @returns Count of cached professional skills
   */
  getProfessionalSkillCount(): number {
    return this.metadataCache.size;
  }
}

export default ProfessionalSkillRegistry;