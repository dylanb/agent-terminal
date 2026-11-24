import type { MonitorEvent } from '../shared/ipc';
import type { WindowAnswerFailure } from '../shared/mcpBridge';
import type { McpWindowState, McpTodo } from '../shared/mcpWindowState';

export type McpOperationResult = WindowAnswerFailure | {
  kind: 'taken' | 'taken-side-effect-failed' | 'waiting-on-dialog' | 'retried' | 'dismissed' | 'selected' | 'accepted';
  message: string;
};
export type McpActionResult = McpWindowState | McpOperationResult
  | { kind: 'created' | 'edited' | 'completed' | 'deleted' | 'reordered'; todos: McpTodo[] }
  | { kind: 'captured'; message: string; events: MonitorEvent[] };
