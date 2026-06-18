import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover, readArtifact, emptyTree } from '../../src/main/artifactTree';
import type { ArtifactNode } from '../../src/shared/ipc';

// Real git, real filesystem — no mocks (CLAUDE.md). Discovery (§20.1) is exercised against a
// temp repo we build with actual git commands, mirroring how scanner tests drive a real shadow.

const git = (args: string[], cwd: string): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** Flatten a tree to "relPath" leaves for order-independent assertions. */
function fileRelPaths(nodes: ArtifactNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: ArtifactNode[]): void => {
    for (const n of ns) {
      if (n.kind === 'file') out.push(n.relPath);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
function findFile(nodes: ArtifactNode[], relPath: string): ArtifactNode | undefined {
  let found: ArtifactNode | undefined;
  const walk = (ns: ArtifactNode[]): void => {
    for (const n of ns) {
      if (n.kind === 'file' && n.relPath === relPath) found = n;
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return found;
}

describe('artifact discovery (§20.1 / D8 — real git)', () => {
  let repo: string;
  let plain: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'art-repo-'));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t'], repo);
    git(['config', 'user.name', 'T'], repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'committed.md'), '# Committed\n\nbody');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'init'], repo);
    // Now make a working-tree change, add an untracked file, and an agent-loop artifact.
    writeFileSync(join(repo, 'committed.md'), '# Committed\n\nbody changed');
    writeFileSync(join(repo, 'untracked.txt'), 'scratch');
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'plan.md'), '# Plan\n');

    plain = mkdtempSync(join(tmpdir(), 'art-plain-'));
    mkdirSync(join(plain, 'docs'), { recursive: true });
    writeFileSync(join(plain, 'readme.md'), '# Readme');
    writeFileSync(join(plain, 'docs', 'note.txt'), 'note');
    // Dotfiles/dirs that merely *start with* ".git" must not be mistaken for the literal .git dir.
    writeFileSync(join(plain, '.gitignore'), 'node_modules\n');
    mkdirSync(join(plain, '.github'), { recursive: true });
    writeFileSync(join(plain, '.github', 'ci.yml'), 'name: ci\n');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  it('curated scope = working-tree changes ∪ agent-loop, excluding unchanged committed files', () => {
    const tree = discover(repo, 'curated');
    expect(tree.isRepo).toBe(true);
    expect(tree.root).toBe(repo);
    const files = fileRelPaths(tree.nodes);
    expect(files).toEqual(expect.arrayContaining(['committed.md', 'untracked.txt', '.agent-loop/plan.md']));
    expect(files).not.toContain('src/a.ts'); // committed, unchanged → not curated
  });

  it('tags provenance: changed for working-tree edits, loop for .agent-loop files', () => {
    const tree = discover(repo, 'curated');
    expect(findFile(tree.nodes, 'committed.md')?.provenance).toContain('changed');
    expect(findFile(tree.nodes, '.agent-loop/plan.md')?.provenance).toContain('loop');
  });

  it('repo scope = every tracked + untracked file, built hierarchically', () => {
    const tree = discover(repo, 'repo');
    const files = fileRelPaths(tree.nodes);
    expect(files).toEqual(expect.arrayContaining(['committed.md', 'src/a.ts', 'untracked.txt']));
    // src/a.ts lives under a real directory node, not a flat row.
    const srcDir = tree.nodes.find((n) => n.kind === 'dir' && n.name === 'src');
    expect(srcDir?.children?.some((c) => c.name === 'a.ts')).toBe(true);
  });

  it('outside a git repo, discovers the whole cwd directory tree (no provenance)', () => {
    const tree = discover(plain, 'curated');
    expect(tree.isRepo).toBe(false);
    expect(tree.root).toBe(plain);
    expect(fileRelPaths(tree.nodes)).toEqual(expect.arrayContaining(['readme.md', 'docs/note.txt']));
    expect(findFile(tree.nodes, 'readme.md')?.provenance).toBeUndefined();
  });

  it('outside a git repo, includes dotfiles like .gitignore and .github/ (only the literal .git dir is skipped)', () => {
    const tree = discover(plain, 'curated');
    const files = fileRelPaths(tree.nodes);
    expect(files).toEqual(expect.arrayContaining(['.gitignore', '.github/ci.yml']));
  });

  // viewer:tree must satisfy its Promise<ArtifactTree> contract even for an untrusted/invalid
  // request — the handler returns this safe empty tree instead of null (which would crash the
  // renderer's `data.root` read).
  it('emptyTree() is a valid, empty ArtifactTree (the invalid-request fallback)', () => {
    expect(emptyTree('/some/cwd')).toEqual({ root: '/some/cwd', isRepo: false, scope: 'curated', nodes: [] });
    expect(emptyTree('/x', 'repo').scope).toBe('repo');
  });

  it('reads a file by tree-relative path, classifying markdown vs code', () => {
    expect(readArtifact(repo, 'committed.md')).toMatchObject({ kind: 'markdown', name: 'committed.md' });
    const code = readArtifact(repo, 'src/a.ts');
    expect(code).toMatchObject({ kind: 'code', lang: 'typescript' });
    expect(code?.body).toContain('export const x = 1;');
  });

  it('refuses to read outside the discovery root (path-escape guard)', () => {
    expect(readArtifact(repo, '../../etc/passwd')).toBeNull();
    expect(readArtifact(repo, 'does-not-exist.md')).toBeNull();
  });

  it('refuses to follow an in-root symlink that points outside the discovery root', () => {
    // A symlink that lives inside the root but targets an outside file passes the lexical
    // guard; the read must still refuse it (resolve real paths, not just the literal path).
    const outside = mkdtempSync(join(tmpdir(), 'art-outside-'));
    writeFileSync(join(outside, 'secret.md'), '# secret');
    try {
      symlinkSync(join(outside, 'secret.md'), join(plain, 'link.md'));
    } catch {
      return; // platform without symlink permission — skip
    }
    expect(readArtifact(plain, 'link.md')).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  // §20.2: a code file carries the current-file line numbers that differ from HEAD — added or
  // modified lines only (not a diff; deletions leave no current line to mark).
  it('marks added lines of a modified code file by their current-file position', () => {
    // a.ts was committed as a single line; append two more, leaving line 1 untouched.
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
    expect(readArtifact(repo, 'src/a.ts')?.changedLines).toEqual([2, 3]);
  });

  it('marks a modified line in place, not as a deletion', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 99;\n');
    expect(readArtifact(repo, 'src/a.ts')?.changedLines).toEqual([1]);
  });

  it('marks every line of an untracked (entirely new) code file', () => {
    writeFileSync(join(repo, 'src', 'fresh.ts'), 'a\nb\nc\n');
    expect(readArtifact(repo, 'src/fresh.ts')?.changedLines).toEqual([1, 2, 3]);
  });

  it('leaves changedLines unset for an unchanged code file', () => {
    expect(readArtifact(repo, 'src/a.ts')?.changedLines).toBeUndefined();
  });

  it('does not compute changed lines for markdown files', () => {
    expect(readArtifact(repo, 'committed.md')?.changedLines).toBeUndefined();
  });

  it('outside a git repo, code files carry no changed-line info', () => {
    writeFileSync(join(plain, 'free.ts'), 'a\nb\n');
    expect(readArtifact(plain, 'free.ts')?.changedLines).toBeUndefined();
  });
});
