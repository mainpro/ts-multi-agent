import { existsSync, copyFileSync } from 'fs';
import { ILLMClient } from '../llm';
import { ImprovementStore } from '../improvements';
import type { ImprovementEntry } from '../improvements';

export interface ChangePlan {
  entryId: string;
  analysis: string;
  changes: Change[];
  risk: 'low' | 'medium' | 'high';
  testStrategy: string;
}

export interface Change {
  file: string;
  type: 'edit' | 'replace' | 'append';
  target: string;
  content: string;
}

export interface ProcessResult {
  entry: ImprovementEntry | null;
  plan: ChangePlan | null;
  rejected?: boolean;
  reason?: string;
  approvalQuestion?: string;
}

export class ImprovementAgent {
  private llm: ILLMClient;
  private store: ImprovementStore;

  constructor(llm: ILLMClient, store?: ImprovementStore) {
    this.llm = llm;
    this.store = store || new ImprovementStore();
  }

  /**
   * 获取下一条待处理的 pending 条目
   */
  async getNextPending(): Promise<ImprovementEntry | null> {
    const pending = this.store.getPending({ limit: 1 });
    return pending[0] || null;
  }

  /**
   * 处理下一条 pending 条目
   * 读取→分析→生成修改方案
   */
  async processNextPending(): Promise<ProcessResult> {
    const entry = await this.getNextPending();

    if (!entry) {
      return { entry: null, plan: null };
    }

    const plan = await this.analyzeEntry(entry);

    if (!plan || plan.changes.length === 0) {
      return {
        entry,
        plan: null,
        rejected: true,
        reason: plan?.analysis || '无法生成有效的修改方案',
      };
    }

    plan.entryId = entry.id;

    const approvalQuestion = this.formatApprovalQuestion(entry, plan);

    return { entry, plan, approvalQuestion };
  }

  private formatApprovalQuestion(entry: ImprovementEntry, plan: ChangePlan): string {
    const changesText = plan.changes.map((c, i) =>
      `### 修改 ${i + 1}: ${c.file}\n- 类型: ${c.type}\n- 目标: ${c.target}\n- 新内容:\n\`\`\`\n${c.content.substring(0, 500)}\n\`\`\``
    ).join('\n\n');

    return `## 改进建议 #${entry.id}

**问题**: ${entry.description}
**根因**: ${entry.rootCause || plan.analysis}

**修改方案**:
${changesText}

**风险等级**: ${plan.risk}
**验证策略**: ${plan.testStrategy}

是否应用此修改？(yes/no/skip)`;
  }

  async executePlan(
    entry: ImprovementEntry,
    plan: ChangePlan,
    decision: 'yes' | 'no' | 'skip',
    reason?: string
  ): Promise<{ success: boolean; message: string }> {
    if (decision === 'yes') {
      for (const change of plan.changes) {
        try {
          if (existsSync(change.file)) {
            copyFileSync(change.file, change.file + '.bak');
          }
        } catch {
        }
        console.log(`[ImprovementAgent] 计划修改: ${change.file} (${change.type})`);
      }

      return {
        success: true,
        message: `已执行改进方案 #${entry.id}，共 ${plan.changes.length} 处修改`,
      };
    } else if (decision === 'no') {
      return {
        success: true,
        message: `已拒绝改进方案 #${entry.id}${reason ? `，原因: ${reason}` : ''}`,
      };
    } else {
      return {
        success: true,
        message: `已跳过改进方案 #${entry.id}，保持 pending 状态`,
      };
    }
  }

  async updateEntryStatus(
    entryId: string,
    newStatus: 'completed' | 'rejected',
  ): Promise<boolean> {
    return this.store.updateStatus(entryId, newStatus);
  }

  /**
   * 使用 LLM 分析条目，生成修改方案
   */
  private async analyzeEntry(entry: ImprovementEntry): Promise<ChangePlan | null> {
    const prompt = `你是一个代码质量改进专家。请分析以下改进记录中的改进建议，并生成具体的修改方案。

## 待处理条目
- **ID**: ${entry.id}
- **类别**: ${entry.category}
- **优先级**: ${entry.priority}
- **描述**: ${entry.description}
- **根因**: ${entry.rootCause || '(未提供)'}
- **建议**: ${entry.suggestion || '(未提供)'}
- **涉及文件**: ${entry.involvedFiles?.join(', ') || '(未指定)'}
${entry.context ? `- **上下文**: ${entry.context}` : ''}
${entry.reproductionSteps ? `- **复现步骤**: ${entry.reproductionSteps}` : ''}

## 任务
1. 分析这个改进建议是否合理
2. 如果合理，生成具体的修改方案（修改哪些文件、如何修改）
3. 评估修改风险（low/medium/high）
4. 说明验证策略

## 输出格式
请以 JSON 格式输出（不要包含其他内容）：
{
  "entryId": "${entry.id}",
  "analysis": "详细的根因确认分析",
  "changes": [
    {
      "file": "文件路径",
      "type": "edit|replace|append",
      "target": "要替换的文本或位置描述",
      "content": "修改后的内容"
    }
  ],
  "risk": "low|medium|high",
  "testStrategy": "如何验证这个修改的正确性"
}

## 评估标准
- 如果建议**不合理**（如描述不清、无法复现、不必要），请在 analysis 中说明理由，changes 返回空数组
- 如果建议**合理**但文件路径不明确，请在 analysis 中说明需要哪些额外信息
- 如果建议**合理且可行**，请生成包含具体修改内容的 changes
- 不要修改改进记录本身
- type 支持: edit(修改现有内容), replace(替换整个文件), append(追加到文件末尾)`;

    try {
      const content = await this.llm.generateText(prompt);

      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        try {
          const plan = JSON.parse(codeBlockMatch[1].trim()) as ChangePlan;
          if (!plan.entryId || !plan.analysis) return null;
          return plan;
        } catch {
          // fall through to raw JSON extraction
        }
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const plan = JSON.parse(jsonMatch[0]) as ChangePlan;
      if (!plan.entryId || !plan.analysis) return null;

      return plan;
    } catch {
      return null;
    }
  }

  async execute(
    _skill: any,
    _params?: Record<string, unknown>,
  ): Promise<{ success: boolean; message?: string; error?: string; data?: unknown }> {
    const result = await this.processNextPending();
    if (!result.entry) {
      return { success: true, message: '没有待处理的改进建议' };
    }
    if (result.rejected) {
      return { success: false, error: result.reason || '改进建议被拒绝' };
    }
    return {
      success: true,
      data: result,
      message: result.approvalQuestion,
    };
  }
}
