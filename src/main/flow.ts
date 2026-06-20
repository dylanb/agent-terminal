// Flow lifecycle state machine (§18.2 / §24.2.2). The walking skeleton: a single manual
// step driven not_started --start--> in_progress --advance--> done; done is terminal.
// Illegal transitions throw, so "a second Advance is impossible" is a machine-level
// invariant, not just a UI affordance.
//
// S2 (§18.1): the step definition is sourced from a real <worktree>/.agent-terminal/flow.yaml
// (no longer a hardcoded constant). A missing/malformed/invalid file is not a crash — it
// becomes an inert `error` state the status strip renders (§22.3).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AgentState, FlowStateView, FlowStatus, TodoItem } from '../shared/ipc';
import { createFlowStateStore, type FlowStateStore } from './flowState';

/**
 * Derive the live in-progress status (§22.3 / §24.2.2 S5): a PURE function of the flow view, the
 * repo's todos, and the §8.3 agent activity. An `in_progress` view gains `derived`
 * (activity + n/m done + gate readiness — every todo done); any other status passes through
 * untouched (no step is being worked). The input view is never mutated.
 */
export function deriveFlowView(view: FlowStateView, todos: TodoItem[], activity: AgentState): FlowStateView {
  if (view.status !== 'in_progress') return view;
  const todosTotal = todos.length;
  const todosDone = todos.filter((t) => t.status === 'done').length;
  return { ...view, derived: { activity, todosDone, todosTotal, ready: todosDone === todosTotal } };
}

/** §19.2 not-ready warning — spec refs are for code/review, never the UI (§24.2.2 v2.64). */
export const ADVANCE_NOT_READY_NOTICE = 'Advanced with todos still outstanding.';

/**
 * §19.2 human-override advance: read gate readiness from the PRE-advance state (every todo done),
 * advance, and ride a one-shot not-ready `notice` on the result when todos were still outstanding.
 * It always completes — the warning never blocks.
 */
export function advanceWithReadinessGate(
  flow: { state(repoKey: string): FlowStateView; advance(repoKey: string): FlowStateView },
  repoKey: string,
  todos: TodoItem[],
  activity: AgentState,
): FlowStateView {
  const ready = deriveFlowView(flow.state(repoKey), todos, activity).derived?.ready ?? true;
  const view = flow.advance(repoKey);
  return ready ? view : { ...view, notice: ADVANCE_NOT_READY_NOTICE };
}

/** A §18.1 step, minimal S2 shape: a manual step with an id and optional skill/template refs. */
export interface FlowStepDef {
  id: string;
  kind: 'manual';
  skill?: string;
  todoTemplate?: string;
}

export interface FlowDefinition {
  name: string;
  steps: FlowStepDef[];
}

/** Result of reading <worktree>/.agent-terminal/flow.yaml: a validated definition or a reason.
 *  On success `flowDir` is the directory that held the flow.yaml — the anchor for resolving the
 *  step's co-located `todo_template` (§18.6). */
export type FlowLoad =
  | { ok: true; definition: FlowDefinition; flowDir: string }
  // `kind` is the structured failure discriminator: 'absent' (ENOENT — no flow.yaml here),
  // 'read_error' (a real IO failure), 'invalid' (present but malformed). Local-first resolution
  // routes on `kind`, never on the error text (§18.1).
  | { ok: false; kind: 'absent' | 'read_error' | 'invalid'; error: string };

