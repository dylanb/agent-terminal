// In-app bootstrap (pickup) — §26.9 / L1. Reimplements the external `agent-loop pickup` (the retired
// §24.2.3 T3 injection) as out-of-band git/gh calls driven by the bound LoopDef's pickup_contract
// (§26.5), ending in the initial whole-document state.yaml write (§26.6). The orchestrator depends on
// DOMAIN ports (createBranchFromBase / createDraftPr / …), never raw exec(argv) — the CLAUDE.md seam
// rule — so the runner is tested against fakes while the real ports shell out via execFile (CWE-78:
// every value crosses as a distinct argv element, never spliced into a command string).

import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { PickupContract } from './loopDef';
import { writeLoopState, type LoopStateWrite } from './loopStateWriter';
import { numberFromGithubUrl } from '../shared/githubUrl';
import { APP_STATE_DIRS } from './appStateDirs';

/** GitHub issue facts the pickup needs for the start commit + PR title. */
export interface IssueInfo {
  title: string;
  url: string;
}

/** Git operations pickup needs, in the runner's own vocabulary (not the git CLI's). */
export interface PickupGit {
  /** True iff the tree is clean enough to bootstrap — churn under app-owned state dirs (`.agent-loop/`
   *  engine parity, `.agent-terminal/` app state) is ignored (§26.9). */
  isCleanTree(): Promise<boolean>;
  /** The branch to fork from + target the PR at; null when undiscoverable (the run then aborts). */
  resolveBaseBranch(): Promise<string | null>;
  /** True iff `branch` already exists (local or remote) — a re-pickup conflict (§26.9 `on_conflict`). */
  branchExists(branch: string): Promise<boolean>;
  /** Remove a conflicting `branch` (local + remote) so a fresh bootstrap can proceed (§26.9
   *  wipe-and-retry). Deleting the remote head closes its PR. Destructive + outward-facing — the runner
   *  calls this ONLY after the operator confirmed the wipe (`wipeConflict`), never on mere detection. */
  wipeConflictingBranch(branch: string): Promise<void>;
  /** Create `branch` off a freshly-fetched `base`, checked out. */
  createBranchFromBase(branch: string, base: string): Promise<void>;
  /** Commit an empty `[skip ci]` start commit so the branch has a tip to open a PR against. */
  commitEmptyStart(message: string): Promise<void>;
  /** Push `branch` to origin and set its upstream. */
  pushBranchUpstream(branch: string): Promise<void>;
}

/** GitHub operations pickup needs, as domain ops the real port satisfies via `gh`. */
export interface PickupGitHub {
  viewIssue(issue: number): Promise<IssueInfo | null>;
  assignIssueToSelf(issue: number): Promise<void>;
  setIssueLabel(issue: number, label: string, on: boolean): Promise<void>;
  createDraftPr(args: { base: string; head: string; title: string; body: string }): Promise<number | null>;
  setPrLabel(pr: number, label: string, on: boolean): Promise<void>;
}

export interface PickupDeps {
  git: PickupGit;
  github: PickupGitHub;
  /** Persist the initial state (§26.6); the timestamp seam lives in this closure, not the runner. */
  writeState(state: LoopStateWrite): void;
  /** Remove any stale `.agent-loop/` before the fresh state is written (engine parity). */
  wipeStaleLoopDir(): void;
}

export interface PickupRequest {
  repoDir: string;
  issue: number;
  loopName: string;
  pickup: PickupContract;
  /** Explicit base override; when absent the base is discovered via `resolveBaseBranch`. */
  base?: string;
  /** Resolve a detected branch conflict by wiping it (§26.9 wipe-and-retry), rather than returning a
   *  `conflict` result for the operator to confirm. Set only after that confirmation. */
  wipeConflict?: boolean;
}

/** A re-pickup whose target branch already exists, under a `wipe-and-retry` policy (§26.9): the runner
 *  did NOTHING destructive and awaits the operator's confirmation before wiping. */
export interface PickupConflict {
  branch: string;
}

export type PickupResult =
  | { ok: true; pr: number; branch: string; status: string }
  | { ok: false; conflict: PickupConflict }
  | { ok: false; error: string };

/** What the host does with a resolved async pickup (§26.9), consumed by the completion switch in index.ts:
 *  `work` drives the turn, `conflict` prompts the wipe confirm, `revert` rolls back to the initiating step
 *  and raises the blocking error dialog, `stale` is inert (the flow already left the step). */
export type PickupAction =
  | { kind: 'work'; status: string }
  | { kind: 'conflict'; branch: string }
  | { kind: 'revert'; reason: string }
  | { kind: 'stale' };

/** Decide what the host does with a resolved pickup result, given whether the flow is STILL on the
 *  bootstrap step. Pure so the fire-and-forget completion glue is driven by a tested decision. */
