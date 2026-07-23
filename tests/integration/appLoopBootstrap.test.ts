import { describe, expect, it, vi } from 'vitest';
import {
  createAppLoopBootstrapCoordinator,
  runAppLoopBootstrap,
  type AppLoopBootstrapJob,
  type AppLoopBootstrapResult,
  type AppLoopBootstrapSpec,
} from '../../src/main/appLoopBootstrap';
import type { AppLoopBootstrap } from '../../src/main/appLoopState';
import type { BootstrapGit, BootstrapGitHub } from '../../src/main/bootstrapPorts';

const bootstrap: AppLoopBootstrapSpec = {
  origin: 'operator',
  branchTemplate: 'plan-loop/issue-{issue}',
  wipe: { mode: 'wipe-and-retry' },
  initialLabels: [
    { action: 'remove', target: 'issue', label: 'ready' },
    { action: 'add', target: 'issue', label: 'in-progress' },
    { action: 'add', target: 'pr', label: 'draft' },
  ],
};

function spec(origin: AppLoopBootstrapSpec['origin'] = 'operator'): AppLoopBootstrapSpec {
  return {
    ...bootstrap,
    origin,
    initialLabels: [...bootstrap.initialLabels],
  };
}

function fakeGit(over: { clean?: boolean; base?: string | null; branchExists?: boolean } = {}): {
  git: BootstrapGit;
  calls: string[];
  wipeConflictingBranch(branch: string): Promise<void>;
  rollbackCreatedBranch(branch: string): Promise<void>;
  hasBranch(branch: string): boolean;
} {
  const calls: string[] = [];
  const branches = new Set<string>();
  return {
    calls,
    rollbackCreatedBranch: async (branch) => {
      branches.delete(branch);
    },
    wipeConflictingBranch: async (branch) => {
      calls.push(`wipe:${branch}`);
      branches.delete(branch);
    },
    hasBranch: (branch) => branches.has(branch),
    git: {
      isCleanTree: async () => {
        calls.push('clean');
        return over.clean ?? true;
      },
      resolveBaseBranch: async () => {
        calls.push('base');
        return over.base === undefined ? 'main' : over.base;
      },
      branchExists: async (branch) => {
        calls.push(`exists:${branch}`);
        return over.branchExists ?? branches.has(branch);
      },
      createBranchFromBase: async (branch, base) => {
        calls.push(`branch:${branch}<-${base}`);
        branches.add(branch);
      },
      commitEmptyStart: async (message) => void calls.push(`commit:${message}`),
      pushBranchUpstream: async (branch) => void calls.push(`push:${branch}`),
    },
  };
}

