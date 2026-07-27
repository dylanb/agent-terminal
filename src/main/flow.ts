// Flow lifecycle state machine (§18.2 / §24.2.2). Illegal transitions throw, so transition
// legality is a machine invariant the UI cannot subvert, not just an affordance. The step
// definition is read from <worktree>/.agent-terminal/flow.yaml (§18.1); a missing/malformed file
// is not a crash but an inert `error` state the strip renders (§22.3).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AgentState, FlowLoopView, FlowPrompt, FlowRefs, FlowStateView, FlowStatus, TodoItem } from '../shared/ipc';
import { hasFlowRefs } from '../shared/ipc';
import { normalizeTitle } from '../shared/statusBar';
import { createFlowStateStore, type FlowStateStore } from './flowState';
import type { AgentLoopState } from './agentLoopBridge';
import { gateForStatus, type LoopDef } from './loopDef';
import { isHumanNeededStatus } from '../shared/loopStatus';
import { isRecord } from './yamlRecord';
import { errMsg } from './errno';
import { APP_LOOP_NAMESPACE, DEFAULT_LOOP_NAMESPACE, isLoopNamespace, type LoopNamespace } from '../shared/loopNamespace';
import { isSafePathSegment } from '../shared/pathSegment';

/**
 * Single source of truth for "the loop needs you" (§24.2.3 T4), consumed by both the status bar's alert and
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
  cost: string | null = null,
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
      // §26 D42a — iteration is a single MONOTONIC counter across the whole run (ai-deque parity): it is
      // already the running total across every loop the run has passed through (a successor loop carries it
      // forward, never resetting to 1), so the wire value is the raw counter — no cross-loop summation here.
      iteration: loop.iteration,
      pr: loop.pr,
      branch: loop.branch,
      ready,
      humanNeeded,
      ...(gateOptions ? { gateOptions, actionable: true } : {}),
      ...(cost !== null ? { cost } : {}),
      ...(loop.errorReason ? { errorReason: loop.errorReason } : {}),
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
  /** Which def namespace the loop binding names (§27.15): the closed set of `legacy` (§26) and `app`
   *  (§27). Present on every `loop` step, defaulting to `legacy` when the flow file names none — so
   *  engine choice is a property of the reviewed flow file, not of what is installed on the machine. */
  loopNamespace?: LoopNamespace;
  /** Per-step entry bootstrap (§18.3): `pickup` runs `agent-loop pickup <input>` on entry. The only
   *  kind in scope (§24.2.3 T3); the loader rejects any other value. */
  bootstrap?: 'pickup';
  inputs?: FlowInputDef[];
}

export interface FlowDefinition {
  name: string;
  steps: FlowStepDef[];
}

/** The §26 (legacy) LoopDef name a step binds, or null when none applies — the gate-decision write half's
 *  engine selector (§27.15), symmetric with the read/entry halves. An `app`-namespace step resolves NO §26
 *  name, so a decision arriving for a §27-bound step is refused before it can dispatch into the §26 write
 *  path; a manual or missing step resolves none either. */
export function legacyLoopNameForStep(step: FlowStepDef | undefined): string | null {
  if (step?.kind !== 'loop' || step.loopNamespace === APP_LOOP_NAMESPACE) return null;
  return step.loop ?? null;
}

/** Result of reading <worktree>/.agent-terminal/flow.yaml. On success `flowDir` is the directory the
 *  flow.yaml came from — the anchor for resolving co-located templates (§18.6). */
export type FlowLoad =
  | { ok: true; definition: FlowDefinition; flowDir: string }
  | { ok: false; error: string };

const FLOW_HOME_SUBDIR = '.agent-terminal';

/** The definition's file name within a flow home — the reader's own, so the installer seeds the name that
 *  is read back (CLAUDE.md writer↔reader rule; the `flowHomeDir` half of the same pair is below). */
export const FLOW_DEF_FILE = 'flow.yaml';
const FLOW_REL = path.join(FLOW_HOME_SUBDIR, FLOW_DEF_FILE);