const FLOW_REL = path.join('.agent-terminal', 'flow.yaml');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read & validate <worktreeDir>/.agent-terminal/flow.yaml against the §18.1 minimal shape. */
export function loadFlowDefinition(worktreeDir: string): FlowLoad {
  const file = path.join(worktreeDir, FLOW_REL);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    // Absence is the common "no flow here" case; any other failure (EACCES/EPERM/EISDIR) is a real
    // read error and must be surfaced, not masked as "not found" (§18.1 — a clear error view).
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: false, kind: 'absent', error: `no flow.yaml found at ${FLOW_REL}` };
    return { ok: false, kind: 'read_error', error: `cannot read ${FLOW_REL}: ${(e as Error).message}` };
  }

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    return { ok: false, kind: 'invalid', error: `flow.yaml is not valid YAML: ${(e as Error).message}` };
  }

  if (!isRecord(doc)) return { ok: false, kind: 'invalid', error: 'flow.yaml must be a mapping with name + steps' };
  if (typeof doc.name !== 'string' || doc.name.length === 0)
    return { ok: false, kind: 'invalid', error: 'flow.yaml is missing a name' };
  if (!Array.isArray(doc.steps) || doc.steps.length === 0)
    return { ok: false, kind: 'invalid', error: 'flow.yaml has no steps' };

  // S2 scope is the manual kind only (§24.2.2): validate the first step is a manual step.
  const first = doc.steps[0];
  if (!isRecord(first) || typeof first.id !== 'string' || first.id.length === 0)
    return { ok: false, kind: 'invalid', error: 'flow.yaml step is missing an id' };
  if (first.kind !== 'manual')
    return { ok: false, kind: 'invalid', error: `flow.yaml step "${first.id}" is not a manual step (S2 supports manual only)` };
  if (first.skill !== undefined && typeof first.skill !== 'string')
    return { ok: false, kind: 'invalid', error: `flow.yaml step "${first.id}" has a non-string skill` };
  // The skill is injected into the PTY (§9.3); an embedded CR/LF or other control char would
  // execute as a command line when bracketed-paste is off, so an untrusted repo's flow.yaml
  // cannot smuggle line terminators into the injection path.
  if (typeof first.skill === 'string' && /[\u0000-\u001f\u007f]/.test(first.skill))
    return { ok: false, kind: 'invalid', error: `flow.yaml step "${first.id}" skill has control characters` };
  if (first.todo_template !== undefined && typeof first.todo_template !== 'string')
    return { ok: false, kind: 'invalid', error: `flow.yaml step "${first.id}" has a non-string todo_template` };

  const step: FlowStepDef = {
    id: first.id,
    kind: 'manual',
    ...(typeof first.skill === 'string' ? { skill: first.skill } : {}),
    ...(typeof first.todo_template === 'string' ? { todoTemplate: first.todo_template } : {}),
  };
  return { ok: true, definition: { name: doc.name, steps: [step] }, flowDir: path.dirname(file) };
}

/**
 * Resolve the flow DEFINITION local-first then global (§18.1): the repo's flow.yaml wins; a
 * global default (e.g. $HOME) is used only when the repo has none. A present-but-invalid local
 * file surfaces its own error rather than being masked by the global. (The flow STATE, by
 * contrast, is always repo-local — see flowState.)
 */
export function loadFlowDefinitionLocalFirst(localDir: string, globalDir: string): FlowLoad {
  const local = loadFlowDefinition(localDir);
  if (local.ok) return local;
  // Fall back to the global default only when the local file is genuinely ABSENT. A present-but-
  // unreadable (read_error) or malformed (invalid) local file surfaces its own error, never masked
  // by the global. Routing on the structured `kind`, not error text, keeps it copy-change-proof.
  if (local.kind !== 'absent') return local;
  const global = loadFlowDefinition(globalDir);
  if (global.ok) return global;
  // Neither loaded: a present-but-broken global (invalid/read_error) surfaces its own error; only
  // when the global is also merely absent is the local "no flow.yaml found" the right message.
  return global.kind === 'absent' ? local : global;
}

export interface FlowMachine {
  state(): FlowStateView;
  /** not_started → in_progress; throws on any other current status (inert in the error state). */
  start(): FlowStateView;
  /** in_progress → done; throws on any other current status (inert in the error state). */
  advance(): FlowStateView;
  /** done → in_progress; resets and re-runs the first step. Throws on any other current
   *  status (inert in the error state). */
  restart(): FlowStateView;
  /** done → in_progress; reverts a manual advance WITHOUT re-running the step's entry actions
   *  (the inverse of advance, not a restart). Throws on any other status (inert on error). */
  undo(): FlowStateView;
}

/** Run the step's entry actions on ENTRY (start/restart), returning a one-shot transient notice
 *  to surface on the transition view — e.g. the §19.3 busy refusal (§24.2.2 S4). */
export type FlowEnterStep = (step: FlowStepDef) => { notice?: string } | void;

