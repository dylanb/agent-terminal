// Artifact discovery (§20.1 / D8): the session's cwd as the viewer's file tree.

import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { APP_LOOP_DIR_SEGMENTS } from './appLoopPaths';
import { readBoundedNoFollow } from './boundedRead';
import { isUnderAppStateDir } from './appStateDirs';
import { confinedRealPath, resolveJail } from './confinedPath';
import type {
  ArtifactNode,
  ArtifactProvenance,
  ArtifactScope,
  ArtifactTree,
  ViewerFile,
  ViewerFileKind,
} from '../shared/ipc';

export interface DiscoverDeps {
  /** Run git in `cwd`, returning stdout. Throws on failure (→ treated as not-a-repo). */
  git?: (args: string[], cwd: string) => string;
  /** List files (tree-relative) under a non-repo dir; defaults to a bounded recursive walk. */
  listDir?: (dir: string) => string[];
  /** The PR base branch to diff this branch against (§20.1) — e.g. `origin/main`; null when no base
   *  resolves. The merge-base of this ref with HEAD is what the branch is diffed against for the `pr`
   *  provenance and the viewer's changed lines. Defaults to the repo's local default branch
   *  (`origin/HEAD`, else `main`/`master`) — never a network call; the real gh PR base is refined
   *  off-thread by `warmBaseRef`. */
  baseRef?: (root: string) => string | null;
}

export const MAX_FILE_BYTES = 512 * 1024;
const MAX_WALK_ENTRIES = 5000;
// Shared with the live-reload watcher (viewerWatch.ts): discovery skips these dirs, so the watcher
// MUST ignore events under them too — else `git status`'s own `.git/index` write feeds a reload loop.
export const IGNORED_DIRS = new Set(['.git', 'node_modules', '.agent-terminal']);
const NUL = '\u0000';

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

function defaultGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

const execFileAsync = promisify(execFile);

/** The current branch's PR base branch name from GitHub, or null when there is no PR / gh is
 *  unavailable. Async so the network round-trip is never on the synchronous discovery path (§20.1). */
async function defaultPrBaseName(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', '--json', 'baseRefName', '-q', '.baseRefName'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// --end-of-options: a base ref is repo/remote-controlled data, so it is passed as a ref, never parsed
// as a git switch even if it begins with `-` (CLAUDE.md: untrusted data crosses a boundary as data,
// not syntax; CWE-88).
function refExists(ref: string, root: string, git: (args: string[], cwd: string) => string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], root);
    return true;
  } catch {
    return false;
  }
}

// Memoized per (root, branch) so the viewer's watch-driven re-pulls (§20.1) don't re-resolve on every burst.
const baseRefMemo = new Map<string, string | null>();

function branchKey(root: string, git: (args: string[], cwd: string) => string): string {
  let branch = '';
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
  } catch {
    // detached HEAD / no commits — resolve unkeyed by branch.
  }
  return `${root}${NUL}${branch}`;
}

/** The base ref inferred from local refs alone — the repo's remote default branch (origin/HEAD), else a
 *  conventional local default. Never a network call, so it can run on the synchronous discovery path. */
function localBaseRef(root: string, git: (args: string[], cwd: string) => string): string | null {
  try {
    const head = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root).trim();
    if (head) return head.replace(/^refs\/remotes\//, '');
  } catch {
    // origin/HEAD unset.
  }
  for (const cand of ['main', 'master']) if (refExists(cand, root, git)) return cand;
  return null;
}

function defaultBaseRef(root: string, git: (args: string[], cwd: string) => string): string | null {
  const key = branchKey(root, git);
  const cached = baseRefMemo.get(key);
  if (cached !== undefined) return cached;
  const resolved = localBaseRef(root, git);
  if (resolved !== null) baseRefMemo.set(key, resolved); // don't cache a miss — re-resolve if a base later appears
  return resolved;
}

export interface WarmDeps {
  git?: (args: string[], cwd: string) => string;
  /** The branch's PR base branch name from GitHub (§20.1), or null when there's no PR / it's unavailable. */
  prBaseName?: (root: string) => Promise<string | null>;
  /** Current time in ms (§20.1) — injected so the retry throttle is deterministically testable. */
  now?: () => number;
}

// A resolved gh base is deduped for the session; an UNRESOLVED attempt (no PR yet / gh offline) is
// retried no more often than WARM_RETRY_MS. This bounds the credential-bearing spawn on the per-burst
// warm path (a git checkout produces no cwd change — §20.1) while still picking up a PR opened, or
// connectivity restored, mid-session — the guarantee a plain once-per-session guard would drop.
export const WARM_RETRY_MS = 30_000;
const warmedKeys = new Set<string>();
const lastWarmAttempt = new Map<string, number>();

