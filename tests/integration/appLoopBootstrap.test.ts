import { describe, expect, it, vi } from 'vitest';
import {
  createAppLoopBootstrapCoordinator,
  createAppLoopBootstrapSession,
  resolveAppGateRefs,
  runAppLoopBootstrap,
  type AppLoopBootstrapJob,
  type AppLoopBootstrapRequest,
  type AppLoopBootstrapResult,
  type AppLoopBootstrapSpec,
} from '../../src/main/appLoopBootstrap';
import type { AppLoopBootstrap } from '../../src/main/appLoopState';
import {
  AmbiguousBootstrapOperationError,
  OwnedBootstrapBranchError,
  UnresolvedRemoteBootstrapBranchError,
  type AppBootstrapConflicts,
  type AppBootstrapGit,
  type AppBootstrapGitHub,
} from '../../src/main/bootstrapPorts';
import type { AppBootstrapConflictTarget } from '../../src/shared/appBootstrap';

const PREEXISTING_OID = 'a'.repeat(40);

const bootstrap: AppLoopBootstrapSpec = {
  initialStatus: 'planning',
  wipe: { mode: 'abort' },
  branchTemplate: 'plan-loop/issue-{issue}',
  initialLabels: [
    { action: 'remove', target: 'issue', label: 'ready' },
    { action: 'add', target: 'issue', label: 'in-progress' },
    { action: 'add', target: 'pr', label: 'draft' },
  ],
};

function spec(): AppLoopBootstrapSpec {
  return {
    ...bootstrap,
    initialLabels: [...bootstrap.initialLabels],
  };
}

function fakeGit(over: { clean?: boolean; base?: string | null } = {}): {
  git: AppBootstrapGit;
  calls: string[];
  rollbackCreatedBranch(branch: string, ownedOid: string | null): Promise<void>;
  hasBranch(branch: string): boolean;
  hasRemoteBranch(branch: string): boolean;
  landRemoteBranch(branch: string, oid?: string): void;
} {
  const calls: string[] = [];
  const branches = new Set<string>();
  const remoteBranches = new Map<string, string>();
  const rollbackCreatedBranch = async (branch: string, ownedOid: string | null): Promise<void> => {
    calls.push(`rollback:${branch}@${ownedOid}`);
    if (remoteBranches.get(branch) === ownedOid) remoteBranches.delete(branch);
    branches.delete(branch);
  };
  return {
    calls,
    rollbackCreatedBranch,
    hasBranch: (branch) => branches.has(branch),
    hasRemoteBranch: (branch) => remoteBranches.has(branch),
    landRemoteBranch: (branch, oid = '1111111111111111111111111111111111111111') => {
      remoteBranches.set(branch, oid);
    },
    git: {
      isCleanTree: async () => {
        calls.push('clean');
        return over.clean ?? true;
      },
      resolveBaseBranch: async () => {
        calls.push('base');
        return over.base === undefined ? 'main' : over.base;
      },
      branchState: async (branch) => {
        calls.push(`exists:${branch}`);
        return {
          localOid: branches.has(branch) ? PREEXISTING_OID : null,
          remoteOid: remoteBranches.get(branch) ?? null,
        };
      },
      deleteBranch: async (branch, state) => {
        calls.push(`wipe:${branch}`);
        if (state.localOid !== null) branches.delete(branch);
        if (state.remoteOid !== null) remoteBranches.delete(branch);
      },
      createBranchFromBase: async (branch, base) => {
        calls.push(`branch:${branch}<-${base}`);
        branches.add(branch);
      },
      commitEmptyStart: async (message) => {
        calls.push(`commit:${message}`);
        return '1111111111111111111111111111111111111111';
      },
      pushBranchUpstream: async (branch, ownedOid) => {
        calls.push(`push:${branch}`);
        remoteBranches.set(branch, ownedOid);
        return ownedOid;
      },
      rollbackCreatedBranch,
    },
  };
}

function fakeGitHub(pr: number | null = 42): {
  github: AppBootstrapGitHub;
  calls: string[];
  prBody(): string;
  isAssigned(issue: number): boolean;
  issueHasLabel(issue: number, label: string): boolean;
  prHasLabel(number: number, label: string): boolean;
  hasOpenPr(number: number): boolean;
  landOpenPr(number: number, body: string): void;
} {
  const calls: string[] = [];
  let body = '';
  const assigned = new Set<number>();
  const issueLabels = new Map<number, Set<string>>([[78, new Set(['ready'])]]);
  const prLabels = new Map<number, Set<string>>();
  const openPrs = new Set<number>();
  const prBodies = new Map<number, string>();
  return {
    calls,
    prBody: () => body,
    isAssigned: (issue) => assigned.has(issue),
    issueHasLabel: (issue, label) => issueLabels.get(issue)?.has(label) ?? false,
    prHasLabel: (number, label) => prLabels.get(number)?.has(label) ?? false,
    hasOpenPr: (number) => openPrs.has(number),
    landOpenPr: (number, prBody) => {
      openPrs.add(number);
      prBodies.set(number, prBody);
    },
    github: {
      viewIssue: async (issue) => {
        calls.push(`view:${issue}`);
        return { title: `Ticket ${issue}`, url: `https://example.test/issues/${issue}` };
      },
      assignIssueToSelf: async (issue) => {
        calls.push(`assign:${issue}`);
        assigned.add(issue);
      },
      setIssueLabel: async (issue, label, on) => {
        calls.push(`issue-label:${on ? '+' : '-'}${label}@${issue}`);
        const labels = issueLabels.get(issue) ?? new Set<string>();
        if (on) labels.add(label);
        else labels.delete(label);
        issueLabels.set(issue, labels);
      },
      createDraftPr: async (args) => {
        body = args.body;
        calls.push(`pr:${args.base}<-${args.head}:${args.title}`);
        if (pr === null) {
          throw new AmbiguousBootstrapOperationError('draft PR creation failed');
        }
        openPrs.add(pr);
        prBodies.set(pr, args.body);
        return pr;
      },
      findOwnedOpenPr: async ({ base, head, marker }) => {
        calls.push(`find-pr:${base}<-${head}`);
        const owned = [...openPrs].find((number) => prBodies.get(number)?.includes(marker));
        if (owned !== undefined) return { kind: 'owned', number: owned };
        return openPrs.size === 0 ? { kind: 'absent' } : { kind: 'foreign' };
      },
      closePr: async (number) => {
        calls.push(`close-pr:${number}`);
        openPrs.delete(number);
        prBodies.delete(number);
      },
      setPrLabel: async (number, label, on) => {
        calls.push(`pr-label:${on ? '+' : '-'}${label}@${number}`);
        const labels = prLabels.get(number) ?? new Set<string>();
        if (on) labels.add(label);
        else labels.delete(label);
        prLabels.set(number, labels);
      },
    },
  };
}

function target(
  over: Partial<AppBootstrapConflictTarget> = {},
): AppBootstrapConflictTarget {
  return {
    repository: 'github.com/owner/repository',
    branch: 'plan-loop/issue-78',
    localOid: '1'.repeat(40),
    remoteOid: '2'.repeat(40),
    pullRequests: [321],
    ...over,
  };
}

function noTarget(branch = 'plan-loop/issue-78'): AppBootstrapConflictTarget {
  return {
    repository: 'github.com/owner/repository',
    branch,
    localOid: null,
    remoteOid: null,
    pullRequests: [],
  };
}

