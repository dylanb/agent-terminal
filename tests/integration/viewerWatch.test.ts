import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  watchViewerTree,
  viewerRoot,
  watchableDirs,
  viewerWatchDirs,
  VIEWER_WATCH_DEBOUNCE_MS,
  viewerWatchMode,
  viewerWatchFactory,
  type ViewerWatchFactory,
} from '../../src/main/viewerWatch';

// The watcher's coalescing + ignore classification are driven through an injected watch factory so
// event delivery is deterministic (CLAUDE.md endorses injectable timers/seams for timing tests); the
// real recursive fs.watch path is exercised end-to-end by the §20.1 live-reload Playwright e2e.
const DEBOUNCE = 10;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, DEBOUNCE * 4));

function fakeWatch(): {
  factory: ViewerWatchFactory;
  emit: (f: string | Buffer | null) => void;
  closed: () => boolean;
} {
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

  it('cancels a pending coalesced fire when unsubscribed before the debounce elapses', async () => {
    const w = fakeWatch();
    let fired = 0;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    w.emit('a.md');
    stop(); // before the debounce window elapses — the armed fire must be cancelled
    await settle();
    expect(fired).toBe(0);
  });

  it('fires a conservative reload for a null filename the platform could not classify', async () => {
    // node fs.watch may deliver filename === null; isIgnoredEvent cannot classify it, so it must not
    // be silently dropped — the viewer reloads rather than miss a real change.
    const w = fakeWatch();
    let fired = 0;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    try {
      w.emit(null);
      await settle();
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  });

  it('classifies a Buffer filename the same as its string form', async () => {
    const w = fakeWatch();
    let fired = 0;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    try {
      w.emit(Buffer.from(join('.git', 'index'))); // ignored just like the string path
      w.emit(Buffer.from('a.md')); // a real edit still fires
      await settle();
      expect(fired).toBe(1);
    } finally {
      stop();
    }
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

  it('reloads on a file named like the repo root — per-dir watchers report dir-relative names, so this is a real edit', async () => {
    // The watch now covers many dirs individually (non-recursive), so `filename` is relative to the firing
    // dir, not the tree root. A dir-relative name equal to the repo-root basename is therefore a legitimate
    // file edit and MUST reload; suppressing it (the old `rel === rootName` guard) dropped real reloads. A
    // spurious platform self-event named the same is at worst one harmless debounced re-pull; IGNORED_DIRS
    // still covers the real skip set.
    const w = fakeWatch();
    let fired = 0;
    const rootName = dir.split(sep).pop()!;
    const stop = watchViewerTree(dir, () => (fired += 1), { debounceMs: DEBOUNCE, watch: w.factory });
    try {
      w.emit(rootName);
      await settle();
      expect(fired).toBe(1);
    } finally {
      stop();
    }
  });
});

describe('watchableDirs — the directories the recursive watch actually covers (§20.1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watchable-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The reported crash: watching the launch root recursively descends into node_modules and exhausts the
  // inotify limit (ENOSPC). The watch surface must PRUNE IGNORED_DIRS at creation — not just filter their
  // events — so a repo checkout's node_modules is never watched, matching discovery which skips them.
  it('covers the root and non-ignored subdirs but never descends into an IGNORED_DIR at any depth', () => {
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    mkdirSync(join(dir, '.agent-loop', 'reviews', '1'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'got', 'dist', 'source'), { recursive: true });
    mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(dir, 'pkg', 'node_modules', 'left-pad'), { recursive: true }); // nested ignored
    writeFileSync(join(dir, 'src', 'a.ts'), '');

    const rels = watchableDirs(dir).map((d) => relative(dir, d) || '.');

    expect(rels).toContain('.');
    expect(rels).toContain('src');
    expect(rels).toContain(join('src', 'deep'));
    expect(rels).toContain('.agent-loop');
    expect(rels).toContain(join('.agent-loop', 'reviews', '1'));
    expect(rels).toContain('pkg');
    // No watched dir lies within an ignored dir at ANY depth — the node_modules descent that caused ENOSPC.
    expect(rels.some((d) => d.split(sep).includes('node_modules'))).toBe(false);
    expect(rels.some((d) => d.split(sep).includes('.git'))).toBe(false);
  });

  it('never throws for a missing root — returns just that root (the caller degrades to inert)', () => {
    expect(watchableDirs(join(dir, 'nope'))).toEqual([join(dir, 'nope')]);
  });

  // A repo can plant `.agent-loop`/`.agent-terminal` as a SYMLINK to a huge external tree; viewerWatchDirs
  // walks those paths as roots. Descending through the symlink would enumerate the target's whole subtree
  // and re-exhaust inotify (ENOSPC) — the crash this walk exists to prevent. The symlink itself is a bounded
  // leaf; its subtree must never be enumerated (CWE-59).
  it('does not descend into a symlinked directory root — treats it as a single leaf', () => {
    const external = join(dir, 'external');
    mkdirSync(join(external, 'a', 'b'), { recursive: true });
    const link = join(dir, 'link');
    symlinkSync(external, link);
    expect(watchableDirs(link)).toEqual([link]);
  });

  it('does not follow a symlinked subdirectory entry', () => {
    const external = join(dir, 'ext2');
    mkdirSync(join(external, 'deep'), { recursive: true });
    const root = join(dir, 'root');
    mkdirSync(root);
    symlinkSync(external, join(root, 'link'));
    expect(watchableDirs(root).map((d) => relative(root, d) || '.')).toEqual(['.']);
  });
});

