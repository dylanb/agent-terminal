import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRealPickupGit, decidePickupAction, runPickup, type PickupGit, type PickupGitHub, type PickupResult } from '../../src/main/loopPickup';
import type { LoopStateWrite } from '../../src/main/loopStateWriter';
import { parseLoopDef, type PickupContract } from '../../src/main/loopDef';

// §26.9 / L1 — in-app bootstrap (pickup) reimplements `agent-loop pickup` via git/gh, driven by the
// bound LoopDef's pickup_contract, then writes the initial whole-document state.yaml (§26.6). The runner
// orchestrates DOMAIN ops on injected git/gh ports (not raw exec, per the CLAUDE.md seam rule); these
// tests assert the observable side-effects: the GitHub/branch contract calls + the persisted state.

// Records each domain op so the test can assert the contract the runner has with the OS/GitHub boundary.
function makeFakeGit(overrides: Partial<Record<string, unknown>> = {}): { git: PickupGit; calls: string[] } {
  const calls: string[] = [];
  const git: PickupGit = {
    isCleanTree: async () => ('clean' in overrides ? (overrides.clean as boolean) : true),
    resolveBaseBranch: async () => ('base' in overrides ? (overrides.base as string | null) : 'main'),
    branchExists: async () => ('branchExists' in overrides ? (overrides.branchExists as boolean) : false),
    wipeConflictingBranch: async (branch) => void calls.push(`wipe:${branch}`),
    createBranchFromBase: async (branch, base) => {
      calls.push(`branch:${branch}<-${base}`);
    },
    commitEmptyStart: async (msg) => {
      calls.push(`commit:${msg.split('\n')[0]}`);
    },
    pushBranchUpstream: async (branch) => void calls.push(`push:${branch}`),
  };
  return { git, calls };
}

interface FakeGitHub {
  github: PickupGitHub;
  calls: string[];
  prArgs: () => { base: string; head: string; title: string; body: string } | null;
}
function makeFakeGitHub(overrides: Partial<Record<string, unknown>> = {}): FakeGitHub {
  const calls: string[] = [];
  let captured: { base: string; head: string; title: string; body: string } | null = null;
  const github: PickupGitHub = {
    viewIssue: async (n) =>
      overrides.issue === null ? null : { title: `Ticket ${n} title`, url: `https://example/issues/${n}` },
    assignIssueToSelf: async (n) => void calls.push(`assign:${n}`),
    setIssueLabel: async (n, label, on) => void calls.push(`issue-label:${on ? '+' : '-'}${label}@${n}`),
    createDraftPr: async (args) => {
      captured = args;
      calls.push(`pr-create:${args.head}`);
      return (overrides.pr as number | null | undefined) === undefined ? 42 : (overrides.pr as number | null);
    },
    setPrLabel: async (pr, label, on) => void calls.push(`pr-label:${on ? '+' : '-'}${label}@${pr}`),
  };
  return { github, calls, prArgs: () => captured };
}

