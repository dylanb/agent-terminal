export const MCP_SERVER_NAME = 'agent-terminal';

/** Every tool the server lists and its window answers; the server and the window both act on this one list. */
export const MCP_TOOL_NAMES = ['read_state'] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export const APP_MCP_ACK_TIMEOUT_ENV = 'APP_MCP_ACK_TIMEOUT_MS';

export const DEFAULT_MCP_ACK_TIMEOUT_MS = 5_000;

/** The argument that runs the installed launch as a Claude Code hook rather than as the server. */
export const MCP_HOOK_ARG = '--hook';

/** The app binary and server script of the window's own build, so a session runs its window's build whichever build
 *  last rewrote the shared launcher. */
export const MCP_WINDOW_EXEC_ENV = 'AGENT_TERMINAL_MCP_EXEC';
export const MCP_WINDOW_SCRIPT_ENV = 'AGENT_TERMINAL_MCP_SCRIPT';

/** The window endpoint a session in the window's terminal reaches its own window through. */
export const MCP_WINDOW_ENV = 'AGENT_TERMINAL_MCP_WINDOW';

/** The longest delay a Node or browser timer honours; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

export function mcpAckTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[APP_MCP_ACK_TIMEOUT_ENV]?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return DEFAULT_MCP_ACK_TIMEOUT_MS;
  const ms = Number(raw);
  return ms > 0 ? Math.min(ms, MAX_TIMER_MS) : DEFAULT_MCP_ACK_TIMEOUT_MS;
}
