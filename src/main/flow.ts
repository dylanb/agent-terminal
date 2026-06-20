// Flow lifecycle state machine (§18.2 / §24.2.2). The walking skeleton: a single manual
// step driven not_started --start--> in_progress --advance--> done; done is terminal.
// Illegal transitions throw, so "a second Advance is impossible" is a machine-level
// invariant, not just a UI affordance.
//
// S2 (§18.1): the step definition is sourced from a real <worktree>/.agent-terminal/flow.yaml
// (no longer a hardcoded constant). A missing/malformed/invalid file is not a crash — it
// becomes an inert `error` state the status strip renders (§22.3).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AgentState, FlowPrompt, FlowStateView, FlowStatus, TodoItem } from '../shared/ipc';
import { createFlowStateStore, type FlowStateStore } from './flowState';
import type { AgentLoopState } from './agentLoopBridge';
import { gateForStatus, type LoopDef } from './loopDef';
import { isRecord } from './yamlRecord';

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

/**
 * Fold the read-only agent-loop state.yaml mirror (§24.2.3 T2) onto a flow view as a `loop` field
 * PARALLEL to S5's `derived` (loop state outlives the manual `in_progress` window, so it is never
 * nested inside `derived`). A null mirror (non-loop step, or a missing/corrupt/unknown state.yaml)
 * passes the view through untouched. `ready` is the §19.2 advance gate.
 *
 * When the bound LoopDef resolves, readiness + options are GATE-DRIVEN (§18.1): `ready` is true only
 * at a TERMINAL gate (the loop reached its exit status — §19.2's "approved/terminal"), and
 * `gateOptions` mirrors the current status's gate `human_options`. With no LoopDef it degrades to the
 * documented `awaiting-human-*` "needs you" family and offers no options. The input is never mutated.
 */
export function deriveLoopView(
  view: FlowStateView,
  loop: AgentLoopState | null,
  loopDef: LoopDef | null = null,
): FlowStateView {
  if (!loop) return view;
  const gate = loopDef ? gateForStatus(loopDef, loop.status) : undefined;
  const ready = loopDef ? gate?.terminal === true : !loop.status.startsWith('awaiting-human');
  const gateOptions = gate && gate.humanOptions.length > 0 ? gate.humanOptions : undefined;
  return { ...view, loop: { ...loop, ready, ...(gateOptions ? { gateOptions } : {}) } };
}

/** A step's declared typed input (§18.4 / §24.2.3 T3): a named value of a catalog `type`
 *  (`github-ticket`/`pr`/`files`/`free-text`). A `required` input must be resolved on step entry —
 *  prompted for when unsatisfied — before the step's `bootstrap` can run. */
export interface FlowInputDef {
  name: string;
  type: string;
  required: boolean;
}

/** A §18.1 step. `manual`: a human produces an artifact (optional skill/template refs). `loop`
 *  (§24.2.3 T2): runs an agent-loop, binding its LoopDef by name (`loop`); the app mirrors that
 *  loop's state.yaml read-only. The `action` kind (§18.2) is a later phase. */
export interface FlowStepDef {
  id: string;
  kind: 'manual' | 'loop';
  skill?: string;
  todoTemplate?: string;
  /** The bound agent-loop LoopDef name (`loop` steps only) — which loop this step mirrors. */
  loop?: string;
  /** A per-step entry bootstrap (§18.3): `pickup` runs `agent-loop pickup <input>` on entry. The
   *  only kind in scope (§24.2.3 T3); the loader rejects any other value. */
  bootstrap?: 'pickup';
  /** Typed inputs the step requires on entry (§18.4); a required one prompts when unsatisfied. */
  inputs?: FlowInputDef[];
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
  | { ok: false; error: string };

const FLOW_REL = path.join('.agent-terminal', 'flow.yaml');

/** Validate a step's `inputs:` (§18.4): each entry needs a string name + type; `required` defaults
 *  to false. Absent → []; a malformed entry → the sentinel 'invalid' so the loader can error. */
function parseInputs(raw: unknown): FlowInputDef[] | 'invalid' {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'invalid';
  const out: FlowInputDef[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.type !== 'string') return 'invalid';
    out.push({ name: item.name, type: item.type, required: item.required === true });
  }
  return out;
}

