import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { MCP_SERVER_NAME } from '../shared/mcp';
import type { AckTimers, McpCaller } from '../shared/mcpBridge';
import { invalidToolArguments, mcpToolDefinitions, toolResult } from './mcpTools';
import { callWindow } from './mcpWindowClient';

/** The MCP server one Claude Code session runs. `endpoint` is the session's window, or null outside agent-terminal,
 *  where it lists no tools; `caller` is that session. */
export function createMcpServer<H>(opts: { endpoint: string | null; build: string; ackTimeoutMs: number; timers: AckTimers<H>; caller?: McpCaller }): Server {
  const server = new Server({ name: MCP_SERVER_NAME, version: opts.build }, { capabilities: { tools: {} } });
  const { endpoint } = opts;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: endpoint === null ? [] : mcpToolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (endpoint === null) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${JSON.stringify(name)}: this session is not in an agent-terminal window`);
    const problem = invalidToolArguments(name, args);
    if (problem !== null) throw new McpError(ErrorCode.InvalidParams, problem);
    return { ...toolResult(await callWindow(endpoint, { tool: name, args: args ?? {} }, opts)) };
  });
  return server;
}
