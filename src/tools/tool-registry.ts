import { Tool, ToolContext, ToolResult } from './interfaces';
import { FileReadTool } from './file-read-tool';
import { BashTool } from './bash-tool';
import { GlobTool } from './glob-tool';
import { GrepTool } from './grep-tool';
import { WriteTool } from './write-tool';
import { EditTool } from './edit-tool';

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

  isConcurrencySafe(toolName: string, input: unknown): boolean {
    const tool = this.tools.get(toolName);
    return tool ? tool.isConcurrencySafe(input) : false;
  }

  isReadOnly(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    return tool ? tool.isReadOnly() : true;
  }
}

export default ToolRegistry;