describe('in-app pickup runner (§26.9 / L1)', () => {
  let repo: string;
  let written: LoopStateWrite | null;
  let wiped: number;
  const exampleConfigDir = resolve(__dirname, '..', '..', 'example');
  let planPickup: PickupContract;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'pickup-'));
    written = null;
    wiped = 0;
    const def = parseLoopDef(repo, 'plan-loop', exampleConfigDir);
    planPickup = def!.pickup!;
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const deps = (git: PickupGit, github: PickupGitHub) => ({
    git,
    github,
    // The timestamp seam lives in writeState's closure (real wiring → writeLoopState(repoDir, s, now)),
    // so the runner stays clock-free; the test just captures the value the runner hands it.
    writeState: (s: LoopStateWrite) => {
      written = s;
    },
    wipeStaleLoopDir: () => {
      wiped += 1;
    },
  });

  const req = () => ({ repoDir: repo, issue: 176, loopName: 'plan-loop', pickup: planPickup });

  it('creates the branch + draft PR and persists plan-draft state (happy path, real pickup_contract)', async () => {
    const g = makeFakeGit();
    const h = makeFakeGitHub();
    const result = await runPickup(deps(g.git, h.github), req());

    expect(result).toEqual({ ok: true, pr: 42, branch: 'plan-loop/issue-176', status: 'plan-draft' });
    // branch templated from initial_branch_tpl; forked off the resolved base
    expect(g.calls).toContain('branch:plan-loop/issue-176<-main');
    expect(g.calls).toContain('push:plan-loop/issue-176');
    // draft PR opened with closes-# semantics, targeting the base, from the new branch
    expect(h.prArgs()).toMatchObject({ base: 'main', head: 'plan-loop/issue-176' });
    expect(h.prArgs()?.title).toContain('(closes #176)');
    expect(h.prArgs()?.body).toContain('closes #176');
    // state persisted as the whole-document write the mirror reads
    expect(written).toEqual({
      status: 'plan-draft',
      iteration: 1,
      pr: 42,
      branch: 'plan-loop/issue-176',
      boundLoop: 'plan-loop',
      linkedIssues: [176],
    });
  });

  it('applies the resolved pickup_contract labels to the issue and the PR (target-scoped)', async () => {
    const g = makeFakeGit();
    const h = makeFakeGitHub();
    await runPickup(deps(g.git, h.github), req());
    expect(h.calls).toContain('assign:176');
    expect(h.calls).toContain('issue-label:-plan-loop/ready@176');
    expect(h.calls).toContain('issue-label:+plan-loop/in-progress@176');
    expect(h.calls).toContain('pr-label:+plan-loop/plan-draft@42');
  });

  it('refuses a dirty working tree: no PR, no state write', async () => {
    const g = makeFakeGit({ clean: false });
    const h = makeFakeGitHub();
    const result = await runPickup(deps(g.git, h.github), req());
    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain('pr-create:plan-loop/issue-176');
    expect(written).toBeNull();
  });

  it('fails (no state write) when the base branch cannot be resolved', async () => {
    const g = makeFakeGit({ base: null });
    const h = makeFakeGitHub();
    const result = await runPickup(deps(g.git, h.github), req());
    expect(result.ok).toBe(false);
    expect(written).toBeNull();
  });

  it('fails (no state write) when the draft PR cannot be created', async () => {
    const g = makeFakeGit();
    const h = makeFakeGitHub({ pr: null });
    const result = await runPickup(deps(g.git, h.github), req());
    expect(result.ok).toBe(false);
    expect(written).toBeNull();
  });

  it('wipes any stale .agent-loop before writing the fresh state', async () => {
    const g = makeFakeGit();
    const h = makeFakeGitHub();
    await runPickup(deps(g.git, h.github), req());
    expect(wiped).toBe(1);
  });

  // §26.9 on_conflict — a re-pickup whose branch already exists. The vendored plan-loop declares
  // `on_conflict: wipe-and-retry`; the runner asks first (a `conflict` result) rather than destroying the
  // branch silently, and wipes only when told to (`wipeConflict`), matching the confirm-first UX.
  describe('existing-branch conflict (on_conflict: wipe-and-retry)', () => {
    it('asks first: an existing branch returns a conflict result with NO destructive op and NO state write', async () => {
      const g = makeFakeGit({ branchExists: true });
      const h = makeFakeGitHub();
      const result = await runPickup(deps(g.git, h.github), req());
      expect(result).toEqual({ ok: false, conflict: { branch: 'plan-loop/issue-176' } });
      expect(g.calls).not.toContain('wipe:plan-loop/issue-176'); // never wiped without confirmation
      expect(g.calls).not.toContain('branch:plan-loop/issue-176<-main');
      expect(h.calls).not.toContain('pr-create:plan-loop/issue-176');
      expect(written).toBeNull();
    });

    it('wipes the conflicting branch, then bootstraps cleanly, when told to (wipeConflict)', async () => {
      const g = makeFakeGit({ branchExists: true });
      const h = makeFakeGitHub();
      const result = await runPickup(deps(g.git, h.github), { ...req(), wipeConflict: true });
      expect(result).toEqual({ ok: true, pr: 42, branch: 'plan-loop/issue-176', status: 'plan-draft' });
      // the wipe precedes the fresh branch creation
      expect(g.calls.indexOf('wipe:plan-loop/issue-176')).toBeGreaterThanOrEqual(0);
      expect(g.calls.indexOf('wipe:plan-loop/issue-176')).toBeLessThan(g.calls.indexOf('branch:plan-loop/issue-176<-main'));
      expect(written?.status).toBe('plan-draft');
    });

    it('does NOT ask (and never wipes) when the branch does not exist — the happy path is unchanged', async () => {
      const g = makeFakeGit({ branchExists: false });
      const h = makeFakeGitHub();
      const result = await runPickup(deps(g.git, h.github), req());
      expect(result.ok).toBe(true);
      expect(g.calls).not.toContain('wipe:plan-loop/issue-176');
    });

    it('hard-fails (no conflict prompt, no wipe) on an existing branch when the policy is not wipe-and-retry', async () => {
      const g = makeFakeGit({ branchExists: true });
      const h = makeFakeGitHub();
      const result = await runPickup(deps(g.git, h.github), { ...req(), pickup: { ...planPickup, onConflict: '' } });
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('conflict'); // an unknown policy is a hard error, not a wipe prompt
      expect(g.calls).not.toContain('wipe:plan-loop/issue-176');
      expect(written).toBeNull();
    });

    it('never wipes under a non-wipe-and-retry policy even when wipeConflict is set — the destructive path enforces the policy too', async () => {
      const g = makeFakeGit({ branchExists: true });
      const h = makeFakeGitHub();
      // A confirmed wipe (wipeConflict) only reaches here for a wipe-and-retry job by construction, but the
      // destructive op must guard the policy invariant directly so no future path can wipe under another one.
      const result = await runPickup(deps(g.git, h.github), {
        ...req(),
        wipeConflict: true,
        pickup: { ...planPickup, onConflict: '' },
      });
      expect(result.ok).toBe(false);
      expect(g.calls).not.toContain('wipe:plan-loop/issue-176');
      expect(written).toBeNull();
    });
  });

  // The resolved branch is templated from `initial_branch_tpl`, which the repo-local LoopDef yaml
  // supplies and the codebase treats as untrusted (loopDef.ts). It reaches git as an argv positional
  // (`ls-remote`/`branch --list`/`branch -D`/`push --delete`); git permutes options among positionals,
  // so a value like `--upload-pack=<cmd>` would be parsed as an OPTION, not a ref (CWE-88 → CWE-78).
  describe('branch-name safety (arg injection, CWE-88)', () => {
    it('rejects a branch that could be parsed as a git option, reaching NO git/gh sink and writing no state', async () => {
      const g = makeFakeGit();
      const h = makeFakeGitHub();
      const result = await runPickup(deps(g.git, h.github), {
        ...req(),
        pickup: { ...planPickup, initialBranchTpl: '--upload-pack=touch{issue}' },
      });
      expect(result.ok).toBe(false);
      expect(g.calls).toEqual([]); // never reached branchExists/create/commit/push/wipe with the tainted value
      expect(h.calls).toEqual([]); // no issue view/assign/label, no PR create
      expect(written).toBeNull();
    });

    it('rejects a branch with a shell/ref metacharacter (space, semicolon) the same way', async () => {
      const g = makeFakeGit();
      const h = makeFakeGitHub();
      const result = await runPickup(deps(g.git, h.github), {
        ...req(),
        pickup: { ...planPickup, initialBranchTpl: 'plan; rm -rf {issue}' },
      });
      expect(result.ok).toBe(false);
      expect(g.calls).toEqual([]);
      expect(written).toBeNull();
    });
  });

  // The hard-failure path now ALWAYS reaches the operator's blocking dialog (decidePickupAction revert), so
  // the reason it carries must never be blank. A git/gh port that rejects with a non-Error value (a bare
  // string, a plain object) must still surface a meaningful reason (CLAUDE.md — a caught value is `unknown`,
  // never an `Error`; an error surfaced with an empty reason is swallowed just as thoroughly as one dropped).
  it('surfaces a non-Error throw as its stringified reason (never a blank dialog)', async () => {
    const g = makeFakeGit();
    g.git.isCleanTree = () => Promise.reject('boom'); // a thrown string, not an Error
    const h = makeFakeGitHub();
    const result = await runPickup(deps(g.git, h.github), req());
    expect(result).toEqual({ ok: false, error: 'boom' });
  });
});