function fakeConflicts(initial = noTarget()): {
  conflicts: AppBootstrapConflicts;
  wiped: AppBootstrapConflictTarget[];
  failWipe(error: unknown): void;
} {
  let current = structuredClone(initial);
  let wipeError: unknown;
  const wiped: AppBootstrapConflictTarget[] = [];
  return {
    wiped,
    failWipe(error) {
      wipeError = error;
    },
    conflicts: {
      inspect: async () => structuredClone(current),
      wipe: async (confirmed) => {
        if (wipeError !== undefined) throw wipeError;
        wiped.push(structuredClone(confirmed));
        current = noTarget(confirmed.branch);
      },
    },
  };
}

function runnerDeps(
  g: ReturnType<typeof fakeGit>,
  h: ReturnType<typeof fakeGitHub>,
  writeBootstrap: (identity: AppLoopBootstrap) => void = () => {},
  prepareBootstrap: (identity: Omit<AppLoopBootstrap, 'pr'>) => void = () => {},
  clearBootstrap: () => void = () => {},
  conflicts: ReturnType<typeof fakeConflicts> = fakeConflicts(),
) {
  return {
    git: g.git,
    github: h.github,
    conflicts: conflicts.conflicts,
    writeBootstrap,
    prepareBootstrap,
    clearBootstrap,
  };
}

const wipeSpec = (): AppLoopBootstrapSpec => ({
  ...spec(),
  wipe: { mode: 'wipe-and-retry' },
});

function completed(result: AppLoopBootstrapResult) {
  if (result.ok) return result;
  throw new Error(
    'conflict' in result
      ? `expected a completed bootstrap, got a conflict for ${result.conflict.branch}`
      : result.error,
  );
}

function failed(result: AppLoopBootstrapResult) {
  if (result.ok) throw new Error('expected a failed bootstrap, got a completed one');
  if ('conflict' in result) {
    throw new Error(`expected a failed bootstrap, got a conflict for ${result.conflict.branch}`);
  }
  return result;
}

const request = (over: Partial<Parameters<typeof runAppLoopBootstrap>[1]> = {}) => ({
  issue: 78,
  spec: spec(),
  ...over,
});

