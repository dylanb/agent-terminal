import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { applyInstallExamples, exampleInstallDirs, type InstallDestination } from '../../src/main/installExamples';
import { parseLoopDef, resolveLoopDir } from '../../src/main/loopDef';
import { loadFlowDefinitionLocalFirst, flowHomeDir } from '../../src/main/flow';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';

const BUNDLE_FLOW = path.resolve('example', 'flow');
const BUNDLE_APP_LOOPS = path.resolve('example', 'loops-v2');
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
const loopsTargetDir = (): string => (dirs.find((d) => d.id === 'loops') as InstallDestination).targetDir as string;
const appLoopsTargetDir = (): string => (dirs.find((d) => d.id === 'appLoops') as InstallDestination).targetDir as string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'install-res-home-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'install-res-cfg-'));
  repo = mkdtempSync(path.join(tmpdir(), 'install-res-repo-'));
  dirs = exampleInstallDirs({ packaged: false, appPath: process.cwd() }, home, configRoot);
});
afterEach(() => {
  for (const d of [home, configRoot, repo]) rmSync(d, { recursive: true, force: true });
});

describe('after the install, every loop name the shipped flow binds resolves on the §27 engine', () => {
  it('binds at least one loop name (the fixture would otherwise grade nothing)', () => {
    expect(boundLoopNames().length).toBeGreaterThan(0);
  });

  it('resolves each bound name from the operator app-loop location', () => {
    applyInstallExamples(dirs, []);
    for (const name of boundLoopNames()) {
      const resolved = resolveLoopDefV2(name, {
        repoDir: repo,
        tiers: {
          operator: appLoopsTargetDir(),
          appBundled: BUNDLE_APP_LOOPS,
        },
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.def.origin).toBe('operator');
    }
  });

  it('has no operator definition before install, then installs every bound definition there', () => {
    for (const name of boundLoopNames()) {
      expect(existsSync(path.join(appLoopsTargetDir(), name, `${name}.yaml`))).toBe(false);
    }
    applyInstallExamples(dirs, []);
    for (const name of boundLoopNames()) {
      expect(existsSync(path.join(appLoopsTargetDir(), name, `${name}.yaml`))).toBe(true);
    }
  });

  it('exposes each definition declared human gate options', () => {
    applyInstallExamples(dirs, []);
    for (const name of boundLoopNames()) {
      const resolved = resolveLoopDefV2(name, {
        repoDir: repo,
        tiers: { operator: appLoopsTargetDir(), appBundled: BUNDLE_APP_LOOPS },
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.def.gate.some((gate) => gate.option === 'approve')).toBe(true);
        expect(resolved.def.gate.some((gate) => gate.option === 'request-changes')).toBe(true);
      }
    }
  });
});

describe('the shipped feature-dev flow binds the complete §27 chain (ST3 AC6)', () => {
  it('installs exactly groom-loop → plan-loop → impl-loop on the app namespace', () => {
    applyInstallExamples(dirs, []);

    const loaded = loadFlowDefinitionLocalFirst(repo, home);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.definition.steps).toEqual([
      {
        id: 'groom',
        kind: 'loop',
        loop: 'groom-loop',
        loopNamespace: 'app',
        inputs: [
          { name: 'ticket', type: 'github-ticket', required: true },
        ],
      },
      {
        id: 'plan',
        kind: 'loop',
        loop: 'plan-loop',
        loopNamespace: 'app',
      },
      {
        id: 'implement',
        kind: 'loop',
        loop: 'impl-loop',
        loopNamespace: 'app',
      },
    ]);
  });

  it('pins the installer target to the runtime reader resolver', () => {
    const flowTarget = dirs.find((d) => d.id === 'flow')?.targetDir;
    expect(flowTarget).toBe(flowHomeDir(home));

    applyInstallExamples(dirs, []);
    const loaded = loadFlowDefinitionLocalFirst(repo, home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.flowDir).toBe(flowTarget);
  });

  it('joins file-producing steps by one id and path, then leaves implementation commit-producing', () => {
    const defs = ['groom-loop', 'plan-loop', 'impl-loop'].map((name) => {
      const resolved = resolveLoopDefV2(name, {
        repoDir: repo,
        tiers: {
          operator: null,
          appBundled: BUNDLE_APP_LOOPS,
        },
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.reason);
      return resolved.def;
    });

    expect(defs[0].outputs).toHaveLength(1);
    expect(defs[1].inputs).toEqual(defs[0].outputs);
    expect(defs[1].outputs).toHaveLength(1);
    expect(defs[2].inputs).toEqual(defs[1].outputs);
    expect(defs[2].work.artifact).toBe('commits');
    expect(defs[2].outputs).toEqual([]);
  });

  it('installs the §27 defs into the operator tier used by the bootstrap origin gate', () => {
    applyInstallExamples(dirs, []);
    for (const name of ['groom-loop', 'plan-loop', 'impl-loop']) {
      const resolved = resolveLoopDefV2(name, {
        repoDir: repo,
        tiers: {
          operator: appLoopsTargetDir(),
          appBundled: BUNDLE_APP_LOOPS,
        },
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.def.origin).toBe('operator');
    }
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

  it('writes every app-loop definition into the operator tier, not the repo override', () => {
    seedOverride();
    applyInstallExamples(dirs, []);
    for (const rel of walk(BUNDLE_APP_LOOPS)) {
      expect(existsSync(path.join(appLoopsTargetDir(), rel))).toBe(true);
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
