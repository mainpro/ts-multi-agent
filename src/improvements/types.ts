export type ImprovementPriority = 'P0' | 'P1' | 'P2';
export type ImprovementStatus = 'pending' | 'completed' | 'rejected';
export type ImprovementType = 'improvement' | 'bug' | 'optimization' | 'refactoring' | 'security' | 'other';
export type ImprovementCategory = 'description' | 'script' | 'logic' | 'security' | 'prompt' | 'other';

export interface ImprovementEntry {
  id: string;
  type: ImprovementType;
  category: ImprovementCategory;
  skill: string;
  priority: ImprovementPriority;
  status: ImprovementStatus;
  created_at: string;
  description: string;
  rootCause?: string;
  suggestion?: string;
  involvedFiles?: string[];
  context?: string;
  reproductionSteps?: string;
}
