// §28.5.1/§28.5.2a — git-only test-path detection for the §28 completion predicates, in two modes, each with NO
// knowledge of any test framework (the engine never runs the test command, §28.5.4; it only asks git):
//   • changedTestPaths — which test-glob files that existed at the baseline had a line CHANGED OR REMOVED, or
//     were deleted: between two COMMITS (baseline↔head) for the commit↔commit frozen check (§28.5.1), or (head
//     omitted) between the baseline and the WORKING TREE for the GREEN frozen check run at completion before the
//     phase commit lands (§28.5.3). A test file added, or lines only added to one, is not a frozen change.
//   • workingTreeTestPaths — which test-glob files this turn ADDED LINES to in the WORKING TREE vs HEAD: the RED
//     "a failing test was authored" check (§28.5.2a), run before the RED commit; a deletion or a line-removal
//     is deliberately NOT "added" (the intentional asymmetry with the frozen check above).
//
// Paths are string-matched against `testGlobs`, never opened or walked, so no path confinement applies to the
// diff output. Both fail TOWARD the check firing (CWE-20/770): a bad baseline, an empty glob list, a
// non-object-id baseline, or an unresolvable HEAD reject rather than reading as "nothing changed".

import { isGitObjectId } from '../shared/appBootstrap';
import { run, runBuffer } from './appBootstrapCommand';
import { decodeUtf8Strict } from './decodeUtf8Strict';
import { matchesAnyGlob } from '../shared/globMatch';
import {
  parseLoopCapabilities,
  LOOP_CAPABILITIES_FILENAME,
  MAX_CAPABILITIES_BYTES,
  type LoopCapabilities,
} from '../shared/loopCapabilities';
import { loadLoopCapabilities } from './loopCapabilities';
import { isUnderAppStateDir } from './appStateDirs';
import { baselineForBranch, readBaselineCommit } from './appLoopState';
import { LOCK_FREE_GIT_READ_ENV, readGitBranch } from './gitBranch';
import { errMsg } from './errno';

// The most (Σ glob chars)·(path chars) matching work one detection may perform across ALL changed paths. Real
// repos multiply to < 10⁷ (a handful of short globs × a normal diff); this cap (10⁸) only rejects a crafted
// capabilities-file-times-diff amplification (CWE-400).
const MAX_MATCH_WORK = 100_000_000;

/** Match `paths` against `testGlobs`, bounding aggregate glob-match work against MAX_MATCH_WORK (CWE-400) — the
 *  guard BOTH detections share, so the bound cannot be present in one and absent in its twin. globMatch bounds
 *  each individual pair; this bounds their sum. Returns the matched paths, order preserved. */
function matchTestGlobsWithinBudget(paths: readonly string[], testGlobs: readonly string[]): string[] {
  const globChars = testGlobs.reduce((sum, glob) => sum + glob.length, 0);
  let work = 0;
  const matched: string[] = [];
  for (const path of paths) {
    work += globChars * path.length;
    if (work > MAX_MATCH_WORK) throw new Error('test-path detection: aggregate glob-match work budget exceeded');
    if (matchesAnyGlob(path, testGlobs)) matched.push(path);
  }
  return matched;
}

/** The final filter shared by every frozen-tests query (commit↔commit, working-tree frozen, and added-lines) —
 *  so the app's own state dirs are excluded on ALL of them (never a legitimate test path even under a broad
 *  glob, independent of `.gitignore` — CWE-200/754); the differing diff plumbing that produces `paths` stays
 *  per-query. */
function matchedTestPaths(paths: readonly string[], testGlobs: readonly string[]): string[] {
  const matched = matchTestGlobsWithinBudget(paths, testGlobs).filter((path) => !isUnderAppStateDir(path));
  return [...new Set(matched)].sort();
}

export interface FrozenTestsQuery {
  /** The checked-out repo working tree; git runs here as cwd. */
  repoDir: string;
  /** The baseline commit (the RED loop's recorded SHA, §28.5.1) — validated as a git object id. */
  baseline: string;
  /** The head to diff against (usually the ref `HEAD`) — the commit↔commit frozen check (§28.5.1). OMITTED
   *  (§28.5.3) diffs the baseline against the WORKING TREE: the GREEN frozen check runs at completion, before
   *  the phase commit lands, so the GREEN edits live in the working tree, not in any commit. */
  head?: string;
  /** The repository's test path globs (from loop-capabilities.yaml, §28.5.4). */
  testGlobs: readonly string[];
  signal?: AbortSignal;
}

/** Decode git's `-z` NUL-separated pathname BYTES into exact paths, or throw. Git pathnames are byte strings
 *  not guaranteed to be UTF-8 (POSIX), so a fatal decoder rejects non-UTF-8 output (fail toward firing) rather
 *  than let a lossy decode normalize a changed test path into a different one. The trailing empty entry from
 *  the final NUL is dropped. Exported for direct testing: a non-UTF-8 filename cannot be created on macOS. */
