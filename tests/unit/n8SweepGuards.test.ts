// N8 sweep completion guards (issue #98, docs/n8-deletion-list.md §D.4). AC 1's real guard is a test in
// the suite, not a manual grep: the retired in-terminal loop engine and every citation of it are gone, and
// these tests keep them gone. Each guard names the mutation that falsifies it, per §D.4's preamble.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** Tracked files under the given repo-relative roots — the "tracked path" set §D.4 grades over, never the
 *  working tree (which would sweep in build output). */
function trackedFiles(...roots: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', ...roots], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => f.length > 0);
}

const readText = (f: string): string => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

// ─── §D.4 row: the citation grep over `src` + `tests` returns zero (AC 1) ───────────────────────────────
// The needle is CONSTRUCTED (not the literal), so this test file does not match its own source and needs no
// exclusion list. The file set is every tracked file under src/ and tests/, not a TypeScript glob —
// index.html and styles.css carry citations the AC's grep counts too. Falsified by planting the sequence in
// any tracked src/ or tests/ file (890 matching lines before the sweep).
describe('AC1 — no §26 citation survives under src/ or tests/', () => {
  const SECTION = String.fromCharCode(0xa7); // U+00A7 '§' — constructed so this file is not a self-match
  const NEEDLE = SECTION + '26';

  it('every tracked file under src/ and tests/ is free of the retired-section citation', () => {
    const offenders = trackedFiles('src', 'tests').filter((f) => readText(f).includes(NEEDLE));
    expect(offenders, `${NEEDLE} still cited in:\n${offenders.join('\n')}`).toEqual([]);
  });
});

// ─── §D.4 row: the orphan walk from the entry points (AC 1) ─────────────────────────────────────────────
// Reachability over the module graph from the three runtime entry points plus the two build-time modules,
// following ONLY relative import/export specifiers (a non-relative specifier is a package, not a module in
// the graph). `*.d.ts` is excluded as a closed rule; test files are non-consumers (a src module reachable
// only from a test is still an orphan). Post-sweep every src module is reachable; a leftover module from the
// deletion (e.g. legacyPickupPorts.ts) would be named in the failure.

/** Generic reachability: the set of nodes reachable from `roots` under `neighbors`. Pure — the synthetic
 *  test below plants an orphan and a test-only importer to grade it independently of the tree. */
function reachableFrom(roots: string[], neighbors: (n: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const n = stack.pop() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of neighbors(n)) if (!seen.has(m)) stack.push(m);
  }
  return seen;
}

/** Every relative module specifier `text` imports/exports/dynamically-imports. */
function importSpecifiers(text: string): string[] {
  const specs = new Set<string>();
  for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1]); // import/export … from
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.add(m[1]); // side-effect import
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]); // dynamic import
  return [...specs];
}

/** Resolve a relative specifier to the repo-relative path of an existing module file, or null (a package,
 *  or a non-module asset that is not a graph node). */
function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base + '.ts',
    base + '.tsx',
    base.replace(/\.js$/, '.ts'),
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && (c.endsWith('.ts') || c.endsWith('.tsx'))) {
      return relative('.', c);
    }
  }
  return null;
}

describe('AC1 — no orphaned src module survives the sweep', () => {
  const ROOTS = [
    'src/main/index.ts',
    'src/preload/index.ts',
    'src/renderer/src/index.ts',
    'src/main/appIconBuild.ts', // build-time (§ appIconBuild)
    'src/main/exampleAssetsBuild.ts', // build-time (§ exampleAssetsBuild)
  ];

  it('the entry points still exist', () => {
    for (const r of ROOTS) expect(existsSync(r), `entry point missing: ${r}`).toBe(true);
  });

  it('every tracked src module is reachable from an entry point', () => {
    const neighbors = (file: string): string[] =>
      file.endsWith('.ts') || file.endsWith('.tsx')
        ? importSpecifiers(readText(file)).map((s) => resolveModule(file, s)).filter((r): r is string => r !== null)
        : [];
    const reached = reachableFrom(ROOTS, neighbors);
    const modules = trackedFiles('src').filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    const orphans = modules.filter((m) => !reached.has(m));
    expect(orphans, `orphaned src modules (unreachable from any entry point):\n${orphans.join('\n')}`).toEqual([]);
  });

  // The algorithm, graded on a synthetic graph independent of the tree: a planted orphan is flagged, and a
  // module reachable ONLY through a test file is still an orphan (tests are non-consumers).
  it('flags a planted orphan and a test-only-imported module (algorithm falsifier)', () => {
    const graph: Record<string, string[]> = {
      'src/entry.ts': ['src/used.ts'],
      'src/used.ts': [],
      'src/orphan.ts': [], // reachable from nothing
      'tests/only.test.ts': ['src/testOnly.ts'], // a test imports it…
      'src/testOnly.ts': [], // …but the walk starts from src roots, so it stays an orphan
    };
    const reached = reachableFrom(['src/entry.ts'], (n) => graph[n] ?? []);
    const srcModules = Object.keys(graph).filter((f) => f.startsWith('src/'));
    const orphans = srcModules.filter((m) => !reached.has(m));
    expect(orphans).toContain('src/orphan.ts');
    expect(orphans).toContain('src/testOnly.ts');
    expect(orphans).not.toContain('src/used.ts');
  });
});
