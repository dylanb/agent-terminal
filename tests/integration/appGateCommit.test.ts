import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import {
  createAppGateCommit,
  createRealAppGateCommit,
  type AppGateCommitOperations,
  type AppGateCommitStep,
} from '../../src/main/appGateCommit';
import { APP_STATE_DIRS } from '../../src/main/appStateDirs';
import { isGitObjectId } from '../../src/shared/appBootstrap';

// §28.3/§28.5.1 — the commit gate side-effect, widened to capture the phase-commit SHA (the baseline the next
// phase's frozen-tests diffs from) AND to stage ONLY the phase's own paths (the injected phase-start snapshot,
// §28.5.1). L1 drives the real adapter against real temp git repos (no git mock — CLAUDE.md); L2 drives the
// ports-injected composition with a fake seam, where the §28.5.1 TOCTOU guard and the object-id validation are
// exercised (a real single-threaded git can't reproduce a raced commit). Assertions are all observable: HEAD
// delta, the captured SHA vs rev-parse, commit subject bytes, the commit's file list, porcelain emptiness,
// .gitignore bytes, a planted-hook/gpg sentinel, the injected snapshot the seam received, thrown errors.

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const headCount = (dir: string): number => Number(git(dir, 'rev-list', '--count', 'HEAD'));
const headSha = (dir: string): string => git(dir, 'rev-parse', 'HEAD');
const headSubject = (dir: string): string => git(dir, 'log', '-1', '--format=%s');
const headFiles = (dir: string): string => git(dir, 'show', '--name-only', '--format=', 'HEAD');
const porcelain = (dir: string): string => git(dir, 'status', '--porcelain');