// §26.9 — the async pickup is fire-and-forget: its `.then()` may resolve AFTER the operator terminated
// or navigated the flow off the bootstrap step. `decidePickupAction` names the decision the host glue
// makes on completion. A hard FAILURE always surfaces (revert to the initiating step + blocking dialog) so
// a failed bootstrap is never swallowed (CLAUDE.md — a critical-path failure the operator cannot see must
// never be silent). Only a SUCCESS or CONFLICT that lands after the flow left the step is dropped as
// `stale`: driving a work turn or prompting a wipe against a moved/terminated flow would act on the wrong
// context.
describe('decidePickupAction (§26.9)', () => {
  const ok: PickupResult = { ok: true, pr: 7, branch: 'b', status: 'plan-draft' };
  const conflict: PickupResult = { ok: false, conflict: { branch: 'b' } };
  const hardFail: PickupResult = { ok: false, error: 'working tree is not clean' };

  it('drops a success or conflict result as stale when the flow no longer sits on the bootstrap step', () => {
    expect(decidePickupAction(ok, false)).toEqual({ kind: 'stale' });
    expect(decidePickupAction(conflict, false)).toEqual({ kind: 'stale' });
  });

  it('ALWAYS surfaces a hard failure (revert + dialog) even when the flow left the bootstrap step', () => {
    expect(decidePickupAction(hardFail, false)).toEqual({ kind: 'revert', reason: 'working tree is not clean' });
  });

  it('drives the work turn on success while still on the step', () => {
    expect(decidePickupAction(ok, true)).toEqual({ kind: 'work', status: 'plan-draft' });
  });

  it('prompts the wipe on a conflict while still on the step', () => {
    expect(decidePickupAction(conflict, true)).toEqual({ kind: 'conflict', branch: 'b' });
  });

  it('rolls back to the initiating step + surfaces the reason on a hard failure while still on the step', () => {
    expect(decidePickupAction(hardFail, true)).toEqual({ kind: 'revert', reason: 'working tree is not clean' });
  });
});

