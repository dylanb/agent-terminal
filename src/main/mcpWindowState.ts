import type { ControllerLoopMessage, FlowStateView, TodoItem } from '../shared/ipc';
import type { McpWindowState } from '../shared/mcpWindowState';

/** What the window's UI renders, read when a session asks for its window's state. `latestRoundReport` is the latest
 *  review round's report of the run's loop step, or null. */
export interface WindowStateSource {
  windowId: string;
  repoKey: string | null;
  view: FlowStateView | null;
  /** The flow the picker has selected, or null for the default. */
  selectedFlow: string | null;
  loopMessage: ControllerLoopMessage | null;
  todos: readonly TodoItem[];
  latestRoundReport: unknown;
  startable: readonly { id: string; name: string }[];
}

export function readWindowState(source: WindowStateSource): McpWindowState {
  return {
    window: { id: source.windowId },
    repo: null,
    flow: null,
    gate: null,
    stalledTurn: null,
    loopMessage: null,
    roundReport: null,
    todos: [],
    startable: null,
    terminateTodoCount: null,
  };
}
