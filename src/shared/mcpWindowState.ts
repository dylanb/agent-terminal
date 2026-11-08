import type { ControllerLoopMessage, FlowStatus, TodoStatus } from './ipc';

/** What `read_state` returns: the window's state as its UI shows it, with the identity of every target an acting
 *  tool names, in the form that tool takes it. */
export interface McpWindowState {
  window: { id: string };
  repo: { key: string } | null;
  /** `selected` is the flow the window's picker has selected, or null when it runs the default. */
  flow: { selected: string | null; steps: string[]; step: string; status: FlowStatus; runStarted: boolean } | null;
  /** True when the flow the picker has selected cannot be used: Start refuses it rather than run the default. */
  selectionUnusable: boolean;
  gate: { step: string; turn: string | null; options: string[]; reasons: string[]; engineDeciding: boolean } | null;
  stalledTurn: { step: string; turn: string; reason: string | null } | null;
  loopMessage: ControllerLoopMessage | null;
  roundReport: unknown;
  todos: { id: string; text: string; status: TodoStatus }[];
  /** Before Start, the flows and loops the window can start, as its picker lists them; null once a run started. */
  startable: { id: string; name: string }[] | null;
  /** Before Start, why the picker could not list the flows, when it could not; otherwise null. */
  startableError: string | null;
  /** Wherever the window offers Terminate, the todo count its confirmation states; otherwise null. */
  terminateTodoCount: number | null;
}
