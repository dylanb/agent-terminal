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
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { confinedRealPath, resolveJail } from './confinedPath';
import { isRecord } from './yamlRecord';

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
/** The round-report leaf filename — spelled once so the write-target (`roundReportRel`) and the read-source
 *  (`roundReportFile`) cannot diverge on the naming scheme (CLAUDE.md writer↔reader-location). */
const roundReportLeaf = (round: number): string => `${round}.md`;

const STATUSES: readonly AppLoopStatus[] = ['working', 'error', 'complete'];

export type AppLoopStatus = 'working' | 'error' | 'complete';

/** The reconstructable identity of the §27 work turn a relaunch resumes: the bound loop, the flow step it
 *  runs against, the turn key, its status, and (only under `error`) why it stopped. */
export interface AppLoopRunState {
  loop: string;
  step: string;
  turnKey: string;
  status: AppLoopStatus;
  errorReason?: string;
  round?: number;
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
  // The round belongs to a review-and-fix turn; a work run carries none (absent = no round has run). Written
  // only for a valid positive integer, so a recovered round is never a fabricated identity (§27.5 IPC item 3).
  if (Number.isInteger(state.round) && (state.round as number) > 0) doc.round = state.round;
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
  // Field-local validation (CWE-20): a round is a positive integer or it is dropped, so a mis-typed or
  // negative value never surfaces as a fabricated round identity to the view/dedup/resume.
  const round = typeof doc.round === 'number' && Number.isInteger(doc.round) && doc.round > 0 ? doc.round : undefined;
  return {
    loop,
    step,
    turnKey,
    status: status as AppLoopStatus,
    ...(errorReason !== undefined ? { errorReason } : {}),
    ...(round !== undefined ? { round } : {}),
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
  return [...APP_LOOP_DIR_SEGMENTS, REPORTS_SUBDIR, roundReportLeaf(round)].join('/');
}

/** The confined absolute round-report path the engine READS back to gate completion (§27.5), or null when
 *  the loop area cannot be reduced to a symlink-free real path under the repo (a planted link, CWE-22/59).
 *  Confined through resolveJail because the loop area sits inside the untrusted repo working tree. */
export function roundReportFile(repoDir: string, round: number): string | null {
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS, REPORTS_SUBDIR);
  if (jail === null) return null;
  return confinedRealPath(jail, path.join(jail, roundReportLeaf(round)));
}