describe('runAppLoopBootstrap (§27.10 ST2)', () => {
  it('runs the def-declared bootstrap and persists only the app-owned bootstrap identity', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    let written: AppLoopBootstrap | null = null;
    const deps = runnerDeps(
      g,
      h,
      (identity) => {
        written = identity;
      },
    );

    const result = await runAppLoopBootstrap(deps, request());

    expect(result).toMatchObject({
      ok: true,
      identity: {
        pr: 42,
        branch: 'plan-loop/issue-78',
        issue: 78,
        initialStatus: 'planning',
      },
    });
    expect(g.hasBranch('plan-loop/issue-78')).toBe(true);
    expect(g.hasRemoteBranch('plan-loop/issue-78')).toBe(true);
    expect(g.calls).toContain(
      'commit:[skip ci] start work on #78\n\nSee https://example.test/issues/78',
    );
    expect(h.prBody()).toContain('closes #78');
    expect(h.isAssigned(78)).toBe(false);
    await createAppLoopBootstrapSession(deps).finalize(request(), completed(result).identity);
    expect(h.isAssigned(78)).toBe(true);
    expect(h.issueHasLabel(78, 'ready')).toBe(false);
    expect(h.issueHasLabel(78, 'in-progress')).toBe(true);
    expect(h.prHasLabel(42, 'draft')).toBe(true);
    expect(written).toEqual({
      pr: 42,
      branch: 'plan-loop/issue-78',
      issue: 78,
      initialStatus: 'planning',
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid issue identity %s before running git/gh',
    async (issue) => {
      const g = fakeGit();
      const h = fakeGitHub();
      const result = await runAppLoopBootstrap(
        runnerDeps(g, h),
        request({ issue }),
      );
      expect(result).toEqual({ ok: false, kind: 'error' as const, error: expect.stringMatching(/issue/i) });
      expect(g.calls).toEqual([]);
      expect(h.calls).toEqual([]);
    },
  );

  it('rejects a blank initial status before running git or GitHub', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const blank = spec();
    blank.initialStatus = ' \t ';

    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({ spec: blank }),
    );

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: expect.stringMatching(/initial status/i) });
    expect(g.calls).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('rejects an unsafe def-derived branch before branch mutation or issue/PR work', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const unsafe = spec();
    unsafe.branchTemplate = '--upload-pack=evil-{issue}';
    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({ spec: unsafe }),
    );
    expect(result).toEqual({ ok: false, kind: 'error' as const, error: expect.stringMatching(/unsafe branch/i) });
    expect(g.calls.some((call) => /^(exists|branch|commit|push):/.test(call))).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it.each([
    { name: 'dirty tree', git: { clean: false }, error: /not clean/ },
    { name: 'unresolvable base', git: { base: null }, error: /base branch/ },
  ])('fails safely for $name without opening a PR', async ({ git, error }) => {
    const g = fakeGit(git);
    const h = fakeGitHub();
    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request(),
    );
    expect(result).toEqual({ ok: false, kind: 'error' as const, error: expect.stringMatching(error) });
    expect(h.calls.some((call) => call.startsWith('pr:'))).toBe(false);
  });

  it('detects a wipe-authorized conflict without deleting anything before confirmation', async () => {
    const h = fakeGitHub();
    const conflicts = fakeConflicts(target());

    const result = await runAppLoopBootstrap(
      runnerDeps(fakeGit(), h, undefined, undefined, undefined, conflicts),
      request({ spec: wipeSpec() }),
    );

    expect(result).toEqual({ ok: false, kind: 'conflict' as const, conflict: target() });
    expect(conflicts.wiped).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('hard-fails a conflict with no wipe policy instead of offering a destructive decision', async () => {
    const conflicts = fakeConflicts(target());

    const result = await runAppLoopBootstrap(
      runnerDeps(fakeGit(), fakeGitHub(), undefined, undefined, undefined, conflicts),
      request(),
    );

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: expect.stringMatching(/already exists/i) });
    expect(conflicts.wiped).toEqual([]);
  });

  // The authorizing policy is re-read at the destructive operation, not merely at the prompt that
  // produced the confirmation, so a def edited between the two cannot license a wipe.
  it('re-checks the wipe policy at the destructive operation before touching git or gh', async () => {
    const g = fakeGit();
    const h = fakeGitHub();

    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({ confirmedWipe: target() }),
    );

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: expect.stringMatching(/wipe policy/i) });
    expect(g.calls).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('wipes only the exact confirmed resources, then recreates the bootstrap', async () => {
    const conflicts = fakeConflicts(target());

    const result = await runAppLoopBootstrap(
      runnerDeps(fakeGit(), fakeGitHub(), undefined, undefined, undefined, conflicts),
      request({ spec: wipeSpec(), confirmedWipe: target() }),
    );

    expect(result).toMatchObject({
      ok: true,
      identity: { pr: 42, branch: 'plan-loop/issue-78', issue: 78 },
    });
    expect(conflicts.wiped).toEqual([target()]);
  });

  it('refuses a confirmation naming a different branch before any operation', async () => {
    const g = fakeGit();
    const h = fakeGitHub();

    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({ spec: wipeSpec(), confirmedWipe: target({ branch: 'other/branch' }) }),
    );

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: expect.stringMatching(/different branch/i) });
    expect(g.calls).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('requires fresh confirmation when any destructive target changes', async () => {
    const g = fakeGit();
    const moved = target({ remoteOid: '3'.repeat(40), pullRequests: [321, 654] });
    const conflicts = fakeConflicts(moved);

    const result = await runAppLoopBootstrap(
      runnerDeps(g, fakeGitHub(), undefined, undefined, undefined, conflicts),
      request({ spec: wipeSpec(), confirmedWipe: target() }),
    );

    expect(result).toEqual({ ok: false, kind: 'conflict' as const, conflict: moved });
    expect(conflicts.wiped).toEqual([]);
    expect(g.calls.some((call) => call.startsWith('branch:'))).toBe(false);
  });

  it('does not recreate the branch when the exact wipe fails', async () => {
    const g = fakeGit();
    const conflicts = fakeConflicts(target());
    conflicts.failWipe(new Error('PR #321 could not be closed'));

    const result = await runAppLoopBootstrap(
      runnerDeps(g, fakeGitHub(), undefined, undefined, undefined, conflicts),
      request({ spec: wipeSpec(), confirmedWipe: target() }),
    );

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: 'PR #321 could not be closed' });
    expect(g.calls.some((call) => call.startsWith('branch:'))).toBe(false);
  });

  it('fails when draft PR creation is rejected and writes no bootstrap identity', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.github.createDraftPr = async () => {
      throw new Error('draft PR creation rejected');
    };
    const rollback = vi.fn(g.git.rollbackCreatedBranch);
    g.git.rollbackCreatedBranch = rollback;
    const writeBootstrap = vi.fn();
    const result = await runAppLoopBootstrap(
      runnerDeps(g, h, writeBootstrap),
      request(),
    );
    expect(result).toEqual({ ok: false, kind: 'error' as const, error: expect.stringMatching(/PR creation/i) });
    expect(writeBootstrap).not.toHaveBeenCalled();
    expect(g.hasBranch('plan-loop/issue-78')).toBe(false);
    expect(h.isAssigned(78)).toBe(false);
    expect(h.issueHasLabel(78, 'ready')).toBe(true);
    expect(h.issueHasLabel(78, 'in-progress')).toBe(false);
    expect(rollback).toHaveBeenCalledWith(
      'plan-loop/issue-78',
      '1111111111111111111111111111111111111111',
    );
  });

  it('reconciles an owned remote branch when push lands but reports failure', async () => {
    const g = fakeGit();
    g.git.pushBranchUpstream = async () => {
      g.landRemoteBranch('plan-loop/issue-78');
      throw new Error('branch push failed');
    };
    const rollback = vi.fn(g.git.rollbackCreatedBranch);
    g.git.rollbackCreatedBranch = rollback;

    const result = await runAppLoopBootstrap(runnerDeps(g, fakeGitHub()), request());

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: 'branch push failed' });
    expect(rollback).toHaveBeenCalledWith(
      'plan-loop/issue-78',
      '1111111111111111111111111111111111111111',
    );
    expect(g.hasRemoteBranch('plan-loop/issue-78')).toBe(false);
  });

  it('removes its local branch when the initial commit fails before an owned OID exists', async () => {
    const g = fakeGit();
    g.git.commitEmptyStart = async () => {
      throw new Error('initial commit failed');
    };
    const rollback = vi.fn(g.git.rollbackCreatedBranch);
    g.git.rollbackCreatedBranch = rollback;

    const result = await runAppLoopBootstrap(runnerDeps(g, fakeGitHub()), request());

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: 'initial commit failed' });
    expect(rollback).toHaveBeenCalledWith('plan-loop/issue-78', null);
    expect(g.hasBranch('plan-loop/issue-78')).toBe(false);
    expect(g.hasRemoteBranch('plan-loop/issue-78')).toBe(false);
  });

  it('compensates a branch ref created before checkout reports failure', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const createBranch = g.git.createBranchFromBase;
    g.git.createBranchFromBase = async (branch, base) => {
      await createBranch(branch, base);
      throw new OwnedBootstrapBranchError('branch checkout failed');
    };
    const rollback = vi.fn(g.git.rollbackCreatedBranch);
    g.git.rollbackCreatedBranch = rollback;

    const result = await runAppLoopBootstrap(runnerDeps(g, h), request());

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: 'branch checkout failed' });
    expect(rollback).toHaveBeenCalledWith('plan-loop/issue-78', null);
    expect(g.hasBranch('plan-loop/issue-78')).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('closes its draft PR before branch compensation when the completed identity cannot persist', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const trace: string[] = [];
    const originalRollback = g.git.rollbackCreatedBranch;
    const rollback = vi.fn(async (branch: string, oid: string | null) => {
      trace.push('rollback-branch');
      expect(h.hasOpenPr(42)).toBe(false);
      await originalRollback(branch, oid);
    });
    g.git.rollbackCreatedBranch = rollback;
    const originalClose = h.github.closePr;
    h.github.closePr = async (pr) => {
      trace.push('close-pr');
      await originalClose(pr);
    };

    const result = await runAppLoopBootstrap(
      runnerDeps(g, h, () => {
        throw new Error('ENOSPC while writing bootstrap identity');
      }),
      request(),
    );

    expect(result).toEqual({
      ok: false,
      kind: 'error',
      error: 'ENOSPC while writing bootstrap identity',
    });
    expect(h.calls).toContain('close-pr:42');
    expect(h.hasOpenPr(42)).toBe(false);
    expect(h.isAssigned(78)).toBe(false);
    expect(h.issueHasLabel(78, 'ready')).toBe(true);
    expect(h.issueHasLabel(78, 'in-progress')).toBe(false);
    expect(rollback).toHaveBeenCalledWith(
      'plan-loop/issue-78',
      '1111111111111111111111111111111111111111',
    );
    expect(trace).toEqual(['close-pr', 'rollback-branch']);
  });

  it('reconciles and closes a draft PR that lands before create reports a transport failure', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const create = h.github.createDraftPr;
    h.github.createDraftPr = async (args) => {
      await create(args);
      throw new AmbiguousBootstrapOperationError('draft PR creation failed');
    };

    const result = await runAppLoopBootstrap(runnerDeps(g, h), request());

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: 'draft PR creation failed' });
    expect(h.calls).toContain('find-pr:main<-plan-loop/issue-78');
    expect(h.calls).toContain('close-pr:42');
    expect(h.hasOpenPr(42)).toBe(false);
    expect(g.hasBranch('plan-loop/issue-78')).toBe(false);
  });

  it('keeps ambiguous PR ownership after the first absent reconciliation read', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.github.createDraftPr = async () => {
      throw new AmbiguousBootstrapOperationError('draft PR transport failed');
    };

    const result = await runAppLoopBootstrap(runnerDeps(g, h), request());

    expect(result).toMatchObject({
      ok: false,
      requiresAttention: true,
      error: expect.stringMatching(/transport failed.*not yet stable/i),
      recovery: { pr: { kind: 'ambiguous', absentChecks: 1 } },
    });
    expect(h.calls).toContain('find-pr:main<-plan-loop/issue-78');
    expect(g.hasBranch('plan-loop/issue-78')).toBe(true);
  });

  it('reconciles a marked PR that appears after the first absent lookup', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    let body = '';
    let creates = 0;
    h.github.createDraftPr = async (args) => {
      creates += 1;
      if (creates === 1) {
        body = args.body;
        throw new AmbiguousBootstrapOperationError('draft PR transport failed');
      }
      return 43;
    };
    const session = createAppLoopBootstrapSession(runnerDeps(g, h));
    const first = await session.run(request());
    expect(first).toMatchObject({ ok: false, requiresAttention: true });
    h.landOpenPr(42, body);

    const second = await session.run(request());

    expect(second).toMatchObject({ ok: true, identity: { pr: 43 } });
    expect(h.calls).toContain('close-pr:42');
    expect(h.hasOpenPr(42)).toBe(false);
  });

  it('does not claim an unmarked collaborator PR after an ambiguous create failure', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.landOpenPr(99, 'collaborator-authored body');
    h.github.createDraftPr = async () => {
      throw new AmbiguousBootstrapOperationError('draft PR transport failed');
    };
    const rollback = vi.fn(g.git.rollbackCreatedBranch);
    g.git.rollbackCreatedBranch = rollback;

    const result = await runAppLoopBootstrap(runnerDeps(g, h), request());

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/transport failed.*conflicts with another open PR/i),
      requiresAttention: true,
    });
    expect(h.hasOpenPr(99)).toBe(true);
    expect(rollback).not.toHaveBeenCalled();
    expect(g.hasBranch('plan-loop/issue-78')).toBe(true);
  });

  it('retains exact recovery metadata when PR reconciliation itself fails', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.github.createDraftPr = async () => {
      throw new AmbiguousBootstrapOperationError('draft PR transport failed');
    };
    h.github.findOwnedOpenPr = async () => {
      throw new Error('GitHub lookup unavailable');
    };
    const rollback = vi.fn(g.git.rollbackCreatedBranch);
    g.git.rollbackCreatedBranch = rollback;

    const result = await runAppLoopBootstrap(runnerDeps(g, h), request());

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/transport failed.*lookup unavailable/i),
      requiresAttention: true,
      recovery: {
        branch: 'plan-loop/issue-78',
        ownedOid: '1111111111111111111111111111111111111111',
        pr: { kind: 'ambiguous' },
      },
    });
    expect(rollback).not.toHaveBeenCalled();
  });

  it('retains the branch when closing the owned PR fails', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.github.closePr = async () => {
      throw new Error('GitHub close unavailable');
    };
    const rollback = vi.fn(g.git.rollbackCreatedBranch);
    g.git.rollbackCreatedBranch = rollback;

    const result = await runAppLoopBootstrap(
      runnerDeps(g, h, () => {
        throw new Error('bootstrap state is unwritable');
      }),
      request(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/state is unwritable.*close unavailable/i),
      requiresAttention: true,
      recovery: {
        branch: 'plan-loop/issue-78',
        pr: { kind: 'known', number: 42 },
      },
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(g.hasBranch('plan-loop/issue-78')).toBe(true);
  });

  it('validates the bootstrap journal target before mutating git or GitHub state', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const result = await runAppLoopBootstrap(
      runnerDeps(
        g,
        h,
        () => {},
        () => {
          throw new Error('EISDIR: bootstrap.yaml is a directory');
        },
      ),
      request(),
    );

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: expect.stringMatching(/bootstrap\.yaml is a directory/i) });
    expect(g.calls.some((call) => /^(branch|commit|push):/.test(call))).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('keeps assignment and label failures best-effort while completing the critical bootstrap', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.github.assignIssueToSelf = async () => Promise.reject('assignment rejected');
    h.github.setIssueLabel = async () => Promise.reject('issue label rejected');
    h.github.setPrLabel = async () => Promise.reject('PR label rejected');
    let written: AppLoopBootstrap | null = null;

    const deps = runnerDeps(g, h, (identity) => {
        written = identity;
      });
    const result = await runAppLoopBootstrap(deps, request());
    await createAppLoopBootstrapSession(deps).finalize(request(), completed(result).identity);

    expect(result).toMatchObject({
      ok: true,
      identity: {
        pr: 42,
        branch: 'plan-loop/issue-78',
        issue: 78,
        initialStatus: 'planning',
      },
    });
    expect(g.hasBranch('plan-loop/issue-78')).toBe(true);
    expect(written).toEqual({
      pr: 42,
      branch: 'plan-loop/issue-78',
      issue: 78,
      initialStatus: 'planning',
    });
  });

  it('compensates the created branch when persisting the completed identity fails', async () => {
    const g = fakeGit();
    const result = await runAppLoopBootstrap(
      runnerDeps(g, fakeGitHub(), () => {
        throw new Error('bootstrap state is unwritable');
      }),
      request(),
    );

    expect(result).toEqual({ ok: false, kind: 'error' as const, error: 'bootstrap state is unwritable' });
    expect(g.hasBranch('plan-loop/issue-78')).toBe(false);
  });

  it('surfaces a failed compensating rollback together with the bootstrap failure', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.github.createDraftPr = async () => {
      throw new Error('draft PR creation failed');
    };
    g.git.rollbackCreatedBranch = async () => Promise.reject('cleanup exploded');
    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/draft PR creation failed.*cleanup exploded/i),
      requiresAttention: true,
    });
    expect(g.hasBranch('plan-loop/issue-78')).toBe(true);
  });

  it('coerces a non-Error rejection into the surfaced reason', async () => {
    const g = fakeGit();
    g.git.isCleanTree = () => Promise.reject('git exploded');
    const result = await runAppLoopBootstrap(
      runnerDeps(g, fakeGitHub()),
      request(),
    );
    expect(result).toEqual({ ok: false, kind: 'error' as const, error: 'git exploded' });
  });

  it('retries retained in-process compensation before the next bootstrap attempt', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.github.createDraftPr = async () => {
      throw new Error('draft PR creation failed');
    };
    const rollback = g.git.rollbackCreatedBranch;
    let attempts = 0;
    g.git.rollbackCreatedBranch = async (branch, oid) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient remote failure');
      await rollback(branch, oid);
    };
    const session = createAppLoopBootstrapSession(runnerDeps(g, h));

    const first = await session.run(request());
    expect(first).toMatchObject({ ok: false, requiresAttention: true });
    expect(g.hasBranch('plan-loop/issue-78')).toBe(true);

    h.github.createDraftPr = async () => 42;
    const second = await session.run(request());

    expect(second).toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });

  it('does not permanently gate later bootstraps after terminal remote ownership ambiguity', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.github.createDraftPr = async () => {
      throw new Error('draft PR creation failed');
    };
    const rollback = g.git.rollbackCreatedBranch;
    let firstRollback = true;
    g.git.rollbackCreatedBranch = async (branch, oid) => {
      await rollback(branch, oid);
      if (firstRollback) {
        firstRollback = false;
        throw new UnresolvedRemoteBootstrapBranchError(
          'initial push ownership is ambiguous',
        );
      }
    };
    const session = createAppLoopBootstrapSession(runnerDeps(g, h));

    const first = await session.run(request());
    expect(first).toMatchObject({ ok: false, requiresAttention: true });
    expect(failed(first).recovery).toBeUndefined();

    h.github.createDraftPr = async () => 42;
    const second = await session.run(request());

    expect(second).toMatchObject({ ok: true });
  });

  it('clears a completed journal when retryable compensation later becomes terminal', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const clearBootstrap = vi.fn();
    const rollback = g.git.rollbackCreatedBranch;
    let attempts = 0;
    g.git.rollbackCreatedBranch = async (branch, oid) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient remote probe failure');
      await rollback(branch, oid);
      throw new UnresolvedRemoteBootstrapBranchError(
        'remote branch ownership is now terminally ambiguous',
      );
    };
    const session = createAppLoopBootstrapSession(
      runnerDeps(g, h, () => {}, () => {}, clearBootstrap),
    );
    const accepted = await session.run(request());
    await expect(session.compensate(completed(accepted).ownership)).rejects.toThrow(
      /transient remote probe failure/i,
    );

    const recovery = await session.run(request());

    expect(recovery).toMatchObject({
      ok: false,
      requiresAttention: true,
      error: expect.stringMatching(/terminally ambiguous/i),
    });
    expect(failed(recovery).recovery).toBeUndefined();
    expect(clearBootstrap).toHaveBeenCalledTimes(1);
  });

  it('finishes a failed accepted-bootstrap compensation before starting the next attempt', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const clearBootstrap = vi.fn();
    const trace: string[] = [];
    const closePr = h.github.closePr;
    let closeAttempts = 0;
    h.github.closePr = async (number) => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('transient PR close failure');
      await closePr(number);
    };
    const session = createAppLoopBootstrapSession(
      runnerDeps(
        g,
        h,
        () => {},
        () => trace.push('prepare'),
        () => {
          trace.push('clear');
          clearBootstrap();
        },
      ),
    );
    const first = await session.run(request());
    await expect(session.compensate(completed(first).ownership)).rejects.toThrow(/close failure/i);
    trace.length = 0;
    const second = await session.run(request());

    expect(second).toMatchObject({ ok: true });
    expect(closeAttempts).toBe(2);
    expect(clearBootstrap).toHaveBeenCalledTimes(1);
    expect(trace.slice(0, 2)).toEqual(['clear', 'prepare']);
  });
});

