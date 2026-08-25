// §28.5.1 — the frozen-tests detection. Cross-cutting: the diff paths are string-matched, never opened or
// walked, so the repo-path confinement rule does NOT apply to this module.

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitObjectId } from '../shared/appBootstrap';
import { run, runBuffer } from './appBootstrapCommand';
import { coreExecHardeningArgs } from './gitHardening';
import { matchesAnyGlob } from './globMatch';
import { parseLoopCapabilities, LOOP_CAPABILITIES_FILENAME, MAX_CAPABILITIES_BYTES } from '../shared/loopCapabilities';
import { type LoopCapabilitiesLoad } from './loopCapabilities';

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
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
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

/** The changed test paths, sourcing the globs from the repo's own loop-capabilities.yaml. Its failure arm is
 *  the capabilities-load failure (absent/malformed/confinement) so a consumer can degrade or refuse; a git or
 *  baseline failure still rejects (fail toward firing). This is the seam S3/S4 gate a turn on. */
export type ChangedTestPathsResult =
  | { ok: true; paths: string[] }
  | { ok: false; cause: 'absent' | 'malformed' | 'confinement'; reason: string };

/** The test_globs as they stood in the RED baseline's COMMITTED loop-capabilities.yaml — a fixed git object
 *  the checked agent cannot narrow after the baseline is recorded, unlike the working tree it controls. Read
 *  as a raw blob (cat-file, no textconv), with the same no-replace / no-lazy-fetch hardening as the diff. */
async function baselineCapabilities(repoDir: string, baseline: string): Promise<LoopCapabilitiesLoad> {
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
  const text = await run(
    'git',
    [...harden, 'cat-file', 'blob', `${baseline}:${LOOP_CAPABILITIES_FILENAME}`],
    repoDir,
    'frozen-tests: baseline capabilities read failed',
    env,
  );
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
