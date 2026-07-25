import { describe, expect, it } from 'vitest';
import type { ConfirmDialogOptions } from '../../src/renderer/src/confirmDialog';
import { wireAppBootstrapConflict } from '../../src/renderer/src/wireAppBootstrapConflict';
import type { AppBootstrapConflictTarget } from '../../src/shared/appBootstrap';

const conflict: AppBootstrapConflictTarget = {
  repository: 'github.com/owner/repository',
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

    const named = (h.opts().resources ?? []).join('\n');
    expect(named).toContain('plan-loop/issue-78');
    expect(named).toContain('1'.repeat(40));
    expect(named).toContain('2'.repeat(64));
    expect(named).toContain('github.com/owner/repository#321');
    expect(named).toContain('github.com/owner/repository#654');
  });

  it('does not promise to delete resources absent from the snapshot', () => {
    const h = harness();
    h.deliver(
      {
        repository: conflict.repository,
        branch: conflict.branch,
        localOid: null,
        remoteOid: null,
        pullRequests: [321],
      },
      '/repo',
      'plan',
    );

    const named = (h.opts().resources ?? []).join('\n');
    expect(named).toContain('github.com/owner/repository#321');
    expect(named).not.toContain('local branch');
    expect(named).not.toContain('origin branch');
  });
  // WCAG 1.3.1 — the resources are discrete data items whose boundaries exist only as commas in one
  // ~350-character utterance, so the set has no programmatically determinable count and no per-item
  // navigation, immediately before authorising an irreversible delete.
  it('names each resource as its own item with its own verb', () => {
    const h = harness();
    h.deliver(conflict, '/repo', 'plan');

    expect(h.opts().resources).toEqual([
      `Delete local branch plan-loop/issue-78 (${'1'.repeat(40)})`,
      `Delete origin branch plan-loop/issue-78 (${'2'.repeat(40)})`,
      'Close pull request github.com/owner/repository#321',
      'Close pull request github.com/owner/repository#654',
    ]);
    expect(h.opts().message).toMatch(/4 resources/);
    expect(h.opts().message).not.toContain('1111');
  });

});