function fakeGitHub(pr: number | null = 42): {
  github: BootstrapGitHub;
  calls: string[];
  prBody(): string;
  isAssigned(issue: number): boolean;
  issueHasLabel(issue: number, label: string): boolean;
  prHasLabel(number: number, label: string): boolean;
} {
  const calls: string[] = [];
  let body = '';
  const assigned = new Set<number>();
  const issueLabels = new Map<number, Set<string>>([[78, new Set(['ready'])]]);
  const prLabels = new Map<number, Set<string>>();
  return {
    calls,
    prBody: () => body,
    isAssigned: (issue) => assigned.has(issue),
    issueHasLabel: (issue, label) => issueLabels.get(issue)?.has(label) ?? false,
    prHasLabel: (number, label) => prLabels.get(number)?.has(label) ?? false,
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
        return pr;
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

function runnerDeps(
  g: ReturnType<typeof fakeGit>,
  h: ReturnType<typeof fakeGitHub>,
  writeBootstrap: (identity: AppLoopBootstrap) => void = () => {},
) {
  return {
    git: g.git,
    github: h.github,
    wipeConflictingBranch: g.wipeConflictingBranch,
    rollbackCreatedBranch: g.rollbackCreatedBranch,
    writeBootstrap,
  };
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

    const result = await runAppLoopBootstrap(
      runnerDeps(
        g,
        h,
        (identity) => {
          written = identity;
        },
      ),
      request(),
    );

    expect(result).toEqual({
      ok: true,
      identity: { pr: 42, branch: 'plan-loop/issue-78', issue: 78 },
    });
    expect(g.hasBranch('plan-loop/issue-78')).toBe(true);
    expect(h.prBody()).toContain('closes #78');
    expect(h.isAssigned(78)).toBe(true);
    expect(h.issueHasLabel(78, 'ready')).toBe(false);
    expect(h.issueHasLabel(78, 'in-progress')).toBe(true);
    expect(h.prHasLabel(42, 'draft')).toBe(true);
    expect(written).toEqual({ pr: 42, branch: 'plan-loop/issue-78', issue: 78 });
  });

  it('refuses a repo-resident pickup before the first git or gh operation (CWE-829)', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({ spec: spec('repo') }),
    );
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/origin|repo-resident/i) });
    expect(g.calls).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('honors command-bearing pickup only from the operator-authored resolver branch', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({ spec: spec('app-bundled') }),
    );
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/operator-authored|origin/i) });
    expect(g.calls).toEqual([]);
    expect(h.calls).toEqual([]);
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
      expect(result).toEqual({ ok: false, error: expect.stringMatching(/issue/i) });
      expect(g.calls).toEqual([]);
      expect(h.calls).toEqual([]);
    },
  );

  it('rejects an unsafe def-derived branch before branch mutation or issue/PR work', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    const unsafe = spec();
    unsafe.branchTemplate = '--upload-pack=evil-{issue}';
    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({ spec: unsafe }),
    );
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/unsafe branch/i) });
    expect(g.calls.some((call) => /^(exists|branch|commit|push):/.test(call))).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it.each([
    { name: 'dirty tree', git: { clean: false }, error: /not clean/, wipe: false },
    { name: 'unresolvable base', git: { base: null }, error: /base branch/, wipe: false },
    { name: 'existing branch', git: { branchExists: true }, error: /already exists/, wipe: true },
  ])('fails safely for $name without opening a PR', async ({ git, error, wipe }) => {
    const g = fakeGit(git);
    const h = fakeGitHub();
    const pickup = spec();
    if (wipe) pickup.wipe = { mode: 'abort' };
    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({ spec: pickup }),
    );
    expect(result).toEqual({ ok: false, error: expect.stringMatching(error) });
    expect(h.calls.some((call) => call.startsWith('pr:'))).toBe(false);
  });

  it('detects a wipe-authorized conflict without deleting anything before confirmation', async () => {
    const g = fakeGit({ branchExists: true });
    const h = fakeGitHub();

    const result = await runAppLoopBootstrap(runnerDeps(g, h), request());

    expect(result).toEqual({ ok: false, conflict: { branch: 'plan-loop/issue-78' } });
    expect(g.calls).not.toContain('wipe:plan-loop/issue-78');
    expect(h.calls).toEqual([]);
  });

  it('hard-fails a conflict with no wipe policy instead of offering a destructive decision', async () => {
    const g = fakeGit({ branchExists: true });
    const noWipe = spec();
    noWipe.wipe = { mode: 'abort' };

    const result = await runAppLoopBootstrap(
      runnerDeps(g, fakeGitHub()),
      request({ spec: noWipe }),
    );

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/already exists/i) });
    expect(g.calls).not.toContain('wipe:plan-loop/issue-78');
  });

  it('re-checks the wipe policy at the destructive operation before touching git or gh', async () => {
    const g = fakeGit({ branchExists: true });
    const h = fakeGitHub();
    const noWipe = spec();
    noWipe.wipe = { mode: 'abort' };

    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({
        spec: noWipe,
        confirmedWipe: { branch: 'plan-loop/issue-78' },
      }),
    );

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/wipe policy/i) });
    expect(g.calls).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('wipes only the confirmed named branch, then recreates the bootstrap', async () => {
    const g = fakeGit({ branchExists: true });

    const result = await runAppLoopBootstrap(
      runnerDeps(g, fakeGitHub()),
      request({ confirmedWipe: { branch: 'plan-loop/issue-78' } }),
    );

    expect(result).toEqual({
      ok: true,
      identity: { pr: 42, branch: 'plan-loop/issue-78', issue: 78 },
    });
    expect(g.calls.filter((call) => call.startsWith('wipe:'))).toEqual([
      'wipe:plan-loop/issue-78',
    ]);
  });

  it('refuses a confirmation naming a different branch before any operation', async () => {
    const g = fakeGit({ branchExists: true });
    const h = fakeGitHub();

    const result = await runAppLoopBootstrap(
      runnerDeps(g, h),
      request({ confirmedWipe: { branch: 'other/branch' } }),
    );

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/different branch/i) });
    expect(g.calls).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('fails when draft PR creation is rejected and writes no bootstrap identity', async () => {
    const g = fakeGit();
    const h = fakeGitHub(null);
    const writeBootstrap = vi.fn();
    const result = await runAppLoopBootstrap(
      runnerDeps(g, h, writeBootstrap),
      request(),
    );
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/PR creation/i) });
    expect(writeBootstrap).not.toHaveBeenCalled();
    expect(g.hasBranch('plan-loop/issue-78')).toBe(false);
  });

  it('keeps assignment and label failures best-effort while completing the critical bootstrap', async () => {
    const g = fakeGit();
    const h = fakeGitHub();
    h.github.assignIssueToSelf = async () => Promise.reject('assignment rejected');
    h.github.setIssueLabel = async () => Promise.reject('issue label rejected');
    h.github.setPrLabel = async () => Promise.reject('PR label rejected');
    let written: AppLoopBootstrap | null = null;

    const result = await runAppLoopBootstrap(
      runnerDeps(g, h, (identity) => {
        written = identity;
      }),
      request(),
    );

    expect(result).toEqual({
      ok: true,
      identity: { pr: 42, branch: 'plan-loop/issue-78', issue: 78 },
    });
    expect(g.hasBranch('plan-loop/issue-78')).toBe(true);
    expect(written).toEqual({ pr: 42, branch: 'plan-loop/issue-78', issue: 78 });
  });

  it('compensates the created branch when persisting the completed identity fails', async () => {
    const g = fakeGit();
    const result = await runAppLoopBootstrap(
      runnerDeps(g, fakeGitHub(), () => {
        throw new Error('bootstrap state is unwritable');
      }),
      request(),
    );

    expect(result).toEqual({ ok: false, error: 'bootstrap state is unwritable' });
    expect(g.hasBranch('plan-loop/issue-78')).toBe(false);
  });

  it('surfaces a failed compensating rollback together with the bootstrap failure', async () => {
    const g = fakeGit();
    g.rollbackCreatedBranch = async () => Promise.reject('cleanup exploded');
    const result = await runAppLoopBootstrap(
      runnerDeps(g, fakeGitHub(null)),
      request(),
    );
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/draft PR creation failed.*cleanup exploded/i),
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
    expect(result).toEqual({ ok: false, error: 'git exploded' });
  });
});

