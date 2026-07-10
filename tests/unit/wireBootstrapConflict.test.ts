import { describe, it, expect } from 'vitest';
import { wireBootstrapConflict } from '../../src/renderer/src/wireBootstrapConflict';
import type { ConfirmDialogOptions } from '../../src/renderer/src/confirmDialog';

// §26.9 — the operator's answer to a bootstrap conflict is DESTRUCTIVE (wipe deletes the branch on origin
// and closes its PR). It must be bound to the repo the conflict was RAISED for — carried on the push — never
// the terminal's current cwd, or a conflict for repo A answered while the user has cd'd to repo B routes the
// wipe at the wrong repo. The seam names the concepts (subscribe/confirm/resolve), not the IPC mechanism.
describe('wireBootstrapConflict (§26.9 — answer bound to the conflict repo, not the current cwd)', () => {
  function harness() {
    let deliver: ((branch: string, repoKey: string) => void) | undefined;
    let opts: ConfirmDialogOptions | undefined;
    const resolved: Array<{ repoKey: string; wipe: boolean }> = [];
    wireBootstrapConflict({
      onBootstrapConflict: (cb) => {
        deliver = cb;
        return () => {};
      },
      confirm: (o) => {
        opts = o;
      },
      resolve: (repoKey, wipe) => void resolved.push({ repoKey, wipe }),
    });
    return {
      deliver: (branch: string, repoKey: string) => deliver!(branch, repoKey),
      opts: () => opts!,
      resolved,
    };
  }

  it('wipes the repo the conflict is FOR when the operator confirms', () => {
    const h = harness();
    h.deliver('feat/x', 'repoA');
    h.opts().onConfirm();
    expect(h.resolved).toEqual([{ repoKey: 'repoA', wipe: true }]);
  });

  it('cancel rolls back that same repo (wipe:false)', () => {
    const h = harness();
    h.deliver('feat/y', 'repoB');
    h.opts().onCancel?.();
    expect(h.resolved).toEqual([{ repoKey: 'repoB', wipe: false }]);
  });

  it('names the conflicting branch in the confirm message', () => {
    const h = harness();
    h.deliver('feat/z', 'repoC');
    expect(h.opts().message).toContain('feat/z');
  });
});
