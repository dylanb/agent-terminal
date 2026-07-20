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
/** The round-keyed leaf filename — spelled once so each write-target and its read-source cannot diverge on
 *  the naming scheme (CLAUDE.md writer↔reader-location). */
const roundLeaf = (round: number): string => `${round}.md`;

/** A round is a positive integer or it is no round at all. The ONE gate both the writer and the reader of the
 *  persisted `round` field consult, so a value the writer drops can never be one the reader keeps (CLAUDE.md
 *  writer↔reader shared-semantics; §27.5 IPC item 3, CWE-20). */
function isValidRound(round: unknown): round is number {
  return typeof round === 'number' && Number.isInteger(round) && round > 0;
}

const STATUSES: readonly AppLoopStatus[] = ['working', 'error', 'complete'];

export type AppLoopStatus = 'working' | 'error' | 'complete';

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

/** The confined absolute armed-interrupt file path (§27.9), or null when the loop area is unresolvable. */
function armedInterruptFile(repoDir: string): string | null {
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS);
  if (jail === null) return null;
  return confinedRealPath(jail, path.join(jail, ARMED_INTERRUPT_FILE));
}

/** Arm the queued interrupt for `step` (§27.9/AC9), persisted in its OWN file so a wholesale run-state write
 *  can neither clobber nor resurrect it. A blank step is inert — never a phantom arm on an empty identity
 *  (CWE-20). Throws when the loop area is unresolvable (a planted symlink, CWE-59), matching the run-state
 *  writer's fail-loud contract; the caller's best-effort wrapper keeps it off the critical path. */
export function armInterrupt(repoDir: string, step: string): void {
  if (step.length === 0) return;
  const file = armedInterruptFile(repoDir);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  if (!atomicWriteFileSync(file, yaml.dump({ schema_version: APP_LOOP_STATE_SCHEMA, step }))) {
    throw new Error(`cannot write §27 armed interrupt: ${path.dirname(file)} is not a real directory`);
  }
}

/** Clear the armed interrupt (§27.9/AC9) — the one-shot honor. Best-effort: an absent file is already the
 *  cleared state. */
export function clearInterrupt(repoDir: string): void {
  const file = armedInterruptFile(repoDir);
  if (file === null) return;
  rmSync(file, { force: true });
}

/** The armed interrupt's step identity, or null when none is armed (§27.9/AC9/AC11). Field-local validation
 *  (CWE-20): an empty/missing/non-string step is not a valid arm, so it reads as not-armed rather than
 *  surfacing a phantom identity. Survives a relaunch as app-owned loop state. */
export function readArmedInterrupt(repoDir: string): { step: string } | null {
  const file = armedInterruptFile(repoDir);
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
}
