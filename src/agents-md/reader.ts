import { promises as fs } from 'fs';
import * as yaml from 'yaml';
import {
  AgentMdEntry,
  AgentMdSection,
  EntryCategory,
  EntryStatus,
} from './types';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const SECTION_HEADER_REGEX = /^##\s+(.+)\s*$/gm;

function sectionNameToEnum(sectionName: string): AgentMdSection {
  const normalized = sectionName.toLowerCase().replace(/\s+/g, '');
  if (normalized.includes('knowledge')) return AgentMdSection.KNOWLEDGE;
  if (normalized.includes('pending')) return AgentMdSection.PENDING;
  if (normalized.includes('history')) return AgentMdSection.HISTORY;
  return AgentMdSection.HISTORY;
}

function isValidCategory(value: string): value is EntryCategory {
  return Object.values(EntryCategory).includes(value as EntryCategory);
}

function isValidStatus(value: string): value is EntryStatus {
  return Object.values(EntryStatus).includes(value as EntryStatus);
}

function isValidPriority(value: string): value is 'P0' | 'P1' | 'P2' {
  return ['P0', 'P1', 'P2'].includes(value);
}

function parseEntriesFromSection(
  sectionContent: string,
  section: AgentMdSection,
): AgentMdEntry[] {
  const entries: AgentMdEntry[] = [];
  const blocks = sectionContent.split(/^(?=---\r?\n)/m).filter(Boolean);

  for (const block of blocks) {
    const match = block.match(FRONTMATTER_REGEX);
    if (!match) continue;

    const frontmatterContent = match[1];
    const rawContent = block.slice(match[0].length).trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = yaml.parse(frontmatterContent) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (!parsed.id || typeof parsed.id !== 'string') continue;
    if (!parsed.type || typeof parsed.type !== 'string') continue;

    const category = isValidCategory(parsed.category as string)
      ? (parsed.category as EntryCategory)
      : EntryCategory.OTHER;

    const status = isValidStatus(parsed.status as string)
      ? (parsed.status as EntryStatus)
      : EntryStatus.PENDING;

    const priority = isValidPriority(parsed.priority as string)
      ? (parsed.priority as 'P0' | 'P1' | 'P2')
      : 'P2';

    const entry: AgentMdEntry = {
      id: parsed.id,
      type: parsed.type,
      category,
      skill: typeof parsed.skill === 'string' ? parsed.skill : 'general',
      priority,
      status,
      created_at:
        typeof parsed.created_at === 'string'
          ? parsed.created_at
          : new Date().toISOString(),
      description:
        typeof parsed.description === 'string' ? parsed.description : '',
      section,
      rawContent,
    };

    if (parsed.rootCause && typeof parsed.rootCause === 'string') {
      entry.rootCause = parsed.rootCause;
    }
    if (parsed.suggestion && typeof parsed.suggestion === 'string') {
      entry.suggestion = parsed.suggestion;
    }
    if (Array.isArray(parsed.involvedFiles)) {
      entry.involvedFiles = parsed.involvedFiles as string[];
    }
    if (parsed.context && typeof parsed.context === 'string') {
      entry.context = parsed.context;
    }
    if (parsed.reproductionSteps && typeof parsed.reproductionSteps === 'string') {
      entry.reproductionSteps = parsed.reproductionSteps;
    }

    entries.push(entry);
  }

  return entries;
}

export async function parseAgentMd(filePath: string): Promise<AgentMdEntry[]> {
  const content = await fs.readFile(filePath, 'utf-8');

  const sections: { name: string; start: number }[] = [];
  let match: RegExpExecArray | null;

  const headerRegex = new RegExp(SECTION_HEADER_REGEX.source, 'gm');
  while ((match = headerRegex.exec(content)) !== null) {
    sections.push({ name: match[1], start: match.index });
  }

  if (sections.length === 0) return [];

  const allEntries: AgentMdEntry[] = [];

  for (let i = 0; i < sections.length; i++) {
    const start = sections[i].start;
    const end = i + 1 < sections.length ? sections[i + 1].start : content.length;
    const headerEndIdx = content.indexOf('\n', start);
    const sectionContent = content.slice(headerEndIdx + 1, end).trim();
    const section = sectionNameToEnum(sections[i].name);

    const entries = parseEntriesFromSection(sectionContent, section);
    allEntries.push(...entries);
  }

  return allEntries;
}
