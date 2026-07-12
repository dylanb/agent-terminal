import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exampleInstallDirs } from '../../src/main/installExamples';
import { INSTALL_DESTINATION_IDS } from '../../src/shared/ipc';
import { resolveLoopDir } from '../../src/main/loopDef';
import { flowHomeDir } from '../../src/main/flow';
import {
  userConfigLoopsDir,
  userConfigSkillsDir,
  userConfigCommandsDir,
} from '../../src/main/userConfig';
import {
  resolveExampleFlowDir,
  resolveExampleLoopsDir,
  resolveExampleCommandsDir,
} from '../../src/main/exampleAssets';

// The installer's destinations are pinned to the readers' own resolvers (CLAUDE.md writer↔reader rule).
// The loops destination is pinned to the NAMED user-config branch, never to the precedence-aware
// resolveLoopDir — a global install must be global (CLAUDE.md precedence-aware corollary).

const loc = { packaged: false, appPath: '/out/main' } as const;
const FLOW_HOME = '/home/u';

const bundleOf = (dirs: ReturnType<typeof exampleInstallDirs>, id: string): string =>
  dirs.find((d) => d.id === id)!.bundleDir;
const targetOf = (dirs: ReturnType<typeof exampleInstallDirs>, id: string): string =>
  dirs.find((d) => d.id === id)!.targetDir;

describe('exampleInstallDirs — the destination set is the contract, in the contract order', () => {
  it('yields exactly INSTALL_DESTINATION_IDS, in that order (report order is single-sourced)', () => {
    // The registry and the contract's id list are not two lists that must be kept in sync by hand: the
    // installer derives its destinations — and their order — from INSTALL_DESTINATION_IDS alone, so the
    // report order (which also iterates that list) cannot drift from preview/apply order.
    expect(exampleInstallDirs(loc, FLOW_HOME, '/cfg').map((d) => d.id)).toEqual([...INSTALL_DESTINATION_IDS]);
  });
});

describe('exampleInstallDirs — bundle sources come from the runtime resolvers', () => {
  it('sources each destination from the resolver that reads it back', () => {
    const dirs = exampleInstallDirs(loc, FLOW_HOME, '/cfg');
    expect(bundleOf(dirs, 'flow')).toBe(resolveExampleFlowDir(loc));
    expect(bundleOf(dirs, 'loops')).toBe(resolveExampleLoopsDir(loc));
    expect(bundleOf(dirs, 'commands')).toBe(resolveExampleCommandsDir(loc));
    // The skills destination has no bundle of its own — its files fan in from the loops bundle (§26.5).
    expect(bundleOf(dirs, 'skills')).toBe(resolveExampleLoopsDir(loc));
  });
});

describe('exampleInstallDirs — targets are the destinations their readers discover from', () => {
  it('targets the global flow home for the flow destination (§18.1)', () => {
    // Derived from the READER's own resolver, never re-spelled: an assertion that hard-codes
    // '.agent-terminal' stays green when the installer reintroduces the parallel literal flowHomeDir()
    // exists to remove, and the seeded flow silently stops being the flow the app reads back.
    expect(targetOf(exampleInstallDirs(loc, FLOW_HOME, '/cfg'), 'flow')).toBe(flowHomeDir(FLOW_HOME));
  });

  it('targets the user-config loops, skills and commands directories (§24.2.3)', () => {
    const dirs = exampleInstallDirs(loc, FLOW_HOME, '/cfg');
    expect(targetOf(dirs, 'loops')).toBe(userConfigLoopsDir('/cfg'));
    expect(targetOf(dirs, 'skills')).toBe(userConfigSkillsDir('/cfg'));
    expect(targetOf(dirs, 'commands')).toBe(userConfigCommandsDir('/cfg'));
  });
});

describe('exampleInstallDirs — the loops target ignores a repo-local override (a global install is global)', () => {
  let repo: string;
  let configDir: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'install-dirs-repo-'));
    configDir = mkdtempSync(path.join(tmpdir(), 'install-dirs-cfg-'));
    mkdirSync(path.join(repo, 'my-loops', 'plan-loop'), { recursive: true });
    writeFileSync(path.join(repo, 'my-loops', 'plan-loop', 'plan-loop.yaml'), 'name: plan-loop\n');
    writeFileSync(path.join(repo, '.agent-loop.yaml'), 'loops:\n  plan-loop: my-loops/plan-loop/plan-loop.yaml\n');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('resolves the loops target to the user-config branch even while an override is in force', () => {
    // The fixture is the point: resolveLoopDir(repo, …) answers the OVERRIDE dir here. An installer wired
    // to it would seed one repo and leave every other repo unseeded. A no-override fixture cannot tell
    // the two apart, so this test installs WITH an override present.
    const overrideDir = resolveLoopDir(repo, 'plan-loop', configDir);
    expect(overrideDir).toBe(realpathSync(path.join(repo, 'my-loops', 'plan-loop')));

    const dirs = exampleInstallDirs(loc, FLOW_HOME, configDir);
    expect(targetOf(dirs, 'loops')).toBe(userConfigLoopsDir(configDir));
    expect(targetOf(dirs, 'loops')).not.toBe(overrideDir);
    expect(targetOf(dirs, 'loops').startsWith(realpathSync(repo))).toBe(false);
  });
});
