import { readFileSync } from 'fs';
import { join } from 'path';
import type { SystemSkill } from './types';
import { resolveResource } from '../utils/app-root';

export type { SystemSkill, SystemSkillExecutor, SystemSkillResult } from './types';
export { ExecutorRegistry } from './executor-registry';

export class SystemSkillLoader {
  private skills: Map<string, SystemSkill> = new Map();
  private systemSkillsDir: string;

  constructor(systemSkillsDir?: string) {
    this.systemSkillsDir = systemSkillsDir || resolveResource('system-skills');
  }

  loadAll(): Map<string, SystemSkill> {
    this.skills.clear();

    const fs = require('fs');

    try {
      const entries = fs.readdirSync(this.systemSkillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = join(this.systemSkillsDir, entry.name);
        const skillMdPath = join(skillDir, 'SKILL.md');

        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const content = readFileSync(skillMdPath, 'utf-8');
          const parsed = this.parseSkillMd(content, entry.name, skillDir);
          if (parsed) {
            this.skills.set(parsed.command, parsed);
          }
        } catch (err) {
          console.warn(`[SystemSkillLoader] ⚠️ 加载系统技能失败: ${entry.name}: ${err}`);
        }
      }
    } catch (err) {
      console.warn(`[SystemSkillLoader] ⚠️ 扫描 system-skills 目录失败: ${err}`);
    }

    console.log(`[System] 系统技能已加载 (${this.skills.size}):`);
    for (const [cmd, skill] of this.skills) {
      console.log(`  /${cmd} - ${skill.description}${skill.adminOnly ? ' [admin]' : ''}`);
    }

    return this.skills;
  }

  private parseSkillMd(content: string, commandName: string, skillDir: string): SystemSkill | null {
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!frontmatterMatch) return null;

    const frontmatter = frontmatterMatch[1];

    const name = this.extractYamlValue(frontmatter, 'name') || commandName;
    const description = this.extractYamlValue(frontmatter, 'description') || '';
    const executor = this.extractNestedYamlValue(frontmatter, 'metadata', 'executor') || 'sub-agent';
    const adminOnlyStr = this.extractNestedYamlValue(frontmatter, 'metadata', 'adminOnly') || 'false';
    const adminOnly = adminOnlyStr.toLowerCase() === 'true';

    return {
      name,
      command: commandName,
      description,
      executor,
      adminOnly,
      skillDir,
      skillContent: content,
    };
  }

  private extractYamlValue(yaml: string, key: string): string | null {
    const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const match = yaml.match(regex);
    return match ? match[1].trim() : null;
  }

  private extractNestedYamlValue(yaml: string, _parentKey: string, childKey: string): string | null {
    const regex = new RegExp(`^\\s{2}${childKey}:\\s*(.+)$`, 'm');
    const match = yaml.match(regex);
    return match ? match[1].trim() : null;
  }

  getCommand(commandName: string): SystemSkill | undefined {
    return this.skills.get(commandName);
  }

  getAllCommands(): string[] {
    return Array.from(this.skills.keys());
  }

  static isSystemCommand(input: string): boolean {
    return input.startsWith('/');
  }

  static extractCommandName(input: string): string {
    return input.slice(1).split(' ')[0].split('/')[0];
  }
}
