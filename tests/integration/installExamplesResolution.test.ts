import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { applyInstallExamples, exampleInstallDirs, type InstallDestination } from '../../src/main/installExamples';
import { parseLoopDef, resolveLoopDir } from '../../src/main/loopDef';
import { composeWorkPrompt, composeConsolidatePrompt } from '../../src/main/loopRecipe';

// After a real install into a temp config root, the flow's bound loop names must resolve to the seeded
// definitions and their actor turns must compose from the seeded templates (§24.2.3/§26.5). And the
// install must be GLOBAL: a repo-local override never redirects where the definitions land.

const BUNDLE_FLOW = path.resolve('example', 'flow');
const BUNDLE_LOOPS = path.resolve('example', 'loops');

function walk(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))],
  );
}

/** The loop names the bundled feature-dev flow binds — read from the flow, never hard-coded. */
function boundLoopNames(): string[] {
  const doc = yaml.load(readFileSync(path.join(BUNDLE_FLOW, 'flow.yaml'), 'utf8')) as {
    steps: { kind: string; loop?: string }[];
  };
  return doc.steps.filter((s) => s.kind === 'loop' && typeof s.loop === 'string').map((s) => s.loop as string);
}

let home: string;
let configRoot: string;
let repo: string;
let dirs: InstallDestination[];
const loopsTargetDir = (): string => (dirs.find((d) => d.id === 'loops') as InstallDestination).targetDir;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'install-res-home-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'install-res-cfg-'));
  repo = mkdtempSync(path.join(tmpdir(), 'install-res-repo-'));
  dirs = exampleInstallDirs({ packaged: false, appPath: process.cwd() }, home, configRoot);
});
afterEach(() => {
  for (const d of [home, configRoot, repo]) rmSync(d, { recursive: true, force: true });
});

describe('after the install, every loop name the flow binds resolves and composes', () => {
  it('binds at least one loop name (the fixture would otherwise grade nothing)', () => {
    expect(boundLoopNames().length).toBeGreaterThan(0);
  });

  it('resolves each bound name to a definition at the engine loop-config location', () => {
    applyInstallExamples(dirs, []);
    for (const name of boundLoopNames()) {
      expect(resolveLoopDir(repo, name, configRoot)).toBe(path.join(loopsTargetDir(), name));
      expect(parseLoopDef(repo, name, configRoot)).not.toBeNull();
    }
  });

  it('makes each definition an operator-config copy, so its exec gate is admissible (§26.6)', () => {
    applyInstallExamples(dirs, []);
    for (const name of boundLoopNames()) {
      expect(parseLoopDef(repo, name, configRoot)?.origin).toBe('operator-config');
    }
  });

  it('exposes each definition declared human gate options to its loop step (§19.4)', () => {
    applyInstallExamples(dirs, []);
    for (const name of boundLoopNames()) {
      const def = parseLoopDef(repo, name, configRoot);
      expect(def).not.toBeNull();
      expect(def?.gates.some((g) => g.humanOptions.length > 0)).toBe(true);
    }
  });

  it('composes the work turn and the consolidate turn for each bound name without a configuration error', () => {
    applyInstallExamples(dirs, []);
    for (const name of boundLoopNames()) {
      const def = parseLoopDef(repo, name, configRoot);
      expect(def?.phases.length).toBeGreaterThan(0);
      const phase = def!.phases[0].id;
      expect(
        composeWorkPrompt({ repoDir: repo, loopName: name, phase, turnKey: `work-${phase}`, tokens: {}, configDir: configRoot }),
      ).not.toBeNull();
      expect(
        composeConsolidatePrompt({
          repoDir: repo,
          loopName: name,
          phase,
          iteration: 1,
          turnKey: `consolidate-${phase}`,
          tokens: {},
          configDir: configRoot,
        }),
      ).not.toBeNull();
    }
  });

  it('fails to compose before the install — the RED half of the resolution guarantee', () => {
    const name = boundLoopNames()[0];
    expect(
      composeWorkPrompt({ repoDir: repo, loopName: name, phase: 'plan', turnKey: 'work-plan', tokens: {}, configDir: configRoot }),
    ).toBeNull();
  });
});

describe('the install is global — a repo-local override never redirects where definitions land', () => {
  const overrideRel = path.join('my-loops', 'plan-loop');

  // resolveLoopDefPath returns the symlink-resolved real path (§20.2), and a temp dir is reached through
  // a symlink on darwin — so the override's real path is what resolution answers with.
  function seedOverride(): string {
    const overrideDir = path.join(repo, overrideRel);
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(path.join(overrideDir, 'plan-loop.yaml'), 'name: plan-loop\nlocal: true\n');
    writeFileSync(path.join(repo, '.agent-loop.yaml'), `loops:\n  plan-loop: ${overrideRel}/plan-loop.yaml\n`);
    return realpathSync(overrideDir);
  }

  it('resolves plan-loop to the override in that repo — the precondition this test rests on', () => {
    const overrideDir = seedOverride();
    expect(resolveLoopDir(repo, 'plan-loop', configRoot)).toBe(overrideDir);
  });

  it('writes every definition file into the user-config loops directory, not the override', () => {
    seedOverride();
    applyInstallExamples(dirs, []);
    for (const rel of walk(BUNDLE_LOOPS)) {
      expect(existsSync(path.join(loopsTargetDir(), rel))).toBe(true);
    }
  });

  it('leaves the override directory byte-for-byte unchanged — not read, not written, not reported', () => {
    const overrideDir = seedOverride();
    const before = readFileSync(path.join(overrideDir, 'plan-loop.yaml'), 'utf8');

    const res = applyInstallExamples(dirs, ['flow', 'loops', 'skills', 'commands']);
    expect(res.ok).toBe(true);

    expect(walk(overrideDir)).toEqual(['plan-loop.yaml']);
    expect(readFileSync(path.join(overrideDir, 'plan-loop.yaml'), 'utf8')).toBe(before);
  });

  it('seeds the loops directory the packaged app reads even from a repo carrying an override', () => {
    seedOverride();
    applyInstallExamples(dirs, []);
    // A repo with NO override (a different repo, or the packaged app opened against none) now resolves
    // plan-loop to the seeded global copy. This is what a global install buys.
    const otherRepo = mkdtempSync(path.join(tmpdir(), 'install-res-other-'));
    try {
      expect(resolveLoopDir(otherRepo, 'plan-loop', configRoot)).toBe(path.join(loopsTargetDir(), 'plan-loop'));
      expect(parseLoopDef(otherRepo, 'plan-loop', configRoot)).not.toBeNull();
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });
});
