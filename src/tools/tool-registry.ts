import { Tool, ToolContext, ToolResult } from './interfaces';
import { FileReadTool } from './file-read-tool';
import { BashTool } from './bash-tool';
import { GlobTool } from './glob-tool';
import { GrepTool } from './grep-tool';
import { WriteTool } from './write-tool';
import { EditTool } from './edit-tool';
import { ConversationGetTool } from './context-tool';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    const defaultTools = [
      new FileReadTool(),
      new BashTool(),
      new GlobTool(),
      new GrepTool(),
      new WriteTool(),
      new EditTool(),
      new ConversationGetTool(),
    ];

    for (const tool of defaultTools) {
      this.register(tool);
    }
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  get names(): string[] {
    return Array.from(this.tools.keys());
  }

  async execute(
    toolName: string,
    input: unknown,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    
    if (!tool) {
      return { success: false, error: `Tool not found: ${toolName}` };
    }

    return tool.execute(input, context);
  }

  /**
   * P1-2: 检查工具是否并发安全
   */
  isConcurrencySafe(toolName: string, toolArgs?: Record<string, unknown>): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;
    if (typeof tool.isConcurrencySafe === 'function') {
      return tool.isConcurrencySafe(toolArgs);
    }
    return false;
  }

  isReadOnly(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    return tool ? tool.isReadOnly() : true;
  }
}

export default ToolRegistry;
