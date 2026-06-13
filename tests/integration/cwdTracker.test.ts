import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createCwdTracker, type CwdInfo } from '../../src/main/cwdTracker';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Drive the REAL @xterm/headless shadow with scripted OSC 7 bytes (§test rules:
// no emulator mocks). The repo-key resolver is injected so the test controls the
// cwd→key mapping without touching the filesystem.
function osc7(p: string): string {
  return `\x1b]7;file://localhost${p}\x07`;
}

describe('createCwdTracker (§16.3 — OSC 7 cwd tracking)', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  let tracker: ReturnType<typeof createCwdTracker>;
  afterEach(() => {
    tracker?.dispose();
    shadow?.dispose();
  });

  function setup(resolveRepoKey: (cwd: string) => string) {
    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: 5, quietMs: 20, onStatus: () => {} });
    const changes: CwdInfo[] = [];
    tracker = createCwdTracker({
      onOsc: (id, cb) => shadow.onOsc(id, cb),
      resolveRepoKey,
    });
    tracker.onChange((info) => changes.push(info));
    return { changes };
  }

  it('decodes an OSC 7 file:// sequence to the cwd path', async () => {
    setup((cwd) => cwd);
    shadow.write(osc7('/home/dylan/project'));
    await sleep(10);
    expect(tracker.cwd()).toBe('/home/dylan/project');
  });

  it('percent-decodes an escaped path', async () => {
    setup((cwd) => cwd);
    shadow.write(osc7('/home/dylan/my%20repo'));
    await sleep(10);
    expect(tracker.cwd()).toBe('/home/dylan/my repo');
  });

  it('fires onChange once per repo-key change, not on same-key cwd moves', async () => {
    const { changes } = setup((cwd) =>
      cwd.startsWith('/repoA') ? '/repoA' : cwd.startsWith('/repoB') ? '/repoB' : cwd,
    );
    shadow.write(osc7('/repoA'));
    await sleep(10);
    shadow.write(osc7('/repoA/src')); // same repo → no swap
    await sleep(10);
    shadow.write(osc7('/repoA/src/deep')); // still same repo → no swap
    await sleep(10);
    shadow.write(osc7('/repoB')); // new repo → swap
    await sleep(10);

    expect(changes).toEqual([
      { cwd: '/repoA', repoKey: '/repoA' },
      { cwd: '/repoB', repoKey: '/repoB' },
    ]);
    expect(tracker.cwd()).toBe('/repoB');
    expect(tracker.repoKey()).toBe('/repoB');
  });

  it('tracks cwd() even when the repo key is unchanged', async () => {
    setup(() => '/fixed-key');
    shadow.write(osc7('/repoA'));
    await sleep(10);
    shadow.write(osc7('/repoA/src'));
    await sleep(10);
    expect(tracker.cwd()).toBe('/repoA/src');
    expect(tracker.repoKey()).toBe('/fixed-key');
  });

  it('ignores an unparseable OSC 7 payload', async () => {
    const { changes } = setup((cwd) => cwd);
    shadow.write('\x1b]7;not-a-url\x07');
    await sleep(10);
    expect(tracker.cwd()).toBeNull();
    expect(changes).toEqual([]);
  });

  it('stops firing after dispose()', async () => {
    const { changes } = setup((cwd) => cwd);
    tracker.dispose();
    shadow.write(osc7('/repoA'));
    await sleep(10);
    expect(changes).toEqual([]);
  });
});
