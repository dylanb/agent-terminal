export const MCP_SERVER_NAME = 'agent-terminal';

export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export const APP_MCP_ACK_TIMEOUT_ENV = 'APP_MCP_ACK_TIMEOUT_MS';

export const DEFAULT_MCP_ACK_TIMEOUT_MS = 5_000;

/** The window endpoint a session in the window's terminal reaches its own window through. */
export const MCP_WINDOW_ENV = 'AGENT_TERMINAL_MCP_WINDOW';

export function mcpAckTimeoutMs(_env: Readonly<Record<string, string | undefined>>): number {
  return 0;
}
