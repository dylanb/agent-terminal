// §28.5.1 — the frozen-tests detection: which test-glob files changed between a baseline commit and a head,
// computed from git alone with NO knowledge of any test framework. Pure ground truth for the §28 completion
// predicates (S3/S4): the engine never runs the test command (§28.5.4); it only asks git what changed.
//
// The paths are string-matched against `testGlobs`, never opened or walked, so no path confinement applies to
// the diff output. It fails TOWARD the check firing (CWE-20/770): a bad baseline, an empty glob list, or a
// non-object-id baseline all reject rather than reading as "nothing changed".

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitObjectId } from '../shared/appBootstrap';
import { run } from './appBootstrapCommand';
import { coreExecHardeningArgs } from './gitHardening';
import { matchesAnyGlob } from './globMatch';
import { loadLoopCapabilities } from './loopCapabilities';

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
  const stdout = await run(
    'git',
    [
      '--no-replace-objects', // ignore any repo-planted refs/replace/* so the recorded baseline is used verbatim (tamper-evidence)
      ...coreExecHardeningArgs(disabledHooks),
      'diff',
      '--name-only', // names only — never generates a patch, so no textconv/external-diff runs
      '-z', // NUL-delimited, raw UTF-8: git otherwise C-quotes non-ASCII names and they never match a glob
      '--no-renames', // decompose renames to delete+add (config-independent) so a test moved out still shows
      '--ignore-submodules=none', // a changed test tree tracked as a gitlink must show regardless of a repo-local diff.ignoreSubmodules
      '--end-of-options', // the two revisions cannot be read as options (CWE-88)
      baseline,
      head,
    ],
    repoDir,
    'frozen-tests diff failed',
  );

  const changed = stdout.split('\0').filter((path) => path.length > 0);
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

/** The changed test paths, sourcing the globs from the repo's own loop-capabilities.yaml. Its failure arm is
 *  the capabilities-load failure (absent/malformed/confinement) so a consumer can degrade or refuse; a git or
 *  baseline failure still rejects (fail toward firing). This is the seam S3/S4 gate a turn on. */
export type ChangedTestPathsResult =
  | { ok: true; paths: string[] }
  | { ok: false; cause: 'absent' | 'malformed' | 'confinement'; reason: string };

export async function changedTestPathsFromCapabilities(query: {
  repoDir: string;
  baseline: string;
  head: string;
}): Promise<ChangedTestPathsResult> {
  const capabilities = loadLoopCapabilities(query.repoDir);
  if (!capabilities.ok) return capabilities;
  const paths = await changedTestPaths({ ...query, testGlobs: capabilities.value.testGlobs });
  return { ok: true, paths };
}