export function decidePickupAction(result: PickupResult, stillOnStep: boolean): PickupAction {
  // Checked BEFORE the stale gate so an off-step hard failure still surfaces (CLAUDE.md: a critical-path
  // failure the operator cannot see or fix by clicking must not be swallowed). Safe because the caller's
  // revertStep self-guards to a no-op once the flow has left the step, so only the blocking dialog fires.
  if (!result.ok && 'error' in result) return { kind: 'revert', reason: result.error };
  if (!stillOnStep) return { kind: 'stale' };
  if (result.ok) return { kind: 'work', status: result.status };
  return { kind: 'conflict', branch: result.conflict.branch };
}

// A conservative injection-safety allowlist for the pickup branch — NOT a full git refname validator
// (git's refname grammar is stricter; this does not model it). It only guarantees the value is safe to
// cross to a git argv: no leading `-` (git would read it as an option — CWE-88) and only a restricted
// subset of ref characters. `initial_branch_tpl` is untrusted repo-local config (loopDef.ts), so the
// resolved branch is validated against this before it reaches any git argv (CWE-78).
const SAFE_BRANCH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/** A best-effort side-effect (assign / label) must not abort the bootstrap if GitHub rejects it —
 *  engine parity (pickup continues past a label failure; the publisher reconciles later). */
async function bestEffort(op: () => Promise<void>): Promise<void> {
  try {
    await op();
  } catch {
    /* swallowed: assign/label failures are reconciled later, never block the PR (§26.9) */
  }
}

/** Run the in-app pickup for one issue. Aborts (no state write) on a dirty tree, an unresolvable base,
 *  a failed PR create, or (unless `wipeConflict`) an existing-branch conflict; never throws — a thrown
 *  git/gh op resolves to `{ok:false}`. An existing branch under a `wipe-and-retry` policy returns a
 *  `conflict` result (nothing destructive done) so the operator confirms before the wipe (§26.9). */
