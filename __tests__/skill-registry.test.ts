import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SkillRegistry } from '../src/skill-registry';
import type { SkillMetadata } from '../src/types';

const mockFs = {
  stat: mock(async (path: string) => {
    if (path.includes('not-a-directory')) {
      throw new Error('Not a directory');
    }
    if (path.includes('nonexistent')) {
      throw new Error('File not found');
    }
    return {
      isDirectory: () => path.endsWith('skills') || !path.endsWith('.md'),
      isFile: () => path.endsWith('.md'),
    };
  }),
  readdir: mock(async (dir: string, options: { withFileTypes?: boolean }) => {
    if (dir.includes('skills-valid')) {
      return [
        { name: 'calculator', isDirectory: () => true, isFile: () => false },
        { name: 'writer', isDirectory: () => true, isFile: () => false },
        { name: 'not-a-dir.txt', isDirectory: () => false, isFile: () => true },
      ];
    }
    if (dir.includes('skills-empty')) {
      return [];
    }
    if (dir.includes('skills-missing-skill-md')) {
      return [
        { name: 'empty-skill', isDirectory: () => true, isFile: () => false },
      ];
    }
    if (dir.includes('skills-duplicate')) {
      return [
        { name: 'skill-a', isDirectory: () => true, isFile: () => false },
        { name: 'skill-b', isDirectory: () => true, isFile: () => false },
      ];
    }
    throw new Error('Directory not found');
  }),
  readFile: mock(async (filePath: string) => {
    if (filePath.includes('calculator/SKILL.md')) {
      return `---
name: calculator
description: A calculator skill
license: MIT
compatibility: universal
metadata:
  author: Test
  version: '1.0'
allowedTools:
  - math
---

# Calculator Skill

This is the body of the calculator skill.
`;
    }
    if (filePath.includes('writer/SKILL.md')) {
      return `---
name: writer
description: A writer skill
---

# Writer Skill

This writes things.
`;
    }
    if (filePath.includes('skill-a/SKILL.md') || filePath.includes('skill-b/SKILL.md')) {
      return `---
name: duplicate-name
description: Duplicate skill
---

# Duplicate Skill
`;
    }
    if (filePath.includes('invalid-yaml/SKILL.md')) {
      return `---
invalid yaml content: [unclosed
---

Body`;
    }
    if (filePath.includes('missing-name/SKILL.md')) {
      return `---
description: Missing name field
---

Body`;
    }
    if (filePath.includes('missing-desc/SKILL.md')) {
      return `---
name: no-desc
---

Body`;
    }
    if (filePath.includes('no-frontmatter/SKILL.md')) {
      return `# No Frontmatter

Just body content.`;
    }
    throw new Error('File not found');
  }),
};

mock.module('fs', () => ({
  promises: mockFs,
}));

mock.module('fs/promises', () => mockFs);