/** Where a root keeps its flow definition (§18.1/§23.4) — the resolver the install action writes through,
 *  so the seeded location and the location read back here cannot drift (CLAUDE.md writer↔reader rule). */
export function flowHomeDir(root: string): string {
  return path.join(root, FLOW_HOME_SUBDIR);
}

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
    return { ok: false, error: `flow.yaml is not valid YAML: ${errMsg(e)}` };
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
    let loopNamespace: LoopNamespace = DEFAULT_LOOP_NAMESPACE;
    if (raw.kind === 'loop') {
      if (raw.loop_namespace !== undefined) {
        if (!isLoopNamespace(raw.loop_namespace))
          return { ok: false, error: `flow.yaml loop step "${raw.id}" names an unrecognized def namespace "${String(raw.loop_namespace)}" (supports: legacy, app)` };
        loopNamespace = raw.loop_namespace;
      }
      // The §27 engine holds the flow-supplied loop name to one safe segment BEFORE it is joined to any
      // tier root (§27.9); a §26 (legacy) name still validates at resolution, unchanged.
      if (loopNamespace === APP_LOOP_NAMESPACE && !isSafePathSegment(raw.loop as string))
        return { ok: false, error: `flow.yaml loop step "${raw.id}" binds an app def name that is not a single safe path segment: ${String(raw.loop)}` };
    }
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
      ...(raw.kind === 'loop' ? { loop: raw.loop as string, loopNamespace } : {}),
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
  /** Roll a half-entered bootstrap step back one step when its async pickup failed (§26.9): in_progress
   *  at `fromStepId` → in_progress at the previous step, re-running NO entry actions and PRESERVING
   *  resolved inputs, so the operator can fix the cause and re-advance. A first-step loop (no previous
   *  step) reverts to not_started — a recoverable state (Start re-fires pickup). A NO-OP GUARD, never a
   *  throw: it fires from an async `.then()`, so a stale call (the flow already moved off `fromStepId`,
   *  or is not in_progress) returns the current view untouched rather than raising. */
  revertStep(fromStepId: string): FlowStateView;
  /** in_progress|done → not_started (#26): abandons the flow and discards carried inputs. Throws
   *  from not_started (inert on error). */
  terminate(): FlowStateView;
  /** Record the answer to a step-entry input prompt (§18.4 / §24.2.3 T3) and RE-ENTER the current
   *  step so the now-satisfied bootstrap runs. Legal only while a step is in_progress. */
  provideInput(values: Record<string, string>): FlowStateView;
  /** Name this worktree's work (§22.3.1), or clear the name with a blank. Legal from EVERY status,
   *  including the load-error state — the name describes the worktree, not the run, so a directory whose
   *  flow.yaml never loaded is nameable like any other (only the name is written; no progression). */
  setTitle(text: string): FlowStateView;
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

/** The formatted §26.10 cost-meter readout for this flow's repo, or null when no cost has been recorded
 *  yet. Called on every view so the strip shows the live last-recorded cost. */
export type FlowReadLoopCost = () => string | null;

/** The §27 (app-namespace) loop-view provider: resolve the bound app-def by name and produce its whole
 *  loop view — a run-less view or a def-failure view (see loopViewV2). Selected when a loop step's
 *  `loopNamespace` is `app` (§27.15); absent for a §26-only wiring (tests), where an app step renders no
 *  loop view rather than falling back to the §26 engine. It reads no §26 loop state. */
export type FlowReadAppLoopView = (name: string) => FlowLoopView;

/** Hand the §27 cost meter the run window and the engine binding (§27.11): the selected `app` loop's name,
 *  or null when §27 is not the engine for the most-recent entered loop step, plus the run's recorded start.
 *  One nullable name answers both questions the meter has — IS this §27, and WHICH loop is it — so the
 *  meter never re-derives either from flow state. Called whenever the value changes. */
