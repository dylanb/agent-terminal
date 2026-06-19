// Artifact discovery (§20.1 / D8): turn the session's current directory into the viewer's
// file tree. In a git repo the curated default is working-tree changes ∪ the agent-loop
// directory, with a whole-repo scope on demand and per-file provenance tags; outside a repo
// it is simply the cwd's directory tree. Real git + real fs — the PR provenance tag and the
// LoopDef `artifacts:` declarations wait on the agent-loop bridge (§24.2).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
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
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_WALK_ENTRIES = 5000;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.agent-terminal']);
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

function gitRootOf(cwd: string, git: (args: string[], cwd: string) => string): string | null {
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
  // NUL-separated; a rename record is "R  old\0new", so an R/C status pairs with the next field.
  const parts = out.split(NUL).filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    let file = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') {
      file = parts[++i] ?? file; // the destination path is the next NUL field
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
  const loopDir = path.join(root, '.agent-loop');
  if (!existsSync(loopDir)) return new Set();
  // walkDir yields path.sep-separated paths; the provenance sets are keyed by the POSIX-normalized
  // paths buildTree produces (and changed/tracked come from git, always '/'). Normalize so loop
  // membership matches on Windows too, where path.sep is '\\' (§20.1).
  return new Set(walkDir(loopDir, root).map((p) => p.split(path.sep).join('/')));
}

/** Build a hierarchical node tree from tree-relative file paths; dirs first, then name. */
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

/** A valid, empty tree (§20.1) — the viewer:tree fallback for an untrusted/invalid request,
 *  so the `Promise<ArtifactTree>` contract holds (returning null would crash the renderer). */
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

  const changed = changedFiles(root, git);
  const loop = loopFiles(root);
  const provenance = (rel: string): ArtifactProvenance[] | undefined => {
    const tags: ArtifactProvenance[] = [];
    if (changed.has(rel)) tags.push('changed');
    if (loop.has(rel)) tags.push('loop');
    return tags.length ? tags : undefined;
  };

  const rels = scope === 'repo' ? trackedFiles(root, git) : [...new Set([...changed, ...loop])];

  return { root, isRepo: true, scope, nodes: buildTree(rels, provenance) };
}

/** Current-file line numbers (1-based) parsed from the `+` side of a unified diff's hunk headers. */
function addedLinesFromDiff(diff: string): number[] {
  const lines: number[] = [];
  for (const row of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]); // a `+c,0` (pure deletion) marks nothing
    for (let i = 0; i < count; i++) lines.push(start + i);
  }
  return lines;
}

/** Lines in `rel`'s working-tree copy that differ from HEAD — added or modified, never deletions (§20.2). */
function changedLinesOf(root: string, rel: string, body: string, git: (args: string[], cwd: string) => string): number[] {
  let status: string;
  try {
    status = git(['status', '--porcelain', '-z', '--', rel], root);
  } catch {
    return [];
  }
  if (status.length === 0) return []; // matches HEAD and index → nothing to mark
  if (status.startsWith('??')) {
    // Untracked: HEAD has no version, so every content line is new. `git diff HEAD` would skip it.
    const content = body.endsWith('\n') ? body.slice(0, -1) : body;
    return content === '' ? [] : content.split('\n').map((_, i) => i + 1);
  }
  try {
    return addedLinesFromDiff(git(['diff', '--no-color', '-U0', 'HEAD', '--', rel], root));
  } catch {
    return [];
  }
}

/** True if `target` is `base` or lives under it (§20.2 escape guard). path.relative-based, so the
 *  filesystem root (`base === '/'`, where `base + sep` would be '//') and Windows cross-drive paths
 *  resolve correctly — a startsWith(base + sep) check mishandles both. */
export function pathWithin(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = path.relative(base, target);
  if (rel === '') return true; // identical after normalization
  if (path.isAbsolute(rel)) return false; // different root/drive (Windows) → escape
  // Only a leading `..` SEGMENT is an escape; a dir whose name merely starts with ".." is in-root.
  return rel.split(path.sep)[0] !== '..';
}

export function readArtifact(cwd: string, relPath: string, deps: DiscoverDeps = {}): ViewerFile | null {
  const git = deps.git ?? defaultGit;
  const gitRoot = gitRootOf(cwd, git);
  const root = gitRoot ?? path.resolve(cwd);
  const abs = path.resolve(root, relPath);
  // Escape guard: the resolved path must stay within the discovery root (§20.2).
  if (!pathWithin(root, abs)) return null;
  try {
    // Resolve symlinks too: an in-root link pointing outside passes the lexical guard above,
    // so re-check the real path against the real root before reading (§20.2).
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (!pathWithin(realRoot, real)) return null;
    // Stat/read the VALIDATED real path, not the original (possibly symlink) abs — otherwise a
    // target swap between the realpath check and the read could bypass the guard (TOCTOU, §20.2).
    // ext/name below are pure string ops on the user-navigated path (no fs access → no TOCTOU), and
    // keeping them on relPath/abs matches the tree label the user clicked.
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const body = readFileSync(real, 'utf8');
    if (body.includes(NUL)) return null; // binary
    const ext = path.extname(abs).toLowerCase();
    const kind: ViewerFileKind = ext === '.md' || ext === '.markdown' ? 'markdown' : 'code';
    const rel = relPath.split(path.sep).join('/');
    const file: ViewerFile = { relPath: rel, name: path.basename(abs), kind, lang: LANG_BY_EXT[ext], body };
    if (gitRoot && kind === 'code') {
      const changed = changedLinesOf(gitRoot, rel, body, git);
      if (changed.length) file.changedLines = changed;
    }
    return file;
  } catch {
    return null;
  }
}