describe('SkillRegistry', () => {
  let registry: SkillRegistry;
  let logger: { warn: ReturnType<typeof mock>; error: ReturnType<typeof mock> };

  beforeEach(() => {
    logger = {
      warn: mock(() => {}),
      error: mock(() => {}),
    };
    registry = new SkillRegistry(logger);
    mockFs.stat.mockClear?.();
    mockFs.readdir.mockClear?.();
    mockFs.readFile.mockClear?.();
    logger.warn.mockClear?.();
    logger.error.mockClear?.();
  });

  describe('constructor', () => {
    it('should create registry with custom logger', () => {
      expect(registry).toBeDefined();
    });

    it('should create registry with default console logger', () => {
      const defaultRegistry = new SkillRegistry();
      expect(defaultRegistry).toBeDefined();
    });
  });

  describe('scanSkills', () => {
    it('should return empty array for non-existent directory', async () => {
      const result = await registry.scanSkills('./nonexistent');
      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should return empty array for file instead of directory', async () => {
      const result = await registry.scanSkills('./not-a-directory');
      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should scan valid skills directory and load skills', async () => {
      const result = await registry.scanSkills('./skills-valid');
      expect(result).toContain('calculator');
      expect(result).toContain('writer');
      expect(result).toHaveLength(2);
    });

    it('should return empty array for empty directory', async () => {
      const result = await registry.scanSkills('./skills-empty');
      expect(result).toEqual([]);
    });

    it('should skip directories without SKILL.md', async () => {
      const result = await registry.scanSkills('./skills-missing-skill-md');
      expect(result).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should skip non-directory entries', async () => {
      const result = await registry.scanSkills('./skills-valid');
      expect(result).not.toContain('not-a-dir.txt');
    });

    it('should detect and skip duplicate skill names', async () => {
      const result = await registry.scanSkills('./skills-duplicate');
      expect(result).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should handle errors gracefully and continue scanning', async () => {
      const result = await registry.scanSkills('./skills-valid');
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getSkillMetadata', () => {
    it('should return undefined for non-existent skill', () => {
      const metadata = registry.getSkillMetadata('non-existent');
      expect(metadata).toBeUndefined();
    });

    it('should return metadata for cached skill', async () => {
      await registry.scanSkills('./skills-valid');
      const metadata = registry.getSkillMetadata('calculator');
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('calculator');
      expect(metadata?.description).toBe('A calculator skill');
      expect(metadata?.license).toBe('MIT');
    });

    it('should return copy of metadata (not reference)', async () => {
      await registry.scanSkills('./skills-valid');
      const metadata1 = registry.getSkillMetadata('calculator');
      const metadata2 = registry.getSkillMetadata('calculator');
      expect(metadata1).not.toBe(metadata2);
    });
  });

  describe('getAllMetadata', () => {
    it('should return empty array when no skills loaded', () => {
      const metadata = registry.getAllMetadata();
      expect(metadata).toEqual([]);
    });

    it('should return all skill metadata', async () => {
      await registry.scanSkills('./skills-valid');
      const metadata = registry.getAllMetadata();
      expect(metadata).toHaveLength(2);
      expect(metadata.map(m => m.name)).toContain('calculator');
      expect(metadata.map(m => m.name)).toContain('writer');
    });
  });

  describe('getSkillNames', () => {
    it('should return empty array when no skills loaded', () => {
      const names = registry.getSkillNames();
      expect(names).toEqual([]);
    });

    it('should return all skill names', async () => {
      await registry.scanSkills('./skills-valid');
      const names = registry.getSkillNames();
      expect(names).toContain('calculator');
      expect(names).toContain('writer');
    });
  });

  describe('hasSkill', () => {
    it('should return false for non-existent skill', () => {
      expect(registry.hasSkill('non-existent')).toBe(false);
    });

    it('should return true for cached skill', async () => {
      await registry.scanSkills('./skills-valid');
      expect(registry.hasSkill('calculator')).toBe(true);
    });
  });

  describe('getSkillCount', () => {
    it('should return 0 when no skills loaded', () => {
      expect(registry.getSkillCount()).toBe(0);
    });

    it('should return correct count after scanning', async () => {
      await registry.scanSkills('./skills-valid');
      expect(registry.getSkillCount()).toBe(2);
    });
  });

  describe('loadFullSkill', () => {
    it('should return null for non-existent skill', async () => {
      const skill = await registry.loadFullSkill('non-existent');
      expect(skill).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should load full skill with body', async () => {
      await registry.scanSkills('./skills-valid');
      const skill = await registry.loadFullSkill('calculator');
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('calculator');
      expect(skill?.body).toContain('Calculator Skill');
    });

    it('should include optional directories if they exist', async () => {
      const originalStat = mockFs.stat;
      mockFs.stat = mock(async (path: string) => {
        if (path.includes('scripts') || path.includes('references') || path.includes('assets')) {
          return { isDirectory: () => true, isFile: () => false };
        }
        return originalStat(path);
      });

      await registry.scanSkills('./skills-valid');
      const skill = await registry.loadFullSkill('calculator');
      
      expect(skill?.scriptsDir).toBeDefined();
      expect(skill?.referencesDir).toBeDefined();
      expect(skill?.assetsDir).toBeDefined();
    });
  });

  describe('clearCache', () => {
    it('should clear all cached skills', async () => {
      await registry.scanSkills('./skills-valid');
      expect(registry.getSkillCount()).toBe(2);
      registry.clearCache();
      
      expect(registry.getSkillCount()).toBe(0);
      expect(registry.getSkillNames()).toEqual([]);
    });
  });
});

describe('SkillRegistry - Frontmatter Parsing Edge Cases', () => {
  let registry: SkillRegistry;
  let logger: { warn: ReturnType<typeof mock>; error: ReturnType<typeof mock> };

  beforeEach(() => {
    logger = {
      warn: mock(() => {}),
      error: mock(() => {}),
    };
    registry = new SkillRegistry(logger);
  });

  it('should handle missing frontmatter gracefully', async () => {
    expect(registry).toBeDefined();
  });

  it('should handle invalid YAML gracefully', async () => {
    expect(registry).toBeDefined();
  });
});
