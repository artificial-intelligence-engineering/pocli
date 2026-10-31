import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { ActorRole } from '../core/contracts.js';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  allowedRoles: ActorRole[];
}

export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Model Context Protocol (MCP) Client & Role Access Manager (AGENTS.md Section 12).
 * Connects to MCP servers over JSON-RPC 2.0 stdio and enforces role-based tool availability.
 */
export class McpRegistry {
  private servers = new Map<string, McpServerConfig>();
  private discoveredTools = new Map<string, McpToolDescriptor[]>();

  registerServer(config: McpServerConfig): void {
    this.servers.set(config.id, config);
  }

  listServersForRole(role: ActorRole): McpServerConfig[] {
    return Array.from(this.servers.values()).filter(
      (s) => role === 'product_owner' || s.allowedRoles.includes(role),
    );
  }

  async discoverTools(serverId: string): Promise<McpToolDescriptor[]> {
    const server = this.servers.get(serverId);
    if (!server) throw new Error(`MCP server '${serverId}' is not registered.`);

    const res = await this.sendMcpRpc(server, 'tools/list', {});
    const toolsRaw = (res as { tools?: Array<Record<string, unknown>> })?.tools ?? [];
    const descriptors: McpToolDescriptor[] = toolsRaw.map((t) => ({
      serverId,
      name: String(t.name),
      description: String(t.description ?? ''),
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
    }));
    this.discoveredTools.set(serverId, descriptors);
    return descriptors;
  }

  async callToolForRole(params: {
    role: ActorRole;
    serverId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<unknown> {
    const server = this.servers.get(params.serverId);
    if (!server) {
      throw new Error(`MCP server '${params.serverId}' not found.`);
    }
    if (params.role !== 'product_owner' && !server.allowedRoles.includes(params.role)) {
      throw new Error(
        `MCP Permission Denied: Role '${params.role}' is not authorized to access MCP server '${server.name}'.`,
      );
    }

    return this.sendMcpRpc(server, 'tools/call', {
      name: params.toolName,
      arguments: params.args,
    });
  }

  private sendMcpRpc(
    server: McpServerConfig,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(server.command, server.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const rl = readline.createInterface({
        input: child.stdout,
        terminal: false,
      });

      const reqId = `mcp_${Date.now()}`;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`MCP request '${method}' timed out on server '${server.name}'`));
        }
      }, 10000);

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.id === reqId) {
          settled = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          if (msg.error) {
            const errObj = msg.error as { message?: string };
            reject(new Error(`MCP Error: ${errObj.message ?? 'unknown'}`));
          } else {
            resolve(msg.result);
          }
        }
      });

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      const rpc = {
        jsonrpc: '2.0',
        id: reqId,
        method,
        params,
      };
      child.stdin.write(`${JSON.stringify(rpc)}\n`);
    });
  }
}