/** Refine the memoized base for `root`'s current branch to the real gh-resolved PR base, off the
 *  synchronous discovery path (§20.1). Returns true when the base changed from what the sync path
 *  resolved (the caller re-pulls the viewer). A resolved base is deduped for the session; an unresolved
 *  attempt never overwrites the memo and is retried after WARM_RETRY_MS, so a PR opened — or gh
 *  connectivity restored — mid-session is still picked up. */
export async function warmBaseRef(root: string, deps: WarmDeps = {}): Promise<boolean> {
  const git = deps.git ?? defaultGit;
  const fetchBase = deps.prBaseName ?? defaultPrBaseName;
  const now = deps.now ?? Date.now;
  const key = branchKey(root, git);
  if (warmedKeys.has(key)) return false;
  const last = lastWarmAttempt.get(key);
  if (last !== undefined && now() - last < WARM_RETRY_MS) return false;
  lastWarmAttempt.set(key, now());
  let name: string | null = null;
  try {
    name = (await fetchBase(root))?.trim() || null;
  } catch {
    name = null;
  }
  if (!name) return false;
  let ghBase: string | null = null;
  if (refExists(`origin/${name}`, root, git)) ghBase = `origin/${name}`;
  else if (refExists(name, root, git)) ghBase = name;
  if (!ghBase) return false;
  warmedKeys.add(key);
  lastWarmAttempt.delete(key);
  const current = baseRefMemo.has(key) ? baseRefMemo.get(key)! : localBaseRef(root, git);
  baseRefMemo.set(key, ghBase);
  return ghBase !== current;
}

/** Wire base-warming to a cwd/branch change (§20.1): resolve the current root, warm its base off the
 *  synchronous path, and fire `onChanged` only when the real PR base differs from the local one.
 *  Best-effort — a warm that throws is swallowed so it can never abort the caller. */
export function createBaseWarmer(deps: {
  root: () => string | null;
  warm: (root: string) => Promise<boolean>;
  onChanged: () => void;
}): () => Promise<void> {
  return async () => {
    const root = deps.root();
    if (!root) return;
    try {
      if (await deps.warm(root)) deps.onChanged();
    } catch {
      // best-effort: a failed warm never propagates into the caller.
    }
  };
}

/** The viewer-activity handler (§20.1): a watch burst both re-pulls the viewer and warms the base
 *  off-thread — a `git checkout` produces no cwd change, so its working-tree writes are the branch-switch
 *  signal. Extracted so the "burst also warms" wiring is covered without driving the non-hermetic gh path. */
export function createViewerActivityHandler(deps: { pushChanged: () => void; warm: () => Promise<void> }): () => void {
  return () => {
    deps.pushChanged();
    void deps.warm();
  };
}

/** Test-only: clear the process-lifetime base-resolution caches so integration tests are isolated
 *  explicitly, not by temp-dir uniqueness (§20.1). */
export function __resetBaseRefState(): void {
  baseRefMemo.clear();
  warmedKeys.clear();
  lastWarmAttempt.clear();
}

/** The merge-base of `baseRef` and HEAD — the branch point the PR is diffed against — or null. */
function mergeBaseOf(baseRef: string, root: string, git: (args: string[], cwd: string) => string): string | null {
  try {
    const mb = git(['merge-base', '--end-of-options', baseRef, 'HEAD'], root).trim();
    return mb || null;
  } catch {
    return null;
  }
}

/** Files committed on this branch since `mergeBase` (existing on HEAD — deletions excluded). */
function prFiles(root: string, mergeBase: string, git: (args: string[], cwd: string) => string): Set<string> {
  try {
    const out = git(['diff', '--name-only', '-z', '--diff-filter=d', mergeBase, 'HEAD'], root);
    return new Set(out.split(NUL).filter((p) => p.length > 0));
  } catch {
    return new Set();
  }
}

/** The git top-level of `cwd` (`path.resolve`d), or null when `cwd` is not in a repo. Shared with the
 *  live-reload watcher (viewerWatch.ts) so the watch root and the discovery root resolve identically. */
export function gitRootOf(cwd: string, git: (args: string[], cwd: string) => string = defaultGit): string | null {
  try {
    const out = git(['rev-parse', '--show-toplevel'], cwd).trim();
    return out ? path.resolve(out) : null;
  } catch {
    return null;
  }
}

