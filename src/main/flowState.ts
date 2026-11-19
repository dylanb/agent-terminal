// Flow-progression persistence (§19.1 / §24.2.2 S3). The app NEVER modifies the user's .gitignore
// (no-gitignore-writes rule); a user who does not want flow-state.yaml committed ignores
// .agent-terminal/ themselves.

import path from 'node:path';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { readBoundedNoFollow } from './boundedRead';
import { FLOW_HOME_SUBDIR } from './flowHome';
import { confinedRealPathResult, resolveJail } from './confinedPath';
import { errMsg } from './errno';
import type { FlowStatus } from '../shared/ipc';
import { decisionNote, type FlowDecision } from '../shared/flowBranch';
import { normalizeTitle } from '../shared/statusBar';
import { isRecord } from './yamlRecord';

/** Persisted progression (§19.1). `inputs` is flow-wide, not per-step, so a value resolved at one
 *  step threads to later steps' inputs (§18.1 output→input; §18.4 / §24.2.3 T3). */
export interface PersistedFlowState {
  step: string;
  status: FlowStatus;
  inputs?: Record<string, string>;
  /** Epoch ms at which this run of the flow began: Start writes it, Restart and Undo keep it, a reset to
   *  `not_started` clears it (§27.9.1). It names the run's §25 file with `flow`. Absent for a flow that
   *  never started, and for one persisted before this field. */
  startedAt?: number;
  /** The name of the flow this run was started from (§27.9.1), so the run's identity never re-resolves the
   *  live pointer. Absent for a run persisted before this field. */
  flow?: string;
  /** The name the user gave this worktree's work (§22.3.1). Absent until they name one. */
  title?: string;
  /** §28.4 loop-back state: per-repeat-step iteration count (how many times each repeat step has been
   *  reached), so a relaunch resumes the correct impl-slice instead of restarting the loop. Keyed by step
   *  id; each value a positive integer. Absent for a flow with no repeat steps or none yet reached. */
  repeatCounts?: Record<string, number>;
  decisions?: Record<string, PersistedDecision>;
}

/** A decision an approve records names the gate turn it was recorded at, and counts only once that turn's accept
 *  has persisted; Advance off the step drops the name (§18.2). */
export interface PersistedDecision extends FlowDecision {
  gateTurn?: string;
}

export interface FlowStateStore {
  /** The persisted progression, or null when absent/corrupt (never throws). */
  read(): PersistedFlowState | null;
  /** Persist progression atomically (§19.1). Throws if the write cannot land. */
  write(state: PersistedFlowState): void;
  /** The worktree's name (§22.3.1), readable even where the progression is absent or corrupt. */
  readTitle(): string | null;
  /** Name the worktree, leaving any progression on disk untouched. Throws if the write cannot land. */
  writeTitle(title: string | null): void;
  /** Discard any progression, keeping a readable title — the never-started document. Throws if the write
   *  cannot land. */
  clearProgression(): void;
}

const AGENT_DIR = FLOW_HOME_SUBDIR;
const STATE_LEAF = 'flow-state.yaml';
const STATE_REL = path.join(AGENT_DIR, STATE_LEAF);
const PERSISTABLE: ReadonlySet<FlowStatus> = new Set(['not_started', 'in_progress', 'done']);
const PERSISTED_KEYS: ReadonlySet<string> = new Set(['step', 'status', 'inputs', 'started_at', 'flow', 'title', 'repeat_counts', 'decisions']);

/** The legality gate for a persisted progression's `status`: the one vocabulary the store's `decode` and the
 *  `worktreeStartedness` safety accessor both classify against, so a status one reader rejects the other cannot
 *  silently treat as a different category (§18.7.4, writer↔reader rule). */
export function isPersistableStatus(value: unknown): value is FlowStatus {
  return typeof value === 'string' && PERSISTABLE.has(value as FlowStatus);
}

/** The legality gate for a persisted progression's `step`: the one predicate the store's `decode` and the
 *  `worktreeStartedness` safety accessor both classify against, so a step one reader rejects the other cannot
 *  silently treat as a different category (§18.7.4, writer↔reader rule — the `isPersistableStatus` sibling). */
