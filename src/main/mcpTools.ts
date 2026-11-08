import { MCP_TOOL_NAMES, isMcpToolName, type McpToolName } from '../shared/mcp';
import { isWindowAnswerFailure, type WindowCallOutcome } from '../shared/mcpBridge';

/** What a tool call returns to Claude Code. */
export interface McpToolResult {
  isError: boolean;
  content: { type: 'text'; text: string }[];
}

export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: 'string'; description: string }>; required?: string[]; additionalProperties: false };
}

const target = (description: string) => ({ type: 'string' as const, description });

const TOOLS: { readonly [N in McpToolName]: Omit<McpToolDefinition, 'name'> } = {
  read_state: {
    description:
      "Read this agent-terminal window's state as its UI shows it: the repository, the flow and its step, a waiting gate with its options and why it waits, a failed turn, the loop message, the latest round report, the todos, the flows it can start, and the todo count Terminate would delete.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  approve: {
    description:
      "Approve the loop gate this agent-terminal window is waiting at, as its Approve control does, side effects included. Name the gate as read_state returns it. It works only in a turn the operator started by typing a prompt in the window's terminal or over Remote Control; any other turn is refused and nothing changes.",
    inputSchema: {
      type: 'object',
      properties: {
        window: target("The window's id, as read_state returns it (window.id)."),
        repo: target("The window's repository, as read_state returns it (repo.key)."),
        step: target('The waiting gate\'s step, as read_state returns it (gate.step).'),
        turn: target('The waiting gate\'s turn, as read_state returns it (gate.turn).'),
      },
      required: ['window', 'repo', 'step', 'turn'],
      additionalProperties: false,
    },
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
  const { properties, required = [] } = TOOLS[tool].inputSchema;
  const given = args ?? {};
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return `${tool} takes an object of arguments`;
  const unknown = Object.keys(given).filter((key) => !Object.hasOwn(properties, key));
  if (unknown.length > 0) return `${tool} takes no argument named ${unknown.map((k) => JSON.stringify(k)).join(', ')}`;
  const values = given as Record<string, unknown>;
  const missing = required.filter((key) => !Object.hasOwn(values, key));
  if (missing.length > 0) return `${tool} needs ${missing.join(', ')}`;
  const notStrings = Object.keys(values).filter((key) => typeof values[key] !== 'string');
  return notStrings.length === 0 ? null : `${tool}'s ${notStrings.join(', ')} must be text`;
}

const text = (body: Record<string, unknown>): McpToolResult['content'] => [{ type: 'text', text: JSON.stringify(body, null, 2) }];

const fieldsOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };

/** The tool result a window call's outcome becomes. */
export function toolResult(outcome: WindowCallOutcome): McpToolResult {
  switch (outcome.kind) {
    case 'answered':
      if (isWindowAnswerFailure(outcome.value)) return { isError: true, content: text({ kind: outcome.value.kind, message: outcome.value.message }) };
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