/** Working-tree changes from `git status --porcelain` → tree-relative paths (handles rename arrows). */
function changedFiles(root: string, git: (args: string[], cwd: string) => string): Set<string> {
  const out = git(['status', '--porcelain', '-z'], root);
  const set = new Set<string>();
  // git -z rename/copy record is "R  old\0new": the R/C entry pairs with the next NUL field.
  const parts = out.split(NUL).filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    let file = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') {
      file = parts[++i] ?? file;
    }
    if (file) set.add(file);
  }
  return set;
}

function trackedFiles(root: string, git: (args: string[], cwd: string) => string): string[] {
  const out = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root);
  return out.split(NUL).filter((p) => p.length > 0);
}

function walkDir(dir: string, base = dir, acc: string[] = []): string[] {
  if (acc.length >= MAX_WALK_ENTRIES) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= MAX_WALK_ENTRIES) break;
    if (IGNORED_DIRS.has(e.name)) continue; // skips the literal .git, not .gitignore/.github/…
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(abs, base, acc);
    else if (e.isFile()) acc.push(path.relative(base, abs));
  }
  return acc;
}

function loopFiles(root: string): Set<string> {
  // Confine the loop-dir walk: a symlink planted at .agent-terminal/loop or its parent that resolves out of
  // the (untrusted) working tree is refused, not enumerated into the tree (CWE-59/22). Same confinement the
  // loop engine reads the area through (appLoopState.ts: resolveJail + confinedRealPath).
  const jail = resolveJail(root, ...APP_LOOP_DIR_SEGMENTS);
  const real = jail === null ? null : confinedRealPath(jail, jail);
  if (real === null) return new Set();
  // Key relPaths on the loop segments (not path.relative(root, …)) so a symlinked repo root can't escape them,
  // and POSIX-join so they match buildTree's '/'-keyed paths on Windows too (§20.1).
  return new Set(walkDir(real, real).map((p) => [...APP_LOOP_DIR_SEGMENTS, ...p.split(path.sep)].join('/')));
}

function buildTree(relPaths: string[], prov: (rel: string) => ArtifactProvenance[] | undefined): ArtifactNode[] {
  const root: ArtifactNode[] = [];
  const dirIndex = new Map<string, ArtifactNode[]>([['', root]]);

  const ensureDir = (dirRel: string): ArtifactNode[] => {
    const existing = dirIndex.get(dirRel);
    if (existing) return existing;
    const parentRel = dirRel.includes('/') ? dirRel.slice(0, dirRel.lastIndexOf('/')) : '';
    const siblings = ensureDir(parentRel);
    const node: ArtifactNode = { name: dirRel.slice(dirRel.lastIndexOf('/') + 1), relPath: dirRel, kind: 'dir', children: [] };
    siblings.push(node);
    dirIndex.set(dirRel, node.children!);
    return node.children!;
  };

  for (const rel of [...new Set(relPaths)].sort()) {
    const norm = rel.split(path.sep).join('/');
    const dirRel = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
    const siblings = ensureDir(dirRel);
    siblings.push({ name: norm.slice(norm.lastIndexOf('/') + 1), relPath: norm, kind: 'file', provenance: prov(norm) });
  }

  const sortNodes = (ns: ArtifactNode[]): void => {
    ns.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
    for (const n of ns) if (n.children) sortNodes(n.children);
  };
  sortNodes(root);
  return root;
}

/** The viewer:tree fallback for an invalid request: an empty tree, never null — the renderer
 *  consumes `ArtifactTree` and would crash on null (§20.1). */
export function emptyTree(root: string, scope: ArtifactScope = 'curated'): ArtifactTree {
  return { root, isRepo: false, scope, nodes: [] };
}