export function strictDecodeNulPaths(stdout: Buffer): string[] {
  let text: string;
  try {
    text = decodeUtf8Strict(stdout);
  } catch {
    throw new Error('frozen-tests: git emitted non-UTF-8 path bytes');
  }
  return text.split('\0').filter((path) => path.length > 0);
}

/** A ref that is safe to hand git as a revision: non-empty and free of control characters that would corrupt
 *  argv or the NUL-framed output. A leading `-` is separately neutralized by `--end-of-options`. */
function isSafeRef(ref: string): boolean {
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return ref.length > 0;
}

/** One `git diff --numstat -z --no-renames` record per path. A binary file's counts are `-`, read as NaN. */
function parseNumstat(stdout: Buffer, what: string): { added: number; deleted: number; path: string }[] {
  let text: string;
  try {
    text = decodeUtf8Strict(stdout);
  } catch {
    throw new Error(`${what}: git emitted non-UTF-8 path bytes`);
  }
  // The path is everything after the second tab (a tab CAN appear in a filename).
  return text
    .split('\0')
    .filter((rec) => rec.length > 0)
    .flatMap((rec) => {
      const firstTab = rec.indexOf('\t');
      const secondTab = rec.indexOf('\t', firstTab + 1);
      if (firstTab < 0 || secondTab < 0) return [];
      return [{ added: Number(rec.slice(0, firstTab)), deleted: Number(rec.slice(firstTab + 1, secondTab)), path: rec.slice(secondTab + 1) }];
    });
}

/** The frozen test-glob paths between `baseline` and (with `head`) another commit, or (head omitted) the
 *  WORKING TREE — sorted, deduped, never a non-test path: each file that existed at the baseline and lost or
 *  changed a line (a binary change counts), or was deleted or changed type. A new test file, or a test file
 *  that only gained lines, is not reported (§28.5.1). Empty when nothing matching changed. Rejects on a git
 *  failure or an invalid baseline/head (fail toward firing, never reads as "∅"). */
export async function changedTestPaths(query: FrozenTestsQuery): Promise<string[]> {
  const { repoDir, baseline, head, testGlobs, signal } = query;
  const options = { env: LOCK_FREE_GIT_READ_ENV, signal };
  if (testGlobs.length === 0) throw new Error('frozen-tests: testGlobs is empty');
  if (!isGitObjectId(baseline)) throw new Error('frozen-tests: baseline is not a git object id');

  // Shared diff flags: NUL-delimited raw pathname BYTES (git does not C-quote, decoded strictly), renames
  // decomposed to delete+add (§28.5.1), a changed gitlink shown regardless of a repo-local diff.ignoreSubmodules,
  // and the revision(s) neutralized against option-injection, with no textconv or external diff driver.
  // `--numstat` finds lost or changed lines; `--diff-filter=DT` finds a deleted or retyped file, which has no
  // line to lose when it was empty.
  const shared = ['-z', '--no-renames', '--ignore-submodules=none', '--no-textconv', '--no-ext-diff'];
  let revisions: string[];
  if (head === undefined) {
    revisions = [`${baseline}^{commit}`];
  } else {
    if (!isSafeRef(head)) throw new Error('frozen-tests: head is not a usable ref');
    revisions = [
      `${baseline}^{commit}`, // peel to a commit: git accepts a bare tree/blob object id as a diff operand, so a
      `${head}^{commit}`, //     non-commit operand would diff instead of failing toward the check firing
    ];
  }
  // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
  const numstatOut = await runBuffer(
    'git',
    ['diff', '--numstat', ...shared, '--end-of-options', ...revisions],
    repoDir,
    'frozen-tests diff failed',
    options,
  );
  // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
  const removedOut = await runBuffer(
    'git',
    ['diff', '--name-only', '--diff-filter=DT', ...shared, '--end-of-options', ...revisions],
    repoDir,
    'frozen-tests diff failed',
    options,
  );
  const lostLines = parseNumstat(numstatOut, 'frozen-tests')
    .filter((rec) => rec.deleted !== 0)
    .map((rec) => rec.path);
  return matchedTestPaths([...lostLines, ...strictDecodeNulPaths(removedOut)], testGlobs);
}

/** The changed test paths, sourcing the globs from the RED baseline's loop-capabilities.yaml (a git blob, so
 *  no path is walked and there is no `confinement` cause). Its failure arm is absent (no config → degrade) or
 *  malformed (human-owned); a git or baseline failure rejects (fail toward firing). The seam S3/S4 gate on. */
export type ChangedTestPathsResult =
  | { ok: true; paths: string[] }
  | { ok: false; cause: 'absent' | 'malformed'; reason: string };

