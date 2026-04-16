import { Tool, ToolContext, ToolResult } from './interfaces';
import { sessionContextService } from '../memory/session-context';

export class ConversationGetTool implements Tool {
  name = 'conversation-get';
  description = '获取当前会话的对话历史。用于查看之前的对话内容，从中提取信息。';
  parameters = {
    limit: { type: 'number', description: '获取最近 N 条对话，默认 10' },
  };
  required = [];

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { limit = 10 } = (input as { limit?: number }) || {};

    try {
      const sessionContext = sessionContextService.getContext(context.sessionId);
      const recentConversation = sessionContext.conversation.slice(-limit);

      return {
        success: true,
        data: recentConversation,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }

  isConcurrencySafe(_input: unknown): boolean {
    return true;
  }

  isReadOnly(): boolean {
    return true;
  }
}

export default {
  ConversationGetTool,
};