export function discover(cwd: string, scope: ArtifactScope, deps: DiscoverDeps = {}): ArtifactTree {
  const git = deps.git ?? defaultGit;
  const root = gitRootOf(cwd, git);

  if (!root) {
    const dir = path.resolve(cwd);
    const files = (deps.listDir ?? ((d) => walkDir(d)))(dir);
    return { root: dir, isRepo: false, scope, nodes: buildTree(files, () => undefined) };
  }

  const notAppState = (files: Iterable<string>): Set<string> =>
    new Set([...files].filter((f) => !isUnderAppStateDir(f)));
  const changed = notAppState(changedFiles(root, git));
  const loop = loopFiles(root);
  const base = (deps.baseRef ?? ((r: string) => defaultBaseRef(r, git)))(root);
  const mergeBase = base ? mergeBaseOf(base, root, git) : null;
  const pr = notAppState(mergeBase ? prFiles(root, mergeBase, git) : new Set<string>());
  const provenance = (rel: string): ArtifactProvenance[] | undefined => {
    const tags: ArtifactProvenance[] = [];
    if (changed.has(rel)) tags.push('changed');
    if (pr.has(rel)) tags.push('pr');
    if (loop.has(rel)) tags.push('loop');
    return tags.length ? tags : undefined;
  };

  const rels =
    scope === 'repo'
      ? [...notAppState(trackedFiles(root, git))]
      : // §20.1: the loop tree lives under .agent-terminal/, which `notAppState` excludes from changed/pr —
        // so `loop` is the only term re-admitting it (curated-only, never repo scope). Dropping either the
        // exclusion or this re-add silently changes which files carry the `loop` tag.
        [...new Set([...changed, ...pr, ...loop])];

  return { root, isRepo: true, scope, nodes: buildTree(rels, provenance) };
}

/** Current-file line numbers (1-based) parsed from the `+` side of a unified diff's hunk headers. */
function addedLinesFromDiff(diff: string): number[] {
  const lines: number[] = [];
  for (const row of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]); // `+c,0` (pure deletion) marks nothing
    for (let i = 0; i < count; i++) lines.push(start + i);
  }
  return lines;
}

/** Lines in `rel`'s working-tree copy that differ from `baseline` (the PR merge-base, else HEAD) —
 *  added or modified, never deletions (§20.2). Diffing the working tree against the merge-base is the
 *  superset: it marks both committed-in-PR and uncommitted lines in one pass. */
function changedLinesOf(root: string, rel: string, body: string, git: (args: string[], cwd: string) => string, baseline: string): number[] {
  let status: string;
  try {
    status = git(['status', '--porcelain', '-z', '--', rel], root);
  } catch {
    return [];
  }
  if (status.startsWith('??')) {
    // Untracked: `git diff <baseline>` skips it, so mark every content line as new.
    const content = body.endsWith('\n') ? body.slice(0, -1) : body;
    return content === '' ? [] : content.split('\n').map((_, i) => i + 1);
  }
  try {
    return addedLinesFromDiff(git(['diff', '--no-color', '-U0', baseline, '--', rel], root));
  } catch {
    return [];
  }
}

/** True if `target` is `base` or lives under it (§20.2 escape guard). MUST stay path.relative-based,
 *  not startsWith(base + sep): the latter mishandles the filesystem root and Windows cross-drive paths. */
export function pathWithin(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = path.relative(base, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // different root/drive → escape
  // Only a leading `..` SEGMENT escapes; a dir whose name merely starts with ".." is in-root.
  return rel.split(path.sep)[0] !== '..';
}

export function readArtifact(cwd: string, relPath: string, deps: DiscoverDeps = {}): ViewerFile | null {
  const git = deps.git ?? defaultGit;
  const gitRoot = gitRootOf(cwd, git);
  const root = gitRoot ?? path.resolve(cwd);
  const abs = path.resolve(root, relPath);
  if (!pathWithin(root, abs)) return null; // §20.2 escape guard
  try {
    // §20.2: re-check the realpath (an in-root symlink can point out), then read the validated
    // real path — not abs — so a post-check target swap can't bypass the guard (TOCTOU). ext/name
    // stay on relPath/abs (pure string ops, no fs) to match the tree label the user clicked.
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (!pathWithin(realRoot, real)) return null;
    const read = readBoundedNoFollow(real, MAX_FILE_BYTES);
    if (!read.ok) return null;
    const body = read.text;
    if (body.includes(NUL)) return null;
    const ext = path.extname(abs).toLowerCase();
    const kind: ViewerFileKind = ext === '.md' || ext === '.markdown' ? 'markdown' : 'code';
    const rel = relPath.split(path.sep).join('/');
    const file: ViewerFile = { relPath: rel, name: path.basename(abs), kind, lang: LANG_BY_EXT[ext], body };
    if (gitRoot && kind === 'code') {
      const base = (deps.baseRef ?? ((r: string) => defaultBaseRef(r, git)))(gitRoot);
      const mergeBase = base ? mergeBaseOf(base, gitRoot, git) : null;
      const changed = changedLinesOf(gitRoot, rel, body, git, mergeBase ?? 'HEAD');
      if (changed.length) file.changedLines = changed;
    }
    return file;
  } catch {
    return null;
  }
}
