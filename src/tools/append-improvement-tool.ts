/**
 * AppendImprovementTool - Record improvement entries to the improvements store
 *
 * Allows SubAgent to record improvement suggestions during execution.
 * Append-only: can only add entries, cannot read/modify/delete existing ones.
 * Writes JSON entries to the improvements/ directory via ImprovementStore.
 */

import { BaseTool } from './base-tool';
import type { ToolContext, ToolResult, ToolParameters } from './interfaces';
import { ImprovementStore } from '../improvements';
import type { ImprovementEntry, ImprovementCategory } from '../improvements';

export interface AppendImprovementArgs {
  category: string;
  skill: string;
  description: string;
  rootCause?: string;
  suggestion?: string;
  involvedFiles?: string[];
  context?: string;
  reproductionSteps?: string[];
}

export class AppendImprovementTool extends BaseTool {
  name = 'append_improvement';

  description = `记录一条改进建议到改进记录中。

Use this tool to record improvement suggestions, bug reports, or optimization ideas discovered during task execution. Entries are append-only and cannot be modified or deleted.

### Entry Criteria (what to record)

MUST record:
- Bug that caused execution failure or incorrect results (severity: critical/high)
- Foreseeable risks: mismatched params, hardcoded paths, race conditions, security gaps (severity: medium/high)
- Ambiguous instructions: AI had to guess intent multiple times (severity: medium)

SHOULD record:
- Same issue recurring 3+ times (severity: low/medium, note recurrence: 3+)
- Execution succeeded but felt fragile / "lucky" (severity: low, note reason: luck)

MUST NOT record:
- One-time network timeouts (external dependency issue)
- Cosmetic typos/formatting that don't affect functionality
- One-time LLM hallucination (won't stably reproduce)
- Feature requests ("would be nice to have X")

Arguments:
- category (required): bug, improvement, optimization, refactoring, security, other
- skill (required): Name of the skill being executed
- description (required): Clear description of the issue
- severity (optional): critical, high, medium, low (default: medium)
- rootCause (optional): Root cause analysis
- suggestion (optional): Suggested fix or improvement
- involvedFiles (optional): Array of file paths involved
- context (optional): Additional execution context
- reproductionSteps (optional): Steps to reproduce`;

  parameters: ToolParameters = {
    category: {
      type: 'string',
      description: 'Entry category: bug, improvement, optimization, refactoring, security, other',
      enum: ['bug', 'improvement', 'optimization', 'refactoring', 'security', 'other'],
    },
    skill: {
      type: 'string',
      description: 'Name of the skill that generated this improvement entry',
    },
    description: {
      type: 'string',
      description: 'Clear description of the improvement or issue found',
    },
    rootCause: {
      type: 'string',
      description: 'Root cause analysis of the issue (optional)',
    },
    suggestion: {
      type: 'string',
      description: 'Suggested fix or improvement approach (optional)',
    },
    involvedFiles: {
      type: 'string',
      description: 'Comma-separated list of files involved in this issue (optional)',
    },
    context: {
      type: 'string',
      description: 'Additional context information (optional)',
    },
    reproductionSteps: {
      type: 'string',
      description: 'Comma-separated reproduction steps for bugs (optional)',
    },
  };

  required = ['category', 'skill', 'description'];

  isConcurrencySafe(_input: unknown): boolean {
    return false;
  }

  isReadOnly(): boolean {
    return false;
  }

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = input as AppendImprovementArgs;

    try {
      if (!args.category || typeof args.category !== 'string' || args.category.trim().length === 0) {
        return { success: false, error: 'category is required and must be a non-empty string' };
      }
      if (!args.skill || typeof args.skill !== 'string' || args.skill.trim().length === 0) {
        return { success: false, error: 'skill is required and must be a non-empty string' };
      }
      if (!args.description || typeof args.description !== 'string' || args.description.trim().length === 0) {
        return { success: false, error: 'description is required and must be a non-empty string' };
      }

      const validCategories = ['bug', 'improvement', 'optimization', 'refactoring', 'security', 'other'];
      if (!validCategories.includes(args.category.trim().toLowerCase())) {
        return { success: false, error: `category must be one of: ${validCategories.join(', ')}` };
      }

      const store = new ImprovementStore();
      const entryId = this.generateEntryId(store);
      const now = new Date().toISOString();
      const entry: ImprovementEntry = {
        id: entryId,
        type: 'improvement',
        category: args.category.trim().toLowerCase() as ImprovementCategory,
        skill: args.skill.trim(),
        priority: 'P1',
        status: 'pending',
        created_at: now,
        description: args.description.trim(),
        rootCause: args.rootCause?.trim(),
        suggestion: args.suggestion?.trim(),
        involvedFiles: args.involvedFiles,
        context: args.context?.trim(),
        reproductionSteps: args.reproductionSteps?.join(', '),
      };

      await store.create(entry);
      return {
        success: true,
        data: {
          entryId,
          message: `Improvement entry ${entryId} created`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to create improvement entry: ${message}` };
    }
  }

  /**
   * Generate entry ID in format: agent-YYYYMMDD-NNN
   * NNN is a sequence number based on existing entries for the same date.
   */
  private generateEntryId(store: ImprovementStore): string {
    const today = new Date();
    const dateStr = today.getFullYear().toString() +
      String(today.getMonth() + 1).padStart(2, '0') +
      String(today.getDate()).padStart(2, '0');
    const prefix = `agent-${dateStr}-`;

    const existing = store.getAll();
    const matches = existing.filter(e => e.id.startsWith(prefix));
    const seq = matches.length + 1;

    return `${prefix}${String(seq).padStart(3, '0')}`;
  }
}
