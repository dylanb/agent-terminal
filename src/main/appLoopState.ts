import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { lstatSync, rmSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { readBoundedNoFollow } from './boundedRead';
import { confinedRealPath, resolveJail } from './confinedPath';
import { APP_LOOP_DIR_SEGMENTS } from './appLoopPaths';
import { isRecord } from './yamlRecord';
import { errMsg, isErrno } from './errno';
import { readDirEntries } from './dirEntries';
import { isGitObjectId } from '../shared/appBootstrap';
import { CONSOLIDATOR_VERDICTS, verdictCarriesReason, type ConsolidatorVerdict } from '../shared/consolidatorOutput';
import { PHASE_OUTPUT_SUFFIX, phaseOutputRel } from '../shared/phaseResult';
import { isOneOf } from '../shared/oneOf';

/** The §27 loop-state schema this app writes and accepts. Independent of the def's `v2` marker (that keys
 *  def parsing); this keys resume-file compatibility. A file declaring any other value fails to parse. */
export const APP_LOOP_STATE_SCHEMA = 1;

const RUN_STATE_FILE = 'run-state.yaml';
/** The round reports live under a dedicated subtree of the loop area, keyed by round number (§27.5/§27.10),
 *  disjoint from the run-state file and from every other round's report. */
const REPORTS_SUBDIR = 'reports';
const REFACTOR_RESULTS_SUBDIR = 'refactor-results';
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
const roundLeaf = (round: number): string => `${round}.json`;

/** A round is a positive integer or it is no round at all. The ONE gate both the writer and the reader of the
 *  persisted `round` field consult, so a value the writer drops can never be one the reader keeps (CLAUDE.md
 *  writer↔reader shared-semantics; §27.5 IPC item 3, CWE-20). */
function isPositiveWhole(round: unknown): round is number {
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
  /** §27.10 */
  chainedInputs?: string[];
  /** §27.3 */
  leg?: number;
  /** §27.3 */
  goalSession?: string;
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

/** The confined absolute path of a file directly inside the §27 loop area (<repo>/.agent-terminal/loop/), or
 *  null when the loop area cannot be reduced to a symlink-free real path under the repo (a planted link at
 *  `.agent-terminal`, CWE-22/59). The ONE confinement-leaf resolver the per-file resolvers here share (run-state,
 *  the disjoint step-flags, the baseline), so the jail derivation lives once. */
export function loopAreaFile(repoDir: string, leaf: string): string | null {
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS);
  if (jail === null) return null;
  return confinedRealPath(jail, path.join(jail, leaf));
}

export const MAX_LOOP_AREA_FILE_BYTES = 1024 * 1024;

const GOAL_PROMPT_FILE = 'goal-prompt.md';

/** §27.3 */
export function goalPromptRel(): string {
  return [...APP_LOOP_DIR_SEGMENTS, GOAL_PROMPT_FILE].join('/');
}

/** §27.3 */
export function writeGoalPrompt(repoDir: string, prompt: string): boolean {
  const file = loopAreaFile(repoDir, GOAL_PROMPT_FILE);
  if (file === null) return false;
  try {
    return atomicWriteFileSync(file, prompt);
  } catch {
    return false;
  }
}

const GOAL_SESSION_BYTES = 4;
const GOAL_SESSION_LENGTH = GOAL_SESSION_BYTES * 2;

/** §27.3 — the id a fresh goal turn keeps its own files under, so no earlier turn's can be read as its own. */
export function newGoalSession(): string {
  return randomBytes(GOAL_SESSION_BYTES).toString('hex');
}

/** §27.3 */
export function isGoalSession(v: unknown): v is string {
  if (typeof v !== 'string' || v.length !== GOAL_SESSION_LENGTH) return false;
  for (const c of v) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

/** §27.3 — each file a goal session keeps, as the prefix and suffix around its session id. */
const GOAL_SESSION_FILES = {
  progress: { prefix: 'goal-progress.', suffix: '.json' },
  notes: { prefix: 'goal-notes.', suffix: '.md' },
  refactorResult: { prefix: 'refactor-result.', suffix: '.json' },
  refactorOutput: { prefix: 'refactor-result.', suffix: PHASE_OUTPUT_SUFFIX },
} as const;
type GoalSessionFile = keyof typeof GOAL_SESSION_FILES;

function goalSessionLeaf(kind: GoalSessionFile, session: string): string {
  if (!isGoalSession(session)) throw new Error(`not a goal session id: ${JSON.stringify(session)}`);
  const { prefix, suffix } = GOAL_SESSION_FILES[kind];
  return `${prefix}${session}${suffix}`;
}

const goalSessionRel = (kind: GoalSessionFile, session: string): string => [...APP_LOOP_DIR_SEGMENTS, goalSessionLeaf(kind, session)].join('/');

/** §27.3 — the state the engine reads at the done-signal. */
export function goalProgressRel(session: string): string {
  return goalSessionRel('progress', session);
}

/** §27.3 */
export function goalProgressFile(repoDir: string, session: string): string | null {
  return loopAreaFile(repoDir, goalSessionLeaf('progress', session));
}

/** §27.3 — the session's own notes for the next leg, which the engine never reads. */
export function goalNotesRel(session: string): string {
  return goalSessionRel('notes', session);
}

/** §27.3/§28.5.3 — where a refactor goal session records its test result. */
export function goalRefactorResultRel(session: string): string {
  return goalSessionRel('refactorResult', session);
}

/** §27.3/§28.5.3 */
export function goalRefactorResultFile(repoDir: string, session: string): string | null {
  return loopAreaFile(repoDir, goalSessionLeaf('refactorResult', session));
}

/** §27.3 — removes every goal session's files; an absent loop area is already the cleared state. */
export function clearGoalSessionFiles(repoDir: string): void {
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS);
  if (jail === null) return;
  for (const e of readDirEntries(jail)) {
    if (!e.isFile) continue;
    const kind = Object.values(GOAL_SESSION_FILES).find((k) => e.name.startsWith(k.prefix) && e.name.endsWith(k.suffix));
    if (kind === undefined || !isGoalSession(e.name.slice(kind.prefix.length, -kind.suffix.length))) continue;
    const file = loopAreaFile(repoDir, e.name);
    if (file !== null) rmSync(file, { force: true });
  }
}

/** The confined absolute run-state file path inside the §27 loop area, or null (CWE-22/59). */
export function appLoopStateFile(repoDir: string): string | null {
  return loopAreaFile(repoDir, RUN_STATE_FILE);
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
  if (isPositiveWhole(state.round)) doc.round = state.round;
  // §27.6 — the consolidator's verdict, and (through the single-sourced gate, mirroring error_reason) its
  // reason ONLY under `stop for a human`. A verdict outside the closed set is never serialized.
  if (isOneOf(CONSOLIDATOR_VERDICTS, state.verdict)) {
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
  // §27.10 — absent reads back as "carried nothing", so a recovered carry fails toward NOT carrying.
  if (state.chainedInputs && state.chainedInputs.length > 0) doc.chained_inputs = state.chainedInputs;
  if (isPositiveWhole(state.leg)) doc.leg = state.leg;
  if (isGoalSession(state.goalSession)) doc.goal_session = state.goalSession;
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
  // rejected rather than mis-parsed.
  if (String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return null;
  const { loop, step, turn_key: turnKey, status } = doc;
  if (typeof loop !== 'string' || typeof step !== 'string' || typeof turnKey !== 'string') return null;
  if (!isOneOf(STATUSES, status)) return null;
  const errorReason = status === 'error' && typeof doc.error_reason === 'string' ? doc.error_reason : undefined;
  // Field-local validation (CWE-20): a mis-typed or negative value is dropped, so it never surfaces as a
  // fabricated round identity to the view/dedup/resume.
  const round = isPositiveWhole(doc.round) ? doc.round : undefined;
  // §27.6 — the verdict is admitted only from the closed set; its reason is kept only under the
  // stop-for-a-human gate (the same gate the writer applies), so a recovered verdict never renders a
  // mismatched reason; the chosen roster is a list of strings (AC8).
  const verdict = isOneOf(CONSOLIDATOR_VERDICTS, doc.verdict) ? doc.verdict : undefined;
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
  // §27.10 — same field-local validation as the chosen roster; a malformed list reads as carried nothing.
  const chainedInputs =
    Array.isArray(doc.chained_inputs) && doc.chained_inputs.every((i) => typeof i === 'string') && doc.chained_inputs.length > 0
      ? (doc.chained_inputs as string[])
      : undefined;
  const leg = isPositiveWhole(doc.leg) ? doc.leg : undefined;
  const goalSession = isGoalSession(doc.goal_session) ? doc.goal_session : undefined;
  return {
    loop,
    step,
    turnKey,
    status,
    ...(errorReason !== undefined ? { errorReason } : {}),
    ...(round !== undefined ? { round } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(verdictReason !== undefined ? { verdictReason } : {}),
    ...(chosenRoster !== undefined ? { chosenRoster } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
    ...(chainedInputs !== undefined ? { chainedInputs } : {}),
    ...(leg !== undefined ? { leg } : {}),
    ...(goalSession !== undefined ? { goalSession } : {}),
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
  const read = readBoundedNoFollow(file, MAX_LOOP_AREA_FILE_BYTES);
  return read.ok ? parseAppLoopState(read.text) : null;
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

/** §28.5.5 — the confined path of the raw captured run kept beside the phase result at `resultPath`, which is
 *  itself already confined; null when the sibling cannot be reduced to a symlink-free path inside the result's own
 *  directory (CWE-22/59). */
export function phaseOutputFile(resultPath: string): string | null {
  const jail = resolveJail(path.dirname(resultPath));
  if (jail === null) return null;
  return confinedRealPath(jail, path.join(jail, phaseOutputRel(path.basename(resultPath))));
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

/** §28.5.3 — the repo-relative refactor-result path the fixer is instructed to write, the WRITE-target half of
 *  the resolver whose READ-source half is `refactorResultFile`, so the two cannot drift (writer↔reader-location).
 *  Round-keyed and disjoint from the round reports and the consolidator output. */
export function refactorResultRel(round: number): string {
  return [...APP_LOOP_DIR_SEGMENTS, REFACTOR_RESULTS_SUBDIR, roundLeaf(round)].join('/');
}

/** §28.5.3 — the confined absolute refactor-result path the engine READS back to gate the refactor round, or
 *  null when the loop area cannot be reduced to a symlink-free real path (CWE-22/59). */
export function refactorResultFile(repoDir: string, round: number): string | null {
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS, REFACTOR_RESULTS_SUBDIR);
  if (jail === null) return null;
  return confinedRealPath(jail, path.join(jail, roundLeaf(round)));
}

const BOOTSTRAP_FILE = 'bootstrap.yaml';

/** §27.10 */
export interface AppLoopBootstrap {
  pr: number;
  branch: string;
  issue: number;
  initialStatus: string;
}

export type ReadAppLoopBootstrap = Omit<AppLoopBootstrap, 'initialStatus'> & {
  initialStatus?: string;
};

export type AppLoopBootstrapIntent = Omit<AppLoopBootstrap, 'pr'>;

const bootstrapFileOf = (repoDir: string): string | null => {
  const jail = resolveJail(repoDir, ...APP_LOOP_DIR_SEGMENTS);
  if (jail === null) return null;
  const parent = confinedRealPath(jail, jail);
  if (parent !== jail) return null;
  const file = path.join(jail, BOOTSTRAP_FILE);
  try {
    if (!lstatSync(file).isFile()) return null;
  } catch (e) {
    if (!isErrno(e, 'ENOENT')) return null;
  }
  return file;
};

export function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

export function isNonBlank(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function writeAppLoopBootstrap(repoDir: string, b: AppLoopBootstrap, now: () => Date = () => new Date()): void {
  if (!isPositiveInt(b.pr) || !isPositiveInt(b.issue) || !isNonBlank(b.branch) || !isNonBlank(b.initialStatus)) {
    throw new Error('invalid §27 bootstrap identity');
  }
  const file = bootstrapFileOf(repoDir);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  const doc = {
    schema_version: APP_LOOP_STATE_SCHEMA,
    status: 'complete',
    pr: b.pr,
    branch: b.branch,
    issue: b.issue,
    initial_status: b.initialStatus,
    updated_at: now().toISOString(),
  };
  if (!atomicWriteFileSync(file, yaml.dump(doc))) {
    throw new Error(`cannot write §27 bootstrap identity: ${path.dirname(file)} is not a real directory`);
  }
}

export function writeAppLoopBootstrapIntent(
  repoDir: string,
  intent: AppLoopBootstrapIntent,
  now: () => Date = () => new Date(),
): void {
  if (!isPositiveInt(intent.issue) || !isNonBlank(intent.branch) || !isNonBlank(intent.initialStatus)) {
    throw new Error('invalid §27 bootstrap intent');
  }
  const file = bootstrapFileOf(repoDir);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  const doc = {
    schema_version: APP_LOOP_STATE_SCHEMA,
    status: 'pending',
    branch: intent.branch,
    issue: intent.issue,
    initial_status: intent.initialStatus,
    updated_at: now().toISOString(),
  };
  if (!atomicWriteFileSync(file, yaml.dump(doc))) {
    throw new Error(`cannot write §27 bootstrap intent: ${path.dirname(file)} is not a real directory`);
  }
}

/** §27.10 */
export type PickupRecord =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'complete'; bootstrap: ReadAppLoopBootstrap }
  | { kind: 'invalid'; detail: string };

const BOOTSTRAP_REL = [...APP_LOOP_DIR_SEGMENTS, BOOTSTRAP_FILE].join('/');

export function readPickupRecord(repoDir: string): PickupRecord {
  const invalid = (why: string): PickupRecord => ({ kind: 'invalid', detail: `${BOOTSTRAP_REL} ${why}` });
  const file = bootstrapFileOf(repoDir);
  if (file === null) return invalid('is not a regular file inside a real loop directory');
  const read = readBoundedNoFollow(file, MAX_LOOP_AREA_FILE_BYTES);
  if (!read.ok) {
    switch (read.cause) {
      case 'absent':
        return { kind: 'none' };
      case 'over-cap':
        return invalid(`is larger than ${MAX_LOOP_AREA_FILE_BYTES} bytes`);
      case 'unreadable':
        return invalid(`cannot be read: ${read.error === undefined ? 'not a regular file' : errMsg(read.error)}`);
      default:
        return read.cause satisfies never;
    }
  }
  let doc: unknown;
  try {
    doc = yaml.load(read.text);
  } catch (e) {
    return invalid(`is not valid YAML: ${errMsg(e)}`);
  }
  if (!isRecord(doc)) return invalid('is not a YAML mapping');
  if (String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return invalid(`has unsupported schema_version ${String(doc.schema_version)}`);
  if (doc.status === 'pending') {
    return isPositiveInt(doc.issue) && isNonBlank(doc.branch) && isNonBlank(doc.initial_status)
      ? { kind: 'pending' }
      : invalid('is a pending pickup without a positive integer issue, a non-blank branch and initial_status');
  }
  if (doc.status !== undefined && doc.status !== 'complete') return invalid(`has unknown status ${String(doc.status)}`);
  if (!isPositiveInt(doc.pr) || !isPositiveInt(doc.issue)) return invalid('needs positive integer pr and issue');
  if (!isNonBlank(doc.branch)) return invalid('needs a non-blank branch');
  if (doc.initial_status !== undefined && !isNonBlank(doc.initial_status)) return invalid('has a blank initial_status');
  return {
    kind: 'complete',
    bootstrap: {
      pr: doc.pr,
      branch: doc.branch,
      issue: doc.issue,
      ...(isNonBlank(doc.initial_status) ? { initialStatus: doc.initial_status } : {}),
    },
  };
}

export function readAppLoopBootstrap(repoDir: string): ReadAppLoopBootstrap | null {
  const record = readPickupRecord(repoDir);
  return record.kind === 'complete' ? record.bootstrap : null;
}

export function clearAppLoopBootstrap(repoDir: string): void {
  const file = bootstrapFileOf(repoDir);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  rmSync(file, { force: true });
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
  /** Like `read`, but a present flag that cannot be read or validated is `unreadable`, not unset. */
  probe(repoDir: string): FlagProbe;
}

export type FlagProbe = { kind: 'absent' } | { kind: 'set'; step: string } | { kind: 'unreadable' };

function stepFlag(filename: string, what: string): StepFlag {
  const fileOf = (repoDir: string): string | null => loopAreaFile(repoDir, filename);
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
      const p = this.probe(repoDir);
      return p.kind === 'set' ? { step: p.step } : null;
    },
    probe(repoDir) {
      const file = fileOf(repoDir);
      if (file === null) return { kind: 'absent' };
      const read = readBoundedNoFollow(file, MAX_LOOP_AREA_FILE_BYTES);
      if (!read.ok) {
        switch (read.cause) {
          case 'absent':
            return { kind: 'absent' };
          case 'over-cap':
          case 'unreadable':
            return { kind: 'unreadable' };
          default:
            return read.cause satisfies never;
        }
      }
      let doc: unknown;
      try {
        doc = yaml.load(read.text);
      } catch {
        return { kind: 'unreadable' };
      }
      if (!isRecord(doc)) return { kind: 'unreadable' };
      if (String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return { kind: 'unreadable' };
      if (typeof doc.step !== 'string' || doc.step.length === 0) return { kind: 'unreadable' };
      return { kind: 'set', step: doc.step };
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
export function probeArmedInterrupt(repoDir: string): FlagProbe {
  return armedInterrupt.probe(repoDir);
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

// §28.4.2 — the back-to-RED slice brief in its OWN file, `slice-brief.yaml`, disjoint from run-state.yaml: the
// RED, GREEN and refactor phases each rewrite run-state wholesale, and the brief must outlive all three.
const SLICE_BRIEF_FILE = 'slice-brief.yaml';

/** The operator's brief for redoing impl-slice `slice`, sent back to RED from the `fromStep` gate. */
export interface SliceBrief {
  slice: number;
  fromStep: string;
  text: string;
}

/** Persist the brief. Throws when the loop area is unresolvable (a planted symlink, CWE-59), matching the
 *  run-state writer's fail-loud contract; the caller decides whether that blocks. */
export function writeSliceBrief(repoDir: string, brief: SliceBrief): void {
  const file = loopAreaFile(repoDir, SLICE_BRIEF_FILE);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  const doc = { schema_version: APP_LOOP_STATE_SCHEMA, slice: brief.slice, from_step: brief.fromStep, brief: brief.text };
  if (!atomicWriteFileSync(file, yaml.dump(doc))) {
    throw new Error(`cannot write the slice brief: ${path.dirname(file)} is not a real directory`);
  }
}

/** Clear the brief — best-effort; an absent file is already the cleared state. */
export function clearSliceBrief(repoDir: string): void {
  const file = loopAreaFile(repoDir, SLICE_BRIEF_FILE);
  if (file === null) return;
  rmSync(file, { force: true });
}

/** The persisted brief, or null when unset or malformed (CWE-20): the slice must be a positive integer and the
 *  source step and text non-blank. */
export function readSliceBrief(repoDir: string): SliceBrief | null {
  const file = loopAreaFile(repoDir, SLICE_BRIEF_FILE);
  if (file === null) return null;
  const read = readBoundedNoFollow(file, MAX_LOOP_AREA_FILE_BYTES);
  if (!read.ok) return null;
  let doc: unknown;
  try {
    doc = yaml.load(read.text);
  } catch {
    return null;
  }
  if (!isRecord(doc) || String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return null;
  const { slice, from_step: fromStep } = doc;
  const text = validInstruction(typeof doc.brief === 'string' ? doc.brief.trim() : undefined);
  if (typeof slice !== 'number' || !Number.isInteger(slice) || slice < 1) return null;
  if (typeof fromStep !== 'string' || fromStep.length === 0 || text === undefined) return null;
  return { slice, fromStep, text };
}

// §28.4/§28.5.1 — the phase-commit baseline (the SHA a commit side-effect captured on approve) in its OWN file,
// `baseline-commit.yaml`, disjoint from run-state.yaml. Phase-as-a-loop (§28.4) rewrites run-state wholesale
// between RED/GREEN/refactor, so a baseline stored in run-state would be clobbered before the next phase's
// frozen check reads it; a disjoint file is structurally unclobberable (the polish/armed-interrupt pattern).
// Confined via resolveJail (the loop area sits in the untrusted repo tree, CWE-22/59); field-local validation
// (CWE-20): a non-object-id sha or blank branch is never persisted/read as a baseline.
const BASELINE_COMMIT_FILE = 'baseline-commit.yaml';

/** §28.5.1 */
export interface PhaseBaseline {
  branch: string;
  sha: string;
}

/** Record `sha` (the phase commit) under `branch` — read by the next phase's frozen check (§28.5.1). A blank
 *  branch, the detached-HEAD sentinel `HEAD`, or a non-object-id sha is inert (never a phantom or garbage
 *  baseline, CWE-20). Throws when the loop area is unresolvable (a planted symlink, CWE-59), matching the
 *  run-state writer's fail-loud contract; the caller (§28 approve side-effect) MUST wrap it best-effort so a
 *  filesystem error never aborts the accept. */
export function recordBaselineCommit(repoDir: string, branch: string, sha: string): PhaseBaseline | null {
  // §28.5.1 — `HEAD` is what `rev-parse --abbrev-ref HEAD` yields on a detached commit; refuse it like a blank
  // branch so the write mirrors currentGitBranch's HEAD→null read (one detached-sentinel rule, not two copies).
  if (branch.length === 0 || branch === 'HEAD' || !isGitObjectId(sha)) return null;
  const file = loopAreaFile(repoDir, BASELINE_COMMIT_FILE);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  if (!atomicWriteFileSync(file, yaml.dump({ schema_version: APP_LOOP_STATE_SCHEMA, branch, sha }))) {
    throw new Error(`cannot write §27 baseline commit: ${path.dirname(file)} is not a real directory`);
  }
  return { branch, sha };
}

/** §28.4 D2/#123 — clear the recorded baseline at a slice boundary (a RED phase re-entry). A stale same-branch
 *  baseline from a prior phase/slice would otherwise be MATCHED by the next GREEN/refactor frozen check rather
 *  than refused; with no baseline that check blocks (fail toward firing) until this slice's RED records its own.
 *  Silent no-op when absent (mirrors clearAppLoopBootstrap); throws only when the loop area is unresolvable
 *  (a planted symlink, CWE-59), matching the writer's fail-loud contract — the caller wraps it best-effort. */
export function clearBaselineCommit(repoDir: string): void {
  const file = loopAreaFile(repoDir, BASELINE_COMMIT_FILE);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  rmSync(file, { force: true });
}

/** The recorded phase-commit baseline, or null when unset. Field-local validation (CWE-20): a wrong schema, a
 *  blank/missing branch, or a non-object-id sha reads as unset rather than surfacing a corrupt baseline. One
 *  repo-keyed single-current baseline, overwritten each phase; the key is the git BRANCH the phase loops share
 *  — §28.4 makes RED/GREEN/refactor DISTINCT flow steps, so a step key would mismatch every cross-phase read;
 *  the branch is their one phase-stable slice identity. The frozen check refuses a DIFFERENT-branch baseline
 *  (another run); a stale SAME-branch baseline from a prior phase/slice is NOT yet refused — there is no clear()
 *  and the key is not per-slice — so it can be matched rather than blocking; tracked in #123. */
export function readBaselineCommit(repoDir: string): PhaseBaseline | null {
  const file = loopAreaFile(repoDir, BASELINE_COMMIT_FILE);
  if (file === null) return null;
  const read = readBoundedNoFollow(file, MAX_LOOP_AREA_FILE_BYTES);
  if (!read.ok) return null;
  let doc: unknown;
  try {
    doc = yaml.load(read.text);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  if (String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return null;
  if (typeof doc.branch !== 'string' || doc.branch.length === 0) return null;
  if (typeof doc.sha !== 'string' || !isGitObjectId(doc.sha)) return null;
  return { branch: doc.branch, sha: doc.sha };
}

/** §28.5.1 — the recorded baseline when it can prove "same slice" on `branch` (null for a detached HEAD), else null. */
export function baselineForBranch(
  baseline: PhaseBaseline | null,
  branch: string | null,
): PhaseBaseline | null {
  return baseline !== null && branch !== null && baseline.branch === branch ? baseline : null;
}

// §28.5.3/§28.8.3 — the changed-tests flag: the test-glob files the machine detected changed since the RED
// baseline, recorded at GREEN completion as a NON-blocking flag the regression-guard persona + human gate read.
// Its own file, disjoint from run-state.yaml (the §28.4 wholesale-rewrite hazard, same as the baseline store).
const CHANGED_TESTS_FILE = 'changed-tests.yaml';

/** Bounds on the persisted flag: the hosted agent shares the working tree and can PLANT this file, and its
 *  `paths` reach FlowLoopView → the renderer DOM, so a corrupt/oversized file must not become an unbounded
 *  render or memory cost (CWE-20/400). Both the writer and the reader enforce them (two non-redundant places). */
export const MAX_CHANGED_TEST_PATHS = 1000;
export const MAX_CHANGED_TEST_PATH_LEN = 4096;

/** The recorded changed-test flag: the flow `step` it was recorded under and the test-glob paths that changed.
 *  `paths` is `[]` on a clean GREEN (checked, none changed — distinct from an absent file, which reads null). */
export interface ChangedTestsRecord {
  step: string;
  paths: string[];
}

/** Per-entry sanitize shared by the writer and reader (whole-doc invalidity stays the reader's concern below).
 *  Two properties the code alone does not state: entries are kept VERBATIM (a git-exact path, never trimmed —
 *  the frozen check emits exact repo-relative paths), and the count cap makes `paths` NON-EXHAUSTIVE above the
 *  cap — a safety bound against a planted/pathological file (a real GREEN turn touches a handful of tests), not
 *  an expected operational case, so no `truncated` signal is carried; G5/G6 consumers treat an at-cap list as
 *  advisory. The cap is applied after dedupe+sort so the surviving set is deterministic across writer and reader. */
export function sanitizeChangedTestPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0 && p.length <= MAX_CHANGED_TEST_PATH_LEN,
  );
  return [...new Set(valid)].sort().slice(0, MAX_CHANGED_TEST_PATHS);
}

/** Record `paths` (the changed test-glob files) under `step` as the GREEN turn's changed-tests flag. A blank
 *  step is inert (CWE-20). Entries are sanitized (see above) before writing. Throws when the loop area is
 *  unresolvable (a planted symlink, CWE-59), matching the run-state/baseline writers' fail-loud contract; the
 *  caller (§28.5.3 GREEN completion) MUST wrap it best-effort so a filesystem error never aborts the turn. */
export function recordChangedTests(repoDir: string, step: string, paths: readonly string[]): void {
  if (step.length === 0) return;
  const file = loopAreaFile(repoDir, CHANGED_TESTS_FILE);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  const clean = sanitizeChangedTestPaths(paths);
  if (!atomicWriteFileSync(file, yaml.dump({ schema_version: APP_LOOP_STATE_SCHEMA, step, paths: clean }))) {
    throw new Error(`cannot write §28 changed-tests: ${path.dirname(file)} is not a real directory`);
  }
}

/** The recorded changed-tests flag, or null when unset. Whole-doc invalidity (not a record, wrong schema,
 *  blank step, or `paths` not an array) reads null; a valid doc's `paths` are per-entry sanitized (a planted
 *  garbage entry is dropped, never surfaced). Unlike the branch-keyed baseline, this flag is written AND read
 *  within ONE step (a GREEN/refactor turn records it; the view surfaces it for that same step), so it never
 *  crosses a phase boundary and stays step-keyed. */
export function readChangedTests(repoDir: string): ChangedTestsRecord | null {
  const file = loopAreaFile(repoDir, CHANGED_TESTS_FILE);
  if (file === null) return null;
  const read = readBoundedNoFollow(file, MAX_LOOP_AREA_FILE_BYTES);
  if (!read.ok) return null;
  let doc: unknown;
  try {
    doc = yaml.load(read.text);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  if (String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return null;
  if (typeof doc.step !== 'string' || doc.step.length === 0) return null;
  if (!Array.isArray(doc.paths)) return null;
  return { step: doc.step, paths: sanitizeChangedTestPaths(doc.paths) };
}

// §28.7 AC3 — the resumable promotion record, PER EPIC in its own file promotion-<epic>.yaml (a wholesale
// run-state rewrite cannot clobber it, and two epics sharing a loop area cannot clobber each other's resume
// record). No wall-clock, so an idempotent re-run's "unchanged" assertion is deterministic. This is untrusted
// persisted state and the SOLE guard against re-creating duplicate PUBLIC issues (CLAUDE.md line 76 /
// CWE-20/770), so it fails TOWARD the block: a present-but-malformed record — OR an unresolvable loop area (a
// planted symlink) — reads 'corrupt' (BLOCK), and only a benign absent file reads null (a fresh promotion).
function promotionFileName(epic: number): string {
  return `promotion-${epic}.yaml`;
}

export interface EpicPromotionState {
  /** Each created sub-ticket carries its `title` so the executor can reconcile a resumed record against the
   *  current plan and refuse a divergence (a stale/planted record could otherwise orphan or mis-stack issues). */
  epic: number;
  created: { index: number; issue: number; title: string }[];
  trackingAppended: boolean;
  prClosed: boolean;
}

export function writeEpicPromotion(repoDir: string, state: EpicPromotionState): void {
  const file = loopAreaFile(repoDir, promotionFileName(state.epic));
  if (file === null) throw new Error('§27 loop area is unresolvable');
  const doc = {
    schema_version: APP_LOOP_STATE_SCHEMA,
    epic: state.epic,
    created: state.created.map((c) => ({ index: c.index, issue: c.issue, title: c.title })),
    tracking_appended: state.trackingAppended,
    pr_closed: state.prClosed,
  };
  if (!atomicWriteFileSync(file, yaml.dump(doc))) {
    throw new Error(`cannot write §28 promotion record: ${path.dirname(file)} is not a real directory`);
  }
}

export function readEpicPromotion(repoDir: string, epic: number): EpicPromotionState | 'corrupt' | null {
  const file = loopAreaFile(repoDir, promotionFileName(epic));
  if (file === null) return 'corrupt'; // an unresolvable loop area fails toward the block, never a fresh re-create
  const read = readBoundedNoFollow(file, MAX_LOOP_AREA_FILE_BYTES);
  if (!read.ok) {
    switch (read.cause) {
      case 'absent':
        return null;
      case 'over-cap':
      case 'unreadable':
        return 'corrupt';
      default:
        return read.cause satisfies never;
    }
  }
  let doc: unknown;
  try {
    doc = yaml.load(read.text);
  } catch {
    return 'corrupt';
  }
  if (!isRecord(doc)) return 'corrupt';
  if (String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return 'corrupt';
  if (!isPositiveInt(doc.epic) || doc.epic !== epic) return 'corrupt';
  if (!Array.isArray(doc.created)) return 'corrupt';
  const created: { index: number; issue: number; title: string }[] = [];
  for (const c of doc.created) {
    if (!isRecord(c) || !isPositiveInt(c.index) || !isPositiveInt(c.issue) || typeof c.title !== 'string' || c.title.length === 0) return 'corrupt';
    created.push({ index: c.index, issue: c.issue, title: c.title });
  }
  return { epic: doc.epic, created, trackingAppended: doc.tracking_appended === true, prClosed: doc.pr_closed === true };
}