describe('createRealAppGateCommit — real git (§28.3/§28.5.1 L1)', () => {
  let fx: GitRepoFixture;
  let repo: string;

  beforeEach(() => {
    fx = createGitRepoFixture();
    repo = fx.makeGitRepo('gatecommit');
    fx.writeRepoFile(repo, '.gitignore', '.agent-terminal/\n');
    fx.writeRepoFile(repo, 'seed.txt', 'seed\n');
    fx.commitAll(repo, 'baseline');
  });
  afterEach(() => fx.cleanup());

  it('T1: advances HEAD by one carrying the label, tree clean, and returns the new commit SHA', async () => {
    fx.writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
    const before = headCount(repo);
    const result = await createRealAppGateCommit(repo)({ label: 'RED: slice-x', dirtyAtPhaseStart: [] });
    expect(result.outcome).toBe('committed');
    // §28.5.1 — the captured SHA is exactly the new HEAD, read in-adapter (a valid object id):
    if (result.outcome === 'committed') {
      expect(result.sha).toBe(headSha(repo));
      expect(isGitObjectId(result.sha)).toBe(true);
      // §28.5.1 — the baseline key: the branch the commit landed on, read in-adapter.
      expect(result.branch).toBe(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'));
    }
    expect(headCount(repo)).toBe(before + 1);
    expect(headSubject(repo)).toBe('RED: slice-x');
    expect(porcelain(repo)).toBe('');
  });

  it('T2: stages a NEW untracked file into the commit', async () => {
    fx.writeRepoFile(repo, 'tests/new.test.ts', 'test\n');
    const before = headCount(repo);
    await createRealAppGateCommit(repo)({ label: 'RED: adds-test', dirtyAtPhaseStart: [] });
    expect(headCount(repo)).toBe(before + 1);
    expect(headFiles(repo)).toContain('tests/new.test.ts');
    expect(porcelain(repo)).toBe('');
  });

  it('T2b: stages a deletion of a tracked file', async () => {
    fx.removeRepoFile(repo, 'seed.txt');
    const before = headCount(repo);
    await createRealAppGateCommit(repo)({ label: 'GREEN: removes-seed', dirtyAtPhaseStart: [] });
    expect(headCount(repo)).toBe(before + 1);
    expect(git(repo, 'show', '--name-status', '--format=', 'HEAD')).toMatch(/^D\s+seed\.txt/m);
    expect(porcelain(repo)).toBe('');
  });

  it('T3: leaves a pre-existing .gitignore byte-for-byte unchanged', async () => {
    const sentinel = '# operator-owned\n.agent-terminal/\nnode_modules\n';
    fx.writeRepoFile(repo, '.gitignore', sentinel);
    fx.commitAll(repo, 'set sentinel gitignore');
    fx.writeRepoFile(repo, 'src/b.ts', 'export const b = 2;\n');
    const before = headCount(repo);
    await createRealAppGateCommit(repo)({ label: 'GREEN: unrelated', dirtyAtPhaseStart: [] });
    expect(headCount(repo)).toBe(before + 1);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(sentinel);
  });

  it('T3b: a gitignored .agent-terminal/ write is NOT swept into the commit; the tracked change IS', async () => {
    fx.writeRepoFile(repo, 'src/c.ts', 'export const c = 3;\n');
    fx.writeRepoFile(repo, '.agent-terminal/loop/run-state.yaml', 'status: accepted\n');
    await createRealAppGateCommit(repo)({ label: 'GREEN: coupling', dirtyAtPhaseStart: [] });
    const files = headFiles(repo);
    expect(files).toContain('src/c.ts');
    expect(files).not.toContain('.agent-terminal');
    expect(existsSync(join(repo, '.agent-terminal/loop/run-state.yaml'))).toBe(true);
    expect(porcelain(repo)).toBe('');
  });

  it('T4: creates no .gitignore when none exists', async () => {
    const bare = fx.makeGitRepo('nogitignore');
    fx.writeRepoFile(bare, 'seed.txt', 'seed\n');
    fx.commitAll(bare, 'baseline');
    fx.writeRepoFile(bare, 'src/d.ts', 'export const d = 4;\n');
    const before = headCount(bare);
    await createRealAppGateCommit(bare)({ label: 'GREEN: no-ignore', dirtyAtPhaseStart: [] });
    expect(headCount(bare)).toBe(before + 1);
    expect(existsSync(join(bare, '.gitignore'))).toBe(false);
  });

  it('T5: returns nothing-to-commit (no SHA) and does NOT advance HEAD when the tracked tree is clean', async () => {
    fx.writeRepoFile(repo, '.agent-terminal/loop/run-state.yaml', 'status: accepted\n'); // ignored only
    const before = headCount(repo);
    const result = await createRealAppGateCommit(repo)({ label: 'refactor: noop', dirtyAtPhaseStart: [] });
    expect(result).toEqual({ outcome: 'nothing-to-commit' }); // no `sha` on the no-op arm
    expect(headCount(repo)).toBe(before); // no empty commit
  });

  it('T1b: a shell-metachar label lands verbatim as the subject and is never shell-interpreted (CWE-78)', async () => {
    const sentinel = join(repo, 'PWNED');
    const label = 'RED: $(touch ' + sentinel + ') `id`';
    fx.writeRepoFile(repo, 'src/h.ts', 'export const h = 8;\n');
    await createRealAppGateCommit(repo)({ label, dirtyAtPhaseStart: [] });
    expect(headSubject(repo)).toBe(label);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('T3c: excludes ALL app state dirs from a phase commit even without a gitignore (CWE-200, coupling)', async () => {
    const bare = fx.makeGitRepo('noignore');
    fx.writeRepoFile(bare, 'seed.txt', 'seed\n');
    fx.commitAll(bare, 'baseline');
    fx.writeRepoFile(bare, 'src/g.ts', 'export const g = 7;\n');
    for (const dir of APP_STATE_DIRS) fx.writeRepoFile(bare, `${dir}/state.json`, 'SECRET=xyz\n');
    const before = headCount(bare);
    const result = await createRealAppGateCommit(bare)({ label: 'GREEN: enforced', dirtyAtPhaseStart: [] });
    expect(result.outcome).toBe('committed');
    expect(headCount(bare)).toBe(before + 1);
    const files = headFiles(bare);
    expect(files).toContain('src/g.ts');
    for (const dir of APP_STATE_DIRS) expect(files).not.toContain(dir);
  });

  it('T3d: nothing-to-commit stays reachable without a gitignore when only app state changed (CWE-754)', async () => {
    const bare = fx.makeGitRepo('noignore2');
    fx.writeRepoFile(bare, 'seed.txt', 'seed\n');
    fx.commitAll(bare, 'baseline');
    for (const dir of APP_STATE_DIRS) fx.writeRepoFile(bare, `${dir}/state.json`, 'x\n');
    const before = headCount(bare);
    const result = await createRealAppGateCommit(bare)({ label: 'refactor: noop-enforced', dirtyAtPhaseStart: [] });
    expect(result).toEqual({ outcome: 'nothing-to-commit' });
    expect(headCount(bare)).toBe(before);
  });

  it('T-fail: a genuine git failure (outside a git repo) rejects rather than silently no-op', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'agent-notgit-'));
    await expect(createRealAppGateCommit(notARepo)({ label: 'GREEN: nope', dirtyAtPhaseStart: [] })).rejects.toThrow();
  });

  // §28.3 — the commit stages ONLY the phase's own changes: a path already dirty at phase start
  // (dirtyAtPhaseStart, the operator's WIP) is never swept in, and is left in the same state it was in when
  // the phase began. The snapshot is injected (S3 captures it from the phase lifecycle, §28.5.1); an empty
  // snapshot — every call above — means every changed path is phase-produced, the pre-S3 behaviour.
  it('Tw1: a tracked file modified before the phase (dirtyAtPhaseStart) is NOT swept into the commit', async () => {
    fx.writeRepoFile(repo, 'seed.txt', 'operator wip\n'); // operator WIP present when the phase starts
    fx.writeRepoFile(repo, 'src/p.ts', 'export const p = 1;\n'); // the phase's own change
    const before = headCount(repo);
    const result = await createRealAppGateCommit(repo)({ label: 'GREEN: phase', dirtyAtPhaseStart: ['seed.txt'] });
    expect(result.outcome).toBe('committed');
    expect(headCount(repo)).toBe(before + 1);
    const files = headFiles(repo);
    expect(files).toContain('src/p.ts'); // phase change committed
    expect(files).not.toContain('seed.txt'); // operator WIP NOT swept
    expect(readFileSync(join(repo, 'seed.txt'), 'utf8')).toBe('operator wip\n'); // WIP intact on disk
    expect(git(repo, 'diff', '--name-only')).toContain('seed.txt'); // still an UNSTAGED worktree modification
  });

  it('Tw2: an untracked file present before the phase (dirtyAtPhaseStart) is NOT swept into the commit', async () => {
    fx.writeRepoFile(repo, 'notes.md', 'operator scratch\n'); // untracked operator WIP at phase start
    fx.writeRepoFile(repo, 'src/q.ts', 'export const q = 2;\n'); // the phase's own change
    await createRealAppGateCommit(repo)({ label: 'GREEN: phase2', dirtyAtPhaseStart: ['notes.md'] });
    const files = headFiles(repo);
    expect(files).toContain('src/q.ts'); // phase change committed
    expect(files).not.toContain('notes.md'); // operator WIP NOT swept
    expect(existsSync(join(repo, 'notes.md'))).toBe(true); // still on disk
    expect(porcelain(repo)).toMatch(/^\?\? notes\.md$/m); // still untracked
  });

  it('Tw3: nothing-to-commit when every change was already dirty at phase start (no phase-produced change)', async () => {
    fx.writeRepoFile(repo, 'seed.txt', 'operator wip\n'); // operator WIP only — the phase produced nothing
    const before = headCount(repo);
    const result = await createRealAppGateCommit(repo)({ label: 'refactor: noop', dirtyAtPhaseStart: ['seed.txt'] });
    expect(result).toEqual({ outcome: 'nothing-to-commit' });
    expect(headCount(repo)).toBe(before); // no empty commit
    expect(readFileSync(join(repo, 'seed.txt'), 'utf8')).toBe('operator wip\n'); // WIP preserved
  });

  // The phase-start snapshot will be sourced (in S3) from a git-status listing of the UNTRUSTED operated
  // repo, so a snapshot entry can be any repo-controlled filename. It must reach `git reset` as a literal
  // path — never a git magic pathspec (Tw4) and never an option (Tw5) — or a hostile filename could steer
  // the unstage set (sweep operator WIP into the commit, or leave APP_STATE_DIRS staged).
  it('Tw4: a magic-pathspec-shaped snapshot entry is matched literally and cannot steer the unstage set (CWE-88)', async () => {
    fx.writeRepoFile(repo, 'src/keep.ts', 'export const k = 1;\n'); // the phase's own change — MUST be committed
    // Interpreted, `:(glob)src/**` would unstage the phase's own src/keep.ts and drop it from the commit;
    // as a literal path it matches a (non-existent) file of that name and changes nothing.
    const result = await createRealAppGateCommit(repo)({ label: 'GREEN: literal', dirtyAtPhaseStart: [':(glob)src/**'] });
    expect(result.outcome).toBe('committed');
    expect(headFiles(repo)).toContain('src/keep.ts'); // the magic pathspec did NOT steer the reset
  });

  it('Tw5: an option-shaped snapshot entry is a pathspec, never an option — no destructive `git reset --hard` (CWE-88)', async () => {
    fx.writeRepoFile(repo, 'src/keep.ts', 'export const k = 1;\n'); // staged phase change a `reset --hard` would destroy
    const result = await createRealAppGateCommit(repo)({ label: 'GREEN: dashdash', dirtyAtPhaseStart: ['--hard'] });
    expect(result.outcome).toBe('committed');
    expect(headFiles(repo)).toContain('src/keep.ts'); // `--hard` was an inert pathspec, not a worktree-wiping option
    expect(readFileSync(join(repo, 'src/keep.ts'), 'utf8')).toBe('export const k = 1;\n'); // worktree intact
  });

  it('Tw6: a file BOTH dirty at phase start AND changed by the phase is excluded WHOLESALE (the phase edit is not committed)', async () => {
    fx.writeRepoFile(repo, 'seed.txt', 'operator wip\n'); // operator WIP present when the phase starts
    fx.writeRepoFile(repo, 'seed.txt', 'operator wip\nphase edit\n'); // the phase then edits the SAME file
    fx.writeRepoFile(repo, 'src/other.ts', 'export const o = 1;\n'); // a separate phase change, so there IS a commit
    await createRealAppGateCommit(repo)({ label: 'GREEN: entangled', dirtyAtPhaseStart: ['seed.txt'] });
    const files = headFiles(repo);
    expect(files).toContain('src/other.ts'); // the non-entangled phase change is committed
    expect(files).not.toContain('seed.txt'); // the entangled file is left to the worktree — phase edit NOT committed
    expect(readFileSync(join(repo, 'seed.txt'), 'utf8')).toBe('operator wip\nphase edit\n'); // both edits remain on disk
  });

  it('T-rootless: an initialized repo with NO commit (no HEAD) rejects before touching the tree', async () => {
    const rootless = fx.makeGitRepo('rootless'); // git init, nothing committed → HEAD unresolvable
    fx.writeRepoFile(rootless, 'src/x.ts', 'export const x = 1;\n');
    await expect(createRealAppGateCommit(rootless)({ label: 'RED: rootless', dirtyAtPhaseStart: [] })).rejects.toThrow();
    // headCommit() fails first, so `git add -A` never ran: the change is still UNTRACKED (`??`), not staged (`A`).
    expect(porcelain(rootless)).toMatch(/^\?\? src\//m);
  });
});

describe('createAppGateCommit — ports-injected (§28.3/§28.5.1 L2)', () => {
  const OID = (c: string): string => c.repeat(40);
  const fakeOps = (
    step: AppGateCommitStep,
    headBefore = OID('a'),
  ): {
    ops: AppGateCommitOperations;
    calls: { label: string; dirtyAtPhaseStart: readonly string[] }[];
  } => {
    const calls: { label: string; dirtyAtPhaseStart: readonly string[] }[] = [];
    return {
      calls,
      ops: {
        headCommit: async () => headBefore,
        commitWorkingTree: async (label, dirtyAtPhaseStart) => {
          calls.push({ label, dirtyAtPhaseStart });
          return step;
        },
      },
    };
  };

  it('T7: passes the label AND the phase-start snapshot to the seam and returns { committed, sha, branch } when the parent matches the pre-commit head', async () => {
    const { ops, calls } = fakeOps({ outcome: 'committed', sha: OID('c'), parentSha: OID('a'), branch: 'main' }, OID('a'));
    const result = await createAppGateCommit(ops)({ label: 'GREEN: slice-y', dirtyAtPhaseStart: ['wip.ts'] });
    expect(calls).toEqual([{ label: 'GREEN: slice-y', dirtyAtPhaseStart: ['wip.ts'] }]);
    expect(result).toEqual({ outcome: 'committed', sha: OID('c'), branch: 'main' });
  });

  it('T8: throws on an empty/whitespace label before touching the seam', async () => {
    const { ops, calls } = fakeOps({ outcome: 'committed', sha: OID('c'), parentSha: OID('a'), branch: 'main' });
    await expect(createAppGateCommit(ops)({ label: '   ', dirtyAtPhaseStart: [] })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('T9: propagates a benign nothing-to-commit outcome without throwing (no SHA)', async () => {
    const { ops } = fakeOps({ outcome: 'nothing-to-commit' });
    await expect(createAppGateCommit(ops)({ label: 'refactor: noop', dirtyAtPhaseStart: [] })).resolves.toEqual({
      outcome: 'nothing-to-commit',
    });
  });

  // IT-COMMIT-1b — §28.5.1 TOCTOU: the operated repo hosts a live agent sharing the working tree. If a commit
  // raced into the window, the new commit's parent would NOT be the head we captured before committing → refuse
  // to record a poisoned baseline (fail toward firing — no result returned).
  it('T-TOCTOU: refuses when the new commit parent is not the pre-commit head (a raced commit)', async () => {
    const { ops } = fakeOps({ outcome: 'committed', sha: OID('c'), parentSha: OID('b'), branch: 'main' }, OID('a'));
    await expect(createAppGateCommit(ops)({ label: 'RED: raced', dirtyAtPhaseStart: [] })).rejects.toThrow();
  });

  // IT-COMMIT-1c — a garbage SHA from git must never become a persisted baseline (CWE-20).
  it('T-garbage-sha: throws when the seam yields a non-object-id SHA', async () => {
    const { ops } = fakeOps({ outcome: 'committed', sha: 'not-a-real-object-id', parentSha: OID('a'), branch: 'main' }, OID('a'));
    await expect(createAppGateCommit(ops)({ label: 'RED: garbage', dirtyAtPhaseStart: [] })).rejects.toThrow();
  });
});
