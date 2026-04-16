/**
 * MCP 客户端
 * P3-3: MCP 协议集成
 * 支持 stdio 和 SSE 两种传输方式
 */

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface MCPConnection {
  name: string;
  tools: MCPToolDefinition[];
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  close: () => void;
}

export class MCPClient {
  private servers: Map<string, MCPConnection> = new Map();

  /**
   * 连接 MCP Server
   */
  async connectServer(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      console.warn(`[MCP] Server "${config.name}" already connected`);
      return;
    }

    let connection: MCPConnection;

    if (config.transport === 'stdio') {
      connection = await this.connectStdio(config);
    } else {
      connection = await this.connectSSE(config);
    }

    this.servers.set(config.name, connection);
    console.log(`[MCP] Server "${config.name}" connected, ${connection.tools.length} tools available`);
  }

  /**
   * stdio 传输
   */
  private async connectStdio(config: MCPServerConfig): Promise<MCPConnection> {
    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
      if (!config.command) {
        reject(new Error('stdio transport requires "command"'));
        return;
      }

      const proc = spawn(config.command, config.args || [], {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const tools: MCPToolDefinition[] = [];
      let buffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        // 简单的 JSON-RPC 解析（实际实现需要更完善）
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.method === 'tools/list') {
              // 工具列表响应
            }
          } catch {}
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        console.error(`[MCP:${config.name}] stderr:`, data.toString());
      });

      const connection: MCPConnection = {
        name: config.name,
        tools,
        callTool: async (toolName: string, args: Record<string, unknown>) => {
          const request = JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name: toolName, arguments: args },
          });
          proc.stdin?.write(request + '\n');
          return 'MCP tool call result (placeholder)';
        },
        close: () => {
          proc.kill();
        },
      };

      // 给进程一些启动时间
      setTimeout(() => resolve(connection), 1000);
    }) as any;
  }

  /**
   * SSE 传输
   */
  private async connectSSE(config: MCPServerConfig): Promise<MCPConnection> {
    if (!config.url) {
      throw new Error('sse transport requires "url"');
    }

    const tools: MCPToolDefinition[] = [];

    const connection: MCPConnection = {
      name: config.name,
      tools,
      callTool: async (_toolName: string, _args: Record<string, unknown>) => {
        return 'MCP SSE tool call result (placeholder)';
      },
      close: () => {
        // TODO: 关闭 SSE 连接
      },
    };

    return connection;
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" not connected`);
    }
    return server.callTool(toolName, args);
  }

  /**
   * 获取所有已连接 Server 的工具列表
   */
  getAllTools(): { serverName: string; tools: MCPToolDefinition[] }[] {
    const result: { serverName: string; tools: MCPToolDefinition[] }[] = [];
    for (const [name, connection] of this.servers) {
      result.push({ serverName: name, tools: connection.tools });
    }
    return result;
  }

  /**
   * 断开所有连接
   */
  closeAll(): void {
    for (const [, connection] of this.servers) {
      connection.close();
    }
    this.servers.clear();
  }
}
