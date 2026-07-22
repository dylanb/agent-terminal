// The app-owned §27 loop-state persistence (§27.10/§27.12): one small YAML document under the per-repo §27
// loop area recording which work turn is running, its status, and its error reason, so a relaunch
// reconstructs the stopped turn and never re-drives a completed one. It carries a version/schema
// discriminator (mirroring §26's versioned state.yaml, §19.1) so a later slice can migrate or reject an
// older resume file deterministically. Writer and reader agree on one gate — the error reason is persisted
// only under `status: error` — so a recovered status can never surface a stale reason (CLAUDE.md
// writer↔reader shared-semantics). This slice adds a WRITER N1 did not have, so its destination is confined
// (resolveJail — the loop area sits inside the untrusted repo working tree) before it is written, and it
// never writes a `.gitignore`.

import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { confinedRealPath, resolveJail } from './confinedPath';
import { isRecord } from './yamlRecord';
import { CONSOLIDATOR_VERDICTS, verdictCarriesReason, type ConsolidatorVerdict } from '../shared/consolidatorOutput';

/** The §27 loop-state schema this app writes and accepts. Independent of the def's `v2` marker (that keys
 *  def parsing); this keys resume-file compatibility. A file declaring any other value fails to parse. */
export const APP_LOOP_STATE_SCHEMA = 1;

/** The per-repo §27 loop area, relative to the repo root. The state file is a sibling of the def's
 *  confined `artifacts/` subtree (loopDefV2 `confineArtifact`) — the engine's own state, disjoint from it. */
export const APP_LOOP_DIR_SEGMENTS = ['.agent-terminal', 'loop'] as const;
/** The artifacts subtree of the loop area (§27.10), disjoint from the run-state file, the round reports and
 *  the consolidator outputs. One definition for the def parser that confines bindings into it and for the
 *  repo-relative form the work prompt names. */
export const ARTIFACTS_SUBDIR = 'artifacts';
const RUN_STATE_FILE = 'run-state.yaml';
/** The round reports live under a dedicated subtree of the loop area, keyed by round number (§27.5/§27.10),
 *  disjoint from the run-state file and from every other round's report. */
const REPORTS_SUBDIR = 'reports';
/** The consolidator's per-round verdict outputs live under their own subtree (§27.6), disjoint from the
 *  round reports and the run-state file. */
const CONSOLIDATE_SUBDIR = 'consolidate';
/** The armed-interrupt flag lives in its OWN file, disjoint from the run-state document (§27.9/AC9/AC11), so
 *  a turn-status persist can neither clobber an arm nor resurrect a cleared one. */
const ARMED_INTERRUPT_FILE = 'armed-interrupt.yaml';
/** The polish stand-down lives in its OWN file, disjoint from the run-state document (§27.9/AC6/AC11), for the
 *  same reason as the armed interrupt: a turn-status persist can neither clobber an active stand-down nor
 *  resurrect a cleared one, and it survives a relaunch until the operator approves. */
const POLISH_FILE = 'polish.yaml';
/** The round-keyed leaf filename — spelled once so each write-target and its read-source cannot diverge on
 *  the naming scheme (CLAUDE.md writer↔reader-location). */
const roundLeaf = (round: number): string => `${round}.md`;

/** A round is a positive integer or it is no round at all. The ONE gate both the writer and the reader of the
 *  persisted `round` field consult, so a value the writer drops can never be one the reader keeps (CLAUDE.md
 *  writer↔reader shared-semantics; §27.5 IPC item 3, CWE-20). */
function isValidRound(round: unknown): round is number {
  return typeof round === 'number' && Number.isInteger(round) && round > 0;
}

const STATUSES: readonly AppLoopStatus[] = ['working', 'error', 'complete', 'accepted'];

/** The reconstructable §27 turn statuses. `working`/`error`/`complete` are the turn-driving states; `accepted`
 *  is the terminal state a §27 human-gate approve writes (§27.9/§27.13 / N5) — the loop was accepted at its
 *  gate and the flow advanced off the step. It survives a relaunch as app-owned loop state and reconstructs to
 *  a benign, non-gate, non-human-needed view (no verdict), so a second approve on a raced re-pull is inert. */
export type AppLoopStatus = 'working' | 'error' | 'complete' | 'accepted';

