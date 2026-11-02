// N8 sweep completion guards (issue #98): the retired in-terminal loop engine's modules and identifiers are gone,
// and these tests keep them gone.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { resolveEngineGuideFile } from '../../src/main/exampleAssets';

const SELF = 'tests/unit/n8SweepGuards.test.ts';

/** Tracked files under the given repo-relative roots — the "tracked path" set these guards grade over, never the
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

// ─── The orphan walk from the entry points (AC 1) ─────────────────────────────────────────────
// Reachability over the module graph from the three runtime entry points plus the two build-time modules,
// following ONLY relative import/export specifiers (a non-relative specifier is a package, not a module in
// the graph). `*.d.ts` is excluded as a closed rule; test files are non-consumers (a src module reachable
// only from a test is still an orphan). Post-sweep every src module is reachable; a leftover module from the
// deletion (e.g. a §I.1-deleted port) would be named in the failure.

/** Generic reachability: the set of nodes reachable from `roots` under `neighbors`. */
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
    'src/main/controller.ts',
    'src/renderer/src/controller.ts',
    'src/preload/index.ts',
    'src/renderer/src/index.ts',
    'src/main/appIconBuild.ts', // build-time
    'src/main/exampleAssetsBuild.ts', // build-time
    'src/main/artifactCheckMain.ts', // second main-bundle input (electron.vite.config.ts), run by the agent
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
});

// ─── No removed retired-engine identifier survives in tracked code (AC 1/2/7) ──────────────────
// Seeded from the same constants the sweep removed: the retired FlowApi members, the retired Flow*Msg
// IPC message types, the retired CH channel-key names, and the retired `flow:gate` channel. Matched WHOLE-WORD
// and CASE-SENSITIVE — the surviving §27 tokens (`appGateDecision`, `gateDecisionAuditCmd`,
// `flowAppGateDecision`, `appRouteOut`) differ in case or carry a boundary-less camelCase prefix, so none is a
// match. This file is excluded because the needles are its data.
describe('AC1/2/7 — no removed retired-engine identifier survives in tracked code', () => {
  const CODE_FILE = /\.(?:[cm]?[jt]sx?|sh|bash)$/;
  const NEEDLES = [
    'markTurnComplete', 'gateDecision', 'retryTurn', 'onBootstrapConflict', 'resolveBootstrapConflict', // FlowApi members
    'FlowGateDecisionMsg', 'FlowMarkTurnCompleteMsg', 'FlowBootstrapConflictMsg', 'FlowResolveBootstrapConflictMsg', // Flow*Msg types
    'flowGateDecision', 'flowMarkTurnComplete', 'flowRetryTurn', 'flowOnBootstrapConflict', 'flowResolveBootstrapConflict', // CH keys
    'flow:gate', // retired-engine injected-command gate channel
  ];
  const patterns = NEEDLES.map((n) => ({ needle: n, re: new RegExp(`\\b${n}\\b`) }));

  it('every removed identifier is absent from tracked code and tests', () => {
    const files = trackedFiles('.').filter((f) => CODE_FILE.test(f) && f !== SELF);
    const violations: string[] = [];
    for (const f of files) {
      const text = readText(f);
      for (const { needle, re } of patterns) if (re.test(text)) violations.push(`${needle} → ${f}`);
    }
    expect(violations, `removed retired-engine identifiers still present:\n${violations.join('\n')}`).toEqual([]);
  });
});

// ─── The packaging manifest ships no deleted tree ──────────────────────────────────
// A shipped-files entry for a deleted tree breaks `pnpm run package` (electron-builder copies each `from:` at
// package time; a source that no longer exists aborts the build) with no unit/e2e/build step exercising it.
describe('the packaging manifest ships no deleted path', () => {
  const yml = readText('electron-builder.yml');

  it('every concrete extraResources `from:` path exists on disk', () => {
    // The built engine guide exists only once the build has written it, and CI runs this before any build.
    const builtGuide = resolveEngineGuideFile({ packaged: false, appPath: join('out', 'main') });
    const froms = [...yml.matchAll(/^\s*-\s*from:\s*(\S+)\s*$/gm)].map((m) => m[1]).filter((p) => !/[*?]/.test(p) && p !== builtGuide);
    expect(froms.length).toBeGreaterThan(0);
    const missing = froms.filter((p) => !existsSync(p));
    expect(missing, `electron-builder.yml ships nonexistent path(s):\n${missing.join('\n')}`).toEqual([]);
  });
});
