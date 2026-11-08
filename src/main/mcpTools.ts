import { MCP_TOOL_NAMES, isMcpToolName, type McpToolName } from '../shared/mcp';
import type { WindowCallOutcome } from '../shared/mcpBridge';

/** What a tool call returns to Claude Code. */
export interface McpToolResult {
  isError: boolean;
  content: { type: 'text'; text: string }[];
}

export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; additionalProperties: false };
}

const TOOLS: { readonly [N in McpToolName]: Omit<McpToolDefinition, 'name'> } = {
  read_state: {
    description:
      "Read this agent-terminal window's state as its UI shows it: the repository, the flow and its step, a waiting gate with its options and why it waits, a failed turn, the loop message, the latest round report, the todos, the flows it can start, and the todo count Terminate would delete.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
};

/** The tools the agent-terminal MCP server lists, by name. */
export function mcpToolNames(): string[] {
  return [...MCP_TOOL_NAMES];
}

export function mcpToolDefinitions(): McpToolDefinition[] {
  return MCP_TOOL_NAMES.map((name) => ({ name, ...structuredClone(TOOLS[name]) }));
}

/** Why `args` is not a valid call of `tool`, or null when it is. */
export function invalidToolArguments(tool: string, args: unknown): string | null {
  if (!isMcpToolName(tool)) return `unknown tool ${JSON.stringify(tool)}`;
  const definition = TOOLS[tool];
  if (args === undefined) return null;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return `${tool} takes an object of arguments`;
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(definition.inputSchema.properties, key));
  return unknown.length === 0 ? null : `${tool} takes no argument named ${unknown.map((k) => JSON.stringify(k)).join(', ')}`;
}

const text = (body: Record<string, unknown>): McpToolResult['content'] => [{ type: 'text', text: JSON.stringify(body, null, 2) }];

const fieldsOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };

/** The tool result a window call's outcome becomes. */
export function toolResult(outcome: WindowCallOutcome): McpToolResult {
  switch (outcome.kind) {
    case 'answered':
      return { isError: false, content: text({ kind: 'success', message: 'The window answered.', ...fieldsOf(outcome.value) }) };
    case 'app-unreachable':
      return {
        isError: true,
        content: text({ kind: 'app-unreachable', message: `App unreachable: ${outcome.reason}. Nothing was done.` }),
      };
    case 'result-unknown':
      return {
        isError: true,
        content: text({
          kind: 'result-unknown',
          message: `Result unknown: ${outcome.reason} after the window started the action, so it may have run. Read the window's state again before retrying.`,
        }),
      };
    default:
      return outcome satisfies never;
  }
}
