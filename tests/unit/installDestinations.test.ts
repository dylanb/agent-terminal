import { describe, expect, it } from 'vitest';
import { exampleInstallDirs } from '../../src/main/installExamples';
import { INSTALL_DESTINATION_IDS } from '../../src/shared/ipc';
import { flowHomeDir, flowCatalogDir } from '../../src/main/flow';
import { userConfigLoopsV2Dir, userConfigCommandsDir } from '../../src/main/userConfig';
import {
  resolveFeatureDevFlowDir,
  resolveExampleFlowsDir,
  resolveExampleLoopsV2Dir,
  resolveExampleCommandsDir,
} from '../../src/main/exampleAssets';

// The installer's destinations are pinned to the readers' own resolvers (CLAUDE.md writer↔reader rule).

const loc = { packaged: false, appPath: '/out/main' } as const;
const FLOW_HOME = '/home/u';

const bundleOf = (dirs: ReturnType<typeof exampleInstallDirs>, id: string): string =>
  dirs.find((d) => d.id === id)!.bundleDir;
const targetOf = (dirs: ReturnType<typeof exampleInstallDirs>, id: string): string =>
  dirs.find((d) => d.id === id)!.targetDir as string;

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
    expect(bundleOf(dirs, 'flow')).toBe(resolveFeatureDevFlowDir(loc));
    expect(bundleOf(dirs, 'flowCatalog')).toBe(resolveExampleFlowsDir(loc));
    expect(bundleOf(dirs, 'commands')).toBe(resolveExampleCommandsDir(loc));
    expect(bundleOf(dirs, 'appLoops')).toBe(resolveExampleLoopsV2Dir(loc));
  });
});

describe('exampleInstallDirs — targets are the destinations their readers discover from', () => {
  it('targets the global flow home for the flow destination (§18.1)', () => {
    // Derived from the READER's own resolver, never re-spelled: an assertion that hard-codes
    // '.agent-terminal' stays green when the installer reintroduces the parallel literal flowHomeDir()
    // exists to remove, and the seeded flow silently stops being the flow the app reads back.
    expect(targetOf(exampleInstallDirs(loc, FLOW_HOME, '/cfg'), 'flow')).toBe(flowHomeDir(FLOW_HOME));
  });

  it('targets the app-state flow catalog for the flowCatalog destination (§18.7.1)', () => {
    // The one destination this PR adds: derived from the READER's own resolver (flowCatalogDir), never a
    // parallel literal, so the seeded catalog and the location A2 reads back cannot drift.
    expect(targetOf(exampleInstallDirs(loc, FLOW_HOME, '/cfg'), 'flowCatalog')).toBe(flowCatalogDir(FLOW_HOME));
  });

  it('targets the user-config app loop definitions and commands directories (§24.2.3)', () => {
    const dirs = exampleInstallDirs(loc, FLOW_HOME, '/cfg');
    expect(targetOf(dirs, 'appLoops')).toBe(userConfigLoopsV2Dir('/cfg'));
    expect(targetOf(dirs, 'commands')).toBe(userConfigCommandsDir('/cfg'));
  });
});
