// Flow lifecycle state machine (§18.2 / §24.2.2). Illegal transitions throw, so transition
// legality is a machine invariant the UI cannot subvert, not just an affordance. The step
// definition is read from <worktree>/.agent-terminal/flow.yaml (§18.1); a missing/malformed file
// is not a crash but an inert `error` state the strip renders (§22.3).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AgentState, FlowPrompt, FlowStateView, FlowStatus, TodoItem } from '../shared/ipc';
import { createFlowStateStore, type FlowStateStore } from './flowState';
import type { AgentLoopState } from './agentLoopBridge';
import { gateForStatus, type LoopDef } from './loopDef';
import { isHumanNeededStatus } from '../shared/loopStatus';
import { isRecord } from './yamlRecord';

/**
 * Single source of truth for "the loop needs you" (§24.2.3 T4), consumed by both the in-app cue and
 * the OS notification. With a LoopDef this is gate-driven; without one it degrades to the shared
 * awaiting-human/impasse family. Both paths classify the shipped vocabulary identically.
 */
export function classifyHumanNeeded(status: string, loopDef: LoopDef | null): boolean {
  if (!loopDef) return isHumanNeededStatus(status);
  if (status === 'impasse') return true;
  const gate = gateForStatus(loopDef, status);
  return status.startsWith('awaiting-') && gate !== undefined && !gate.terminal && gate.humanOptions.length > 0;
}

/**
 * Fold the live derived status onto an `in_progress` view (§22.3 / §24.2.2 S5); any other status
 * passes through untouched. Pure — the input view is never mutated.
 */
export function deriveFlowView(view: FlowStateView, todos: TodoItem[], activity: AgentState): FlowStateView {
  if (view.status !== 'in_progress') return view;
  const todosTotal = todos.length;
  const todosDone = todos.filter((t) => t.status === 'done').length;
  return { ...view, derived: { activity, todosDone, todosTotal, ready: todosDone === todosTotal } };
}

/**
 * Fold the read-only agent-loop state.yaml mirror (§24.2.3 T2) onto a view as a `loop` field
 * PARALLEL to S5's `derived`, never nested inside it: loop state outlives the manual `in_progress`
 * window. `ready` is the §19.2 advance gate — gate-driven when the LoopDef resolves (§18.1),
 * degrading to the awaiting-human-* family with no options when it does not. Input is never mutated.
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
  const humanNeeded = classifyHumanNeeded(loop.status, loopDef);
  return { ...view, loop: { ...loop, ready, humanNeeded, ...(gateOptions ? { gateOptions } : {}) } };
}

/** A step's declared typed input (§18.4 / §24.2.3 T3). A `required` input must be resolved on step
 *  entry — prompted for when unsatisfied — before the step's `bootstrap` can run. */
export interface FlowInputDef {
  name: string;
  type: string;
  required: boolean;
}

/** A §18.1 step. `manual`: a human produces an artifact. `loop` (§24.2.3 T2): runs an agent-loop,
 *  binding its LoopDef by name (`loop`) and mirroring that loop's state.yaml read-only. The `action`
 *  kind (§18.2) is a later phase. */
export interface FlowStepDef {
  id: string;
  kind: 'manual' | 'loop';
  skill?: string;
  todoTemplate?: string;
  /** The bound agent-loop LoopDef name; `loop` steps only. */
  loop?: string;
  /** Per-step entry bootstrap (§18.3): `pickup` runs `agent-loop pickup <input>` on entry. The only
   *  kind in scope (§24.2.3 T3); the loader rejects any other value. */
  bootstrap?: 'pickup';
  inputs?: FlowInputDef[];
}

export interface FlowDefinition {
  name: string;
  steps: FlowStepDef[];
}

/** Result of reading <worktree>/.agent-terminal/flow.yaml. On success `flowDir` is the directory the
 *  flow.yaml came from — the anchor for resolving co-located templates (§18.6). */
export type FlowLoad =
  | { ok: true; definition: FlowDefinition; flowDir: string }
  | { ok: false; error: string };

const FLOW_REL = path.join('.agent-terminal', 'flow.yaml');

/** Validate a step's `inputs:` (§18.4); `required` defaults to false. Absent → []; a malformed entry
 *  → the sentinel 'invalid' so the loader can error rather than silently drop it. */
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

  // Only `manual` and `loop` kinds are in scope (§24.2.3 T1/T2); the `action` kind (§18.2) is rejected.
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
 * Resolve the flow DEFINITION local-first then global (§18.1): the global is used only when the repo
 * has no flow.yaml at all — a present-but-invalid local file surfaces its own error rather than being
 * masked by the global. (Flow STATE, by contrast, is always repo-local — see flowState.)
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
  /** Record the answer to a step-entry input prompt (§18.4 / §24.2.3 T3) and RE-ENTER the current
   *  step so the now-satisfied bootstrap runs. Legal only while a step is in_progress. */
  provideInput(values: Record<string, string>): FlowStateView;
}

