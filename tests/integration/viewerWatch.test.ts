import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchViewerTree, viewerRoot, VIEWER_WATCH_DEBOUNCE_MS } from '../../src/main/viewerWatch';

// Real filesystem, real recursive fs.watch — no mocks (CLAUDE.md). Mirrors the agent-loop
// watch test: write a real file and poll the callback rather than asserting on internals.
const waitFor = (pred: () => boolean): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const poll = (): void => {
      if (pred()) return resolve();
      // Generous deadline: recursive fs.watch event delivery can lag many seconds under the full
      // suite's parallel I/O load (the same flakiness the agent-loop watch test exhibits).
      if (Date.now() - t0 > 15_000) return reject(new Error('viewer watch did not fire within 15s'));
      setTimeout(poll, 20);
    };
    poll();
  });

describe('watchViewerTree — artifact tree file watcher', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'viewer-watch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires onChange when a file changes anywhere under the watched tree', async () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'a.md'), 'one\n');
    let fired = 0;
    const stop = watchViewerTree(dir, () => {
      fired += 1;
    });
    try {
      writeFileSync(join(dir, 'sub', 'a.md'), 'one\ntwo\n');
      await waitFor(() => fired > 0);
      expect(fired).toBeGreaterThan(0);
    } finally {
      stop();
    }
  }, 20_000);

  it('stops firing after the returned unsubscribe is called', async () => {
    writeFileSync(join(dir, 'a.md'), 'one\n');
    let fired = 0;
    const stop = watchViewerTree(dir, () => {
      fired += 1;
    });
    writeFileSync(join(dir, 'a.md'), 'one\ntwo\n');
    await waitFor(() => fired > 0);
    stop();
    const after = fired;
    writeFileSync(join(dir, 'a.md'), 'one\ntwo\nthree\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(fired).toBe(after);
  }, 20_000);

  it('is a no-op (never throws) when the directory cannot be watched', () => {
    const stop = watchViewerTree(join(dir, 'does-not-exist'), () => {});
    expect(() => stop()).not.toThrow();
  });

  it('coalesces a burst across distinct files into a single onChange so a busy tree cannot storm refreshes', async () => {
    expect(VIEWER_WATCH_DEBOUNCE_MS).toBeGreaterThan(0);
    let fired = 0;
    const stop = watchViewerTree(dir, () => {
      fired += 1;
    });
    try {
      // Distinct files → distinct fs events (unlike same-file writes, which FSEvents already coalesces).
      for (let i = 0; i < 8; i++) writeFileSync(join(dir, `f${i}.md`), 'x\n');
      await waitFor(() => fired > 0);
      // Past the debounce window, the whole burst must have collapsed to exactly one onChange.
      await new Promise((r) => setTimeout(r, VIEWER_WATCH_DEBOUNCE_MS * 3 + 200));
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  }, 20_000);

  it('ignores churn under .git so a refresh-triggered git write cannot feed back into a reload loop', async () => {
    // discover()/readArtifact() run git on every refresh, which writes .git/index; if those events
    // fired onChange the renderer's refresh would loop forever. The watcher must filter them out.
    mkdirSync(join(dir, '.git'), { recursive: true });
    let fired = 0;
    const stop = watchViewerTree(dir, () => {
      fired += 1;
    });
    try {
      writeFileSync(join(dir, '.git', 'index'), 'x');
      writeFileSync(join(dir, '.git', 'index'), 'xy');
      await new Promise((r) => setTimeout(r, 200));
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
