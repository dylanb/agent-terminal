import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewerInstallationRecovery } from '../../src/main/reviewerInstallationRecovery';
import { createWorktreeLock } from '../../src/main/worktreeLock';
import type { FlowStateView } from '../../src/shared/ipc';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-recovery-')); roots.push(root);
  const lockRoot = join(root, 'locks');
  const lock = createWorktreeLock({ lockRoot });
  let problems = ['Missing charter']; let cleanupProblems: string[] = []; let reset = false;
  const view = { status: 'not_started' } as FlowStateView;
  const recovery = createReviewerInstallationRecovery({
    lock,
    install: () => ({ wrote: [], problems }),
    remove: () => cleanupProblems,
    currentView: (_key, notice) => ({ ...view, ...recovery.retryView(root), ...(notice ? { notice } : {}) }),
    terminate: () => reset ? { outcome: 'reset', view } : { outcome: 'refused', cause: 'failed', reason: 'Not ended', view: { ...view, notice: 'Not ended' } },
  });
  return { root, lockRoot, recovery, fix: () => { problems = []; }, failCleanup: () => { cleanupProblems = ['Cannot remove reviewer']; }, fixCleanup: () => { cleanupProblems = []; }, allowReset: () => { reset = true; } };
}
it('retains the pending start/restart through repeated failure and clears it only after a successful retry', () => {
  for (const action of ['start', 'restart'] as const) {
    const f = fixture();
    f.recovery.prepare(f.root, 'claude-code', action);
    f.recovery.prepare(f.root, 'claude-code');
    expect(f.recovery.retryView(f.root)).toEqual({ installationRetry: action, notice: 'Missing charter' });
    expect(f.recovery.hold(f.root)).toBe('Missing charter');
    expect(f.recovery.hold('another-worktree')).toBeNull();
    f.fix(); f.recovery.prepare(f.root, 'claude-code', action);
    expect(f.recovery.retryView(f.root)).toEqual({});
    expect(f.recovery.hold(f.root)).toBeNull();
  }
});
it('cancel retains recovery while a peer holds the lock or cleanup fails, then removes and clears it without terminating a run', () => {
  const f = fixture();
  f.recovery.prepare(f.root, 'claude-code', 'start');
  const peer = createWorktreeLock({ lockRoot: f.lockRoot }).acquire(f.root);
  expect(peer.ok).toBe(true);
  try {
    expect(f.recovery.terminate(f.root).notice).toMatch(/Another Agent Terminal/);
    expect(f.recovery.retryView(f.root).installationRetry).toBe('start');
  } finally { if (peer.ok) peer.release(); }
  f.failCleanup();
  expect(f.recovery.terminate(f.root).notice).toBe('Cannot remove reviewer');
  expect(f.recovery.retryView(f.root).installationRetry).toBe('start');
  f.fixCleanup();
  expect(f.recovery.terminate(f.root).notice).toMatch(/Restart the agent session/);
  expect(f.recovery.hold(f.root)).toBeNull();
});
it('ordinary termination delegates to the lifecycle and clears a later-installation hold only on reset', () => {
  const f = fixture();
  f.recovery.prepare(f.root, 'claude-code');
  expect(f.recovery.terminate(f.root).notice).toBe('Not ended');
  expect(f.recovery.hold(f.root)).toBe('Missing charter');
  f.allowReset();
  expect(f.recovery.terminate(f.root).notice).toBeUndefined();
  expect(f.recovery.hold(f.root)).toBeNull();
});
it('another agent kind does not install reviewers or silently clear an existing recovery', () => {
  const f = fixture();
  expect(f.recovery.prepare(f.root, 'codex')).toEqual({ wrote: [], problems: [] });
  expect(f.recovery.hold(f.root)).toBeNull();
  f.recovery.prepare(f.root, 'claude-code', 'restart');
  f.recovery.prepare(f.root, 'codex');
  expect(f.recovery.retryView(f.root).installationRetry).toBe('restart');
  expect(f.recovery.hold(f.root)).toBe('Missing charter');
});
