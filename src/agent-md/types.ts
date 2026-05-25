export enum EntryCategory {
  DESCRIPTION = 'description',
  SCRIPT = 'script',
  LOGIC = 'logic',
  SECURITY = 'security',
  PROMPT = 'prompt',
  OTHER = 'other',
}

export enum EntryStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  COMPLETED = 'completed',
}

export enum AgentMdSection {
  KNOWLEDGE = 'knowledge',
  PENDING = 'pending',
  HISTORY = 'history',
}

export interface AgentMdEntry {
  id: string;
  type: string;
  category: EntryCategory;
  skill: string;
  priority: 'P0' | 'P1' | 'P2';
  status: EntryStatus;
  created_at: string;
  description: string;
  rootCause?: string;
  suggestion?: string;
  involvedFiles?: string[];
  context?: string;
  reproductionSteps?: string;
  section: AgentMdSection;
  rawContent: string;
}
