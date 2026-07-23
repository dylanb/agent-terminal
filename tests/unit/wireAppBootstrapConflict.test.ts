import { describe, expect, it } from 'vitest';
import type { ConfirmDialogOptions } from '../../src/renderer/src/confirmDialog';
import { wireAppBootstrapConflict } from '../../src/renderer/src/wireAppBootstrapConflict';
import type { AppBootstrapConflictTarget } from '../../src/shared/appBootstrap';

const conflict: AppBootstrapConflictTarget = {
  branch: 'plan-loop/issue-78',
  localOid: '1'.repeat(40),
  remoteOid: '2'.repeat(40),
  pullRequests: [321, 654],
};

describe('wireAppBootstrapConflict (§27.10 — destructive answer keeps repo + step identity)', () => {
  function harness() {
    let deliver:
      | ((
          conflict: AppBootstrapConflictTarget & {
            repoKey: string;
            step: string;
          },
        ) => void)
      | undefined;
    let opts: ConfirmDialogOptions | undefined;
    const resolved: Array<{
      repoKey: string;
      step: string;
      wipe: boolean;
    }> = [];
    wireAppBootstrapConflict({
      onConflict: (cb) => {
        deliver = cb;
        return () => {};
      },
      confirm: (next) => {
        opts = next;
      },
      resolve: (repoKey, step, wipe) =>
        void resolved.push({ repoKey, step, wipe }),
    });
    return {
      deliver: (
        target: AppBootstrapConflictTarget,
        repoKey: string,
        step: string,
      ) => deliver!({ ...target, repoKey, step }),
      opts: () => opts!,
      resolved,
    };
  }

  it('confirms the exact repo and step named by the conflict push', () => {
    const h = harness();
    h.deliver(conflict, '/repo/a', 'plan');

    h.opts().onConfirm();

    expect(h.resolved).toEqual([
      { repoKey: '/repo/a', step: 'plan', wipe: true },
    ]);
  });

  it('declines against that same identity', () => {
    const h = harness();
    h.deliver(conflict, '/repo/b', 'plan');

    h.opts().onCancel?.();

    expect(h.resolved).toEqual([
      { repoKey: '/repo/b', step: 'plan', wipe: false },
    ]);
  });

  it('names every exact ref and pull request that confirmation will mutate', () => {
    const h = harness();
    const sha256Conflict = {
      ...conflict,
      remoteOid: '2'.repeat(64),
    };
    h.deliver(sha256Conflict, '/repo', 'plan');

    expect(h.opts().message).toContain('plan-loop/issue-78');
    expect(h.opts().message).toContain('1'.repeat(40));
    expect(h.opts().message).toContain('2'.repeat(64));
    expect(h.opts().message).toContain('pull request #321');
    expect(h.opts().message).toContain('pull request #654');
  });

  it('does not promise to delete resources absent from the snapshot', () => {
    const h = harness();
    h.deliver(
      {
        branch: conflict.branch,
        localOid: null,
        remoteOid: null,
        pullRequests: [321],
      },
      '/repo',
      'plan',
    );

    expect(h.opts().message).toContain('pull request #321');
    expect(h.opts().message).not.toContain('local branch');
    expect(h.opts().message).not.toContain('origin branch');
  });
});
