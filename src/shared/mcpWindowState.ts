import type { ControllerLoopMessage, FlowStatus, TodoStatus } from './ipc';

export interface McpTodo { id: string; text: string; status: TodoStatus }

export function mcpTodo(todo: McpTodo): McpTodo {
  return { id: todo.id, text: todo.text, status: todo.status };
}

export interface McpWindowState {
  window: { id: string };
  repo: { key: string } | null;
  flow: { selected: string | null; steps: string[]; step: string; status: FlowStatus; runStarted: boolean } | null;
  selectionUnusable: boolean;
  gate: { step: string; turn: string | null; options: string[]; reasons: string[]; engineDeciding: boolean } | null;
  stalledTurn: { step: string; turn: string; reason: string | null } | null;
  loopMessage: ControllerLoopMessage | null;
  roundReport: unknown;
  todos: McpTodo[];
  startable: { id: string; name: string }[] | null;
  startableError: string | null;
  terminateTodoCount: number | null;
}