/** Read & validate <worktreeDir>/.agent-terminal/flow.yaml against the §18.1 minimal shape. */
export function loadFlowDefinition(worktreeDir: string): FlowLoad {
  const file = path.join(worktreeDir, FLOW_REL);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, error: `no flow.yaml found at ${FLOW_REL}` };
  }

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    return { ok: false, error: `flow.yaml is not valid YAML: ${(e as Error).message}` };
  }

  if (!isRecord(doc)) return { ok: false, error: 'flow.yaml must be a mapping with name + steps' };
  if (typeof doc.name !== 'string' || doc.name.length === 0)
    return { ok: false, error: 'flow.yaml is missing a name' };
  if (!Array.isArray(doc.steps) || doc.steps.length === 0)
    return { ok: false, error: 'flow.yaml has no steps' };

  // T1 (§24.2.3) loads EVERY step, in order — the single-step assumption is retired. Each step is
  // validated against the §18.1 minimal shape. T2 adds the `loop` kind (binding a LoopDef by name);
  // the `action` kind (§18.2) is still out of scope, so any other kind is rejected.
  const steps: FlowStepDef[] = [];
  for (const raw of doc.steps) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0)
      return { ok: false, error: 'flow.yaml step is missing an id' };
    if (raw.kind !== 'manual' && raw.kind !== 'loop')
      return { ok: false, error: `flow.yaml step "${raw.id}" has unsupported kind "${String(raw.kind)}" (supports: manual, loop)` };
    if (raw.kind === 'loop' && (typeof raw.loop !== 'string' || raw.loop.length === 0))
      return { ok: false, error: `flow.yaml loop step "${raw.id}" is missing its loop: LoopDef name` };
    if (raw.skill !== undefined && typeof raw.skill !== 'string')
      return { ok: false, error: `flow.yaml step "${raw.id}" has a non-string skill` };
    if (raw.todo_template !== undefined && typeof raw.todo_template !== 'string')
      return { ok: false, error: `flow.yaml step "${raw.id}" has a non-string todo_template` };
    if (raw.bootstrap !== undefined && raw.bootstrap !== 'pickup')
      return { ok: false, error: `flow.yaml step "${raw.id}" has unsupported bootstrap "${String(raw.bootstrap)}" (supports: pickup)` };
    const inputs = parseInputs(raw.inputs);
    if (inputs === 'invalid')
      return { ok: false, error: `flow.yaml step "${raw.id}" has malformed inputs (each needs name + type)` };
    steps.push({
      id: raw.id,
      kind: raw.kind,
      ...(typeof raw.skill === 'string' ? { skill: raw.skill } : {}),
      ...(typeof raw.todo_template === 'string' ? { todoTemplate: raw.todo_template } : {}),
      ...(raw.kind === 'loop' ? { loop: raw.loop as string } : {}),
      ...(raw.bootstrap === 'pickup' ? { bootstrap: 'pickup' as const } : {}),
      ...(inputs.length > 0 ? { inputs } : {}),
    });
  }
  return { ok: true, definition: { name: doc.name, steps }, flowDir: path.dirname(file) };
}

/**
 * Resolve the flow DEFINITION local-first then global (§18.1): the repo's flow.yaml wins; a
 * global default (e.g. $HOME) is used only when the repo has none. A present-but-invalid local
 * file surfaces its own error rather than being masked by the global. (The flow STATE, by
 * contrast, is always repo-local — see flowState.)
 */
export function loadFlowDefinitionLocalFirst(localDir: string, globalDir: string): FlowLoad {
  if (existsSync(path.join(localDir, FLOW_REL))) return loadFlowDefinition(localDir);
  const global = loadFlowDefinition(globalDir);
  return global.ok ? global : loadFlowDefinition(localDir); // neither: report the local (absent) error
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
  /** Record the answer to a step-entry input prompt (§18.4 / §24.2.3 T3): merge `values` into the
   *  flow's resolved inputs, persist, and RE-ENTER the current step so the now-satisfied bootstrap
   *  runs. Legal only while a step is being worked (in_progress); inert on an error load. */
  provideInput(values: Record<string, string>): FlowStateView;
}

