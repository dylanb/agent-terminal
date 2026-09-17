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
import { isRecord } from './yamlRecord';
import { errMsg, isErrno } from './errno';
import { stripDisplayControlChars } from '../shared/controlChars';
import { APP_LOOP_NAMESPACE, DEFAULT_LOOP_NAMESPACE, MARKED_BINDING_REASON, bindsNoSurvivingEngine, isRecognizedLoopBinding, type LoopBinding } from '../shared/loopNamespace';
import { isSafePathSegment } from '../shared/pathSegment';

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

/** A step's declared typed input (§18.4 / §24.2.3 T3). A `required` input must be resolved on step
 *  entry — prompted for when unsatisfied — before the step's `bootstrap` can run. */
export interface FlowInputDef {
  name: string;
  type: string;
  required: boolean;
}

/** A §18.1 step. `manual`: a human produces an artifact. `loop` (§24.2.3 T2): runs an agent-loop,
 *  binding its LoopDef by name (`loop`). The `action` kind (§18.2) is a later phase. */
export interface FlowStepDef {
  id: string;
  kind: 'manual' | 'loop';
  skill?: string;
  todoTemplate?: string;
  /** The bound agent-loop LoopDef name; `loop` steps only. */
  loop?: string;
  /** Which def namespace the loop binding names (§27.15): the surviving `app` (§27) member, or the retired
   *  `legacy` marker the loader still recognizes (§H.5). Present on every `loop` step, defaulting to the
   *  surviving engine when the flow file names none (AC 4) — so engine choice is a property of the reviewed
   *  flow file, not of what is installed on the machine. */
  loopNamespace?: LoopBinding;
  /** Per-step entry bootstrap (§18.3): `pickup` runs `agent-loop pickup <input>` on entry. The only
   *  kind in scope (§24.2.3 T3); the loader rejects any other value. */
  bootstrap?: 'pickup';
  inputs?: FlowInputDef[];
  /** §28.4 loop-back (repeat) primitive: on advancing OFF this step, jump the flow back to `backTo` (an
   *  EARLIER step) instead of the next step, until it has looped back `count` times. `countInput` names the
   *  flow input holding that count — resolved at runtime (the plan decides the slice count), clamped to
   *  [1, MAX_SLICES]. The mechanism §28.2's slice-loop×N needs to run RED→GREEN→refactor once per impl-slice. */
  repeat?: { backTo: string; countInput: string };
}

/** Upper bound on loop-back iterations (§28.4): an untrusted plan-supplied slice count is clamped to this,
 *  so it can neither disable the loop (fails to 1) nor drive it unbounded (CWE-20/770). */
export const MAX_SLICES = 50;

