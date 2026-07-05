import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPickup, type PickupGit, type PickupGitHub } from '../../src/main/loopPickup';
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
    createBranchFromBase: async (branch, base) => void calls.push(`branch:${branch}<-${base}`),
    commitEmptyStart: async (msg) => void calls.push(`commit:${msg.split('\n')[0]}`),
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
});
