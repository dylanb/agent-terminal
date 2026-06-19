import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepoContext } from '../../src/renderer/src/repoContext';
import type { CwdChangedMsg, RepoInfo } from '../../src/shared/ipc';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A minimal window.monitor stub exposing only the two channels repoContext consumes. */
function makeMonitor(currentRepo: () => Promise<RepoInfo | null>) {
  const handlers: { cwd?: (m: CwdChangedMsg) => void } = {};
  const monitor = {
    onCwdChanged: vi.fn((cb: (m: CwdChangedMsg) => void) => (handlers.cwd = cb)),
    currentRepo: vi.fn(currentRepo),
  };
  const fireCwd = (repoKey: string, cwd = repoKey) =>
    handlers.cwd!({ sessionId: 's1', cwd, repoKey });
  return { monitor, fireCwd };
}

// The single shared OSC-7 repo provider (§16.3): one place owns "subscribe to cwd:changed +
// seed from currentRepo() on mount", so every consumer reads from it instead of re-deriving
// the key (the pattern that was forgotten in two consumers and returned null in the spawn dir).
describe('repoContext — shared OSC-7 repo provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('seeds repoKey/cwd from currentRepo() on mount (main backstops with the spawn cwd)', async () => {
    const { monitor } = makeMonitor(async () => ({ cwd: '/repoA', repoKey: '/repoA' }));
    const ctx = createRepoContext(monitor as never);
    expect(ctx.repoKey()).toBeNull(); // before the async seed resolves
    await flush();
    expect(ctx.repoKey()).toBe('/repoA');
    expect(ctx.cwd()).toBe('/repoA');
  });

  it('delivers the mount seed to a subscriber registered before it resolves', async () => {
    const { monitor } = makeMonitor(async () => ({ cwd: '/seed', repoKey: '/seed' }));
    const ctx = createRepoContext(monitor as never);
    const seen: string[] = [];
    ctx.onChange((info) => seen.push(info.repoKey));
    await flush();
    expect(seen).toEqual(['/seed']);
  });

  it('updates and notifies on a live cwd:changed', async () => {
    const { monitor, fireCwd } = makeMonitor(async () => null);
    const ctx = createRepoContext(monitor as never);
    const seen: string[] = [];
    ctx.onChange((info) => seen.push(info.repoKey));
    fireCwd('/repoB');
    expect(ctx.repoKey()).toBe('/repoB');
    expect(seen).toEqual(['/repoB']);
  });

  it('a live cwd:changed is not clobbered by a late-resolving seed', async () => {
    let resolveSeed: (r: RepoInfo) => void = () => {};
    const { monitor, fireCwd } = makeMonitor(() => new Promise<RepoInfo>((res) => (resolveSeed = res)));
    const ctx = createRepoContext(monitor as never);
    fireCwd('/live');
    resolveSeed({ cwd: '/stale', repoKey: '/stale' });
    await flush();
    expect(ctx.repoKey()).toBe('/live');
  });

  it('a rejected currentRepo() is handled (no unhandled rejection) and leaves repoKey null until a cwd:changed arrives', async () => {
    // A failing IPC / main-process restart must not become an unhandled rejection in the
    // renderer; vitest fails the run on one, so this passes only if the seed pull has a catch.
    const { monitor, fireCwd } = makeMonitor(async () => {
      throw new Error('ipc down');
    });
    const ctx = createRepoContext(monitor as never);
    await flush();
    expect(ctx.repoKey()).toBeNull();
    fireCwd('/later');
    expect(ctx.repoKey()).toBe('/later');
  });

  it('unsubscribe stops notifications', async () => {
    const { monitor, fireCwd } = makeMonitor(async () => null);
    const ctx = createRepoContext(monitor as never);
    const seen: string[] = [];
    const off = ctx.onChange((info) => seen.push(info.repoKey));
    fireCwd('/one');
    off();
    fireCwd('/two');
    expect(seen).toEqual(['/one']);
  });
});