/** The reconstructable identity of the §27 turn a relaunch resumes: the bound loop, the flow step it runs
 *  against, the turn key, its status, and (only under `error`) why it stopped. A consolidator turn also
 *  carries the round's `verdict`, the `verdictReason` it gave (only under `stop for a human`, §27.6), and
 *  the roster it chose for the next round (AC8). */
export interface AppLoopRunState {
  loop: string;
  step: string;
  turnKey: string;
  status: AppLoopStatus;
  errorReason?: string;
  round?: number;
  verdict?: ConsolidatorVerdict;
  verdictReason?: string;
  chosenRoster?: string[];
  /** §27.9/§19.4 (AC4) — the operator's request-changes feedback carried into THIS review round, persisted
   *  so a relaunch mid-round reconstructs it and a Retry re-injects it rather than dropping the human's input.
   *  Present only on a review turn a request-changes entered; a blank value is never persisted. */
  feedback?: string;
  /** §27.9/AC5 — the operator's redo instruction carried into THIS work turn (the clean-slate lever: ticket +
   *  plan + instruction only), persisted so a relaunch mid-work reconstructs it and a Retry re-injects it
   *  rather than dropping the human's input. Present only on a work turn a redo entered; a blank value is
   *  never persisted. Mirrors `feedback` on the review turn. */
  instruction?: string;
}

/** Non-empty text is text; blank or non-string is none. The ONE gate the writer and reader of any human-typed
 *  gate-decision payload consult — feedback (`validFeedback`) and the redo instruction (`validInstruction`)
 *  are the same rule at two boundaries, so "blank = none" has a single definition wherever it crosses (CLAUDE.md
 *  writer↔reader shared-semantics; CWE-20). */
function nonEmptyText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/** Non-empty feedback is feedback; blank or non-string is none. Applied by the writer/reader of the persisted
 *  `feedback` field, the request-changes IPC executor, and the review prompt (one gate, every boundary). */
export function validFeedback(feedback: unknown): string | undefined {
  return nonEmptyText(feedback);
}

/** Non-empty instruction is instruction; blank or non-string is none. Applied by the writer/reader of the
 *  persisted `instruction` field, the redo IPC executor, and the work prompt (one gate, every boundary). */
export function validInstruction(instruction: unknown): string | undefined {
  return nonEmptyText(instruction);
}

/** The confined absolute run-state file path inside the §27 loop area, or null when the loop area cannot be
 *  reduced to a symlink-free real path under the repo (a planted link at `.agent-terminal`, CWE-22/59). */
export function appLoopStateFile(repoDir: string): string | null {
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS);
  if (jail === null) return null;
  return confinedRealPath(jail, path.join(jail, RUN_STATE_FILE));
}

export function serializeAppLoopState(state: AppLoopRunState, now: () => Date): string {
  const doc: Record<string, unknown> = {
    schema_version: APP_LOOP_STATE_SCHEMA,
    loop: state.loop,
    step: state.step,
    turn_key: state.turnKey,
    status: state.status,
    updated_at: now().toISOString(),
  };
  // The reason belongs only to `error` — the one gate both sides read, so a recovered status never renders a
  // stale reason (CLAUDE.md writer↔reader).
  if (state.status === 'error' && state.errorReason) doc.error_reason = state.errorReason;
  // The round belongs to a review-and-fix / consolidator turn; a work run carries none (absent = no round has
  // run). Written only for a valid round, so a recovered round is never a fabricated identity.
  if (isValidRound(state.round)) doc.round = state.round;
  // §27.6 — the consolidator's verdict, and (through the single-sourced gate, mirroring error_reason) its
  // reason ONLY under `stop for a human`. A verdict outside the closed set is never serialized.
  if (state.verdict !== undefined && (CONSOLIDATOR_VERDICTS as readonly string[]).includes(state.verdict)) {
    doc.verdict = state.verdict;
    if (verdictCarriesReason(state.verdict) && state.verdictReason) doc.verdict_reason = state.verdictReason;
  }
  // §27.6/AC8 — the chosen roster is carried by BOTH the consolidator turn (the roster it selected) and the
  // subsequent review round (the roster it runs), so it is persisted independently of the verdict.
  if (state.chosenRoster && state.chosenRoster.length > 0) doc.chosen_roster = state.chosenRoster;
  // §27.9/AC4 — the request-changes feedback for this review round (the one gate both sides read).
  const feedback = validFeedback(state.feedback);
  if (feedback !== undefined) doc.feedback = feedback;
  // §27.9/AC5 — the redo instruction for this work turn (the same one-gate treatment as feedback).
  const instruction = validInstruction(state.instruction);
  if (instruction !== undefined) doc.instruction = instruction;
  return yaml.dump(doc);
}

