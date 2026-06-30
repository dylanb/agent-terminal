// Flow lifecycle state machine (§18.2 / §24.2.2). Illegal transitions throw, so transition
// legality is a machine invariant the UI cannot subvert, not just an affordance. The step
// definition is read from <worktree>/.agent-terminal/flow.yaml (§18.1); a missing/malformed file
// is not a crash but an inert `error` state the strip renders (§22.3).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AgentState, FlowPrompt, FlowRefs, FlowStateView, FlowStatus, TodoItem } from '../shared/ipc';
import { hasFlowRefs } from '../shared/ipc';
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
  // Project only the FlowLoopView fields — spreading the whole AgentLoopState would leak its
  // linkedIssues (which feeds FlowRefs, not the mirror) onto the wire (src/shared/ipc.ts contract).
  return {
    ...view,
    loop: {
      status: loop.status,
      iteration: loop.iteration,
      pr: loop.pr,
      branch: loop.branch,
      ready,
      humanNeeded,
      ...(gateOptions ? { gateOptions } : {}),
    },
  };
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
  /** done → in_progress; resets to the first step, clears all resolved inputs (§18.4) so required
   *  ones are re-requested, and re-runs entry actions. Throws on any other status (inert on error). */
  restart(): FlowStateView;
  /** done → in_progress; reverts a manual advance WITHOUT re-running the step's entry actions
   *  (the inverse of advance, not a restart). Throws on any other status (inert on error). */
  undo(): FlowStateView;
  /** in_progress|done → not_started (#26): abandons the flow and discards carried inputs. Throws
   *  from not_started (inert on error). */
  terminate(): FlowStateView;
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
    return { state: view, start: view, advance: view, restart: view, undo: view, terminate: view, provideInput: view };
  }

  const def = load.definition;
  const steps = def.steps;
  const names = steps.map((s) => s.id);
  // §18.4 / §24.2.3 T7 — the input names whose values feed the ticket/PR refs (name-agnostic, by type).
  const ticketInputName = steps.flatMap((s) => s.inputs ?? []).find((i) => i.type === 'github-ticket')?.name;
  const prInputName = steps.flatMap((s) => s.inputs ?? []).find((i) => i.type === 'pr')?.name;
  // `done` means the last step's Advance completed the whole flow, not just one step (§24.2.3 T1).
  let index = 0;
  let status: FlowStatus = 'not_started';
  // The flow's resolved typed inputs (§18.4 / §24.2.3 T3), flow-wide so a value resolved at one step
  // threads to later steps.
  let inputs: Record<string, string> = {};

  // Re-read the persisted progression from the store (§19.1: flow-state.yaml is the source of truth).
  // Run at construction AND on every state() query, so an external advance — the agent-loop CLI moving
  // the flow, or a manual edit — is reflected live, not frozen at first read. Resume only a step still
  // in *this* definition: a changed flow.yaml whose persisted step is gone starts fresh.
  const hydrate = (): void => {
    if (!store) return; // no backing store (tests / transient): in-memory state is authoritative
    index = 0;
    status = 'not_started';
    inputs = {};
    const persisted = store.read();
    if (!persisted) return;
    const i = names.indexOf(persisted.step);
    if (i >= 0) {
      index = i;
      status = persisted.status;
    }
    if (persisted.inputs) inputs = { ...persisted.inputs };
  };
  hydrate();

  const current = (): FlowStepDef => steps[index];

  // §24.2.3 T7 (shape: the FlowRefs JSDoc in src/shared/ipc.ts). `gates` carry the §24.2.3 T7
  // progress conditions (computed in view): an input value contributes only once a step requesting it
  // has been entered; the loop's linked_issues/pr only once a loop step has been entered. Own-property
  // lookup only, so an input named `__proto__` can't resolve a ref off the prototype chain.
  const numericInput = (name: string | undefined): number | undefined => {
    if (!name || !Object.prototype.hasOwnProperty.call(inputs, name)) return undefined;
    const raw = inputs[name];
    return typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
  };
  const computeRefs = (
    loop: AgentLoopState | null,
    gates: { ticketStep: boolean; prStep: boolean; loopEntered: boolean },
  ): FlowRefs | undefined => {
    const ticket = (gates.ticketStep ? numericInput(ticketInputName) : undefined) ?? (gates.loopEntered ? loop?.linkedIssues[0] : undefined);
    const pr = (gates.prStep ? numericInput(prInputName) : undefined) ?? (gates.loopEntered ? (loop?.pr ?? undefined) : undefined);
    const refs: FlowRefs = {};
    if (typeof ticket === 'number') refs.ticket = ticket;
    if (typeof pr === 'number') refs.pr = pr;
    return hasFlowRefs(refs) ? refs : undefined;
  };

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
    // §24.2.3 T7 (refs) / §24.2.3 T2 (loop mirror) — visibility is gated on flow PROGRESS: a
    // github-ticket/pr input surfaces only once a step requesting it has been entered; the loop's
    // linked_issues ticket, its state.yaml pr, and the mirror only once a loop step has been entered.
    // `not_started` has entered nothing, so a terminate/restart (which resets to the first step) clears
    // the display until it is re-earned by re-entering those steps.
    const entered = status === 'not_started' ? [] : steps.slice(0, index + 1);
    const ticketStep = entered.some((s) => (s.inputs ?? []).some((i) => i.type === 'github-ticket'));
    const prStep = entered.some((s) => (s.inputs ?? []).some((i) => i.type === 'pr'));
    const loopEntered = entered.some((s) => s.kind === 'loop');
    const liveLoop = readLoop?.() ?? null;
    const refs = computeRefs(liveLoop, { ticketStep, prStep, loopEntered });
    const withRefs = refs ? { ...base, refs } : base;
    if (!loopEntered) return withRefs;
    // The mirror binds to the most recently entered loop step's LoopDef (§24.2.3 T2); it stays once a
    // loop step is entered, so a later manual step in the same run still mirrors that loop.
    const loopStep = entered.reduce<FlowStepDef | undefined>((last, s) => (s.kind === 'loop' ? s : last), undefined);
    const loopDef = loopStep?.loop ? (readLoopDef?.(loopStep.loop) ?? null) : null;
    return deriveLoopView(withRefs, liveLoop, loopDef);
  };

  const persist = (): void =>
    store?.write({
      step: current().id,
      status,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    });

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
    state: () => {
      hydrate(); // §19.1: reflect the on-disk progression, not the construction-time snapshot
      return view();
    },
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
      inputs = {}; // §18.4: a restart re-requests resolved inputs; undo() preserves them
      persist();
      return enter(view());
    },
    undo: () => {
      requireStatus('done', 'undo');
      status = 'in_progress';
      persist();
      return view();
    },
    terminate: () => {
      if (status !== 'in_progress' && status !== 'done') {
        throw new Error(`illegal flow transition: cannot terminate from ${status}`);
      }
      index = 0;
      status = 'not_started';
      inputs = {};
      persist();
      return view(); // not_started enters no step, so no onEnter (mirrors advance → done)
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
  terminate(repoKey: string): FlowStateView;
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
  // Cache the machine AND a signature of the definition it was built from. The DEFINITION (flow.yaml)
  // is re-read on every access — like the §19.1 state re-read — and the machine is rebuilt only when
  // that definition changed, so a flow.yaml added/edited/removed while the app runs is picked up on
  // the next directory entry. A cached "no flow.yaml" error no longer sticks (the reported bug).
  const cache = new Map<string, { sig: string; machine: FlowMachine }>();
  const machineFor = (repoKey: string): FlowMachine => {
    const load = loadDef(repoKey, deps.globalDir);
    const sig = JSON.stringify(load);
    const cached = cache.get(repoKey);
    if (cached && cached.sig === sig) return cached.machine;
    // Definition changed (or first visit): rebuild. Progression survives in flow-state.yaml, which
    // the fresh machine re-hydrates at construction — a step no longer in the new definition starts fresh.
    const machine = createFlowMachine(
      load,
      makeStore(repoKey),
      deps.onEnterStep,
      deps.readLoopState ? () => deps.readLoopState!(repoKey) : undefined,
      deps.readLoopDef ? (name) => deps.readLoopDef!(repoKey, name) : undefined,
    );
    cache.set(repoKey, { sig, machine });
    return machine;
  };
  return {
    state: (k) => machineFor(k).state(),
    start: (k) => machineFor(k).start(),
    advance: (k) => machineFor(k).advance(),
    restart: (k) => machineFor(k).restart(),
    undo: (k) => machineFor(k).undo(),
    terminate: (k) => machineFor(k).terminate(),
    provideInput: (k, values) => machineFor(k).provideInput(values),
  };
}