describe('resolveAppGateRefs — live bootstrap identity routing', () => {
  const identity: AppLoopBootstrap = {
    pr: 42,
    branch: 'plan-loop/issue-78',
    issue: 78,
    initialStatus: 'planning',
  };

  it('supplies the generated PR to the matching ticket gate', () => {
    expect(resolveAppGateRefs({ ticket: 78 }, identity)).toEqual({ pr: 42, ticket: 78, bootstrap: identity });
  });

  it('keeps the accepted issue authoritative over mutable flow refs', () => {
    expect(resolveAppGateRefs({ ticket: 79 }, identity)).toEqual({ pr: 42, ticket: 78, bootstrap: identity });
  });

  it('keeps the accepted bootstrap PR authoritative over mutable flow state', () => {
    expect(resolveAppGateRefs({ ticket: 78, pr: 99 }, identity)).toEqual({ pr: 42, ticket: 78, bootstrap: identity });
  });

  it('carries the accepted identity into the gate side-effect context', () => {
    expect(resolveAppGateRefs({ ticket: 78 }, identity).bootstrap).toBe(identity);
  });

  it('reports no identity to the gate when nothing was accepted', () => {
    expect(resolveAppGateRefs({ ticket: 78 }, null)).toEqual({ pr: null, ticket: 78, bootstrap: null });
  });
});

