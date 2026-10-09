import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { applyInstallExamples, exampleInstallDirs, type InstallDestination } from '../../src/main/installExamples';
import { loadFlowDefinitionLocalFirst, flowHomeDir } from '../../src/main/flow';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';

const BUNDLE_FLOW = path.resolve('example', 'flows', 'feature-dev');
const BUNDLE_APP_LOOPS = path.resolve('example', 'loops-v2');

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
          retired: null,
        },
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.tierRoot).toBe(appLoopsTargetDir());
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
        tiers: { operator: appLoopsTargetDir(), appBundled: BUNDLE_APP_LOOPS, retired: null },
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
  it('installs the full-TDD chain groom → plan-bundle → infra → red → green → refactor → integration-slice on the app namespace', () => {
    applyInstallExamples(dirs, []);

    const loaded = loadFlowDefinitionLocalFirst(repo, home);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const implStep = (id: string, loop: string, gateAuthority: 'auto' | 'human') => ({ id, kind: 'loop', loop, gateAuthority, loopNamespace: 'app', todoTemplate: 'impl-loop-review' });
    expect(loaded.definition.steps).toEqual([
      { id: 'preparation', kind: 'manual' },
      {
        id: 'groom',
        kind: 'loop',
        loop: 'groom-loop',
        loopNamespace: 'app',
        todoTemplate: 'ticket-grooming',
        gateAuthority: 'auto',
        inputs: [
          { name: 'ticket', type: 'github-ticket', required: true },
        ],
      },
      {
        id: 'plan-bundle',
        kind: 'loop',
        loop: 'plan-bundle-loop',
        loopNamespace: 'app',
        todoTemplate: 'plan-loop-review',
        gateAuthority: 'human',
      },
      implStep('infra', 'infra-loop', 'auto'),
      implStep('red', 'red-loop', 'auto'),
      implStep('green', 'green-loop', 'auto'),
      // §28.4 loop-back: refactor repeats the RED→GREEN→refactor slice `slices`-many times (impl-slice×N).
      { ...implStep('refactor', 'refactor-loop', 'auto'), repeat: { backTo: 'red', countInput: 'slices' } },
      implStep('integration-slice', 'integration-slice-loop', 'human'),
      { id: 'finalize', kind: 'manual', todoTemplate: 'polish' },
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
          retired: null,
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

  it('installs the §27 defs into the operator tier', () => {
    applyInstallExamples(dirs, []);
    for (const name of ['groom-loop', 'plan-loop', 'impl-loop']) {
      const resolved = resolveLoopDefV2(name, {
        repoDir: repo,
        tiers: {
          operator: appLoopsTargetDir(),
          appBundled: BUNDLE_APP_LOOPS,
          retired: null,
        },
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.tierRoot).toBe(appLoopsTargetDir());
    }
  });
});

describe('the install is global — a repo-local override never redirects where §27 definitions land', () => {
  const overrideDirRel = path.join('my-loops', 'plan-loop');

  // A repo `.agent-loop.yaml` `loops:` entry is resolveLoopDefV2's highest-precedence tier (§20.2), so the
  // override must be a def the SURVIVING parser accepts — a bare `name:` stub the retired reader answered
  // without parsing would make the resolver surface a parse reason instead of the override, and the
  // precedence this block pins could never be exercised (a strictly weaker pin). Minimal well-formed v2:
  // recipe/consolidator refs need not exist (they confine as absent tail segments), only be present.
  const V2_OVERRIDE_DEF = [
    'version: v2',
    'work:',
    '  recipe: work.md',
    '  artifact: plan',
    'consolidator:',
    '  recipe: consolidate.md',
    'reviewers: []',
    'boundaries: []',
    'report:',
    '  sections: []',
    'gate: []',
    '',
  ].join('\n');

  const tiers = () => ({ operator: appLoopsTargetDir(), appBundled: BUNDLE_APP_LOOPS, retired: null });

  function seedOverride(): string {
    const overrideDir = path.join(repo, overrideDirRel);
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(path.join(overrideDir, 'plan-loop.yaml'), V2_OVERRIDE_DEF);
    writeFileSync(path.join(repo, '.agent-loop.yaml'), `loops:\n  plan-loop: ${overrideDirRel}/plan-loop.yaml\n`);
    return realpathSync(overrideDir);
  }

  it('resolves plan-loop to the repo override in that repo — the precondition this test rests on', () => {
    seedOverride();
    const resolved = resolveLoopDefV2('plan-loop', { repoDir: repo, tiers: tiers() });
    expect(resolved.ok).toBe(true);
    // The repo tier root is the repository itself (§20.2) — proof the override won over the operator and
    // app-bundled tiers, not either of them. (repoCandidate roots on path.resolve(repoDir), not its realpath.)
    if (resolved.ok) expect(resolved.tierRoot).toBe(repo);
  });

  it('writes every app-loop definition into the operator tier, neither the override nor under the repo', () => {
    const overrideDir = seedOverride();
    applyInstallExamples(dirs, []);
    const operator = appLoopsTargetDir();
    // The precedence-aware-writer corollary: the writer targets the named user-config tier, never a
    // precedence resolution rooted at the repo — which, wired wrong, would land the defs in the override.
    expect(operator).not.toBe(overrideDir);
    expect(operator.startsWith(repo + path.sep)).toBe(false);
    expect(operator.startsWith(realpathSync(repo) + path.sep)).toBe(false);
    for (const rel of walk(BUNDLE_APP_LOOPS)) {
      expect(existsSync(path.join(operator, rel))).toBe(true);
    }
  });

  it('leaves the override directory byte-for-byte unchanged — not read, not written, not reported', () => {
    const overrideDir = seedOverride();
    const before = readFileSync(path.join(overrideDir, 'plan-loop.yaml'), 'utf8');

    const res = applyInstallExamples(dirs, ['flow', 'appLoops', 'commands']);
    expect(res.ok).toBe(true);

    expect(walk(overrideDir)).toEqual(['plan-loop.yaml']);
    expect(readFileSync(path.join(overrideDir, 'plan-loop.yaml'), 'utf8')).toBe(before);
  });

  it('seeds the operator tier the packaged app reads even from a repo carrying an override', () => {
    seedOverride();
    applyInstallExamples(dirs, []);
    // A DIFFERENT repo (no override) now resolves plan-loop to the seeded operator copy — what a global
    // install buys: the def is readable from any repo, not only the one that carried the override.
    const otherRepo = mkdtempSync(path.join(tmpdir(), 'install-res-other-'));
    try {
      const resolved = resolveLoopDefV2('plan-loop', { repoDir: otherRepo, tiers: tiers() });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.tierRoot).toBe(appLoopsTargetDir());
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });
});
