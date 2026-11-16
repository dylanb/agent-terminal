import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyInstallExamples,
  exampleInstallDirs,
  inspectExamplesCurrency,
  type InstallDestination,
} from '../../src/main/installExamples';
import { flowCatalogDir } from '../../src/main/flow';
import { RETIRED_FLOW_IDS } from '../../src/shared/retiredFlows';
import type { InstallDestinationId, InstallExamplesResult } from '../../src/shared/ipc';

// Whether installing the bundled examples would change anything on this machine (#290 condition 1), answered by
// the installer's own pipeline over real destinations: a file it would create or replace, or a retired example it
// would offer to remove, makes the installation not current.

let home: string;
let configRoot: string;
let codexHome: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'examples-currency-home-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'examples-currency-cfg-'));
  codexHome = path.join(home, 'no-codex-home');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

const destinations = (): InstallDestination[] =>
  exampleInstallDirs({ packaged: false, appPath: process.cwd() }, { flowGlobalDir: home, configDir: configRoot, codexHome });

const CURRENT = { ok: true, current: true };
const STALE = { ok: true, current: false };

function installed(replace: InstallDestinationId[] = [], removeRetired = false): Extract<InstallExamplesResult, { ok: true }> {
  const result = applyInstallExamples(destinations(), replace, { removeRetired });
  if (!result.ok) throw new Error(`fixture install failed: ${result.error}`);
  return result;
}

/** One file the installer wrote, edited so it differs from the bundled copy; returns its destination. */
function editAnInstalledFile(result: Extract<InstallExamplesResult, { ok: true }>): InstallDestinationId {
  const group = result.created[0];
  const target = destinations().find((d) => d.id === group.destination)?.targetDir;
  if (target == null) throw new Error(`no install target for ${group.destination}`);
  appendFileSync(path.join(target, group.files[0]), '\n# edited by the operator\n');
  return group.destination;
}

/** A catalog entry a retired flow left behind, which the installer offers to remove. */
function plantRetiredExample(): void {
  const dir = path.join(flowCatalogDir(home), RETIRED_FLOW_IDS[0]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'flow.yaml'), 'old\n');
}

describe('an installation the installer would change is not current (AC7)', () => {
  it('a machine missing the bundled files (the installer would create them)', () => {
    expect(inspectExamplesCurrency(destinations())).toEqual(STALE);
  });

  it('an installed file that differs from the bundled one (the installer would replace it)', () => {
    editAnInstalledFile(installed());
    expect(inspectExamplesCurrency(destinations())).toEqual(STALE);
  });

  it('a retired example left in the installation (the installer would offer to remove it)', () => {
    installed();
    plantRetiredExample();
    expect(inspectExamplesCurrency(destinations())).toEqual(STALE);
  });
});

describe('an installation the installer would leave alone is current (AC7)', () => {
  it('every bundled file installed, with the Codex home absent so its destinations are skipped', () => {
    installed();
    expect(inspectExamplesCurrency(destinations())).toEqual(CURRENT);
  });

  it("every bundled file installed, beside the operator's own files the installer leaves alone", () => {
    installed();
    const ownFlow = path.join(flowCatalogDir(home), 'my-own-flow');
    mkdirSync(ownFlow, { recursive: true });
    writeFileSync(path.join(ownFlow, 'flow.yaml'), 'name: my-own-flow\n');
    const commands = destinations().find((d) => d.id === 'commands')?.targetDir;
    if (commands == null) throw new Error('no install target for commands');
    writeFileSync(path.join(commands, 'my-own-command.md'), 'mine\n');

    expect(inspectExamplesCurrency(destinations())).toEqual(CURRENT);
  });

  it('every bundled file installed, the Codex destinations included', () => {
    mkdirSync(codexHome);
    installed();
    expect(inspectExamplesCurrency(destinations())).toEqual(CURRENT);
  });
});

describe('the installation after the consent flow (AC17)', () => {
  it('stays not current when the replacement of a differing file is declined, and is current once accepted', () => {
    const edited = editAnInstalledFile(installed());

    installed([]);
    const afterDecline = inspectExamplesCurrency(destinations());
    installed([edited]);
    const afterAccept = inspectExamplesCurrency(destinations());

    expect({ afterDecline, afterAccept }).toEqual({ afterDecline: STALE, afterAccept: CURRENT });
  });

  it('stays not current when the retired examples are kept, and is current once they are removed', () => {
    installed();
    plantRetiredExample();

    installed([], false);
    const afterKeep = inspectExamplesCurrency(destinations());
    installed([], true);
    const afterRemove = inspectExamplesCurrency(destinations());

    expect({ afterKeep, afterRemove }).toEqual({ afterKeep: STALE, afterRemove: CURRENT });
  });
});

describe('an inspection that could not run never reads as current', () => {
  it('answers not ok when a bundle is missing from the build', () => {
    const missing = path.join(home, 'no-such-bundle');
    const broken = destinations().map((d) => (d.id === 'commands' ? { ...d, bundleDir: missing } : d));
    expect(inspectExamplesCurrency(broken)).toMatchObject({ ok: false });
  });

  it.skipIf(process.getuid?.() === 0)('answers not ok when an installed example file cannot be read', () => {
    const group = installed().created[0];
    const target = destinations().find((d) => d.id === group.destination)?.targetDir;
    if (target == null) throw new Error(`no install target for ${group.destination}`);
    chmodSync(path.join(target, group.files[0]), 0o000);

    expect(inspectExamplesCurrency(destinations())).toMatchObject({ ok: false });
  });
});
