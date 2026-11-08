import type { WindowCallOutcome } from '../shared/mcpBridge';

/** What a tool call returns to Claude Code. */
export interface McpToolResult {
  isError: boolean;
  content: { type: 'text'; text: string }[];
}

/** The tools the agent-terminal MCP server lists, by name. */
export function mcpToolNames(): string[] {
  return [];
}

/** The tool result a window call's outcome becomes. */
export function toolResult(_outcome: WindowCallOutcome): McpToolResult {
  return { isError: false, content: [] };
}