// S3 (§19.1): an optional store backs the machine — its status is restored from disk on
// construction (so a relaunch resumes) and every transition is persisted. Without a store the
// machine is in-memory only (the S1/S2 contract), unchanged.
// S4 (§18.6): an optional onEnter runs the step's entry actions on start/restart and its notice
// rides the transition view (one-shot; never part of state()).
export function createFlowMachine(
  load: FlowLoad,
  store?: FlowStateStore,
  onEnter?: FlowEnterStep,
): FlowMachine {
  if (!load.ok) {
    const view = (): FlowStateView => ({
      stepName: '',
      position: 0,
      total: 0,
      status: 'error',
      error: load.error,
    });
    // In the error state there is no step to drive: start/advance/restart/undo are inert (the strip
    // shows no control), so a buggy/racing caller can neither throw nor escape the error — and
    // we never persist, so a bad flow.yaml can't overwrite a good progression.
    return { state: view, start: view, advance: view, restart: view, undo: view };
  }

  const def = load.definition;
  const step = def.steps[0];
  const stepId = step.id;
  let status: FlowStatus = 'not_started';

  // Resume only progression that belongs to the *current* step: a changed flow.yaml (different
  // step id) starts fresh rather than mis-applying a stale status.
  const persisted = store?.read();
  if (persisted && persisted.step === stepId) status = persisted.status;

  const view = (): FlowStateView => ({
    stepName: stepId,
    position: 1,
    total: def.steps.length,
    status,
    ...(step.todoTemplate ? { templateRef: step.todoTemplate } : {}),
  });

  const transition = (from: FlowStatus, to: FlowStatus): FlowStateView => {
    if (status !== from) {
      throw new Error(`illegal flow transition: ${status} cannot move to ${to}`);
    }
    status = to;
    store?.write({ step: stepId, status });
    return view();
  };

  // Entry actions fire AFTER the transition is persisted (state committed, then side effects);
  // the returned notice is merged onto the transition view only.
  const enter = (v: FlowStateView): FlowStateView => {
    const r = onEnter?.(step);
    return r && r.notice ? { ...v, notice: r.notice } : v;
  };

  return {
    state: view,
    start: () => enter(transition('not_started', 'in_progress')),
    advance: () => transition('in_progress', 'done'),
    // Restart resets a completed flow back to its first step, in progress, re-running its
    // entry actions (§24.2.2).
    restart: () => enter(transition('done', 'in_progress')),
    // Undo reverts a manual advance back to in_progress WITHOUT re-entering the step (no entry
    // actions) — it takes back the advance, it does not re-run the work.
    undo: () => transition('done', 'in_progress'),
  };
}

/**
 * The flow as the terminal sees it: keyed by `repoKey` (a git root, or a plain dir — the same
 * `resolveRepoKey` scoping the todo list uses, §16.3), so progression follows the cwd and never
 * leaks between repos. Each key lazily owns one machine: its DEFINITION resolves local-first
 * then global (§18.1), its STATE persists to that key's `flow-state.yaml` (§19.1). Visiting a
 * repo (`state`) only *reads* — no `.agent-terminal` dir is created until a transition writes.
 */
export interface FlowManager {
  state(repoKey: string): FlowStateView;
  start(repoKey: string): FlowStateView;
  advance(repoKey: string): FlowStateView;
  restart(repoKey: string): FlowStateView;
  undo(repoKey: string): FlowStateView;
}

export interface FlowManagerDeps {
  /** Global fallback dir for the DEFINITION only (e.g. $HOME); state is never global. */
  globalDir: string;
  loadDefinition?: (localDir: string, globalDir: string) => FlowLoad;
  makeStore?: (repoKey: string) => FlowStateStore;
  /** Run a step's entry action on entry (start/restart): inject its `skill` (§18.6/§19.3). The
   *  one-shot notice rides the transition view. (Todo templates instantiate on demand, not here.) */
  onEnterStep?: FlowEnterStep;
}

export function createFlowManager(deps: FlowManagerDeps): FlowManager {
  const loadDef = deps.loadDefinition ?? loadFlowDefinitionLocalFirst;
  const makeStore = deps.makeStore ?? createFlowStateStore;
  const cache = new Map<string, FlowMachine>();
  const machineFor = (repoKey: string): FlowMachine => {
    let m = cache.get(repoKey);
    if (!m) {
      m = createFlowMachine(loadDef(repoKey, deps.globalDir), makeStore(repoKey), deps.onEnterStep);
      cache.set(repoKey, m);
    }
    return m;
  };
  return {
    state: (k) => machineFor(k).state(),
    start: (k) => machineFor(k).start(),
    advance: (k) => machineFor(k).advance(),
    restart: (k) => machineFor(k).restart(),
    undo: (k) => machineFor(k).undo(),
  };
}