/** Run the step's entry actions on ENTRY (start/restart/advance-into), given the flow's resolved
 *  typed inputs (§18.4). Returns a one-shot transient `notice` (e.g. the §19.3 busy refusal) and/or
 *  a `prompt` for an unsatisfied required input, to surface on the transition view (§24.2.2 S4). */
export type FlowEnterStep = (step: FlowStepDef, inputs: Record<string, string>) => { notice?: string; prompt?: FlowPrompt } | void;

/** Read the current agent-loop state.yaml mirror for this flow's repo (§24.2.3 T2). Returns null
 *  for a missing/corrupt/unknown-version file; called on every view so the mirror is live. */
export type FlowReadLoop = () => AgentLoopState | null;

/** Resolve the bound LoopDef by name (§24.2.3 T2 / §18.1): the gate model behind the loop step's
 *  `loop:` binding. Returns null for an unresolvable/corrupt LoopDef — readiness then degrades to
 *  the awaiting-human-* family and no gate options are offered. */
export type FlowReadLoopDef = (name: string) => LoopDef | null;

// S3 (§19.1): an optional store backs the machine — its status is restored from disk on
// construction (so a relaunch resumes) and every transition is persisted. Without a store the
// machine is in-memory only (the S1/S2 contract), unchanged.
// S4 (§18.6): an optional onEnter runs the step's entry actions on start/restart and its notice
// rides the transition view (one-shot; never part of state()).
export function createFlowMachine(
  load: FlowLoad,
  store?: FlowStateStore,
  onEnter?: FlowEnterStep,
  readLoop?: FlowReadLoop,
  readLoopDef?: FlowReadLoopDef,
): FlowMachine {
  if (!load.ok) {
    const view = (): FlowStateView => ({
      stepName: '',
      steps: [],
      position: 0,
      total: 0,
      status: 'error',
      error: load.error,
    });
    // In the error state there is no step to drive: start/advance/restart/undo/provideInput are inert
    // (the strip shows no control), so a buggy/racing caller can neither throw nor escape the error —
    // and we never persist, so a bad flow.yaml can't overwrite a good progression.
    return { state: view, start: view, advance: view, restart: view, undo: view, provideInput: view };
  }

  const def = load.definition;
  const steps = def.steps;
  const names = steps.map((s) => s.id);
  // The walking skeleton (§24.2.3 T1): a current-step index plus a lifecycle status. `index` is the
  // step being (or about to be) worked; `status` is the flow's phase at that step. `done` means the
  // last step's Advance completed the whole flow.
  let index = 0;
  let status: FlowStatus = 'not_started';

  // Resume only progression that names a step still in *this* definition (§19.1): the persisted
  // step id locates the index; a changed flow.yaml whose step is gone starts fresh.
  const persisted = store?.read();
  if (persisted) {
    const i = names.indexOf(persisted.step);
    if (i >= 0) {
      index = i;
      status = persisted.status;
    }
  }
  // The flow's resolved typed inputs (§18.4 / §24.2.3 T3), flow-wide so a value resolved at one step
  // threads to later steps. Hydrated from flow-state so persisted answers survive a relaunch.
  let inputs: Record<string, string> = persisted?.inputs ? { ...persisted.inputs } : {};

  const current = (): FlowStepDef => steps[index];

  const view = (): FlowStateView => {
    const step = current();
    const base: FlowStateView = {
      stepName: step.id,
      steps: names,
      position: index + 1,
      total: steps.length,
      status,
      ...(step.todoTemplate ? { templateRef: step.todoTemplate } : {}),
    };
    // A loop step mirrors its agent-loop state.yaml, read live on every view (§24.2.3 T2), and
    // resolves its bound LoopDef so readiness + gate options are gate-driven. Only loop steps
    // mirror; a missing/corrupt file folds to nothing (deriveLoopView passes through).
    if (step.kind !== 'loop') return base;
    const loopDef = step.loop ? (readLoopDef?.(step.loop) ?? null) : null;
    return deriveLoopView(base, readLoop?.() ?? null, loopDef);
  };

  const persist = (): void =>
    store?.write({ step: current().id, status, ...(Object.keys(inputs).length > 0 ? { inputs } : {}) });

  const requireStatus = (expected: FlowStatus, action: string): void => {
    if (status !== expected) {
      throw new Error(`illegal flow transition: cannot ${action} from ${status}`);
    }
  };

  // Entry actions fire AFTER state is committed (state, then side effects); the returned notice is
  // merged onto the transition view only. They run on EVERY entry into a step — start/restart of the
  // first, and advancing INTO a later step (§24.2.3 T3). Completing the flow (`done`) enters no step.
  const enter = (v: FlowStateView): FlowStateView => {
    const r = onEnter?.(current(), inputs);
    if (!r) return v;
    return {
      ...v,
      ...(r.notice ? { notice: r.notice } : {}),
      ...(r.prompt ? { prompt: r.prompt } : {}),
    };
  };

  return {
    state: view,
    start: () => {
      requireStatus('not_started', 'start');
      status = 'in_progress';
      persist();
      return enter(view());
    },
    // Advance walks across steps: each call moves to the next step (still in progress) until the
    // last, whose Advance completes the flow (`done`). `done` is reachable only past the last step.
    advance: () => {
      requireStatus('in_progress', 'advance');
      if (index < steps.length - 1) {
        index += 1;
        persist();
        return enter(view()); // entry-on-advance: the step we just stepped INTO runs its entry actions
      }
      status = 'done';
      persist();
      return view(); // completing the flow enters no step
    },
    // Restart resets a completed flow back to its FIRST step, in progress, re-running its entry
    // actions (§24.2.2).
    restart: () => {
      requireStatus('done', 'restart');
      index = 0;
      status = 'in_progress';
      persist();
      return enter(view());
    },
    // Undo reverts the advance that completed the flow (last step → done) back to in_progress on the
    // last step, WITHOUT re-entering it (no entry actions) — it takes back the advance, not the work.
    undo: () => {
      requireStatus('done', 'undo');
      status = 'in_progress';
      persist();
      return view();
    },
    // The renderer's answer to an entry prompt (§18.4 / §24.2.3 T3): merge the resolved values, persist
    // them, and RE-ENTER the current step so the now-satisfied bootstrap runs (or re-prompts if a
    // required input is still missing). Legal only while a step is being worked.
    provideInput: (values) => {
      requireStatus('in_progress', 'provideInput');
      inputs = { ...inputs, ...values };
      persist();
      return enter(view());
    },
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
  provideInput(repoKey: string, values: Record<string, string>): FlowStateView;
}

export interface FlowManagerDeps {
  /** Global fallback dir for the DEFINITION only (e.g. $HOME); state is never global. */
  globalDir: string;
  loadDefinition?: (localDir: string, globalDir: string) => FlowLoad;
  makeStore?: (repoKey: string) => FlowStateStore;
  /** Run a step's entry action on entry (start/restart): inject its `skill` (§18.6/§19.3). The
   *  one-shot notice rides the transition view. (Todo templates instantiate on demand, not here.) */
  onEnterStep?: FlowEnterStep;
  /** Read the agent-loop state.yaml mirror for a repo (§24.2.3 T2): the manager folds it onto a
   *  loop step's views, live. Omitted → loop steps render with no mirror. */
  readLoopState?: (repoKey: string) => AgentLoopState | null;
  /** Resolve a loop step's bound LoopDef (§24.2.3 T2 / §18.1) for a repo: drives gate-derived
   *  readiness + the gate options. Omitted → readiness degrades to the awaiting-human-* family. */
  readLoopDef?: (repoKey: string, name: string) => LoopDef | null;
}

export function createFlowManager(deps: FlowManagerDeps): FlowManager {
  const loadDef = deps.loadDefinition ?? loadFlowDefinitionLocalFirst;
  const makeStore = deps.makeStore ?? createFlowStateStore;
  const cache = new Map<string, FlowMachine>();
  const machineFor = (repoKey: string): FlowMachine => {
    let m = cache.get(repoKey);
    if (!m) {
      m = createFlowMachine(
        loadDef(repoKey, deps.globalDir),
        makeStore(repoKey),
        deps.onEnterStep,
        deps.readLoopState ? () => deps.readLoopState!(repoKey) : undefined,
        deps.readLoopDef ? (name) => deps.readLoopDef!(repoKey, name) : undefined,
      );
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
    provideInput: (k, values) => machineFor(k).provideInput(values),
  };
}