describe('viewerWatchDirs — scope the watch by git-ness (§20.1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'watchscope-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const gitInit = (d: string): void => {
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: d });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: d });
  };

  it('inside a git repo watches every dir the repo .gitignore does NOT exclude (not a hard-coded list)', () => {
    gitInit(dir);
    // Ignore node_modules AND an arbitrary build dir — proving the skip follows THIS repo's .gitignore.
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\nbuild/\n.agent-loop/\n.agent-terminal/\n');
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'src', 'deep', 'a.ts'), '');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), '');
    mkdirSync(join(dir, 'build', 'out'), { recursive: true });
    writeFileSync(join(dir, 'build', 'out', 'bundle.js'), '');

    const rels = viewerWatchDirs(dir).map((d) => relative(dir, d) || '.');
    expect(rels).toContain('.');
    expect(rels).toContain('src');
    expect(rels).toContain(join('src', 'deep'));
    // BOTH gitignored dirs skipped — node_modules and the arbitrary build/ (the generalization).
    expect(rels.some((d) => d.split(sep).includes('node_modules'))).toBe(false);
    expect(rels.some((d) => d.split(sep).includes('build'))).toBe(false);
  });

  it('watches the app state dirs even when the repo .gitignore excludes them (the allow-list)', () => {
    gitInit(dir);
    writeFileSync(join(dir, '.gitignore'), '.agent-loop/\n.agent-terminal/\n');
    mkdirSync(join(dir, '.agent-loop', 'reviews', '1'), { recursive: true });
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    const set = new Set(viewerWatchDirs(dir));
    expect(set.has(join(dir, '.agent-loop'))).toBe(true);
    expect(set.has(join(dir, '.agent-loop', 'reviews', '1'))).toBe(true);
    expect(set.has(join(dir, '.agent-terminal'))).toBe(true);
  });

  // AC5 (#126): the §27 loop's working tree under .agent-terminal/loop/ must sit inside the live-reload
  // watch surface at ANY depth, so an on-disk edit to a surfaced loop artifact re-renders it. It rides on
  // the APP_STATE_DIRS allow-list above (no watch change was needed for #126); this guards that the NESTED
  // loop subtree — not just the .agent-terminal root — stays watched even when .gitignore excludes it, so a
  // future change that stopped covering the subtree fails here rather than silently freezing AC5.
  it('watches the .agent-terminal/loop/ subtree at any depth (the AC5 live-reload surface, #126)', () => {
    gitInit(dir);
    writeFileSync(join(dir, '.gitignore'), '.agent-terminal/\n');
    for (const d of ['artifacts', 'reports', 'consolidate'])
      mkdirSync(join(dir, '.agent-terminal', 'loop', d), { recursive: true });
    const set = new Set(viewerWatchDirs(dir));
    expect(set.has(join(dir, '.agent-terminal', 'loop'))).toBe(true);
    expect(set.has(join(dir, '.agent-terminal', 'loop', 'artifacts'))).toBe(true);
    expect(set.has(join(dir, '.agent-terminal', 'loop', 'reports'))).toBe(true);
    expect(set.has(join(dir, '.agent-terminal', 'loop', 'consolidate'))).toBe(true);
  });

  it('covers .agent-terminal itself and its loop/ subtree, never other trees an agent leaves under .agent-terminal', () => {
    gitInit(dir);
    writeFileSync(join(dir, '.gitignore'), '.agent-terminal/\n');
    mkdirSync(join(dir, '.agent-terminal', 'loop', 'artifacts'), { recursive: true });
    mkdirSync(join(dir, '.agent-terminal', 'platform', 'copy', 'dist', 'mac'), { recursive: true });
    const dirs = viewerWatchDirs(dir);
    expect(dirs).toContain(join(dir, '.agent-terminal'));
    expect(dirs).toContain(join(dir, '.agent-terminal', 'loop', 'artifacts'));
    expect(dirs.filter((d) => d.startsWith(join(dir, '.agent-terminal', 'platform')))).toEqual([]);
  });

  // The reported crash: launching in ~ (not a repo) watched the entire home filesystem → ENOSPC. Outside a
  // repo the watch must cover ONLY the app-owned state dirs, never the cwd itself nor unrelated siblings.
  it('outside a git repo watches ONLY the app state dirs (.agent-terminal / .agent-loop), never the cwd', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    mkdirSync(join(dir, '.agent-loop', 'reviews', '1'), { recursive: true });
    mkdirSync(join(dir, 'Downloads', 'huge'), { recursive: true }); // a normal home-dir sibling
    const set = new Set(viewerWatchDirs(dir));
    expect(set.has(join(dir, '.agent-terminal'))).toBe(true);
    expect(set.has(join(dir, '.agent-loop'))).toBe(true);
    expect(set.has(join(dir, '.agent-loop', 'reviews', '1'))).toBe(true);
    expect(set.has(dir)).toBe(false); // NOT the cwd root
    expect([...set].some((d) => d.split(sep).includes('Downloads'))).toBe(false); // NOT unrelated dirs
  });

  it('outside a repo with no app dirs present watches nothing that exists (each missing path is inert)', () => {
    // No .agent-terminal / .agent-loop created — the returned paths simply do not exist, so the factory
    // skips them; the point is it never falls back to watching the whole cwd.
    const set = new Set(viewerWatchDirs(dir));
    expect(set.has(dir)).toBe(false);
    for (const d of set) expect(d.startsWith(join(dir, '.agent'))).toBe(true);
  });
});

