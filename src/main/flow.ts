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
import type { FlowStateView, FlowStatus } from '../shared/ipc';
import type { FlowStateStore } from './flowState';

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

/** Result of reading <worktree>/.agent-terminal/flow.yaml: a validated definition or a reason. */
export type FlowLoad = { ok: true; definition: FlowDefinition } | { ok: false; error: string };

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

  // S2 scope is the manual kind only (§24.2.2): validate the first step is a manual step.
  const first = doc.steps[0];
  if (!isRecord(first) || typeof first.id !== 'string' || first.id.length === 0)
    return { ok: false, error: 'flow.yaml step is missing an id' };
  if (first.kind !== 'manual')
    return { ok: false, error: `flow.yaml step "${first.id}" is not a manual step (S2 supports manual only)` };
  if (first.skill !== undefined && typeof first.skill !== 'string')
    return { ok: false, error: `flow.yaml step "${first.id}" has a non-string skill` };
  if (first.todo_template !== undefined && typeof first.todo_template !== 'string')
    return { ok: false, error: `flow.yaml step "${first.id}" has a non-string todo_template` };

  const step: FlowStepDef = {
    id: first.id,
    kind: 'manual',
    ...(typeof first.skill === 'string' ? { skill: first.skill } : {}),
    ...(typeof first.todo_template === 'string' ? { todoTemplate: first.todo_template } : {}),
  };
  return { ok: true, definition: { name: doc.name, steps: [step] } };
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
}

// S3 (§19.1): an optional store backs the machine — its status is restored from disk on
// construction (so a relaunch resumes) and every transition is persisted. Without a store the
// machine is in-memory only (the S1/S2 contract), unchanged.
export function createFlowMachine(load: FlowLoad, store?: FlowStateStore): FlowMachine {
  if (!load.ok) {
    const view = (): FlowStateView => ({
      stepName: '',
      position: 0,
      total: 0,
      status: 'error',
      error: load.error,
    });
    // In the error state there is no step to drive: start/advance/restart are inert (the strip
    // shows no control), so a buggy/racing caller can neither throw nor escape the error — and
    // we never persist, so a bad flow.yaml can't overwrite a good progression.
    return { state: view, start: view, advance: view, restart: view };
  }

  const def = load.definition;
  const stepId = def.steps[0].id;
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
  });

  const transition = (from: FlowStatus, to: FlowStatus): FlowStateView => {
    if (status !== from) {
      throw new Error(`illegal flow transition: ${status} cannot move to ${to}`);
    }
    status = to;
    store?.write({ step: stepId, status });
    return view();
  };

  return {
    state: view,
    start: () => transition('not_started', 'in_progress'),
    advance: () => transition('in_progress', 'done'),
    // Restart resets a completed flow back to its first step, in progress (§24.2.2).
    restart: () => transition('done', 'in_progress'),
  };
}