function job(over: Partial<AppLoopBootstrapJob> = {}): AppLoopBootstrapJob {
  return {
    repoDir: '/repo',
    stepId: 'plan',
    loopName: 'plan-loop',
    issue: 78,
    entryToken: 1,
    entry: 'chain-advance',
    bootstrap: spec(),
    ...over,
  };
}

describe('createAppLoopBootstrapCoordinator — async step identity + rollback (ST2 AC4/AC7)', () => {
  const successOwnership = {
    base: 'main',
    branch: 'plan-loop/issue-78',
    ownedOid: '1111111111111111111111111111111111111111',
    pr: { kind: 'known' as const, number: 42 },
  };
  const success: AppLoopBootstrapResult = {
    ok: true,
    identity: {
      pr: 42,
      branch: 'plan-loop/issue-78',
      issue: 78,
      initialStatus: 'planning',
    },
    ownership: successOwnership,
  };

  function coordinator(result: AppLoopBootstrapResult) {
    const enterWork = vi.fn(() => 'entered' as const);
    const rollbackStep = vi.fn(() => true);
    const emitError = vi.fn();
    const audit = vi.fn();
    const acceptBootstrap = vi.fn();
    const compensateBootstrap = vi.fn(async () => {});
    const finalizeBootstrap = vi.fn(async () => {});
    let current = true;
    const c = createAppLoopBootstrapCoordinator({
      run: async () => result,
      compensateBootstrap,
      finalizeBootstrap,
      hasBootstrapForJob: () => false,
      isCurrentJob: (candidate) => current && candidate.stepId === 'plan' && candidate.entryToken === 1,
      canEnterWork: () => true,
      acceptBootstrap,
      rollbackStep,
      enterWork,
      emitError,
      emitConflict: vi.fn(),
      audit,
    });
    return {
      c,
      enterWork,
      rollbackStep,
      emitError,
      emitConflict: vi.fn(),
      audit,
      acceptBootstrap,
      compensateBootstrap,
      finalizeBootstrap,
      moveAway: () => (current = false),
    };
  }

  it('enters work immediately when the def declares no pickup', () => {
    const x = coordinator(success);
    x.c.enter(job({ bootstrap: null }));
    expect(x.enterWork).toHaveBeenCalledWith('/repo', 'plan-loop', 'plan', 'chain-advance');
  });

  it('enters work after a successful pickup only while the named step is still current', async () => {
    const x = coordinator(success);
    x.c.enter(job());
    await vi.waitFor(() => expect(x.enterWork).toHaveBeenCalledWith('/repo', 'plan-loop', 'plan', 'chain-advance'));
    expect(x.rollbackStep).not.toHaveBeenCalled();
    expect(x.finalizeBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ repoDir: '/repo', entryToken: 1 }),
      success.identity,
    );
  });

  it('runs at most one bootstrap while the same repo step is already in flight', async () => {
    let finish!: (result: AppLoopBootstrapResult) => void;
    const run = vi.fn(
      () =>
        new Promise<AppLoopBootstrapResult>((resolve) => {
          finish = resolve;
        }),
    );
    const enterWork = vi.fn(() => 'entered' as const);
    const audit = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep: () => true,
      enterWork,
      emitError: vi.fn(),
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job());
    c.enter(job());

    expect(run).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    finish(success);
    await vi.waitFor(() => expect(enterWork).toHaveBeenCalledTimes(1));
    expect(audit.mock.calls).toEqual([
      ['/repo', 'start', 'plan'],
      ['/repo', 'success', 'plan', 'plan-loop/issue-78'],
    ]);
  });

  it('holds one global bootstrap lease across repositories and drains fast-path entries in order', async () => {
    const finishes: Array<(result: AppLoopBootstrapResult) => void> = [];
    const run = vi.fn(
      () =>
        new Promise<AppLoopBootstrapResult>((resolve) => {
          finishes.push(resolve);
        }),
    );
    const enterWork = vi.fn(() => 'entered' as const);
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep: vi.fn(() => true),
      enterWork,
      emitError: vi.fn(),
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });

    c.enter(job({ repoDir: '/repo-a' }));
    c.enter(job({ repoDir: '/repo-b', bootstrap: null }));
    c.enter(job({ repoDir: '/repo-c' }));

    expect(run).toHaveBeenCalledTimes(1);
    finishes[0](success);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(enterWork).toHaveBeenCalledWith(
      '/repo-b',
      'plan-loop',
      'plan',
      'chain-advance',
    );

    finishes[1](success);
    await vi.waitFor(() => expect(enterWork).toHaveBeenCalledTimes(3));
  });

  it('serializes repo bootstrap work and rejects an old occurrence after leave-and-return ABA', async () => {
    const finishes: Array<(result: AppLoopBootstrapResult) => void> = [];
    const run = vi.fn(
      () =>
        new Promise<AppLoopBootstrapResult>((resolve) => {
          finishes.push(resolve);
        }),
    );
    let currentToken = 1;
    const enterWork = vi.fn(() => 'entered' as const);
    const acceptBootstrap = vi.fn();
    const emitError = vi.fn();
    const audit = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: (candidate) => candidate.entryToken === currentToken,
      canEnterWork: () => true,
      acceptBootstrap,
      rollbackStep: vi.fn(() => true),
      enterWork,
      emitError,
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job({ entryToken: 1, issue: 78 }));
    currentToken = 2;
    c.enter(job({ entryToken: 2, issue: 79 }));

    expect(run).toHaveBeenCalledTimes(1);
    finishes[0](success);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(acceptBootstrap).not.toHaveBeenCalled();
    expect(enterWork).not.toHaveBeenCalled();
    expect(emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: expect.stringMatching(/completed after.*moved|no longer current/i),
    });

    finishes[1]({
      ok: true,
      identity: {
        pr: 43,
        branch: 'plan-loop/issue-79',
        issue: 79,
        initialStatus: 'planning',
      },
      ownership: {
        ...successOwnership,
        branch: 'plan-loop/issue-79',
        pr: { kind: 'known', number: 43 },
      },
    });
    await vi.waitFor(() => expect(enterWork).toHaveBeenCalledTimes(1));
    expect(acceptBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ entryToken: 2, issue: 79 }),
      {
        pr: 43,
        branch: 'plan-loop/issue-79',
        issue: 79,
        initialStatus: 'planning',
      },
    );
  });

  it('drops a queued no-pickup entry after its exact occurrence becomes stale', async () => {
    let finish!: (result: AppLoopBootstrapResult) => void;
    const run = vi.fn(
      () =>
        new Promise<AppLoopBootstrapResult>((resolve) => {
          finish = resolve;
        }),
    );
    let currentToken = 1;
    const enterWork = vi.fn(() => 'entered' as const);
    const audit = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: (candidate) => candidate.entryToken === currentToken,
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep: vi.fn(() => true),
      enterWork,
      emitError: vi.fn(),
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job({ entryToken: 1 }));
    currentToken = 2;
    c.enter(job({ entryToken: 2, bootstrap: null }));
    currentToken = 3;
    finish({ ok: false, kind: 'error' as const, error: 'late failure' });

    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith('/repo', 'stale', 'plan'));
    expect(enterWork).not.toHaveBeenCalled();
  });

  it('reuses a completed bootstrap only for the same entry occurrence', () => {
    const enterWork = vi.fn(() => 'entered' as const);
    const run = vi.fn(async () => success);
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: (candidate) => candidate.entryToken === 1 && candidate.issue === 78,
      isCurrentJob: () => true,
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep: () => true,
      enterWork,
      emitError: vi.fn(),
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });

    c.enter(job());

    expect(run).not.toHaveBeenCalled();
    expect(enterWork).toHaveBeenCalledWith('/repo', 'plan-loop', 'plan', 'chain-advance');
  });

  it('treats a pickup-bearing step with no positive ticket identity as an async bootstrap failure', async () => {
    const x = coordinator(success);
    x.c.enter(job({ issue: null }));
    await vi.waitFor(() =>
      expect(x.rollbackStep).toHaveBeenCalledWith(
        expect.objectContaining({ repoDir: '/repo', stepId: 'plan', entryToken: 1 }),
      ),
    );
    expect(x.emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: expect.stringMatching(/ticket|issue/i),
    });
    expect(x.enterWork).not.toHaveBeenCalled();
  });

  it('compensates a stale success instead of entering work against a different step', async () => {
    const x = coordinator(success);
    x.c.enter(job());
    x.moveAway();
    await vi.waitFor(() => expect(x.emitError).toHaveBeenCalled());
    expect(x.enterWork).not.toHaveBeenCalled();
    expect(x.rollbackStep).not.toHaveBeenCalled();
    expect(x.acceptBootstrap).not.toHaveBeenCalled();
    expect(x.finalizeBootstrap).not.toHaveBeenCalled();
    expect(x.compensateBootstrap).toHaveBeenCalledWith(expect.anything(), successOwnership);
    expect(x.emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: expect.stringMatching(/completed after.*moved|no longer current/i),
    });
  });

  it('compensates and rolls back when exact-step verification fails after bootstrap succeeds', async () => {
    let finish!: (result: AppLoopBootstrapResult) => void;
    const run = vi.fn(
      () =>
        new Promise<AppLoopBootstrapResult>((resolve) => {
          finish = resolve;
        }),
    );
    let checks = 0;
    const compensateBootstrap = vi.fn(async () => {});
    const rollbackStep = vi.fn(() => true);
    const enterWork = vi.fn(() => 'entered' as const);
    const acceptBootstrap = vi.fn();
    const emitError = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap,
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => {
        checks += 1;
        if (checks >= 3) throw new Error('flow state unreadable after bootstrap');
        return true;
      },
      canEnterWork: () => true,
      acceptBootstrap,
      rollbackStep,
      enterWork,
      emitError,
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });

    c.enter(job());
    finish(success);

    await vi.waitFor(() =>
      expect(compensateBootstrap).toHaveBeenCalledWith(
        expect.objectContaining({ repoDir: '/repo', entryToken: 1 }),
        successOwnership,
      ),
    );
    expect(rollbackStep).toHaveBeenCalledWith(
      expect.objectContaining({ repoDir: '/repo', stepId: 'plan', entryToken: 1 }),
    );
    expect(enterWork).not.toHaveBeenCalled();
    expect(acceptBootstrap).not.toHaveBeenCalled();
    expect(emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: expect.stringMatching(/could not verify bootstrap step.*unreadable after bootstrap/i),
    });
  });

  it('does not start external bootstrap work while the app loop runner is busy', () => {
    const run = vi.fn(async () => success);
    const rollbackStep = vi.fn(() => true);
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => false,
      acceptBootstrap: vi.fn(),
      rollbackStep,
      enterWork: vi.fn(() => 'busy' as const),
      emitError: vi.fn(),
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });

    c.enter(job());

    expect(run).not.toHaveBeenCalled();
    expect(rollbackStep).toHaveBeenCalledWith(
      expect.objectContaining({ repoDir: '/repo', stepId: 'plan', entryToken: 1 }),
    );
  });

  it('rolls back when exact-step verification itself fails', () => {
    const run = vi.fn(async () => success);
    const rollbackStep = vi.fn(() => true);
    const emitError = vi.fn();
    const audit = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => {
        throw new Error('flow state unreadable');
      },
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep,
      enterWork: vi.fn(() => 'entered' as const),
      emitError,
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job());

    expect(run).not.toHaveBeenCalled();
    expect(rollbackStep).toHaveBeenCalledWith(
      expect.objectContaining({ repoDir: '/repo', stepId: 'plan', entryToken: 1 }),
    );
    expect(emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: expect.stringMatching(/could not verify bootstrap step.*flow state unreadable/i),
    });
  });

  it('rolls back once with the readiness failure when the work-entry probe throws', () => {
    const run = vi.fn(async () => success);
    const rollbackStep = vi.fn(() => true);
    const emitError = vi.fn();
    const audit = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => {
        throw new Error('runner state unreadable');
      },
      acceptBootstrap: vi.fn(),
      rollbackStep,
      enterWork: vi.fn(() => 'entered' as const),
      emitError,
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job());

    expect(run).not.toHaveBeenCalled();
    expect(rollbackStep).toHaveBeenCalledTimes(1);
    expect(emitError).toHaveBeenCalledTimes(1);
    expect(emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: expect.stringMatching(/could not verify work-entry readiness.*runner state unreadable/i),
    });
    expect(audit.mock.calls).toEqual([
      [
        '/repo',
        'failure',
        'plan',
        'could not verify work-entry readiness for step plan: runner state unreadable',
      ],
      [
        '/repo',
        'rollback',
        'plan',
        'could not verify work-entry readiness for step plan: runner state unreadable',
      ],
    ]);
  });

  it('compensates a successful bootstrap when the final work handoff is refused', async () => {
    const compensateBootstrap = vi.fn(async () => {});
    const rollbackStep = vi.fn(() => true);
    const acceptBootstrap = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run: async () => success,
      compensateBootstrap,
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => true,
      acceptBootstrap,
      rollbackStep,
      enterWork: () => 'busy',
      emitError: vi.fn(),
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });

    c.enter(job());

    await vi.waitFor(() =>
      expect(rollbackStep).toHaveBeenCalledWith(
        expect.objectContaining({ repoDir: '/repo', stepId: 'plan', entryToken: 1 }),
      ),
    );
    expect(compensateBootstrap).toHaveBeenCalledWith(expect.anything(), successOwnership);
    expect(acceptBootstrap).not.toHaveBeenCalled();
  });

  it('revalidates the exact entry occurrence after awaited compensation before rollback', async () => {
    let finishCompensation!: () => void;
    const compensateBootstrap = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCompensation = resolve;
        }),
    );
    let currentToken = 1;
    const rollbackStep = vi.fn(
      (candidate: AppLoopBootstrapJob) => candidate.entryToken === currentToken,
    );
    const emitError = vi.fn();
    const audit = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run: async () => success,
      compensateBootstrap,
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: (candidate) => candidate.entryToken === currentToken,
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep,
      enterWork: () => 'busy',
      emitError,
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job({ entryToken: 1 }));
    await vi.waitFor(() => expect(compensateBootstrap).toHaveBeenCalled());
    currentToken = 2;
    finishCompensation();

    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith('/repo', 'stale', 'plan'));
    expect(rollbackStep).toHaveBeenCalledWith(
      expect.objectContaining({ entryToken: 1, issue: 78 }),
    );
    expect(emitError).not.toHaveBeenCalled();
  });

  it('rolls back and audits a successful bootstrap whose work entry throws', async () => {
    const rollbackStep = vi.fn(() => true);
    const emitError = vi.fn();
    const audit = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run: async () => success,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep,
      enterWork: () => {
        throw new Error('work entry exploded');
      },
      emitError,
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job());

    await vi.waitFor(() =>
      expect(rollbackStep).toHaveBeenCalledWith(
        expect.objectContaining({ repoDir: '/repo', stepId: 'plan', entryToken: 1 }),
      ),
    );
    expect(audit.mock.calls).toEqual([
      ['/repo', 'start', 'plan'],
      ['/repo', 'failure', 'plan', 'bootstrap succeeded but work entry failed: work entry exploded'],
      ['/repo', 'rollback', 'plan', 'bootstrap succeeded but work entry failed: work entry exploded'],
    ]);
    expect(emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: 'bootstrap succeeded but work entry failed: work entry exploded',
    });
  });

  it('rolls back the exact failed step and emits a blocking error carrying repo + step identity', async () => {
    const x = coordinator({ ok: false, kind: 'error' as const, error: 'working tree is not clean' });
    x.c.enter(job());
    await vi.waitFor(() =>
      expect(x.rollbackStep).toHaveBeenCalledWith(
        expect.objectContaining({ repoDir: '/repo', stepId: 'plan', entryToken: 1 }),
      ),
    );
    expect(x.emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: 'working tree is not clean',
    });
    expect(x.enterWork).not.toHaveBeenCalled();
    expect(x.audit.mock.calls).toEqual([
      ['/repo', 'start', 'plan'],
      ['/repo', 'failure', 'plan', 'working tree is not clean'],
      ['/repo', 'rollback', 'plan', 'working tree is not clean'],
    ]);
  });

  it('surfaces a rollback persistence failure without leaking an unhandled rejection', async () => {
    const emitError = vi.fn();
    const audit = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run: async () => ({ ok: false, kind: 'error' as const, error: 'draft PR creation failed' }),
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep: () => {
        throw new Error('ENOSPC while persisting rollback');
      },
      enterWork: vi.fn(() => 'entered' as const),
      emitError,
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job());

    await vi.waitFor(() =>
      expect(emitError).toHaveBeenCalledWith({
        repoDir: '/repo',
        stepId: 'plan',
        reason: expect.stringMatching(/draft PR creation failed.*ENOSPC while persisting rollback/i),
      }),
    );
    expect(audit.mock.calls).toEqual([
      ['/repo', 'start', 'plan'],
      ['/repo', 'failure', 'plan', 'draft PR creation failed'],
      [
        '/repo',
        'rollback',
        'plan',
        'draft PR creation failed; could not roll back step plan: ENOSPC while persisting rollback',
      ],
    ]);
  });

  it('makes a stale failure inert', async () => {
    const x = coordinator({ ok: false, kind: 'error' as const, error: 'wrong target' });
    x.c.enter(job());
    x.moveAway();
    await vi.waitFor(() => expect(x.audit).toHaveBeenCalledWith('/repo', 'stale', 'plan'));
    expect(x.rollbackStep).not.toHaveBeenCalled();
    expect(x.emitError).not.toHaveBeenCalled();
  });

  it('surfaces retained cleanup ownership from a stale failure without rolling back the new occurrence', async () => {
    const recovery = {
      ...successOwnership,
      pr: { kind: 'ambiguous' as const, marker: '<!-- retained -->' },
    };
    const x = coordinator({
      ok: false,
      kind: 'error' as const,
      error: 'draft PR outcome could not be reconciled',
      requiresAttention: true,
      recovery,
    });
    x.c.enter(job());
    x.moveAway();

    await vi.waitFor(() =>
      expect(x.emitError).toHaveBeenCalledWith({
        repoDir: '/repo',
        stepId: 'plan',
        reason: expect.stringMatching(/cleanup needs attention.*could not be reconciled/i),
      }),
    );
    expect(x.rollbackStep).not.toHaveBeenCalled();
    expect(x.enterWork).not.toHaveBeenCalled();
  });

  it('surfaces an unexpected post-entry acceptance failure without an unhandled rejection', async () => {
    const emitError = vi.fn();
    const audit = vi.fn();
    const finalizeBootstrap = vi.fn(async () => {});
    const c = createAppLoopBootstrapCoordinator({
      run: async () => success,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap,
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => true,
      acceptBootstrap: () => {
        throw new Error('acceptance exploded');
      },
      rollbackStep: vi.fn(() => true),
      enterWork: vi.fn(() => 'entered' as const),
      emitError,
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job());

    await vi.waitFor(() =>
      expect(emitError).toHaveBeenCalledWith({
        repoDir: '/repo',
        stepId: 'plan',
        reason: expect.stringMatching(/completion failed.*acceptance exploded/i),
      }),
    );
    expect(finalizeBootstrap).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      '/repo',
      'failure',
      'plan',
      expect.stringMatching(/completion failed.*acceptance exploded/i),
    );
  });

  it('coerces a rejected runner promise and routes it through the same rollback and error path', async () => {
    const rollbackStep = vi.fn(() => true);
    const emitError = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run: async () => Promise.reject('runner exploded'),
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep,
      enterWork: vi.fn(() => 'entered' as const),
      emitError,
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });

    c.enter(job());

    await vi.waitFor(() =>
      expect(rollbackStep).toHaveBeenCalledWith(
        expect.objectContaining({ repoDir: '/repo', stepId: 'plan', entryToken: 1 }),
      ),
    );
    expect(emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: 'runner exploded',
    });
  });

  it('treats a rollback race as stale and does not attribute the failure to the new step', async () => {
    const emitError = vi.fn();
    const audit = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run: async () => ({ ok: false, kind: 'error' as const, error: 'late failure' }),
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: () => true,
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep: () => false,
      enterWork: vi.fn(() => 'entered' as const),
      emitError,
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job());

    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith('/repo', 'stale', 'plan'));
    expect(emitError).not.toHaveBeenCalled();
  });
});