describe('viewerWatchMode — the watch backend per platform', () => {
  it('uses one recursive watch on macOS, where each per-dir watcher rebuilds a shared FSEvents stream', () => {
    expect(viewerWatchMode('darwin')).toBe('recursive');
  });

  it('watches each covered dir on Linux, where a recursive watch spends an inotify watch per dir', () => {
    expect(viewerWatchMode('linux')).toBe('per-dir');
  });
});

describe('the recursive watch backend — same coverage as the per-dir one (§20.1)', () => {
  let dir: string;
  let stop: (() => void) | undefined;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'watchrec-')));
  });
  afterEach(() => {
    stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  // Re-touches `file` until the watcher reports `name`, so the test waits for the stream to be live rather
  // than for a guessed interval.
  const seenAfterTouching = (seen: string[], name: string, file: string): Promise<void> =>
    new Promise((resolve) => {
      const poll = (): void => {
        if (seen.includes(name)) return resolve();
        writeFileSync(file, String(Math.random()));
        setTimeout(poll, 20);
      };
      poll();
    });

  it('reports edits in covered dirs by their dir-relative name and drops edits outside the covered set', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.agent-terminal/\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'keep.ts'), '');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(dir, '.agent-terminal', 'loop', 'artifacts'), { recursive: true });
    mkdirSync(join(dir, '.agent-terminal', 'platform', 'copy'), { recursive: true });

    const seen: string[] = [];
    const watcher = viewerWatchFactory('recursive')(dir, (f) => {
      if (f !== null) seen.push(f.toString());
    });
    stop = () => watcher.close();
    await seenAfterTouching(seen, 'keep.ts', join(dir, 'src', 'keep.ts'));

    writeFileSync(join(dir, 'node_modules', 'x', 'dropped-a.js'), '');
    writeFileSync(join(dir, '.agent-terminal', 'platform', 'copy', 'dropped-b.js'), '');
    await seenAfterTouching(seen, 'kept-a.ts', join(dir, 'src', 'kept-a.ts'));
    await seenAfterTouching(seen, 'kept-b.md', join(dir, '.agent-terminal', 'loop', 'artifacts', 'kept-b.md'));

    expect(seen.filter((f) => f.startsWith('dropped'))).toEqual([]);
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