export function isPersistedStep(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const isStringValue = (v: unknown): v is string => typeof v === 'string';

/** Null when absent/empty, so the round-trip omits the key for a flow that resolved none (§24.2.3 T3). */
function readInputs(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  // Null-prototype map: a YAML-supplied key like `__proto__` must store as own data, not hit the
  // prototype setter (prototype-pollution / data-loss vector).
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(raw)) if (isStringValue(v)) out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

/** Null unless the value is a real instant: an ill-typed or non-positive `started_at` degrades to
 *  absent on the lenient read path, and rejects the whole document on the strict write path so
 *  `writeTitle` throws rather than silently discarding it (the decode-tolerance boundary). */
function readStartedAt(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function readFlowName(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** True where `v` is a persistable repeat count — a positive integer (§28.4). */
const isRepeatCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Null when absent/empty (so the round-trip omits the key). Keeps only positive-integer counts on the
 *  lenient read path; the strict write path rejects a document carrying an ill-typed one, mirroring
 *  readInputs/readStartedAt (the decode-tolerance boundary). */
function readRepeatCounts(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = Object.create(null); // null-proto: a `__proto__` key stores as own data
  for (const [k, v] of Object.entries(raw)) if (isRepeatCount(v)) out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

const isGateTurn = (v: unknown): v is string => isStringValue(v) && v.length > 0;

function readDecision(raw: unknown): PersistedDecision | null {
  if (!isRecord(raw) || !isStringValue(raw.value)) return null;
  if (raw.gate_turn !== undefined && !isGateTurn(raw.gate_turn)) return null;
  const note = isStringValue(raw.note) ? decisionNote(raw.note) : null;
  return {
    value: raw.value,
    ...(note?.ok === true && note.note !== undefined ? { note: note.note } : {}),
    ...(isGateTurn(raw.gate_turn) ? { gateTurn: raw.gate_turn } : {}),
  };
}

const isExactNote = (v: unknown): boolean => {
  if (!isStringValue(v)) return false;
  const note = decisionNote(v);
  return note.ok && note.note === v;
};

const isExactDecision = (v: unknown): boolean =>
  isRecord(v) &&
  isStringValue(v.value) &&
  Object.keys(v).every((key) => key === 'value' || (key === 'note' && isExactNote(v.note)) || (key === 'gate_turn' && isGateTurn(v.gate_turn)));

function readDecisions(raw: unknown): Record<string, PersistedDecision> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, PersistedDecision> = Object.create(null); // null-proto: a `__proto__` key stores as own data
  for (const [k, v] of Object.entries(raw)) {
    const decision = readDecision(v);
    if (decision !== null) out[k] = decision;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function writtenDecisions(decisions: Record<string, PersistedDecision>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = Object.create(null);
  for (const [step, { value, note, gateTurn }] of Object.entries(decisions)) {
    out[step] = { value, ...(note !== undefined ? { note } : {}), ...(gateTurn !== undefined ? { gate_turn: gateTurn } : {}) };
  }
  return out;
}

/** §18.7.6 (CWE-400) — the progression read is byte-bounded like the pointer's. */
export const MAX_FLOW_STATE_BYTES = 65536;

/** The three-case outcome of loading a worktree's flow-state document: genuinely absent (`missing`), present
 *  but unreadable/unparseable/escaping its jail (`invalid`), or a decoded YAML mapping (`record`). */
export type FlowStateLoad =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'record'; doc: Record<string, unknown> };

/** Load `<worktreeDir>/.agent-terminal/flow-state.yaml` through the confined path (§18.7.4/CWE-59): the file is
 *  jailed under the worktree's `.agent-terminal`, so a symlink planted at the leaf — or at `.agent-terminal`
 *  itself — resolves to `invalid` and never opens the redirect. Only a genuine ENOENT on the confined path is
 *  `missing`; a confinement escape/unresolvable and any non-ENOENT read errno fold into `invalid`, never
 *  `missing`, so the safety-gate reader fails closed instead of reading an escaping doc as absent. The one
 *  reader `createFlowStateStore` and `worktreeStartedness` share, so the two cannot drift (writer↔reader rule). */
export function loadFlowStateDoc(worktreeDir: string): FlowStateLoad {
  const jail = resolveJail(worktreeDir, AGENT_DIR);
  if (jail === null) return { kind: 'invalid', reason: `${STATE_REL} is unresolvable` };
  const confined = confinedRealPathResult(jail, path.join(jail, STATE_LEAF));
  if (!confined.ok) return { kind: 'invalid', reason: `${STATE_REL} ${confined.cause} the worktree` };
  const read = readBoundedNoFollow(confined.path, MAX_FLOW_STATE_BYTES);
  if (!read.ok) {
    if (read.cause === 'absent') return { kind: 'missing' };
    if (read.cause === 'over-cap') return { kind: 'invalid', reason: `${STATE_REL} exceeds ${MAX_FLOW_STATE_BYTES} bytes` };
    return { kind: 'invalid', reason: `cannot read ${STATE_REL}${read.error === undefined ? '' : `: ${errMsg(read.error)}`}` };
  }
  try {
    const doc: unknown = yaml.load(read.text);
    return isRecord(doc)
      ? { kind: 'record', doc }
      : { kind: 'invalid', reason: `${STATE_REL} is not a mapping` };
  } catch (e) {
    return { kind: 'invalid', reason: `cannot parse ${STATE_REL}: ${errMsg(e)}` };
  }
}

export function createFlowStateStore(worktreeDir: string): FlowStateStore {
  const file = path.join(worktreeDir, STATE_REL);

  const loadDoc = (): FlowStateLoad => loadFlowStateDoc(worktreeDir);

  // CWE-59.
  const persist = (doc: Record<string, unknown>): void => {
    if (!atomicWriteFileSync(file, yaml.dump(doc))) {
      throw new Error(`cannot write ${STATE_REL}: ${path.dirname(STATE_REL)} is not a real directory`);
    }
  };

  const decode = (doc: Record<string, unknown>): PersistedFlowState | null => {
    if (!isPersistedStep(doc.step)) return null;
    if (!isPersistableStatus(doc.status)) return null;
    const inputs = readInputs(doc.inputs);
    const startedAt = readStartedAt(doc.started_at);
    const flow = readFlowName(doc.flow);
    const title = normalizeTitle(doc.title);
    const repeatCounts = readRepeatCounts(doc.repeat_counts);
    const decisions = readDecisions(doc.decisions);
    return {
      step: doc.step,
      status: doc.status as FlowStatus,
      ...(inputs ? { inputs } : {}),
      ...(startedAt !== null ? { startedAt } : {}),
      ...(flow !== null ? { flow } : {}),
      ...(title !== null ? { title } : {}),
      ...(repeatCounts ? { repeatCounts } : {}),
      ...(decisions ? { decisions } : {}),
    };
  };

  const decodeStrict = (doc: Record<string, unknown>): PersistedFlowState | null => {
    const progression = decode(doc);
    if (progression === null) return null;
    if (Object.keys(doc).some((key) => !PERSISTED_KEYS.has(key))) return null;
    if (doc.inputs !== undefined && !(isRecord(doc.inputs) && Object.values(doc.inputs).every(isStringValue))) return null;
    if (doc.started_at !== undefined && readStartedAt(doc.started_at) === null) return null;
    if (doc.flow !== undefined && readFlowName(doc.flow) === null) return null;
    if (doc.title !== undefined && normalizeTitle(doc.title) === null) return null;
    if (doc.repeat_counts !== undefined && !(isRecord(doc.repeat_counts) && Object.values(doc.repeat_counts).every(isRepeatCount))) return null;
    if (doc.decisions !== undefined && !(isRecord(doc.decisions) && Object.values(doc.decisions).every(isExactDecision))) return null;
    return progression;
  };

  const read = (): PersistedFlowState | null => {
    const loaded = loadDoc();
    return loaded.kind === 'record' ? decode(loaded.doc) : null;
  };

  const write = (state: PersistedFlowState): void => {
    const hasInputs = state.inputs && Object.keys(state.inputs).length > 0;
    const hasRepeatCounts = state.repeatCounts && Object.keys(state.repeatCounts).length > 0;
    const hasDecisions = state.decisions && Object.keys(state.decisions).length > 0;
    const title = normalizeTitle(state.title);
    persist({
      step: state.step,
      status: state.status,
      ...(hasInputs ? { inputs: state.inputs } : {}),
      ...(state.startedAt !== undefined ? { started_at: state.startedAt } : {}),
      ...(state.flow !== undefined ? { flow: state.flow } : {}),
      ...(title !== null ? { title } : {}),
      ...(hasRepeatCounts ? { repeat_counts: state.repeatCounts } : {}),
      ...(hasDecisions ? { decisions: writtenDecisions(state.decisions ?? {}) } : {}),
    });
  };

  const writeTitle = (title: string | null): void => {
    const loaded = loadDoc();
    const named = normalizeTitle(title);
    if (loaded.kind === 'missing') {
      persist(named !== null ? { title: named } : {});
      return;
    }
    if (loaded.kind === 'invalid') throw new Error(loaded.reason);

    const keys = Object.keys(loaded.doc);
    if (keys.every((key) => key === 'title')) {
      persist(named !== null ? { title: named } : {});
      return;
    }

    const progression = decodeStrict(loaded.doc);
    if (progression === null) throw new Error(`cannot update ${STATE_REL}: unrecognized progression`);
    write({ ...progression, title: named ?? undefined });
  };

  return {
    read,
    write,
    readTitle: () => {
      const loaded = loadDoc();
      return loaded.kind === 'record' ? normalizeTitle(loaded.doc.title) : null;
    },
    writeTitle,
    clearProgression: () => {
      const loaded = loadDoc();
      if (loaded.kind === 'missing') return;
      const title = loaded.kind === 'record' ? normalizeTitle(loaded.doc.title) : null;
      persist(title !== null ? { title } : {});
    },
  };
}