export interface FlowDefinition {
  name: string;
  steps: FlowStepDef[];
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

const FLOWS_CATALOG_SUBDIR = 'flows';

/** The app-state catalog of selectable flows (§18.1/§18.7.1) — one per-flow-home entry per subdirectory. The
 *  install writes through this resolver and the catalog reader consumes it, so the seeded location and the
 *  enumerated location cannot drift (CLAUDE.md writer↔reader rule). */
export function flowCatalogDir(root: string): string {
  return path.join(flowHomeDir(root), FLOWS_CATALOG_SUBDIR);
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
  return loadFlowDefinitionFromFile(path.join(worktreeDir, FLOW_REL), FLOW_REL);
}

/** Read & validate the flow.yaml at `file` against §18.1 — the shared read+validate core the home-root loader
 *  (above) and A2's catalog-entry resolver (§18.7.6) both call, so the §18.1 shape has one validator. `relLabel`
 *  keeps the home loader's `.agent-terminal/flow.yaml`-relative read-error wording (default: the full path). */
export function loadFlowDefinitionFromFile(file: string, relLabel: string = file): FlowLoad {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    // AC 4 reason-accuracy: ENOENT is genuinely "no flow.yaml"; any other errno (EISDIR from a directory
    // planted at the path, EACCES on a shared machine, ENOTDIR/ELOOP from a bad symlink) names what actually
    // failed rather than reporting the flow absent while it sits on disk. Both questions answered through errno.ts.
    if (isErrno(e, 'ENOENT')) return { ok: false, error: `no flow.yaml found at ${relLabel}` };
    return { ok: false, error: `cannot read ${relLabel}: ${errMsg(e)}` };
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
    let loopNamespace: LoopBinding = DEFAULT_LOOP_NAMESPACE;
    if (raw.kind === 'loop') {
      if (raw.loop_namespace !== undefined) {
        if (!isRecognizedLoopBinding(raw.loop_namespace))
          return { ok: false, error: `flow.yaml loop step "${raw.id}" names an unrecognized def namespace "${String(raw.loop_namespace)}" (supports: app)` };
        loopNamespace = raw.loop_namespace;
      }
      // The whole-file safe-segment abort gates on the namespace the FILE names, not on the resolved binding
      // (§B.3): an explicitly-`app` step keeps today's whole-file rejection, while a namespace-less or a
      // `legacy`-marked step with an unsafe name LOADS and fails per-step (AC 4's floor). The §27 engine
      // still holds the flow-supplied name to one safe segment before joining any tier root (§27.9), so the
      // per-step confinement is unchanged — only the file-level abort narrows.
      if (raw.loop_namespace === APP_LOOP_NAMESPACE && !isSafePathSegment(raw.loop as string))
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
    // §28.4 loop-back: `repeat: { back_to, count_input }`. `back_to` must name an EARLIER step (already in
    // `steps`) — a repeat is a loop-BACK, so a forward, unknown, or self target is a load error, not a skip.
    let repeat: { backTo: string; countInput: string } | undefined;
    if (raw.repeat !== undefined) {
      if (
        !isRecord(raw.repeat) ||
        typeof raw.repeat.back_to !== 'string' || raw.repeat.back_to.length === 0 ||
        typeof raw.repeat.count_input !== 'string' || raw.repeat.count_input.length === 0
      )
        return { ok: false, error: `flow.yaml step "${raw.id}" has a malformed repeat (needs back_to + count_input)` };
      const backTo = raw.repeat.back_to;
      if (!steps.some((s) => s.id === backTo))
        return { ok: false, error: `flow.yaml step "${raw.id}" repeat.back_to "${backTo}" is not an earlier step` };
      repeat = { backTo, countInput: raw.repeat.count_input };
    }
    steps.push({
      id: raw.id,
      kind: raw.kind,
      ...(typeof raw.skill === 'string' ? { skill: raw.skill } : {}),
      ...(typeof raw.todo_template === 'string' ? { todoTemplate: raw.todo_template } : {}),
      ...(raw.kind === 'loop' ? { loop: raw.loop as string, loopNamespace } : {}),
      ...(raw.bootstrap === 'pickup' ? { bootstrap: 'pickup' as const } : {}),
      ...(inputs.length > 0 ? { inputs } : {}),
      ...(repeat ? { repeat } : {}),
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
  // No local file. A PRESENT global file's result stands — even a present-but-invalid one surfaces its own
  // reason (AC 4) rather than being masked behind the absent local's "no flow.yaml found". Only when neither
  // exists do we report the local (absent) error, so a bad value is never reported as a missing flow (§B.3).
  if (existsSync(path.join(globalDir, FLOW_REL))) return loadFlowDefinition(globalDir);
  return loadFlowDefinition(localDir); // neither exists: report the local (absent) error
}

export interface FlowMachine {
  state(): FlowStateView;
  /** §28.4 D1 — the impl-slice the flow is on: 1 at first RED, +1 on each loop-back (the repeat step's
   *  `repeat_counts`, default 1). The orchestrator keys each slice's result artifact off this so a
   *  re-entered RED writes fresh instead of resuming the prior slice. 1 for a flow with no repeat step. */
  currentSlice(): number;
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
  /** Roll a half-entered bootstrap step back one step when its async bootstrap failed (§27): in_progress
   *  at `fromStepId` → in_progress at the previous step, re-running NO entry actions and PRESERVING
   *  resolved inputs, so the operator can fix the cause and re-advance. A first-step loop (no previous
   *  step) reverts to not_started — a recoverable state (Start re-fires pickup). A NO-OP GUARD, never a
   *  throw: it fires from an async `.then()`, so a stale call (the flow already moved off `fromStepId`,
   *  or is not in_progress) returns the current view untouched rather than raising. */
  revertStep(fromStepId: string): FlowStateView;
  /** §28.4.2 in_progress → in_progress at the slice's RED step (the repeat step's `backTo`), re-running its
   *  entry actions and PRESERVING the slice count (`repeat_counts`) and resolved inputs — the human
   *  "back to RED" move that redoes the current impl-slice without consuming or adding one. A NO-OP GUARD,
   *  never a throw: inert unless in_progress with a repeat step whose target is at or before the current
   *  step, so a stale gate click cannot crash or jump the flow forward. */
  reopenSlice(): FlowStateView;
  /** in_progress|done → not_started (#26): abandons the flow and discards carried inputs. Throws
   *  from not_started (inert on error). */
  terminate(): FlowStateView;
  /** Record the answer to a step-entry input prompt (§18.4 / §24.2.3 T3) and RE-ENTER the current
   *  step so the now-satisfied bootstrap runs. Legal only while a step is in_progress. */
  provideInput(values: Record<string, string>): FlowStateView;
  /** §28.4.1 — merge programmatically-sourced inputs and persist them WITHOUT re-entering the current step
   *  (unlike provideInput, which answers a step-entry prompt and re-enters). The plan-bundle approve gate uses
   *  it to resolve the `slices` count for the DOWNSTREAM refactor step, where re-entering plan-bundle would
   *  restart its loop. Legal only while a step is in_progress. */
  resolveInputs(values: Record<string, string>): FlowStateView;
  /** Name this worktree's work (§22.3.1), or clear the name with a blank. Legal from EVERY status,
   *  including the load-error state — the name describes the worktree, not the run, so a directory whose
   *  flow.yaml never loaded is nameable like any other (only the name is written; no progression). */
  setTitle(text: string): FlowStateView;
}

/** Run a step's entry actions, given the flow's resolved typed inputs (§18.4). Returns a one-shot
 *  `notice` (the §19.3 busy refusal, or AC 5's migration notice) and/or a `prompt` for an unsatisfied
 *  required input. One-shot: carried on a transition response (and, when an asynchronous producer has one
 *  pending, on a state response); the strip holds it across passive re-pulls and clears it on the next
 *  transition (§B.5 carrier). */
export type FlowEnterStep = (step: FlowStepDef, inputs: Record<string, string>) => { notice?: string; prompt?: FlowPrompt } | void;

/** The §27 loop-view provider: resolve the bound app-def by name and produce its whole loop view — a
 *  run-less view or a def-failure view (see loopViewV2). Selected for every surviving loop binding (§27.15);
 *  omitted in tests, where a loop step then renders no loop view. */
export type FlowReadAppLoopView = (name: string) => FlowLoopView;

// Optional `store` (§19.1) persists every transition and restores on construction so a relaunch
// resumes; without it the machine is in-memory only. Optional `onEnter` (§18.6) runs entry actions.
export function createFlowMachine(
  load: FlowLoad,
  store?: FlowStateStore,
  onEnter?: FlowEnterStep,
  readAppLoopView?: FlowReadAppLoopView,
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
        // CWE-117/CWE-1007 (§16.3): the load-error message interpolates repo-authored content (a step id, a
        // kind:, a js-yaml snippet), so strip display-unsafe control chars ONCE over the whole composed
        // message at the single place FlowStateView.error is populated (§B.3).
        error: stripDisplayControlChars(load.error),
        ...(named !== null ? { userTitle: named } : {}),
      };
    };
    return {
      state: view,
      currentSlice: () => 1, // an error-state flow (no definition) has no slices
      start: view,
      advance: view,
      restart: view,
      undo: view,
      revertStep: view,
      reopenSlice: view,
      terminate: view,
      provideInput: view,
      resolveInputs: view,
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
  // §28.4 loop-back state: how many times each repeat step has been reached (own-property map so a step id
  // like `__proto__` cannot poison the prototype). Persisted, so a relaunch resumes the right impl-slice.
  let repeatCounts: Record<string, number> = Object.create(null);
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
    repeatCounts = Object.create(null);
    const persisted = store.read();
    if (persisted) {
      const i = names.indexOf(persisted.step);
      if (i >= 0) {
        index = i;
        status = persisted.status;
      }
      if (persisted.inputs) inputs = { ...persisted.inputs };
      if (persisted.repeatCounts) for (const [k, v] of Object.entries(persisted.repeatCounts)) repeatCounts[k] = v;
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
  // §28.4 — the loop-back count from an UNTRUSTED plan-supplied input, made safe at the use site: an absent,
  // non-integer, or sub-1 value falls to a single pass (no loop-back — the safe direction against a runaway),
  // and an over-cap value clamps to MAX_SLICES rather than disabling the cap (CWE-20/770).
  const slicesFor = (countInput: string): number => {
    const n = numericInput(countInput);
    if (n === undefined || !Number.isInteger(n) || n < 1) return 1;
    return Math.min(n, MAX_SLICES);
  };
  const computeRefs = (gates: { ticketStepEntered: boolean; prStepEntered: boolean }): FlowRefs | undefined => {
    // Refs come only from the flow's typed inputs now — the fallback onto the retired engine's state-mirror
    // linkedIssues/pr went with the bridge (§B.3; recorded as a removed capability in §F).
    const ticket = gates.ticketStepEntered ? numericInput(ticketInput?.name) : undefined;
    const pr = gates.prStepEntered ? numericInput(prInput?.name) : undefined;
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
    // §24.2.3 T7 (refs) / §27.15 (loop view).
    const entered = status === 'not_started' ? [] : steps.slice(0, index + 1);
    const ticketStepEntered = ticketInput !== undefined && entered.includes(ticketInput.step);
    const prStepEntered = prInput !== undefined && entered.includes(prInput.step);
    const refs = computeRefs({ ticketStepEntered, prStepEntered });
    const withRefs = refs ? { ...base, refs } : base;
    // §27.15 — the loop-view provider is selected on the most-recent loop step's namespace binding. Every
    // binding names the surviving (§27) engine except an explicitly-`legacy` one, which names no surviving
    // engine (AC 4): that marked binding yields an error loop view here rather than reaching any provider.
    const mostRecentLoopStep = entered.reduce<FlowStepDef | undefined>((last, s) => (s.kind === 'loop' ? s : last), undefined);
    if (!mostRecentLoopStep) return withRefs;
    const binding = mostRecentLoopStep.loopNamespace ?? DEFAULT_LOOP_NAMESPACE;
    if (bindsNoSurvivingEngine(binding)) {
      // AC 4 marked-binding arm: a `legacy`-bound step names no surviving engine. Surface an error loop view
      // on the existing loop-error surface (human-needed so the cue/notifier fire, no round) with a reason
      // naming the real cause; the rest of the flow stays operable, and the gate-decision seam refuses a
      // marked binding at the operation (§B.3). Replaces the deleted legacy deriveLoopView fall-through, stated
      // as an affirmative test on the marking rather than the residue of a deleted branch.
      return {
        ...withRefs,
        loop: {
          status: 'error',
          pr: null,
          branch: null,
          ready: false,
          actionable: false,
          humanNeeded: true,
          errorReason: MARKED_BINDING_REASON,
        },
      };
    }
    // A loop step always carries `loop` (loadFlowDefinition enforces it, §18.1); guard the optional type
    // and degrade to no loop view rather than crashing if a caller hands us a malformed loop step.
    const loopName = mostRecentLoopStep.loop;
    if (loopName === undefined) return withRefs;
    const appLoop = readAppLoopView?.(loopName);
    return appLoop ? { ...withRefs, loop: appLoop } : withRefs;
  };

  const persist = (): void =>
    store?.write({
      step: current().id,
      status,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      ...(Object.keys(repeatCounts).length > 0 ? { repeatCounts: { ...repeatCounts } } : {}),
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
    currentSlice: () => {
      hydrate(); // §19.1: reflect the on-disk progression, as state() does
      const repeatStep = steps.find((s) => s.repeat);
      return repeatStep ? (repeatCounts[repeatStep.id] ?? 1) : 1;
    },
    start: () => {
      requireStatus('not_started', 'start');
      status = 'in_progress';
      persist();
      return enter(view());
    },
    advance: () => {
      requireStatus('in_progress', 'advance');
      const step = current();
      // §28.4 loop-back: advancing OFF a repeat step jumps back to `backTo` until the slice count is reached.
      if (step.repeat) {
        const completed = repeatCounts[step.id] ?? 1; // first arrival at this step = one slice done
        const backIndex = names.indexOf(step.repeat.backTo);
        if (completed < slicesFor(step.repeat.countInput) && backIndex >= 0) {
          repeatCounts[step.id] = completed + 1;
          index = backIndex;
          persist();
          return enter(view());
        }
      }
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
      repeatCounts = Object.create(null); // §28.4: a fresh run loops its slices afresh
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
      // navigated, so a mismatch is inert rather than an unhandled rejection (§27).
      if (status !== 'in_progress' || current().id !== fromStepId) return view();
      if (index > 0) index -= 1;
      else {
        status = 'not_started'; // a first-step loop has no previous step; not_started is recoverable
      }
      persist();
      return view(); // no enter(): a rollback restores the prior step, it does not re-run its entry actions
    },
    reopenSlice: () => {
      // §28.4.2 human back-to-RED: jump to the slice's RED step (the repeat step's backTo) and re-enter it,
      // leaving repeat_counts + inputs untouched so this redoes the current slice rather than counting one.
      // Guard, don't throw: a stale click after the flow moved is inert, and the target is never ahead of
      // the current step (a reopen is backward-or-self, never a skip).
      if (status !== 'in_progress') return view();
      const backTo = steps.find((s) => s.repeat)?.repeat?.backTo;
      const target = backTo ? names.indexOf(backTo) : -1;
      if (target < 0 || target > index) return view();
      index = target;
      persist();
      return enter(view()); // re-enter RED so its work turn re-runs
    },
    terminate: () => {
      if (status !== 'in_progress' && status !== 'done') {
        throw new Error(`illegal flow transition: cannot terminate from ${status}`);
      }
      index = 0;
      status = 'not_started';
      inputs = {};
      repeatCounts = Object.create(null); // §28.4: an abandoned flow carries no loop-back state forward
      persist();
      return view(); // not_started enters no step, so no onEnter (mirrors advance → done)
    },
    provideInput: (values) => {
      requireStatus('in_progress', 'provideInput');
      inputs = { ...inputs, ...values };
      persist();
      return enter(view());
    },
    resolveInputs: (values) => {
      requireStatus('in_progress', 'resolveInputs');
      inputs = { ...inputs, ...values };
      persist();
      return view(); // §28.4.1 — no re-enter: a programmatic input resolution must not restart the current step
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
  /** §28.4.2 — the manual back-to-RED transition: re-enter the current slice's RED step (the repeat step's
   *  `back_to`), preserving the slice count. Delegates to the machine keyed by `repoKey`. */
  reopenSlice(repoKey: string): FlowStateView;
  /** §28.4 D1 — the impl-slice a repo's flow is on (default 1). The orchestrator keys each slice's result
   *  artifact off this so a re-entered RED writes fresh. Delegates to the machine keyed by `repoKey`. */
  currentSlice(repoKey: string): number;
  /** Roll a repo's half-entered bootstrap step back one step after a failed bootstrap (§27). */
  revertStep(repoKey: string, fromStepId: string): FlowStateView;
  terminate(repoKey: string): FlowStateView;
  provideInput(repoKey: string, values: Record<string, string>): FlowStateView;
  /** §28.4.1 — merge programmatically-sourced inputs (e.g. the plan-bundle's `slices` count) WITHOUT
   *  re-entering the current step. Delegates to the machine keyed by `repoKey`. */
  resolveInputs(repoKey: string, values: Record<string, string>): FlowStateView;
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
  /** Resolve a repo's loop step's §27 def and produce its whole loop view (§27.15); omitted → a loop step
   *  renders no loop view. A `legacy`-marked step never reaches this — its marked-binding error view (AC 4)
   *  is produced in the machine. */
  readAppLoopView?: (repoKey: string, name: string) => FlowLoopView;
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
      deps.readAppLoopView ? (name) => deps.readAppLoopView!(repoKey, name) : undefined,
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
    reopenSlice: (k) => machineFor(k).reopenSlice(),
    currentSlice: (k) => machineFor(k).currentSlice(),
    revertStep: (k, fromStepId) => machineFor(k).revertStep(fromStepId),
    terminate: (k) => machineFor(k).terminate(),
    provideInput: (k, values) => machineFor(k).provideInput(values),
    resolveInputs: (k, values) => machineFor(k).resolveInputs(values),
    setTitle: (k, text) => machineFor(k).setTitle(text),
  };
}
