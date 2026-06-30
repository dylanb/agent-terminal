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

/** GitHub issue facts the pickup needs for the start commit + PR title. */
export interface IssueInfo {
  title: string;
  url: string;
}

/** Git operations pickup needs, in the runner's own vocabulary (not the git CLI's). */
export interface PickupGit {
  /** True iff the tree is clean enough to bootstrap — `.agent-loop/` churn is ignored (engine parity). */
  isCleanTree(): Promise<boolean>;
  /** The branch to fork from + target the PR at; null when undiscoverable (the run then aborts). */
  resolveBaseBranch(): Promise<string | null>;
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
}

export type PickupResult =
  | { ok: true; pr: number; branch: string; status: string }
  | { ok: false; error: string };

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
 *  or a failed PR create; never throws — a thrown git/gh op resolves to `{ok:false}`. */
export async function runPickup(deps: PickupDeps, req: PickupRequest): Promise<PickupResult> {
  const { git, github, writeState, wipeStaleLoopDir } = deps;
  const fail = (error: string): PickupResult => ({ ok: false, error });
  try {
    // TODO(loop-engine): honor pickup_contract.on_conflict (e.g. wipe-and-retry on an existing
    // branch/PR). L1 handles the fresh-ticket happy path; an existing branch makes createBranchFromBase
    // fail → {ok:false}. Re-entry per on_conflict lands with resume (§26.11, L8).
    if (!(await git.isCleanTree())) return fail('working tree is not clean');

    const base = req.base ?? (await git.resolveBaseBranch());
    if (!base) return fail('could not resolve base branch');

    const branch = req.pickup.initialBranchTpl.replace('{issue}', String(req.issue));
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
    return fail((e as Error).message);
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

/** Drop `git status --porcelain` lines that touch only `.agent-loop/` (engine's filterAgentLoopStatus). */
function treeIsClean(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .every((l) => l.replace(/^.. /, '').startsWith('.agent-loop/'));
}

/** A draft-PR URL ends in `/<number>`; pull it, or null when unparseable. */
function prNumberFromUrl(url: string): number | null {
  const m = url.trim().match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export function createRealPickupGit(repoDir: string): PickupGit {
  const git = (args: string[]): Promise<string> => run('git', args, repoDir);
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
      return prNumberFromUrl(out);
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
