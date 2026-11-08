import type { ControllerLoopMessage, FlowCatalogListResult, FlowStateView, TodoItem } from '../shared/ipc';
import type { McpWindowState } from '../shared/mcpWindowState';
import { isSelectionLocked } from '../shared/flowStarted';
import { flowPickerEntry, flowPickerSelected } from '../shared/flowPickerEntry';
import { shownAutoHaltReason } from '../shared/gateAuthority';
import { loopGateDecidable, loopRouteOutTurn, shownErrorReason, shownVerdictRows } from '../shared/loopGate';
import { terminateOffered, terminateTodoCount } from '../shared/terminateCount';

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
  /** Whether the flow the picker has selected cannot be used, so Start refuses rather than run the default. */
  selectionUnusable?: boolean;
  /** Why the picker could not list the flows, when it could not. */
  startableError?: string;
}

/** Whether the flow's current step is the step its loop runs. */
export function atLoopStep(view: FlowStateView): boolean {
  const loop = view.loop;
  return view.status === 'in_progress' && loop !== undefined && (loop.appTurn?.step ?? view.stepName) === view.stepName;
}

/** The latest round the run state records as reviewed while the flow is at its loop step, or null. Report files carry
 *  no step, so only a round this step's run has finished can name its own report. */
export function reviewedRound(view: FlowStateView): number | null {
  const loop = view.loop;
  if (loop?.iteration === undefined || !atLoopStep(view)) return null;
  const round = loop.verdict === undefined ? loop.iteration - 1 : loop.iteration;
  return round >= 1 ? round : null;
}

/** The report of the latest round the run state records as reviewed, read through `read`, or null. */
export function readLatestRoundReport(repoKey: string, view: FlowStateView, read: (repoKey: string, round: number) => Promise<unknown>): Promise<unknown> {
  const round = reviewedRound(view);
  return round === null ? Promise.resolve(null) : read(repoKey, round);
}

function gateOf(view: FlowStateView): McpWindowState['gate'] {
  if (view.status !== 'in_progress') return null;
  const loop = view.loop;
  if (loop !== undefined && loopGateDecidable(loop)) {
    return {
      step: loop.appTurn.step,
      turn: loop.appTurn.turnKey,
      options: [...loop.gateOptions],
      reasons: [...(loop.autoGate?.haltReasons ?? []).map(shownAutoHaltReason), ...shownVerdictRows(loop).flatMap(({ label, value }) => (value === null ? [] : [`${label}: ${value}`]))],
      engineDeciding: loop.autoGate?.deciding ?? false,
    };
  }
  return atLoopStep(view) ? null : { step: view.stepName, turn: null, options: ['approve'], reasons: [], engineDeciding: false };
}

function stalledTurnOf(loop: FlowStateView['loop']): McpWindowState['stalledTurn'] {
  const turn = loop === undefined ? null : loopRouteOutTurn(loop);
  return turn === null ? null : { step: turn.step, turn: turn.turnKey, reason: loop === undefined ? null : shownErrorReason(loop) };
}

export function readWindowState(source: WindowStateSource): McpWindowState {
  const { view } = source;
  const loop = view?.loop;
  const state: McpWindowState = {
    window: { id: source.windowId },
    repo: source.repoKey === null ? null : { key: source.repoKey },
    flow: view === null ? null : { selected: source.selectedFlow, steps: view.steps, step: view.stepName, status: view.status, runStarted: isSelectionLocked(view.runStarted) },
    selectionUnusable: source.selectionUnusable ?? false,
    gate: view === null ? null : gateOf(view),
    stalledTurn: stalledTurnOf(loop),
    loopMessage: source.loopMessage,
    roundReport: view !== null && atLoopStep(view) ? source.latestRoundReport : null,
    todos: source.todos.map((todo) => ({ id: todo.id, text: todo.text, status: todo.status })),
    startable: view !== null && !isSelectionLocked(view.runStarted) ? [...source.startable] : null,
    startableError: view !== null && !isSelectionLocked(view.runStarted) ? source.startableError ?? null : null,
    terminateTodoCount: view !== null && terminateOffered(view) ? terminateTodoCount(source.todos) : null,
  };
  return structuredClone(state);
}

/** What the picker shows from its catalog listing: the flows it lets the operator choose and its selection, or why
 *  it could not list them. */
export function catalogView(catalog: FlowCatalogListResult): Pick<WindowStateSource, 'startable' | 'startableError' | 'selectedFlow' | 'selectionUnusable'> {
  if (!catalog.ok) return { startable: [], startableError: `The flows could not be listed: ${catalog.reason}`, selectedFlow: null, selectionUnusable: false };
  return {
    startable: catalog.listing.entries.filter((entry) => entry.available).map(flowPickerEntry).map(({ key, name }) => ({ id: key, name })),
    selectedFlow: flowPickerSelected(catalog.listing.selection),
    selectionUnusable: catalog.listing.selection.kind === 'invalid',
  };
}
