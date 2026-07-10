import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exampleInstallDirs } from '../../src/main/installExamples';
import { resolveLoopDir } from '../../src/main/loopDef';
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

describe('exampleInstallDirs — bundle sources come from the runtime resolvers', () => {
  it('sources each destination from the resolver that reads it back', () => {
    const dirs = exampleInstallDirs(loc, FLOW_HOME, '/cfg');
    expect(dirs.flowBundleDir).toBe(resolveExampleFlowDir(loc));
    expect(dirs.loopsBundleDir).toBe(resolveExampleLoopsDir(loc));
    expect(dirs.commandsBundleDir).toBe(resolveExampleCommandsDir(loc));
  });
});

describe('exampleInstallDirs — targets are the destinations their readers discover from', () => {
  it('targets the global flow home for the flow destination (§18.1)', () => {
    expect(exampleInstallDirs(loc, FLOW_HOME, '/cfg').flowTargetDir).toBe(path.join(FLOW_HOME, '.agent-terminal'));
  });

  it('targets the user-config loops, skills and commands directories (§24.2.3)', () => {
    const dirs = exampleInstallDirs(loc, FLOW_HOME, '/cfg');
    expect(dirs.loopsTargetDir).toBe(userConfigLoopsDir('/cfg'));
    expect(dirs.skillsTargetDir).toBe(userConfigSkillsDir('/cfg'));
    expect(dirs.commandsTargetDir).toBe(userConfigCommandsDir('/cfg'));
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
    expect(dirs.loopsTargetDir).toBe(userConfigLoopsDir(configDir));
    expect(dirs.loopsTargetDir).not.toBe(overrideDir);
    expect(dirs.loopsTargetDir.startsWith(realpathSync(repo))).toBe(false);
  });
});