export type FlowPushCostWindow = (loop: string | null, startedAt: number | null) => void;

// Optional `store` (§19.1) persists every transition and restores on construction so a relaunch
// resumes; without it the machine is in-memory only. Optional `onEnter` (§18.6) runs entry actions.
export function createFlowMachine(
  load: FlowLoad,
  store?: FlowStateStore,
  onEnter?: FlowEnterStep,
  readLoop?: FlowReadLoop,
  readLoopDef?: FlowReadLoopDef,
  readLoopCost?: FlowReadLoopCost,
  now: () => number = Date.now,
  readAppLoopView?: FlowReadAppLoopView,
  pushCostWindow?: FlowPushCostWindow,
): FlowMachine {
  if (!load.ok) {
    const view = (): FlowStateView => {
      const named = store?.readTitle() ?? null;
      return {
        stepName: '',
        steps: [],
        position: 0,
        total: 0,
        status: 'error',
        error: load.error,
        ...(named !== null ? { userTitle: named } : {}),
      };
    };
    return {
      state: view,
      start: view,
      advance: view,
      restart: view,
      undo: view,
      revertStep: view,
      terminate: view,
      provideInput: view,
      setTitle: (text) => {
        store?.writeTitle(normalizeTitle(text));
        return view();
      },
    };
  }

  const def = load.definition;
  const steps = def.steps;
  const names = steps.map((s) => s.id);
  // §18.4 / §24.2.3 T7 — the step that declares each typed ref input, and that input's name. One source
  // for both the ref value (the input's name) and its visibility gate (the step), so they cannot desync.
  const typedInput = (type: string): { step: FlowStepDef; name: string } | undefined => {
    for (const step of steps) {
      const input = (step.inputs ?? []).find((i) => i.type === type);
      if (input) return { step, name: input.name };
    }
    return undefined;
  };
  const ticketInput = typedInput('github-ticket');
  const prInput = typedInput('pr');
  // `done` means the last step's Advance completed the whole flow, not just one step (§24.2.3 T1).
  let index = 0;
  let status: FlowStatus = 'not_started';
  // The flow's resolved typed inputs (§18.4 / §24.2.3 T3), flow-wide so a value resolved at one step
  // threads to later steps.
  let inputs: Record<string, string> = {};
  // §26.10 — when THIS run of the flow began. The cost meter sweeps session logs from here, so it must
  // survive every transition within a run and never outlive one.
  let startedAt: number | null = null;
  // §22.3.1.
  let userTitle: string | null = null;

  // Re-read the persisted progression from the store (§19.1: flow-state.yaml is the source of truth).
  // Run at construction AND on every state() query, so an external advance — the agent-loop CLI moving
  // the flow, or a manual edit — is reflected live, not frozen at first read. Resume only a step still
  // in *this* definition: a changed flow.yaml whose persisted step is gone starts fresh.
  const hydrate = (): void => {
    if (!store) return; // no backing store (tests / transient): in-memory state is authoritative
    index = 0;
    status = 'not_started';
    inputs = {};
    startedAt = null;
    const persisted = store.read();
    if (persisted) {
      const i = names.indexOf(persisted.step);
      if (i >= 0) {
        index = i;
        status = persisted.status;
      }
      if (persisted.inputs) inputs = { ...persisted.inputs };
      if (persisted.startedAt !== undefined) startedAt = persisted.startedAt;
      userTitle = persisted.title ?? null;
    } else userTitle = store.readTitle();
  };
  hydrate();

  const current = (): FlowStepDef => steps[index];

  // Own-property lookup only (§24.2.3 T7): an input named `__proto__` must not resolve a ref off the
  // prototype chain.
  const numericInput = (name: string | undefined): number | undefined => {
    if (!name || !Object.prototype.hasOwnProperty.call(inputs, name)) return undefined;
    const raw = inputs[name];
    return typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
  };
  const computeRefs = (
    loop: AgentLoopState | null,
    gates: { ticketStepEntered: boolean; prStepEntered: boolean; loopEntered: boolean },
  ): FlowRefs | undefined => {
    const ticketFromInput = gates.ticketStepEntered ? numericInput(ticketInput?.name) : undefined;
    const prFromInput = gates.prStepEntered ? numericInput(prInput?.name) : undefined;
    const ticket = ticketFromInput ?? (gates.loopEntered ? loop?.linkedIssues[0] : undefined);
    const pr = prFromInput ?? (gates.loopEntered ? (loop?.pr ?? undefined) : undefined);
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
      ...(userTitle !== null ? { userTitle } : {}),
    };
    // §24.2.3 T7 (refs) / §24.2.3 T2 (loop mirror).
    const entered = status === 'not_started' ? [] : steps.slice(0, index + 1);
    const ticketStepEntered = ticketInput !== undefined && entered.includes(ticketInput.step);
    const prStepEntered = prInput !== undefined && entered.includes(prInput.step);
    const loopEntered = entered.some((s) => s.kind === 'loop');
    // §24.2.3 T2 / §27.15 — the loop-view provider is engine-selected on the most-recent loop step's
    // namespace binding. An `app` step feeds the §27 provider, which owns the whole view and reads no
    // §26 loop state; a `legacy` (or namespace-absent) step feeds the §26 provider unchanged.
    const mostRecentLoopStep = entered.reduce<FlowStepDef | undefined>((last, s) => (s.kind === 'loop' ? s : last), undefined);
    const appLoopName = mostRecentLoopStep?.loopNamespace === APP_LOOP_NAMESPACE ? mostRecentLoopStep.loop : undefined;
    // §27.11 — the meter is handed the window and the binding rather than reading either. This runs on the
    // render path (the flow hydrates on every render), so the push itself must do no work: the meter records
    // the value and defers.
    pushCostWindow?.(appLoopName ?? null, startedAt);
    // §27.15 — the flow module holds no independent reader of §26 loop state on the app path: an app step's
    // refs never source from a stray §26 state.yaml, so a §27 step surfaces none of that engine's ticket/PR.
    const liveLoop = appLoopName !== undefined ? null : (readLoop?.() ?? null);
    const refs = computeRefs(liveLoop, { ticketStepEntered, prStepEntered, loopEntered });
    const withRefs = refs ? { ...base, refs } : base;
    if (!loopEntered) return withRefs;
    if (appLoopName !== undefined) {
      const appLoop = readAppLoopView?.(appLoopName);
      return appLoop ? { ...withRefs, loop: appLoop } : withRefs;
    }
    const loopDef = mostRecentLoopStep?.loop ? (readLoopDef?.(mostRecentLoopStep.loop) ?? null) : null;
    return deriveLoopView(withRefs, liveLoop, loopDef, readLoopCost?.() ?? null);
  };

  const persist = (): void =>
    store?.write({
      step: current().id,
      status,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      ...(startedAt !== null ? { startedAt } : {}),
      ...(userTitle !== null ? { title: userTitle } : {}),
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
      startedAt = now();
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
      startedAt = now(); // a re-run is a new run: its cost starts from zero (§26.10)
      persist();
      return enter(view());
    },
    undo: () => {
      requireStatus('done', 'undo');
      status = 'in_progress';
      persist();
      return view();
    },
    revertStep: (fromStepId) => {
      // Guard, don't throw: an async bootstrap failure may arrive after the operator terminated or
      // navigated, so a mismatch is inert rather than an unhandled rejection (§26.9).
      if (status !== 'in_progress' || current().id !== fromStepId) return view();
      if (index > 0) index -= 1;
      else {
        status = 'not_started'; // a first-step loop has no previous step; not_started is recoverable
        startedAt = null; // reverted to not_started: no active run window (mirrors terminate, §26.10)
      }
      persist();
      return view(); // no enter(): a rollback restores the prior step, it does not re-run its entry actions
    },
    terminate: () => {
      if (status !== 'in_progress' && status !== 'done') {
        throw new Error(`illegal flow transition: cannot terminate from ${status}`);
      }
      index = 0;
      status = 'not_started';
      inputs = {};
      startedAt = null; // an abandoned run leaves no window for the next run's cost to be measured from
      persist();
      return view(); // not_started enters no step, so no onEnter (mirrors advance → done)
    },
    provideInput: (values) => {
      requireStatus('in_progress', 'provideInput');
      inputs = { ...inputs, ...values };
      persist();
      return enter(view());
    },
    setTitle: (text) => {
      hydrate(); // §19.1
      const prev = userTitle;
      userTitle = normalizeTitle(text);
      try {
        store?.writeTitle(userTitle);
      } catch (e) {
        userTitle = prev;
        throw e;
      }
      return view();
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
  /** Roll a repo's half-entered bootstrap step back one step after a failed pickup (§26.9). */
  revertStep(repoKey: string, fromStepId: string): FlowStateView;
  terminate(repoKey: string): FlowStateView;
  provideInput(repoKey: string, values: Record<string, string>): FlowStateView;
  /** Name a repo's work, or clear the name with a blank (§22.3.1). */
  setTitle(repoKey: string, text: string): FlowStateView;
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
  /** The formatted §26.10 cost readout for a repo's loop, or null when none recorded; omitted → no cost. */
  readLoopCost?: (repoKey: string) => string | null;
  /** Resolve a repo's `app`-namespace loop step's §27 def and produce its whole loop view (§27.15);
   *  omitted → an app step renders no loop view rather than falling back to §26. Reads no §26 state. */
  readAppLoopView?: (repoKey: string, name: string) => FlowLoopView;
  /** Hand a repo's §27 cost meter the run window and the engine binding (§27.11), deduped on the whole
   *  triple so an unchanged value reaches the meter not at all; omitted → nothing is metered. */
  pushCostWindow?: (repoKey: string, loop: string | null, startedAt: number | null) => void;
  /** The current instant, stamped onto a run when it starts (§26.10); omitted → the wall clock. */
  now?: () => number;
}

export function createFlowManager(deps: FlowManagerDeps): FlowManager {
  const loadDef = deps.loadDefinition ?? loadFlowDefinitionLocalFirst;
  const makeStore = deps.makeStore ?? createFlowStateStore;
  // Cache the machine AND a signature of the definition it was built from. The DEFINITION (flow.yaml)
  // is re-read on every access — like the §19.1 state re-read — and the machine is rebuilt only when
  // that definition changed, so a flow.yaml added/edited/removed while the app runs is picked up on
  // the next directory entry. A cached "no flow.yaml" error no longer sticks (the reported bug).
  const cache = new Map<string, { sig: string; machine: FlowMachine }>();
  // Dedup on the whole triple, and here rather than in the machine: a flow.yaml edit rebuilds the machine,
  // and a per-machine memory would re-push an unchanged value on the next render.
  const lastPushed = new Map<string, string>();
  const pushWindowOnce = (repoKey: string, loop: string | null, startedAt: number | null): void => {
    const key = JSON.stringify([loop, startedAt]);
    if (lastPushed.get(repoKey) === key) return;
    lastPushed.set(repoKey, key);
    deps.pushCostWindow?.(repoKey, loop, startedAt);
  };
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
      deps.readLoopCost ? () => deps.readLoopCost!(repoKey) : undefined,
      deps.now,
      deps.readAppLoopView ? (name) => deps.readAppLoopView!(repoKey, name) : undefined,
      deps.pushCostWindow ? (loop, startedAt) => pushWindowOnce(repoKey, loop, startedAt) : undefined,
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
    revertStep: (k, fromStepId) => machineFor(k).revertStep(fromStepId),
    terminate: (k) => machineFor(k).terminate(),
    provideInput: (k, values) => machineFor(k).provideInput(values),
    setTitle: (k, text) => machineFor(k).setTitle(text),
  };
}
