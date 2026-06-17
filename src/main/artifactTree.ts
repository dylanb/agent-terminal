// Artifact discovery (§20.1 / D8): turn the session's current directory into the viewer's
// file tree. In a git repo the curated default is working-tree changes ∪ the agent-loop
// directory, with a whole-repo scope on demand and per-file provenance tags; outside a repo
// it is simply the cwd's directory tree. Real git + real fs — the PR provenance tag and the
// LoopDef `artifacts:` declarations wait on the agent-loop bridge (§24.2).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
    if (e.name.startsWith('.git') || IGNORED_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(abs, base, acc);
    else if (e.isFile()) acc.push(path.relative(base, abs));
  }
  return acc;
}

function loopFiles(root: string): Set<string> {
  const loopDir = path.join(root, '.agent-loop');
  if (!existsSync(loopDir)) return new Set();
  return new Set(walkDir(loopDir, root));
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

export function readArtifact(cwd: string, relPath: string, deps: DiscoverDeps = {}): ViewerFile | null {
  const git = deps.git ?? defaultGit;
  const root = gitRootOf(cwd, git) ?? path.resolve(cwd);
  const abs = path.resolve(root, relPath);
  // Escape guard: the resolved path must stay within the discovery root (§20.2).
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const body = readFileSync(abs, 'utf8');
    if (body.includes(NUL)) return null; // binary
    const ext = path.extname(abs).toLowerCase();
    const kind: ViewerFileKind = ext === '.md' || ext === '.markdown' ? 'markdown' : 'code';
    return { relPath: relPath.split(path.sep).join('/'), name: path.basename(abs), kind, lang: LANG_BY_EXT[ext], body };
  } catch {
    return null;
  }
}