describe('createAppLoopBootstrapCoordinator — confirm-first wipe (§27.10)', () => {
  const success: AppLoopBootstrapResult = {
    ok: true,
    identity: {
      pr: 42,
      branch: 'plan-loop/issue-78',
      issue: 78,
      initialStatus: 'planning',
    },
    ownership: {
      base: 'main',
      branch: 'plan-loop/issue-78',
      ownedOid: '1'.repeat(40),
      pr: { kind: 'known' as const, number: 42 },
    },
  };

  function conflictCoordinator(
    run: (repoDir: string, request: AppLoopBootstrapRequest) => Promise<AppLoopBootstrapResult>,
  ) {
    const enterWork = vi.fn(() => 'entered' as const);
    const rollbackStep = vi.fn(() => true);
    const emitError = vi.fn();
    const emitConflict = vi.fn();
    const audit = vi.fn();
    let current = true;
    const c = createAppLoopBootstrapCoordinator({
      run,
      compensateBootstrap: vi.fn(async () => {}),
      finalizeBootstrap: vi.fn(async () => {}),
      hasBootstrapForJob: () => false,
      isCurrentJob: (candidate) => current && candidate.stepId === 'plan',
      canEnterWork: () => true,
      acceptBootstrap: vi.fn(),
      rollbackStep,
      enterWork,
      emitError,
      emitConflict,
      audit,
    });
    return {
      c,
      enterWork,
      rollbackStep,
      emitError,
      emitConflict,
      audit,
      moveAway: () => (current = false),
    };
  }

  it('holds a wipe-authorized conflict on its named step until the operator decides', async () => {
    const run = vi.fn(async () => ({ ok: false as const, kind: 'conflict' as const, conflict: target() }));
    const x = conflictCoordinator(run);

    x.c.enter(job());

    await vi.waitFor(() =>
      expect(x.emitConflict).toHaveBeenCalledWith({
        repoDir: '/repo',
        stepId: 'plan',
        ...target(),
      }),
    );
    expect(x.rollbackStep).not.toHaveBeenCalled();
    expect(x.emitError).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('declining a pending wipe rolls back the exact step without re-running pickup', async () => {
    const run = vi.fn(async () => ({ ok: false as const, kind: 'conflict' as const, conflict: target() }));
    const x = conflictCoordinator(run);
    x.c.enter(job());
    await vi.waitFor(() => expect(x.emitConflict).toHaveBeenCalledTimes(1));

    x.c.resolve('/repo', 'plan', false, target());

    expect(x.rollbackStep).toHaveBeenCalledWith(expect.objectContaining({ stepId: 'plan' }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('confirming re-runs the same job with the exact named wipe target', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, kind: 'conflict' as const, conflict: target() })
      .mockResolvedValueOnce(success);
    const x = conflictCoordinator(run);
    x.c.enter(job());
    await vi.waitFor(() => expect(x.emitConflict).toHaveBeenCalledTimes(1));

    x.c.resolve('/repo', 'plan', true, target());

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]).toEqual([
      '/repo',
      expect.objectContaining({ confirmedWipe: target() }),
    ]);
    await vi.waitFor(() =>
      expect(x.enterWork).toHaveBeenCalledWith('/repo', 'plan-loop', 'plan', 'chain-advance'),
    );
  });

  // §27.10 — the answer authorizes the resources the operator was shown, so a confirmation that names a
  // different set than the one now held cannot be spent on it.
  // Defense in depth: the base branch is resolved two statements earlier, so a branch_template whose
  // expansion collides with it must never reach a wipe prompt (CLAUDE.md: never allow an unrecoverable
  // state to occur).
  it('refuses a pickup whose branch is the repository default branch', async () => {
    const g = fakeGit();
    const conflicts = fakeConflicts(target({ branch: 'main' }));
    const result = await runAppLoopBootstrap(
      runnerDeps(g, fakeGitHub(), undefined, undefined, undefined, conflicts),
      request({ spec: { ...wipeSpec(), branchTemplate: 'main' } }),
    );

    expect(result).toEqual({
      ok: false,
      kind: 'error',
      error: expect.stringMatching(/default branch|base branch/i),
    });
    expect(conflicts.wiped).toEqual([]);
    expect(g.calls.some((call) => call.startsWith('branch:'))).toBe(false);
  });

  it('makes a wipe answer for a superseded target inert', async () => {
    const shown = target();
    const superseded = target({ pullRequests: [321, 999] });
    const run = vi.fn(async () => ({ ok: false as const, kind: 'conflict' as const, conflict: superseded }));
    const x = conflictCoordinator(run);
    x.c.enter(job());
    await vi.waitFor(() => expect(x.emitConflict).toHaveBeenCalledTimes(1));

    x.c.resolve('/repo', 'plan', true, shown);

    expect(run).toHaveBeenCalledTimes(1);
    expect(x.rollbackStep).not.toHaveBeenCalled();
  });

  it('makes a stale or wrong-step wipe decision inert', async () => {
    const run = vi.fn(async () => ({ ok: false as const, kind: 'conflict' as const, conflict: target() }));
    const x = conflictCoordinator(run);
    x.c.enter(job());
    await vi.waitFor(() => expect(x.emitConflict).toHaveBeenCalledTimes(1));

    x.c.resolve('/repo', 'implement', true, target());
    x.moveAway();
    x.c.resolve('/repo', 'plan', true, target());

    expect(run).toHaveBeenCalledTimes(1);
    expect(x.rollbackStep).not.toHaveBeenCalled();
  });

  // A held conflict must not keep the single bootstrap slot: the operator may take arbitrarily long to
  // answer, and another repo's pickup would otherwise wait behind a dialog nobody is looking at.
  it('frees the bootstrap slot for another repo while a conflict awaits the operator', async () => {
    const run = vi.fn(async (repoDir: string) =>
      repoDir === '/repo'
        ? { ok: false as const, kind: 'conflict' as const, conflict: target() }
        : success,
    );
    const x = conflictCoordinator(run);
    x.c.enter(job());
    await vi.waitFor(() => expect(x.emitConflict).toHaveBeenCalledTimes(1));

    x.c.enter(job({ repoDir: '/other' }));

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1][0]).toBe('/other');
  });
});