function job(over: Partial<AppLoopBootstrapJob> = {}): AppLoopBootstrapJob {
  return {
    repoDir: '/repo',
    stepId: 'plan',
    loopName: 'plan-loop',
    issue: 78,
    entry: 'chain-advance',
    bootstrap: spec(),
    ...over,
  };
}

describe('createAppLoopBootstrapCoordinator — async step identity + rollback (ST2 AC4/AC7)', () => {
  const success: AppLoopBootstrapResult = {
    ok: true,
    identity: { pr: 42, branch: 'plan-loop/issue-78', issue: 78 },
  };

  function coordinator(result: AppLoopBootstrapResult) {
    const enterWork = vi.fn();
    const rollbackStep = vi.fn(() => true);
    const emitError = vi.fn();
    const audit = vi.fn();
    let current = true;
    const c = createAppLoopBootstrapCoordinator({
      run: async () => result,
      hasBootstrapForIssue: () => false,
      isCurrentStep: (_repoDir, stepId) => current && stepId === 'plan',
      rollbackStep,
      enterWork,
      emitError,
      emitConflict: vi.fn(),
      audit,
    });
    return { c, enterWork, rollbackStep, emitError, audit, moveAway: () => (current = false) };
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
  });

  it('reuses a completed bootstrap for the same issue without running pickup again', () => {
    const enterWork = vi.fn();
    const run = vi.fn(async () => success);
    const c = createAppLoopBootstrapCoordinator({
      run,
      hasBootstrapForIssue: (_repoDir, issue) => issue === 78,
      isCurrentStep: () => true,
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
    await vi.waitFor(() => expect(x.rollbackStep).toHaveBeenCalledWith('/repo', 'plan'));
    expect(x.emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: expect.stringMatching(/ticket|issue/i),
    });
    expect(x.enterWork).not.toHaveBeenCalled();
  });

  it('drops a stale success instead of entering work against a different step', async () => {
    const x = coordinator(success);
    x.c.enter(job());
    x.moveAway();
    await vi.waitFor(() => expect(x.audit).toHaveBeenCalled());
    expect(x.enterWork).not.toHaveBeenCalled();
    expect(x.rollbackStep).not.toHaveBeenCalled();
  });

  it('rolls back the exact failed step and emits a blocking error carrying repo + step identity', async () => {
    const x = coordinator({ ok: false, error: 'working tree is not clean' });
    x.c.enter(job());
    await vi.waitFor(() => expect(x.rollbackStep).toHaveBeenCalledWith('/repo', 'plan'));
    expect(x.emitError).toHaveBeenCalledWith({
      repoDir: '/repo',
      stepId: 'plan',
      reason: 'working tree is not clean',
    });
    expect(x.enterWork).not.toHaveBeenCalled();
  });

  it('makes a stale failure inert', async () => {
    const x = coordinator({ ok: false, error: 'wrong target' });
    x.c.enter(job());
    x.moveAway();
    await vi.waitFor(() => expect(x.audit).toHaveBeenCalled());
    expect(x.rollbackStep).not.toHaveBeenCalled();
    expect(x.emitError).not.toHaveBeenCalled();
  });

  it('coerces a rejected runner promise and routes it through the same rollback and error path', async () => {
    const rollbackStep = vi.fn(() => true);
    const emitError = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run: async () => Promise.reject('runner exploded'),
      hasBootstrapForIssue: () => false,
      isCurrentStep: () => true,
      rollbackStep,
      enterWork: vi.fn(),
      emitError,
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });

    c.enter(job());

    await vi.waitFor(() => expect(rollbackStep).toHaveBeenCalledWith('/repo', 'plan'));
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
      run: async () => ({ ok: false, error: 'late failure' }),
      hasBootstrapForIssue: () => false,
      isCurrentStep: () => true,
      rollbackStep: () => false,
      enterWork: vi.fn(),
      emitError,
      emitConflict: vi.fn(),
      audit,
    });

    c.enter(job());

    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith('/repo', 'stale', 'plan'));
    expect(emitError).not.toHaveBeenCalled();
  });

  it('holds a wipe-authorized conflict on its named step until the operator decides', async () => {
    const run = vi.fn(async () => ({
      ok: false as const,
      conflict: { branch: 'plan-loop/issue-78' },
    }));
    const rollbackStep = vi.fn(() => true);
    const emitConflict = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run,
      hasBootstrapForIssue: () => false,
      isCurrentStep: (_repoDir, stepId) => stepId === 'plan',
      rollbackStep,
      enterWork: vi.fn(),
      emitError: vi.fn(),
      emitConflict,
      audit: vi.fn(),
    });

    c.enter(job());

    await vi.waitFor(() =>
      expect(emitConflict).toHaveBeenCalledWith({
        repoDir: '/repo',
        stepId: 'plan',
        branch: 'plan-loop/issue-78',
      }),
    );
    expect(rollbackStep).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('declining a pending wipe rolls back the exact step without re-running pickup', async () => {
    const run = vi.fn(async () => ({
      ok: false as const,
      conflict: { branch: 'plan-loop/issue-78' },
    }));
    const rollbackStep = vi.fn(() => true);
    const c = createAppLoopBootstrapCoordinator({
      run,
      hasBootstrapForIssue: () => false,
      isCurrentStep: () => true,
      rollbackStep,
      enterWork: vi.fn(),
      emitError: vi.fn(),
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });
    c.enter(job());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    c.resolve('/repo', 'plan', false);

    expect(rollbackStep).toHaveBeenCalledWith('/repo', 'plan');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('confirming re-runs the same job with the exact named wipe target', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        conflict: { branch: 'plan-loop/issue-78' },
      })
      .mockResolvedValueOnce(success);
    const enterWork = vi.fn();
    const c = createAppLoopBootstrapCoordinator({
      run,
      hasBootstrapForIssue: () => false,
      isCurrentStep: () => true,
      rollbackStep: vi.fn(() => true),
      enterWork,
      emitError: vi.fn(),
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });
    c.enter(job());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    c.resolve('/repo', 'plan', true);

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]).toEqual([
      '/repo',
      expect.objectContaining({
        confirmedWipe: { branch: 'plan-loop/issue-78' },
      }),
    ]);
    await vi.waitFor(() =>
      expect(enterWork).toHaveBeenCalledWith(
        '/repo',
        'plan-loop',
        'plan',
        'chain-advance',
      ),
    );
  });

  it('makes a stale or wrong-step wipe decision inert', async () => {
    const run = vi.fn(async () => ({
      ok: false as const,
      conflict: { branch: 'plan-loop/issue-78' },
    }));
    let current = true;
    const rollbackStep = vi.fn(() => true);
    const c = createAppLoopBootstrapCoordinator({
      run,
      hasBootstrapForIssue: () => false,
      isCurrentStep: (_repoDir, stepId) => current && stepId === 'plan',
      rollbackStep,
      enterWork: vi.fn(),
      emitError: vi.fn(),
      emitConflict: vi.fn(),
      audit: vi.fn(),
    });
    c.enter(job());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    c.resolve('/repo', 'implement', true);
    current = false;
    c.resolve('/repo', 'plan', true);

    expect(run).toHaveBeenCalledTimes(1);
    expect(rollbackStep).not.toHaveBeenCalled();
  });
});
