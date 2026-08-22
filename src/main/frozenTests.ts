// §28.5.1/§28.5.2a — git-only test-path detection for the §28 completion predicates, in two modes, each with NO
// knowledge of any test framework (the engine never runs the test command, §28.5.4; it only asks git):
//   • changedTestPaths — which test-glob files CHANGED between two COMMITS (baseline↔head): the frozen-tests
//     check (§28.5.1). "Changed" is the right predicate there — a deleted frozen test is a real change.
//   • workingTreeTestPaths — which test-glob files this turn ADDED LINES to in the WORKING TREE vs HEAD: the RED
//     "a failing test was authored" check (§28.5.2a), run before the RED commit; a deletion or a line-removal
//     is deliberately NOT "added" (the intentional asymmetry with the frozen check above).
//
// Paths are string-matched against `testGlobs`, never opened or walked, so no path confinement applies to the
// diff output. Both fail TOWARD the check firing (CWE-20/770): a bad baseline, an empty glob list, a
// non-object-id baseline, or an unresolvable HEAD reject rather than reading as "nothing changed".

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitObjectId } from '../shared/appBootstrap';
import { run, runBuffer } from './appBootstrapCommand';
import { decodeUtf8Strict } from './decodeUtf8Strict';
import { coreExecHardeningArgs } from './gitHardening';
import { matchesAnyGlob } from '../shared/globMatch';
import {
  parseLoopCapabilities,
  LOOP_CAPABILITIES_FILENAME,
  MAX_CAPABILITIES_BYTES,
  type LoopCapabilities,
} from '../shared/loopCapabilities';
import { loadLoopCapabilities } from './loopCapabilities';
import { isUnderAppStateDir } from './appStateDirs';

// The most (Σ glob chars)·(path chars) matching work one detection may perform across ALL changed paths. Real
// repos multiply to < 10⁷ (a handful of short globs × a normal diff); this cap (10⁸) only rejects a crafted
// capabilities-file-times-diff amplification (CWE-400).
const MAX_MATCH_WORK = 100_000_000;