/** Run a step's entry actions, given the flow's resolved typed inputs (§18.4). Returns a one-shot
 *  `notice` (e.g. the §19.3 busy refusal) and/or a `prompt` for an unsatisfied required input, to
 *  ride the transition view (§24.2.2 S4) — never part of state(). */
export type FlowEnterStep = (step: FlowStepDef, inputs: Record<string, string>) => { notice?: string; prompt?: FlowPrompt } | void;

/** Read the agent-loop state.yaml mirror for this flow's repo (§24.2.3 T2); null for a
 *  missing/corrupt/unknown-version file. Called on every view, so the mirror is live. */
export type FlowReadLoop = () => AgentLoopState | null;

/** Resolve a loop step's bound LoopDef by name (§24.2.3 T2 / §18.1); null for an
 *  unresolvable/corrupt one — readiness then degrades to the awaiting-human-* family with no gate
 *  options. */
export type FlowReadLoopDef = (name: string) => LoopDef | null;

// Optional `store` (§19.1) persists every transition and restores on construction so a relaunch
// resumes; without it the machine is in-memory only. Optional `onEnter` (§18.6) runs entry actions.
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
    // Every transition is inert in the error state, and crucially never persists — so a bad flow.yaml
    // can't overwrite a good on-disk progression, and a racing caller can't throw or escape the error.
    return { state: view, start: view, advance: view, restart: view, undo: view, provideInput: view };
  }

  const def = load.definition;
  const steps = def.steps;
  const names = steps.map((s) => s.id);
  // `done` means the last step's Advance completed the whole flow, not just one step (§24.2.3 T1).
  let index = 0;
  let status: FlowStatus = 'not_started';

  // §19.1: resume only a persisted step still present in *this* definition; a changed flow.yaml
  // whose step is gone starts fresh rather than resuming at a stale index.
  const persisted = store?.read();
  if (persisted) {
    const i = names.indexOf(persisted.step);
    if (i >= 0) {
      index = i;
      status = persisted.status;
    }
  }
  // Flow-wide (§18.4 / §24.2.3 T3) so a value resolved at one step threads to later steps; hydrated
  // from persisted state so answers survive a relaunch.
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
    // Only loop steps mirror their state.yaml + LoopDef, read live here on every view (§24.2.3 T2).
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

  // Entry actions fire AFTER state is committed, on EVERY entry into a step (§24.2.3 T3); the notice
  // merges onto the transition view only. Completing the flow (`done`) enters no step.
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
    advance: () => {
      requireStatus('in_progress', 'advance');
      if (index < steps.length - 1) {
        index += 1;
        persist();
        return enter(view());
      }
      status = 'done';
      persist();
      return view();
    },
    restart: () => {
      requireStatus('done', 'restart');
      index = 0;
      status = 'in_progress';
      persist();
      return enter(view());
    },
    undo: () => {
      requireStatus('done', 'undo');
      status = 'in_progress';
      persist();
      return view();
    },
    provideInput: (values) => {
      requireStatus('in_progress', 'provideInput');
      inputs = { ...inputs, ...values };
      persist();
      return enter(view());
    },
  };
}

/**
 * The flow keyed by `repoKey` (§16.3), so progression follows the cwd and never leaks between repos;
 * each key lazily owns one machine. Visiting a repo (`state`) only *reads* — no `.agent-terminal` dir
 * is created until a transition writes.
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
  /** Global fallback dir for the DEFINITION only (§18.1); STATE is never global. */
  globalDir: string;
  loadDefinition?: (localDir: string, globalDir: string) => FlowLoad;
  makeStore?: (repoKey: string) => FlowStateStore;
  /** Run a step's entry action (§18.6/§19.3). Todo templates instantiate on demand, not here. */
  onEnterStep?: FlowEnterStep;
  /** Read a repo's agent-loop state.yaml mirror (§24.2.3 T2); omitted → loop steps render no mirror. */
  readLoopState?: (repoKey: string) => AgentLoopState | null;
  /** Resolve a repo's loop step's bound LoopDef (§24.2.3 T2 / §18.1); omitted → readiness degrades
   *  to the awaiting-human-* family with no gate options. */
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
