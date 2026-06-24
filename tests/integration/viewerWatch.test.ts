import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  watchViewerTree,
  viewerRoot,
  VIEWER_WATCH_DEBOUNCE_MS,
  type ViewerWatchFactory,
} from '../../src/main/viewerWatch';

// The watcher's coalescing + ignore classification are driven through an injected watch factory so
// event delivery is deterministic (CLAUDE.md endorses injectable timers/seams for timing tests); the
// real recursive fs.watch path is exercised end-to-end by the §20.1 live-reload Playwright e2e.
const DEBOUNCE = 10;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, DEBOUNCE * 4));

function fakeWatch(): { factory: ViewerWatchFactory; emit: (f: string) => void; closed: () => boolean } {
  let onEvent: (f: string | Buffer | null) => void = () => {};
  let open = false;
  return {
    factory: (_dir, cb) => {
      onEvent = cb;
      open = true;
      return {
        close() {
          open = false;
        },
      };
    },
    // A real recursive FSWatcher delivers no events once closed; mirror that so the unsubscribe
    // contract is the thing under test, not a fake that keeps firing past close().
    emit: (f) => {
      if (open) onEvent(f);
    },
    closed: () => !open,
  };
}

describe('watchViewerTree — artifact tree file watcher', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'viewer-watch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes a positive default debounce window', () => {
    expect(VIEWER_WATCH_DEBOUNCE_MS).toBeGreaterThan(0);
  });

  it('fires onChange when a file changes anywhere under the watched tree', async () => {
    const w = fakeWatch();
    let fired = 0;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    try {
      w.emit(join('sub', 'a.md'));
      await settle();
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  });

  it('stops firing (and closes the watcher) after the returned unsubscribe is called', async () => {
    const w = fakeWatch();
    let fired = 0;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    w.emit('a.md');
    await settle();
    expect(fired).toBe(1);
    stop();
    expect(w.closed()).toBe(true);
    w.emit('a.md');
    await settle();
    expect(fired).toBe(1);
  });

  it('is a no-op (never throws) when the directory cannot be watched', () => {
    // Real fs.watch of a missing dir throws synchronously; the degraded no-op path must swallow it.
    const stop = watchViewerTree(join(dir, 'does-not-exist'), () => {});
    expect(() => stop()).not.toThrow();
  });

  it('coalesces a burst across distinct files into a single onChange so a busy tree cannot storm refreshes', async () => {
    const w = fakeWatch();
    let fired = 0;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    try {
      for (let i = 0; i < 8; i++) w.emit(`f${i}.md`);
      await settle();
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  });

  it('ignores churn under .git so a refresh-triggered git write cannot feed back into a reload loop', async () => {
    // discover()/readArtifact() run git on every refresh, which writes .git/index; if those events
    // fired onChange the renderer's refresh would loop forever. The watcher must filter them out.
    const w = fakeWatch();
    let fired = 0;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    try {
      w.emit(join('.git', 'index'));
      w.emit(join('.git', 'index'));
      await settle();
      expect(fired).toBe(0);
    } finally {
      stop();
    }
  });

  it('ignores churn under an ignored dir nested below the root, matching discovery which skips them at any depth', async () => {
    // discovery's walk skips IGNORED_DIRS at ANY depth; a submodule's vendor/.git/index or a nested
    // node_modules write must not fire a reload either, or the watch surface diverges from discovery.
    const w = fakeWatch();
    let fired = 0;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    try {
      w.emit(join('vendor', '.git', 'index'));
      w.emit(join('pkg', 'node_modules', 'left-pad', 'index.js'));
      await settle();
      expect(fired).toBe(0);
    } finally {
      stop();
    }
  });

  it('ignores the spurious self-event some platforms emit for the watched root itself', async () => {
    const w = fakeWatch();
    let fired = 0;
    const rootName = dir.split(sep).pop()!;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    try {
      w.emit(rootName);
      await settle();
      expect(fired).toBe(0);
    } finally {
      stop();
    }
  });
});

describe('viewerRoot — the tree root the watcher must cover', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'viewer-root-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a repo subdir to the git root (the viewer tree is rooted there)', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    // git rev-parse resolves symlinks (macOS /var → /private/var); the same realpath discover's
    // gitRootOf returns, so the watch root and the tree root stay identical.
    expect(viewerRoot(join(dir, 'src', 'deep'))).toBe(realpathSync(dir));
  });

  it('falls back to the cwd itself outside a repo', () => {
    expect(viewerRoot(dir)).toBe(dir);
  });
});
