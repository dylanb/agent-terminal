import { describe, expect, it } from 'vitest';
import { exampleInstallDirs, type InstallRoots } from '../../src/main/installExamples';
import { INSTALL_DESTINATION_IDS } from '../../src/shared/ipc';
import { flowHomeDir, flowCatalogDir } from '../../src/main/flow';
import { userConfigLoopsV2Dir, userConfigCommandsDir } from '../../src/main/userConfig';
import { codexAgentsDir, codexLoopsV2Dir, codexSkillsDir } from '../../src/main/codexConfig';
import {
  resolveFeatureDevFlowDir,
  resolveExampleFlowsDir,
  resolveExampleLoopsV2Dir,
  resolveExampleCommandsDir,
  resolveExampleCodexSkillsDir,
  resolveExampleStepsDir,
} from '../../src/main/exampleAssets';
import { stepLibraryDir } from '../../src/main/stepLibrary';

// The installer's destinations are pinned to the readers' own resolvers (CLAUDE.md writer↔reader rule).

const loc = { packaged: false, appPath: '/out/main' } as const;
const FLOW_HOME = '/home/u';
const CODEX_HOME = '/codex';

const ROOTS: InstallRoots = { flowGlobalDir: FLOW_HOME, configDir: '/cfg', codexHome: CODEX_HOME };
const bundleOf = (dirs: ReturnType<typeof exampleInstallDirs>, id: string): string =>
  dirs.find((d) => d.id === id)!.bundleDir;
const targetOf = (dirs: ReturnType<typeof exampleInstallDirs>, id: string): string =>
  dirs.find((d) => d.id === id)!.targetDir as string;

describe('exampleInstallDirs — the destination set is the contract, in the contract order', () => {
  it('yields exactly INSTALL_DESTINATION_IDS, in that order (report order is single-sourced)', () => {
    // The registry and the contract's id list are not two lists that must be kept in sync by hand: the
    // installer derives its destinations — and their order — from INSTALL_DESTINATION_IDS alone, so the
    // report order (which also iterates that list) cannot drift from preview/apply order.
    expect(exampleInstallDirs(loc, ROOTS).map((d) => d.id)).toEqual([...INSTALL_DESTINATION_IDS]);
  });
});

describe('exampleInstallDirs — bundle sources come from the runtime resolvers', () => {
  it('sources each destination from the resolver that reads it back', () => {
    const dirs = exampleInstallDirs(loc, ROOTS);
    expect(bundleOf(dirs, 'flow')).toBe(resolveFeatureDevFlowDir(loc));
    expect(bundleOf(dirs, 'flowCatalog')).toBe(resolveExampleFlowsDir(loc));
    expect(bundleOf(dirs, 'commands')).toBe(resolveExampleCommandsDir(loc));
    expect(bundleOf(dirs, 'appLoops')).toBe(resolveExampleLoopsV2Dir(loc));
    expect(bundleOf(dirs, 'codexLoops')).toBe(resolveExampleLoopsV2Dir(loc));
    expect(bundleOf(dirs, 'codexSkills')).toBe(resolveExampleCodexSkillsDir(loc));
    expect(bundleOf(dirs, 'stepLibrary')).toBe(resolveExampleStepsDir(loc));
  });
});

describe('exampleInstallDirs — targets are the destinations their readers discover from', () => {
  it('targets the global flow home for the flow destination (§18.1)', () => {
    // Derived from the READER's own resolver, never re-spelled: an assertion that hard-codes
    // '.agent-terminal' stays green when the installer reintroduces the parallel literal flowHomeDir()
    // exists to remove, and the seeded flow silently stops being the flow the app reads back.
    expect(targetOf(exampleInstallDirs(loc, ROOTS), 'flow')).toBe(flowHomeDir(FLOW_HOME));
  });

  it('targets the global step library for the stepLibrary destination (§18.2)', () => {
    expect(targetOf(exampleInstallDirs(loc, ROOTS), 'stepLibrary')).toBe(stepLibraryDir(FLOW_HOME));
    expect(exampleInstallDirs(loc, { ...ROOTS, flowGlobalDir: 'relative' }).find((d) => d.id === 'stepLibrary')!.targetDir).toBeNull();
  });

  it('targets the app-state flow catalog for the flowCatalog destination (§18.7.1)', () => {
    // The one destination this PR adds: derived from the READER's own resolver (flowCatalogDir), never a
    // parallel literal, so the seeded catalog and the location A2 reads back cannot drift.
    expect(targetOf(exampleInstallDirs(loc, ROOTS), 'flowCatalog')).toBe(flowCatalogDir(FLOW_HOME));
  });

  it('targets the user-config app loop definitions and commands directories (§24.2.3)', () => {
    const dirs = exampleInstallDirs(loc, ROOTS);
    expect(targetOf(dirs, 'appLoops')).toBe(userConfigLoopsV2Dir('/cfg'));
    expect(targetOf(dirs, 'commands')).toBe(userConfigCommandsDir('/cfg'));
  });
});

describe('exampleInstallDirs — the Codex destinations hang off the Codex home (§18.1)', () => {
  it('targets the loops-v2 directory under the supplied Codex home', () => {
    expect(targetOf(exampleInstallDirs(loc, ROOTS), 'codexLoops')).toBe(codexLoopsV2Dir(CODEX_HOME));
  });

  it('targets the agents directory under the supplied Codex home', () => {
    expect(targetOf(exampleInstallDirs(loc, ROOTS), 'codexAgents')).toBe(codexAgentsDir(CODEX_HOME));
  });

  it('targets the skills directory under the supplied Codex home', () => {
    expect(targetOf(exampleInstallDirs(loc, ROOTS), 'codexSkills')).toBe(codexSkillsDir(CODEX_HOME));
  });

  it('has no target when the Codex home was refused (a relative CODEX_HOME)', () => {
    const dirs = exampleInstallDirs(loc, { ...ROOTS, codexHome: null });
    expect(dirs.find((d) => d.id === 'codexLoops')!.targetDir).toBeNull();
  });
});
