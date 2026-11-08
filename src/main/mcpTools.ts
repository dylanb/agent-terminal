import { MCP_TOOL_NAMES, isMcpToolName, type McpToolName } from '../shared/mcp';
import { isWindowAnswerFailure, type WindowCallOutcome } from '../shared/mcpBridge';

/** What a tool call returns to Claude Code. */
export interface McpToolResult {
  isError: boolean;
  content: { type: 'text'; text: string }[];
}

type ArgumentSchema =
  | { type: 'string'; description: string }
  | { anyOf: [{ type: 'string' }, { type: 'null' }]; description: string }
  | { type: 'integer'; minimum: number; maximum: number; description: string }
  | { type: 'array'; items: { type: 'string' }; description: string }
  | { type: 'object'; additionalProperties: { type: 'string' }; description: string };

export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, ArgumentSchema>; required?: string[]; additionalProperties: false };
}

const target = (description: string) => ({ type: 'string' as const, description });

const ownWindow = {
  window: target("The window.id returned by read_state."),
  repo: target("The repo.key returned by read_state."),
};
const gateTarget = {
  ...ownWindow,
  step: target('The gate.step or stalledTurn.step returned by read_state.'),
  turn: target('The gate.turn or stalledTurn.turn returned by read_state.'),
};
const inputs: ArgumentSchema = { type: 'object', additionalProperties: { type: 'string' }, description: 'Required inputs for the step being entered, by input name. Already resolved inputs need no value.' };
const action = (description: string, properties: Record<string, ArgumentSchema>, required = Object.keys(properties)): Omit<McpToolDefinition, 'name'> => ({
  description: `${description} Name the target returned by read_state. Only a human-started turn may act.`,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

const todoAction = (description: string, properties: Record<string, ArgumentSchema>): Omit<McpToolDefinition, 'name'> => ({
  description, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});
const todoTarget = { ...ownWindow, todo: target('The todo id returned by read_state.') };

const TOOLS: { readonly [N in McpToolName]: Omit<McpToolDefinition, 'name'> } = {
  todo_create: todoAction('Create a todo in any turn.', { ...ownWindow, text: target('The todo text.') }),
  todo_edit: todoAction('Edit an outstanding todo in any turn.', { ...todoTarget, text: target('The replacement text.') }),
  todo_reorder: todoAction('Reorder outstanding todos in any turn.', { ...ownWindow, todos: { type: 'array', items: { type: 'string' }, description: 'Outstanding todo ids in the desired order.' } }),
  todo_complete: todoAction('Complete a todo in any turn.', todoTarget),
  todo_delete: todoAction('Delete a todo in any turn.', todoTarget),
  todo_send: action('Accept a todo for delivery after this turn ends. Only one send may wait per turn.', todoTarget),
  capture_report: todoAction('Capture the latest report and its findings in any turn.', ownWindow),
  read_state: {
    description:
      "Read this agent-terminal window's state as its UI shows it: the repository, the flow and its step, a waiting gate with its options and why it waits, a failed turn, the loop message, the latest round report, the todos, the flows it can start, and the todo count Terminate would delete.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  approve: action('Approve the waiting loop or step gate, including its side effects.', { ...gateTarget, turn: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The gate.turn returned by read_state. Omit or use null for a step gate.' }, inputs }, ['window', 'repo', 'step']),
  request_changes: action('Request another review round with feedback.', { ...gateTarget, feedback: target('The feedback to deliver.') }),
  redo: action('Redo the work with an instruction.', { ...gateTarget, instruction: target('The instruction to deliver.') }),
  polish: action('Enter polish for the waiting gate.', gateTarget),
  retry: action('Retry the stopped or failed turn.', gateTarget),
  dismiss_loop_message: action('Dismiss the current loop message.', { ...ownWindow, message: target('The loopMessage.id returned by read_state.') }),
  choose_flow: action('Choose a flow or standalone loop before starting.', { ...ownWindow, flow: target('An id from read_state.startable.') }),
  start: action('Start the selected flow or loop with its entry inputs.', { ...ownWindow, inputs }, ['window', 'repo']),
  terminate: action('Terminate the run, deleting its todos and clearing captures.', {
    ...ownWindow,
    expectedTodoCount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'The terminateTodoCount returned by read_state; the action is refused if it changed.' },
  }),
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
  for (const key of Object.keys(values)) {
    const value = values[key];
    const schema = properties[key];
    if ('anyOf' in schema) {
      if (!schema.anyOf.some(option => option.type === 'null' ? value === null : typeof value === option.type)) return `${tool}'s ${key} must be text or null`;
      continue;
    }
    switch (schema.type) {
      case 'string':
        if (typeof value !== 'string') return `${tool}'s ${key} must be text`;
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) return `${tool}'s ${key} must be a nonnegative safe integer`;
        break;
      case 'array':
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return `${tool}'s ${key} must be a list of todo ids`;
        break;
      case 'object':
        if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) return `${tool}'s ${key} must map input names to text`;
        break;
      default:
        return schema satisfies never;
    }
  }
  return null;
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