// §26.9 — pickup's clean-tree gate runs against the REAL git porcelain (createRealPickupGit). It must
// ignore churn under the app's OWN state directories, or agent-terminal's own writes would permanently
// block pickup in any repo it has ever run a flow in: `.agent-loop/` is engine parity, and `.agent-terminal/`
// (flow-state, todos, monitor-events, audit-pointer) is agent-terminal state the external engine never
// writes. A genuine source change — or a `.gitignore` edit, which the app never makes — stays dirty.
describe('createRealPickupGit.isCleanTree — app-owned state is not "dirty" (§26.9)', () => {
  let repo: string;
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: repo });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'pickup-clean-'));
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'init']);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('treats untracked churn under .agent-terminal/ (flow-state, todos, monitor-events, audit-pointer) as clean', async () => {
    mkdirSync(join(repo, '.agent-terminal'));
    for (const f of ['flow-state.yaml', 'todos.json', 'monitor-events.json', 'audit-pointer.yaml']) {
      writeFileSync(join(repo, '.agent-terminal', f), 'x\n');
    }
    expect(await createRealPickupGit(repo).isCleanTree()).toBe(true);
  });

  it('treats churn under .agent-loop/ as clean (engine parity)', async () => {
    mkdirSync(join(repo, '.agent-loop'));
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), 'x\n');
    expect(await createRealPickupGit(repo).isCleanTree()).toBe(true);
  });

  it('preserves §26 behavior for staged app-owned state', async () => {
    mkdirSync(join(repo, '.agent-loop'));
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), 'x\n');
    git(['add', '.agent-loop/state.yaml']);
    expect(await createRealPickupGit(repo).isCleanTree()).toBe(true);
  });

  it('treats a real source change as dirty', async () => {
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    expect(await createRealPickupGit(repo).isCleanTree()).toBe(false);
  });

  it("treats a modified .gitignore as dirty (the app never edits it, so a change is the user's)", async () => {
    writeFileSync(join(repo, '.gitignore'), 'foo\n');
    git(['add', '.gitignore']);
    git(['commit', '-q', '-m', 'add ignore']);
    writeFileSync(join(repo, '.gitignore'), 'foo\nbar\n');
    expect(await createRealPickupGit(repo).isCleanTree()).toBe(false);
  });

  // A repo that does NOT gitignore .agent-terminal/ (the never-touch-.gitignore rule leaves that to the
  // user) tracks the app's state files, so re-writing one shows as a worktree-modified " M " porcelain line
  // — whose leading status space must not defeat the app-state match, or pickup stays permanently blocked
  // in exactly the repos the .agent-terminal/ allowance exists to unblock.
  it('treats a worktree-modified tracked .agent-terminal/ file as clean (" M " status)', async () => {
    mkdirSync(join(repo, '.agent-terminal'));
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'x\n');
    git(['add', '.agent-terminal/flow-state.yaml']);
    git(['commit', '-q', '-m', 'track flow state']);
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'changed\n');
    expect(await createRealPickupGit(repo).isCleanTree()).toBe(true);
  });

  // A staged rename OUT of an app-state dir INTO a real source path mutates the source tree, so it must read
  // dirty even though its origin is app-owned — the gate checks BOTH sides of a `R  <orig> -> <new>` line,
  // not just the origin, or a genuinely-dirty tree slips through the clean gate.
  it('treats a staged rename from an app-state dir to a source file as dirty', async () => {
    mkdirSync(join(repo, '.agent-loop'));
    writeFileSync(join(repo, '.agent-loop', 'x'), 'x\n');
    git(['add', '.agent-loop/x']);
    git(['commit', '-q', '-m', 'track loop file']);
    git(['mv', '.agent-loop/x', 'moved-source.ts']);
    expect(await createRealPickupGit(repo).isCleanTree()).toBe(false);
  });

  // Pins the outer `.every` over lines: app-state churn present alongside a genuine source change is dirty.
  // A regression that short-circuited to clean once one app-state line matched would pass every other case
  // here but let pickup run over uncommitted work (CLAUDE.md — never allow an unrecoverable state).
  it('treats app-state churn alongside a real source change as dirty', async () => {
    mkdirSync(join(repo, '.agent-terminal'));
    writeFileSync(join(repo, '.agent-terminal', 'todos.json'), 'x\n');
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    expect(await createRealPickupGit(repo).isCleanTree()).toBe(false);
  });
});