export async function runPickup(deps: PickupDeps, req: PickupRequest): Promise<PickupResult> {
  const { git, github, writeState, wipeStaleLoopDir } = deps;
  const fail = (error: string): PickupResult => ({ ok: false, error });
  try {
    if (!(await git.isCleanTree())) return fail('working tree is not clean');

    const base = req.base ?? (await git.resolveBaseBranch());
    if (!base) return fail('could not resolve base branch');

    const branch = req.pickup.initialBranchTpl.replace('{issue}', String(req.issue));
    // Reject a tainted branch before it reaches ANY git sink (CWE-88/78): a leading `-` or a ref
    // metacharacter would let untrusted `initial_branch_tpl` config inject a git option.
    if (!SAFE_BRANCH.test(branch)) return fail(`unsafe branch name from initial_branch_tpl: ${branch}`);
    // §26.9 on_conflict — a re-pickup whose branch already exists. `wipe-and-retry` is the vendored policy;
    // any other policy is a hard error. The wipe is destructive + outward-facing (it deletes the remote
    // branch and closes its PR), so the policy invariant gates the destructive op DIRECTLY — not only the
    // detection path — so no route can wipe under another policy. Under wipe-and-retry the runner still does
    // NOTHING on mere detection, returning a `conflict` for the operator to confirm; only a confirmed
    // `wipeConflict` performs the wipe.
    if (await git.branchExists(branch)) {
      if (req.pickup.onConflict !== 'wipe-and-retry') {
        return fail(`branch ${branch} already exists (on_conflict: ${req.pickup.onConflict || 'none'})`);
      }
      if (!req.wipeConflict) return { ok: false, conflict: { branch } };
      await git.wipeConflictingBranch(branch);
    }
    await git.createBranchFromBase(branch, base);
    wipeStaleLoopDir();

    const info = await github.viewIssue(req.issue);
    const seeLine = info?.url ? `\n\nSee ${info.url}` : '';
    await git.commitEmptyStart(`[skip ci] start work on #${req.issue}${seeLine}`);
    await git.pushBranchUpstream(branch);

    await bestEffort(() => github.assignIssueToSelf(req.issue));
    for (const l of req.pickup.initialLabels) {
      if (l.target === 'issue') await bestEffort(() => github.setIssueLabel(req.issue, l.label, l.action === 'add'));
    }

    const title = `${info?.title ?? `issue #${req.issue}`} (closes #${req.issue})`;
    // TODO(loop-engine): resolve the body from pickup_contract.initial_pr_body_ref (§26.9) instead of this
    // hardcoded stub. The field is parsed (loopDef.ts) but not yet resolved to a template; wiring the
    // resolver is its own slice — the vendored defs name a stub, so the observable body is unchanged.
    const body = `closes #${req.issue}\n\n<!-- agent-loop will fill the real plan + implementation. This body is the initial stub. -->\n`;
    const pr = await github.createDraftPr({ base, head: branch, title, body });
    if (pr === null) return fail('draft PR creation failed');

    for (const l of req.pickup.initialLabels) {
      if (l.target === 'pr') await bestEffort(() => github.setPrLabel(pr, l.label, l.action === 'add'));
    }

    const status = req.pickup.initialStatus || 'plan-draft';
    writeState({ status, iteration: 1, pr, branch, boundLoop: req.loopName, linkedIssues: [req.issue] });
    return { ok: true, pr, branch, status };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Real ports — execFile-backed git/gh. Each value crosses as a distinct argv
// element (CWE-78); nothing is concatenated into a shell string.
// ---------------------------------------------------------------------------

const EXEC_TIMEOUT_MS = 60_000;

function run(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const APP_STATE_PREFIXES = APP_STATE_DIRS.map((d) => `${d}/`);

// `git status --porcelain` v1: each line is `XY <path>` (two status columns + a space), and a rename/copy
// carries `<orig> -> <new>`. Clean iff every changed path — BOTH sides of a rename — is app-owned, so a
// rename OUT of an app dir to a real file still reads dirty. Slicing the fixed status columns (not trimming)
// keeps a worktree-modified " M " line's leading space from defeating the prefix match.
function treeIsClean(porcelain: string): boolean {
  const isAppState = (p: string): boolean => APP_STATE_PREFIXES.some((prefix) => p.startsWith(prefix));
  return porcelain
    .split('\n')
    .filter((l) => l.length > 0)
    .every((line) => line.slice(3).split(' -> ').every(isAppState));
}

export function createRealPickupGit(repoDir: string): PickupGit {
  const git = (args: string[]): Promise<string> => run('git', args, repoDir);
  // A git op whose failure means "the thing is already in the goal state" (a branch already absent on one
  // side of the wipe): swallow so the wipe is idempotent across local-only / remote-only leftovers.
  const bestEffortGit = async (args: string[]): Promise<void> => {
    try {
      await git(args);
    } catch {
      /* the branch was already gone on this side — that IS the goal (§26.9 wipe-and-retry) */
    }
  };
  return {
    isCleanTree: async () => treeIsClean(await git(['status', '--porcelain'])),
    resolveBaseBranch: async () => {
      try {
        const out = await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], repoDir);
        const name = out.trim();
        return name.length > 0 ? name : null;
      } catch {
        return null;
      }
    },
    branchExists: async (branch) => {
      // Local first (`git branch --list` prints the branch when it exists), then the remote head.
      const local = await git(['branch', '--list', branch]);
      if (local.trim().length > 0) return true;
      try {
        const remote = await run('git', ['ls-remote', '--heads', 'origin', branch], repoDir);
        return remote.trim().length > 0;
      } catch {
        return false; // no remote / offline — treat as no remote conflict
      }
    },
    wipeConflictingBranch: async (branch) => {
      // Detach HEAD so `branch` isn't the current branch, then force-delete it locally and on origin.
      // Deleting the remote head closes its PR. Each deletion is best-effort — a side already gone is fine.
      await bestEffortGit(['checkout', '--detach']);
      await bestEffortGit(['branch', '-D', branch]);
      await bestEffortGit(['push', 'origin', '--delete', branch]);
    },
    createBranchFromBase: async (branch, base) => {
      await git(['fetch', 'origin', base]);
      await git(['checkout', '-b', branch, 'FETCH_HEAD']);
    },
    commitEmptyStart: async (message) => void (await git(['commit', '--allow-empty', '-m', message])),
    pushBranchUpstream: async (branch) => void (await git(['push', '-u', 'origin', branch])),
  };
}

export function createRealPickupGitHub(repoDir: string): PickupGitHub {
  const gh = (args: string[]): Promise<string> => run('gh', args, repoDir);
  return {
    viewIssue: async (issue) => {
      try {
        const parsed = JSON.parse(await gh(['issue', 'view', String(issue), '--json', 'title,url']));
        if (typeof parsed?.title === 'string' && typeof parsed?.url === 'string') {
          return { title: parsed.title, url: parsed.url };
        }
        return null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) => void (await gh(['issue', 'edit', String(issue), '--add-assignee', '@me'])),
    setIssueLabel: async (issue, label, on) =>
      void (await gh(['issue', 'edit', String(issue), on ? '--add-label' : '--remove-label', label])),
    createDraftPr: async ({ base, head, title, body }) => {
      const out = await gh(['pr', 'create', '--draft', '--base', base, '--head', head, '--title', title, '--body', body]);
      return numberFromGithubUrl(out);
    },
    setPrLabel: async (pr, label, on) =>
      void (await gh(['pr', 'edit', String(pr), on ? '--add-label' : '--remove-label', label])),
  };
}

/** Remove a stale `.agent-loop/` dir under `repoDir` (best-effort; absent is fine). */
export function wipeStaleLoopDir(repoDir: string): void {
  rmSync(path.join(repoDir, '.agent-loop'), { recursive: true, force: true });
}

/** Convenience for the real wiring: build the deps with execFile-backed ports + the disk writer. */
export function createRealPickupDeps(repoDir: string, now: () => Date = () => new Date()): PickupDeps {
  return {
    git: createRealPickupGit(repoDir),
    github: createRealPickupGitHub(repoDir),
    writeState: (state) => writeLoopState(repoDir, state, now),
    wipeStaleLoopDir: () => wipeStaleLoopDir(repoDir),
  };
}