export function parseAppLoopState(text: string): AppLoopRunState | null {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  // Version-gate by String() coercion so a bare `1` and a quoted `"1"` both match, and any other value is
  // rejected rather than mis-parsed (mirrors agentLoopBridge's §26 gate).
  if (String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return null;
  const { loop, step, turn_key: turnKey, status } = doc;
  if (typeof loop !== 'string' || typeof step !== 'string' || typeof turnKey !== 'string') return null;
  if (typeof status !== 'string' || !STATUSES.includes(status as AppLoopStatus)) return null;
  const errorReason = status === 'error' && typeof doc.error_reason === 'string' ? doc.error_reason : undefined;
  // Field-local validation (CWE-20): a mis-typed or negative value is dropped, so it never surfaces as a
  // fabricated round identity to the view/dedup/resume.
  const round = isValidRound(doc.round) ? doc.round : undefined;
  // §27.6 — the verdict is admitted only from the closed set; its reason is kept only under the
  // stop-for-a-human gate (the same gate the writer applies), so a recovered verdict never renders a
  // mismatched reason; the chosen roster is a list of strings (AC8).
  const verdict = (CONSOLIDATOR_VERDICTS as readonly unknown[]).includes(doc.verdict) ? (doc.verdict as ConsolidatorVerdict) : undefined;
  const verdictReason =
    verdict !== undefined && verdictCarriesReason(verdict) && typeof doc.verdict_reason === 'string' ? doc.verdict_reason : undefined;
  const chosenRoster =
    Array.isArray(doc.chosen_roster) && doc.chosen_roster.every((p) => typeof p === 'string') && doc.chosen_roster.length > 0
      ? (doc.chosen_roster as string[])
      : undefined;
  // §27.9/AC4 — field-local validation (CWE-20): a blank or non-string feedback is dropped.
  const feedback = validFeedback(doc.feedback);
  // §27.9/AC5 — same field-local validation for the redo instruction.
  const instruction = validInstruction(doc.instruction);
  return {
    loop,
    step,
    turnKey,
    status: status as AppLoopStatus,
    ...(errorReason !== undefined ? { errorReason } : {}),
    ...(round !== undefined ? { round } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(verdictReason !== undefined ? { verdictReason } : {}),
    ...(chosenRoster !== undefined ? { chosenRoster } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
  };
}

export function writeAppLoopState(repoDir: string, state: AppLoopRunState, now: () => Date = () => new Date()): void {
  const file = appLoopStateFile(repoDir);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  if (!atomicWriteFileSync(file, serializeAppLoopState(state, now))) {
    throw new Error(`cannot write §27 loop state: ${path.dirname(file)} is not a real directory`);
  }
}

export function readAppLoopState(repoDir: string): AppLoopRunState | null {
  const file = appLoopStateFile(repoDir);
  if (file === null) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseAppLoopState(text);
}

/** The repo-relative round-report path the fixer is instructed to write (§27.5) — the WRITE-target half of
 *  the one resolver whose READ-source half is `roundReportFile`, so the two cannot drift (CLAUDE.md
 *  writer↔reader-location). */
export function roundReportRel(round: number): string {
  return [...APP_LOOP_DIR_SEGMENTS, REPORTS_SUBDIR, roundLeaf(round)].join('/');
}

/** The confined absolute round-report path the engine READS back to gate completion (§27.5), or null when
 *  the loop area cannot be reduced to a symlink-free real path under the repo (a planted link, CWE-22/59).
 *  Confined through resolveJail because the loop area sits inside the untrusted repo working tree. */
export function roundReportFile(repoDir: string, round: number): string | null {
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS, REPORTS_SUBDIR);
  if (jail === null) return null;
  return confinedRealPath(jail, path.join(jail, roundLeaf(round)));
}

/** The repo-relative consolidator-output path the consolidator is instructed to write (§27.6) — the
 *  WRITE-target half of the resolver whose READ-source half is `consolidatorOutputFile`, so the two cannot
 *  drift. Disjoint from the round reports so a round's report and its verdict never collide. */
export function consolidatorOutputRel(round: number): string {
  return [...APP_LOOP_DIR_SEGMENTS, CONSOLIDATE_SUBDIR, roundLeaf(round)].join('/');
}

/** The confined absolute consolidator-output path the engine READS back to gate the consolidator turn
 *  (§27.6), or null when the loop area cannot be reduced to a symlink-free real path (CWE-22/59). */
export function consolidatorOutputFile(repoDir: string, round: number): string | null {
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS, CONSOLIDATE_SUBDIR);
  if (jail === null) return null;
  return confinedRealPath(jail, path.join(jail, roundLeaf(round)));
}

/** A per-step flag in the §27 loop area — one small YAML document `{schema_version, step}` in its OWN file, so a
 *  wholesale run-state write can neither clobber nor resurrect it and it survives a relaunch (§27.9). The armed
 *  interrupt (AC9) and the polish stand-down (AC6/AC11) are two disjoint instances of this one shape; each names
 *  its own file so the two never collide. Confined through resolveJail because the loop area sits inside the
 *  untrusted repo working tree (CWE-22/59). */
interface StepFlag {
  /** Persist the flag for `step`. A blank step is inert — never a phantom flag on an empty identity (CWE-20).
   *  Throws when the loop area is unresolvable (a planted symlink, CWE-59), matching the run-state writer's
   *  fail-loud contract; the caller's best-effort wrapper keeps it off the critical path. */
  set(repoDir: string, step: string): void;
  /** Clear the flag — best-effort; an absent file is already the cleared state. */
  clear(repoDir: string): void;
  /** The flag's step identity, or null when unset. Field-local validation (CWE-20): an empty/missing/non-string
   *  step is not a valid flag, so it reads as unset rather than surfacing a phantom identity. */
  read(repoDir: string): { step: string } | null;
}

function stepFlag(filename: string, what: string): StepFlag {
  const fileOf = (repoDir: string): string | null => {
    const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS);
    if (jail === null) return null;
    return confinedRealPath(jail, path.join(jail, filename));
  };
  return {
    set(repoDir, step) {
      if (step.length === 0) return;
      const file = fileOf(repoDir);
      if (file === null) throw new Error('§27 loop area is unresolvable');
      if (!atomicWriteFileSync(file, yaml.dump({ schema_version: APP_LOOP_STATE_SCHEMA, step }))) {
        throw new Error(`cannot write §27 ${what}: ${path.dirname(file)} is not a real directory`);
      }
    },
    clear(repoDir) {
      const file = fileOf(repoDir);
      if (file === null) return;
      rmSync(file, { force: true });
    },
    read(repoDir) {
      const file = fileOf(repoDir);
      if (file === null) return null;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      let doc: unknown;
      try {
        doc = yaml.load(text);
      } catch {
        return null;
      }
      if (!isRecord(doc)) return null;
      if (String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return null;
      if (typeof doc.step !== 'string' || doc.step.length === 0) return null;
      return { step: doc.step };
    },
  };
}

const armedInterrupt = stepFlag(ARMED_INTERRUPT_FILE, 'armed interrupt');
const polishStandDown = stepFlag(POLISH_FILE, 'polish stand-down');

/** Arm the queued one-shot interrupt for `step` (§27.9/AC9), cleared by `clearInterrupt`. */
export function armInterrupt(repoDir: string, step: string): void {
  armedInterrupt.set(repoDir, step);
}
export function clearInterrupt(repoDir: string): void {
  armedInterrupt.clear(repoDir);
}
export function readArmedInterrupt(repoDir: string): { step: string } | null {
  return armedInterrupt.read(repoDir);
}

/** Enter the polish stand-down for `step` (§27.9/AC6) — approve is the one lever that clears it (AC11). */
export function enterPolish(repoDir: string, step: string): void {
  polishStandDown.set(repoDir, step);
}
export function clearPolish(repoDir: string): void {
  polishStandDown.clear(repoDir);
}

/** Whether a polish stand-down is active for `step` (§27.9/AC6). The ONE definition of the stand-down identity
 *  both sides that must agree derive from — the engine's lever-suppression seam (index.ts) and the view's
 *  `inPolish` (loopViewV2) — so the two cannot drift on which gate is standing down (CLAUDE.md shared-semantics). */
export function isPolishActiveForStep(repoDir: string, step: string): boolean {
  return polishStandDown.read(repoDir)?.step === step;
}