/** The baseline-sourced capabilities: a git blob read, so it never has the working-tree loader's `confinement`
 *  cause. Absent (no config in the baseline) degrades; malformed is human-owned; a bad baseline rejects. */
type BaselineCapabilitiesResult =
  | { ok: true; value: LoopCapabilities }
  | { ok: false; cause: 'absent' | 'malformed'; reason: string };

/** The test_globs as they stood in the RED baseline's COMMITTED loop-capabilities.yaml — a fixed git object
 *  the checked agent cannot narrow after the baseline is recorded, unlike the working tree it controls. Read
 *  as a raw blob (cat-file, no textconv). */
async function baselineCapabilities(repoDir: string, baseline: string): Promise<BaselineCapabilitiesResult> {
  // A bad baseline is corrupted loop state (fail toward firing), NOT a degradable capabilities "malformed" —
  // reject exactly as changedTestPaths does for the same input, so callers never confuse the two.
  if (!isGitObjectId(baseline)) throw new Error('frozen-tests: baseline is not a git object id');
  // A bad baseline is fail-toward-firing: rev-parse REJECTS (throws), never degrades to "absent".
  // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
  await run(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${baseline}^{commit}`],
    repoDir,
    'frozen-tests: baseline commit does not resolve',
  );
  // Determine ABSENCE by listing the tree: an empty listing means the config is genuinely not in a readable
  // baseline (degrade). An ls-tree failure — the tree/blob unreadable, e.g. a partial clone missing the object —
  // is NOT absence; it propagates and rejects (fail toward firing), as does a read of a path that
  // ls-tree just proved is present.
  // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
  const listed = await run(
    'git',
    ['ls-tree', '--end-of-options', baseline, LOOP_CAPABILITIES_FILENAME],
    repoDir,
    'frozen-tests: baseline tree read failed',
  );
  if (listed.trim().length === 0) {
    return { ok: false, cause: 'absent', reason: 'no loop-capabilities.yaml in the baseline commit' };
  }
  // ls-tree line is "<mode> <type> <object>\t<path>". Require a regular-file blob (100644/100755); a symlink
  // (120000), directory (040000 tree), or gitlink (160000 commit) is refused as malformed — consistent with
  // the working-tree loader's O_NOFOLLOW / isFile check, rather than reading link-target bytes or a git error.
  const mode = listed.trim().split(' ', 1)[0];
  if (mode !== '100644' && mode !== '100755') {
    return { ok: false, cause: 'malformed', reason: 'loop-capabilities.yaml is not a regular file' };
  }
  // Size FIRST (cat-file -s): an over-cap blob classifies as malformed "too large" identically to the
  // working-tree loader (MAX_CAPABILITIES_BYTES shared), and never exceeds the subprocess stdout buffer below.
  // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
  const sizeOut = await run(
    'git',
    ['cat-file', '-s', `${baseline}:${LOOP_CAPABILITIES_FILENAME}`],
    repoDir,
    'frozen-tests: baseline capabilities size read failed',
  );
  const size = Number(sizeOut.trim());
  if (!Number.isInteger(size) || size > MAX_CAPABILITIES_BYTES) {
    return { ok: false, cause: 'malformed', reason: 'loop-capabilities.yaml is too large' };
  }
  // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
  const blob = await runBuffer(
    'git',
    ['cat-file', 'blob', `${baseline}:${LOOP_CAPABILITIES_FILENAME}`],
    repoDir,
    'frozen-tests: baseline capabilities read failed',
  );
  let text: string;
  try {
    text = decodeUtf8Strict(blob); // invalid UTF-8 is malformed, never normalized to a fail-away value
  } catch {
    return { ok: false, cause: 'malformed', reason: 'loop-capabilities.yaml is not valid UTF-8' };
  }
  const parsed = parseLoopCapabilities(text);
  return parsed.ok ? parsed : { ok: false, cause: 'malformed', reason: parsed.reason };
}

export async function changedTestPathsFromCapabilities(query: {
  repoDir: string;
  baseline: string;
  /** Omitted (§28.5.3) → baseline ↔ working tree (the GREEN frozen check); given → commit↔commit (§28.5.1). The
   *  globs are sourced from the baseline BLOB either way, so the checked agent cannot narrow them by editing the
   *  working-tree loop-capabilities.yaml before the GREEN frozen check runs. */
  head?: string;
}): Promise<ChangedTestPathsResult> {
  const capabilities = await baselineCapabilities(query.repoDir, query.baseline);
  if (!capabilities.ok) return capabilities;
  const paths = await changedTestPaths({ ...query, testGlobs: capabilities.value.testGlobs });
  return { ok: true, paths };
}

export type ApproveTimeFrozenCheck = { ok: true; branch: string; paths: string[] } | { ok: false; detail: string };

/** §27.9.1 N9b.7 — the engine's own frozen check at an `auto` approve: the working tree's globs, the working tree
 *  against the recorded phase baseline. Every way it cannot run is a detail, never "unchanged". */
export async function approveTimeFrozenCheck(repoDir: string, signal: AbortSignal): Promise<ApproveTimeFrozenCheck> {
  const capabilities = loadLoopCapabilities(repoDir);
  if (!capabilities.ok) return { ok: false, detail: `${LOOP_CAPABILITIES_FILENAME} could not be read: ${capabilities.reason}` };
  const branch = await readGitBranch(repoDir, signal);
  if (!branch.ok) return { ok: false, detail: `the current branch could not be read: ${branch.detail}` };
  const baseline = baselineForBranch(readBaselineCommit(repoDir), branch.branch);
  if (baseline === null) return { ok: false, detail: 'no phase baseline is recorded for this branch (baseline-commit.yaml is absent, unreadable, from another branch, or HEAD is detached)' };
  try {
    return { ok: true, branch: baseline.branch, paths: await changedTestPaths({ repoDir, baseline: baseline.sha, testGlobs: capabilities.value.testGlobs, signal }) };
  } catch (e) {
    return { ok: false, detail: `the git read against the baseline failed: ${errMsg(e)}` };
  }
}

/** The working-tree detection's result. Unlike the commit↔commit `ChangedTestPathsResult` (baseline-blob
 *  sourced, so `confinement` is unreachable there and stays out of its type — #105 round 20), the working-tree
 *  wrapper reads the repo's OWN loop-capabilities.yaml through the working-tree loader, which CAN refuse on
 *  confinement — so this arm carries the third `cause`. */
export type WorkingTreeTestPathsResult =
  | { ok: true; paths: string[] }
  | { ok: false; cause: 'absent' | 'malformed' | 'confinement'; reason: string };

/** The test-glob paths this turn ADDED LINES to in the working tree vs HEAD — the RED "a failing test was
 *  authored" check (§28.5.2a), run BEFORE the RED commit (the commit is the approve side-effect). Two
 *  reads, unioned: a `--numstat` diff of tracked files (kept only where added-lines > 0) plus every untracked
 *  file. Neither mutates the index — the check must never stage into the working tree the live agent shares.
 *  Fails TOWARD the check firing (CWE-20/770): an empty glob list or an unresolvable HEAD reject.
 *
 *  Why added-lines > 0, not merely "changed": §28.5.2a's clause is "must ADD lines in test_globs files". A
 *  turn that only DELETES a test, or only removes lines from one (e.g. strips assertions), authored no failing
 *  test — counting it would be the dangerous false-pass the gate exists to prevent. This is why the tracked arm
 *  is `--numstat` here, not the `--name-only` the commit↔commit `changedTestPaths` correctly uses (where a
 *  deletion IS a real change to a frozen test). */
export async function workingTreeTestPaths(query: {
  repoDir: string;
  testGlobs: readonly string[];
}): Promise<string[]> {
  const { repoDir, testGlobs } = query;
  if (testGlobs.length === 0) throw new Error('working-tree tests: testGlobs is empty');

  // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
  const trackedOut = await runBuffer(
    'git',
    ['diff', '--numstat', '-z', '--no-renames', '--ignore-submodules=none', '--end-of-options', 'HEAD'],
    repoDir,
    'working-tree tests: git diff failed',
  );
  // eslint-disable-next-line local/git-hardening -- predates the rule; existing callers stay as they are (CODE-STANDARDS.md)
  const untrackedOut = await runBuffer(
    'git',
    ['ls-files', '-o', '--exclude-standard', '-z'],
    repoDir,
    'working-tree tests: git ls-files failed',
  );

  const tracked = parseNumstat(trackedOut, 'working-tree tests')
    .filter((rec) => Number.isInteger(rec.added) && rec.added > 0)
    .map((rec) => rec.path);
  const untracked = strictDecodeNulPaths(untrackedOut);

  return matchedTestPaths([...tracked, ...untracked], testGlobs);
}

/** The working-tree test paths, sourcing the globs from the repo's own loop-capabilities.yaml — its failure arm
 *  is the capabilities-load failure so the RED gate can surface a distinct reason; a git/HEAD failure still
 *  rejects (fail toward firing). This is the seam the S3 RED completion gate consults. */
export async function workingTreeTestPathsFromCapabilities(query: {
  repoDir: string;
}): Promise<WorkingTreeTestPathsResult> {
  const capabilities = loadLoopCapabilities(query.repoDir);
  if (!capabilities.ok) return capabilities;
  const paths = await workingTreeTestPaths({ repoDir: query.repoDir, testGlobs: capabilities.value.testGlobs });
  return { ok: true, paths };
}
