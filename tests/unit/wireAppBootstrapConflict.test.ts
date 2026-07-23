import { describe, expect, it } from 'vitest';
import type { ConfirmDialogOptions } from '../../src/renderer/src/confirmDialog';
import { wireAppBootstrapConflict } from '../../src/renderer/src/wireAppBootstrapConflict';

describe('wireAppBootstrapConflict (§27.10 — destructive answer keeps repo + step identity)', () => {
  function harness() {
    let deliver:
      | ((conflict: { branch: string; repoKey: string; step: string }) => void)
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
      deliver: (branch: string, repoKey: string, step: string) =>
        deliver!({ branch, repoKey, step }),
      opts: () => opts!,
      resolved,
    };
  }

  it('confirms the exact repo and step named by the conflict push', () => {
    const h = harness();
    h.deliver('plan-loop/issue-78', '/repo/a', 'plan');

    h.opts().onConfirm();

    expect(h.resolved).toEqual([
      { repoKey: '/repo/a', step: 'plan', wipe: true },
    ]);
  });

  it('declines against that same identity', () => {
    const h = harness();
    h.deliver('plan-loop/issue-78', '/repo/b', 'plan');

    h.opts().onCancel?.();

    expect(h.resolved).toEqual([
      { repoKey: '/repo/b', step: 'plan', wipe: false },
    ]);
  });

  it('names the exact branch that confirmation will delete', () => {
    const h = harness();
    h.deliver('plan-loop/issue-78', '/repo', 'plan');

    expect(h.opts().message).toContain('plan-loop/issue-78');
    expect(h.opts().message).toContain('closes its PR');
  });
});