export interface FrozenTestsQuery {
  /** The checked-out repo working tree; git runs here as cwd. */
  repoDir: string;
  /** The baseline commit (the RED loop's recorded SHA, §28.5.1) — validated as a git object id. */
  baseline: string;
  /** The head to diff against, usually the ref `HEAD`. */
  head: string;
  /** The repository's test path globs (from loop-capabilities.yaml, §28.5.4). */
  testGlobs: readonly string[];
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

/** The changed paths between `baseline` and `head` that match `testGlobs`, sorted and deduped. Empty when no
 *  matching path changed; never a non-test path. Rejects on a git failure or an invalid baseline/head. */
export async function changedTestPaths(query: FrozenTestsQuery): Promise<string[]> {
  const { repoDir, baseline, head, testGlobs } = query;
  if (testGlobs.length === 0) throw new Error('frozen-tests: testGlobs is empty');
  if (!isGitObjectId(baseline)) throw new Error('frozen-tests: baseline is not a git object id');
  if (!isSafeRef(head)) throw new Error('frozen-tests: head is not a usable ref');

  // A fresh, unpredictable, never-created hooks dir: with core.hooksPath pointed here no hook can run.
  const disabledHooks = join(tmpdir(), `agent-terminal-frozen-hooks-${randomUUID()}`);
  const stdout = await runBuffer(
    'git',
    [
      '--no-replace-objects', // ignore any repo-planted refs/replace/* so the recorded baseline is used verbatim (tamper-evidence)
      '-c',
      'protocol.allow=never', // on a partial clone a diff can lazy-fetch missing objects; deny every transport so an agent-configured promisor cannot run a command (backstop for GIT_NO_LAZY_FETCH below)
      ...coreExecHardeningArgs(disabledHooks),
      'diff',
      '--name-only', // names only — never generates a patch, so no textconv/external-diff runs
      '-z', // NUL-delimited raw pathname BYTES (git does not C-quote), decoded strictly below
      '--no-renames', // decompose renames to delete+add (config-independent) so a test moved out still shows
      '--ignore-submodules=none', // a changed test tree tracked as a gitlink must show regardless of a repo-local diff.ignoreSubmodules
      '--end-of-options', // the two revisions cannot be read as options (CWE-88)
      `${baseline}^{commit}`, // peel to a commit: git accepts a bare tree/blob object id as a diff operand, so a
      `${head}^{commit}`, //     non-commit operand would diff instead of failing toward the check firing
    ],
    repoDir,
    'frozen-tests diff failed',
    { GIT_NO_LAZY_FETCH: '1' }, // fail CLOSED on a missing object: never lazy-fetch from the (untrusted) promisor remote
  );

  const changed = strictDecodeNulPaths(stdout);
  // Aggregate work guard (CWE-400): a bloated capabilities file (many long globs) times many changed paths can
  // amplify matching far past any single pair. Charge (Σ glob chars)·(path chars) per path and reject once the
  // running total passes the budget — fail toward firing, never a silent hang in the main process. globMatch
  // bounds each individual pair; this bounds their sum.
  const globChars = testGlobs.reduce((sum, glob) => sum + glob.length, 0);
  let work = 0;
  const matched: string[] = [];
  for (const path of changed) {
    work += globChars * path.length;
    if (work > MAX_MATCH_WORK) throw new Error('frozen-tests: aggregate glob-match work budget exceeded');
    if (matchesAnyGlob(path, testGlobs)) matched.push(path);
  }
  return [...new Set(matched)].sort();
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
 *  as a raw blob (cat-file, no textconv), with the same no-replace / no-lazy-fetch hardening as the diff. */
async function baselineCapabilities(repoDir: string, baseline: string): Promise<BaselineCapabilitiesResult> {
  // A bad baseline is corrupted loop state (fail toward firing), NOT a degradable capabilities "malformed" —
  // reject exactly as changedTestPaths does for the same input, so callers never confuse the two.
  if (!isGitObjectId(baseline)) throw new Error('frozen-tests: baseline is not a git object id');
  const disabledHooks = join(tmpdir(), `agent-terminal-frozen-hooks-${randomUUID()}`);
  const harden = ['--no-replace-objects', '-c', 'protocol.allow=never', ...coreExecHardeningArgs(disabledHooks)];
  const env = { GIT_NO_LAZY_FETCH: '1' };
  // A bad baseline is fail-toward-firing: rev-parse REJECTS (throws), never degrades to "absent".
  await run(
    'git',
    [...harden, 'rev-parse', '--verify', '--end-of-options', `${baseline}^{commit}`],
    repoDir,
    'frozen-tests: baseline commit does not resolve',
    env,
  );
  // Determine ABSENCE by listing the tree: an empty listing means the config is genuinely not in a readable
  // baseline (degrade). An ls-tree failure — the tree/blob unreadable, e.g. a partial clone with lazy fetch
  // disabled — is NOT absence; it propagates and rejects (fail toward firing), as does a read of a path that
  // ls-tree just proved is present.
  const listed = await run(
    'git',
    [...harden, 'ls-tree', '--end-of-options', baseline, LOOP_CAPABILITIES_FILENAME],
    repoDir,
    'frozen-tests: baseline tree read failed',
    env,
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
  const sizeOut = await run(
    'git',
    [...harden, 'cat-file', '-s', `${baseline}:${LOOP_CAPABILITIES_FILENAME}`],
    repoDir,
    'frozen-tests: baseline capabilities size read failed',
    env,
  );
  const size = Number(sizeOut.trim());
  if (!Number.isInteger(size) || size > MAX_CAPABILITIES_BYTES) {
    return { ok: false, cause: 'malformed', reason: 'loop-capabilities.yaml is too large' };
  }
  const blob = await runBuffer(
    'git',
    [...harden, 'cat-file', 'blob', `${baseline}:${LOOP_CAPABILITIES_FILENAME}`],
    repoDir,
    'frozen-tests: baseline capabilities read failed',
    env,
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
  head: string;
}): Promise<ChangedTestPathsResult> {
  const capabilities = await baselineCapabilities(query.repoDir, query.baseline);
  if (!capabilities.ok) return capabilities;
  const paths = await changedTestPaths({ ...query, testGlobs: capabilities.value.testGlobs });
  return { ok: true, paths };
}

/** The working-tree detection's result. Unlike the commit↔commit `ChangedTestPathsResult` (baseline-blob
 *  sourced, so `confinement` is unreachable there and stays out of its type — #105 round 20), the working-tree
 *  wrapper reads the repo's OWN loop-capabilities.yaml through the working-tree loader, which CAN refuse on
 *  confinement — so this arm carries the third `cause`. */
export type WorkingTreeTestPathsResult =
  | { ok: true; paths: string[] }
  | { ok: false; cause: 'absent' | 'malformed' | 'confinement'; reason: string };

/** The test-glob paths this turn ADDED LINES to in the working tree vs HEAD — the RED "a failing test was
 *  authored" check (§28.5.2a), run BEFORE the RED commit (the commit is the approve side-effect). Two hardened
 *  reads, unioned: a `--numstat` diff of tracked files (kept only where added-lines > 0) plus every untracked
 *  file. Neither mutates the index — the check must never stage into the working tree the live agent shares.
 *  Fails TOWARD the check firing (CWE-20/770): an empty glob list or an unresolvable HEAD reject.
 *
 *  Why added-lines > 0, not merely "changed": §28.5.2a's clause is "must ADD lines in test_globs files". A
 *  turn that only DELETES a test, or only removes lines from one (e.g. strips assertions), authored no failing
 *  test — counting it would be the dangerous false-pass the gate exists to prevent. This is why the tracked arm
 *  is `--numstat` here, not the `--name-only` the commit↔commit `changedTestPaths` correctly uses (where a
 *  deletion IS a real change to a frozen test).
 *
 *  SECURITY — the tracked `git diff` arm compares the working tree to HEAD, so git re-hashes a changed file and
 *  can run a repo-planted `filter.<driver>.clean` (in-tree `.gitattributes` + config), on EVERY RED completion
 *  attempt including retries (not once, as on the S2 approve commit). It is the SAME lever the S2 commit
 *  side-effect documents-and-accepts (the agent already runs the repo's own code in-turn), so no NEW trust
 *  boundary — but the higher firing frequency is the novel delta. The `ls-files -o` arm lists names only (no
 *  hashing), so it is filter-free.
 *  TODO(dylanb): a plumbing `hash-object --no-filters` staging is the deferred full neutralization (§28.3). */
export async function workingTreeTestPaths(query: {
  repoDir: string;
  testGlobs: readonly string[];
}): Promise<string[]> {
  const { repoDir, testGlobs } = query;
  if (testGlobs.length === 0) throw new Error('working-tree tests: testGlobs is empty');

  const disabledHooks = join(tmpdir(), `agent-terminal-frozen-hooks-${randomUUID()}`);
  const harden = coreExecHardeningArgs(disabledHooks);
  const trackedOut = await runBuffer(
    'git',
    [...harden, 'diff', '--numstat', '-z', '--no-renames', '--end-of-options', 'HEAD'],
    repoDir,
    'working-tree tests: git diff failed',
  );
  const untrackedOut = await runBuffer(
    'git',
    [...harden, 'ls-files', '-o', '--exclude-standard', '-z'],
    repoDir,
    'working-tree tests: git ls-files failed',
  );

  // `--numstat -z` records are `<added>\t<deleted>\t<path>` per NUL-terminated entry (no renames → no split
  // record). The bytes are decoded strictly (a non-UTF-8 path rejects, never a lossy normalization — the same
  // posture as strictDecodeNulPaths). Keep a tracked path only when its added-line count is a positive integer;
  // a binary file's `-` count is NaN → excluded. The path is everything after the second tab (a tab CAN appear
  // in a filename).
  let trackedText: string;
  try {
    trackedText = decodeUtf8Strict(trackedOut);
  } catch {
    throw new Error('working-tree tests: git emitted non-UTF-8 path bytes');
  }
  const tracked = trackedText
    .split('\0')
    .filter((rec) => rec.length > 0)
    .map((rec) => {
      const firstTab = rec.indexOf('\t');
      const secondTab = rec.indexOf('\t', firstTab + 1);
      if (firstTab < 0 || secondTab < 0) return null;
      const added = Number(rec.slice(0, firstTab));
      return Number.isInteger(added) && added > 0 ? rec.slice(secondTab + 1) : null;
    })
    .filter((path): path is string => path !== null);
  const untracked = strictDecodeNulPaths(untrackedOut);

  const matched = [...tracked, ...untracked].filter(
    (path) => matchesAnyGlob(path, testGlobs) && !isUnderAppStateDir(path),
  );
  return [...new Set(matched)].sort();
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
