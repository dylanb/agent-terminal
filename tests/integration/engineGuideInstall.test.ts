import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInstallExamplesCoordinator, exampleInstallDirs, type InstallRoots } from '../../src/main/installExamples';
import { flowHomeDir, FLOW_DEF_FILE } from '../../src/main/flowHome';
import { resolveAppHome, APP_HOME_DIR_ENV } from '../../src/main/launchRoot';
import { ENGINE_GUIDE_FILE } from '../../src/main/exampleAssets';
import { renderEngineGuide } from '../../src/main/engineGuide';
import { ENGINE_CAPABILITIES } from '../../src/shared/engineCapabilities';
import {
  SESSION_ID,
  type InstallDestinationFiles,
  type InstallDestinationId,
  type InstallExamplesPreview,
  type InstallExamplesResult,
} from '../../src/shared/ipc';
import { useBuiltBundle } from '../helpers/builtBundle';

const builtBundle = useBuiltBundle();

const GUIDE = renderEngineGuide(ENGINE_CAPABILITIES);
const STALE = '# An older guide\n\nA line the current build no longer writes.\n';

let scratch: string;
let osHome: string;
let configRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'engine-guide-install-'));
  osHome = path.join(scratch, 'home');
  configRoot = path.join(scratch, 'claude');
  mkdirSync(osHome);
  mkdirSync(configRoot);
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const rootsFor = (flowGlobalDir: string): InstallRoots => ({ flowGlobalDir, configDir: configRoot, codexHome: path.join(osHome, '.codex') });
const coordinatorFor = (flowGlobalDir: string) => createInstallExamplesCoordinator(() => exampleInstallDirs(builtBundle(), rootsFor(flowGlobalDir)));
const guideIn = (appHome: string): string => path.join(flowHomeDir(appHome), ENGINE_GUIDE_FILE);
const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const filesOf = (groups: InstallDestinationFiles[], id: InstallDestinationId): string[] => groups.find((g) => g.destination === id)?.files ?? [];

function previewOk(preview: InstallExamplesPreview): Extract<InstallExamplesPreview, { ok: true }> {
  if (!preview.ok) throw new Error(`the fixture's preview was refused: ${preview.error}`);
  return preview;
}

/** Previews, then applies with nothing ticked, as a user who confirms without choosing anything does. */
function install(flowGlobalDir: string): InstallExamplesResult {
  const coordinator = coordinatorFor(flowGlobalDir);
  const preview = previewOk(coordinator.preview({ sessionId: SESSION_ID }));
  return coordinator.apply({ sessionId: SESSION_ID, previewId: preview.previewId, replace: [], removeRetired: false });
}

const guideReport = (res: InstallExamplesResult) => ({
  created: filesOf(res.created, 'engineGuide'),
  overwritten: filesOf(res.overwritten, 'engineGuide'),
  skipped: filesOf(res.skipped, 'engineGuide'),
});

describe('Install examples writes the engine guide into the app-state home (#276 I1)', () => {
  it('installs the built guide where none is, its home not yet created, and reports it created', () => {
    const appHome = path.join(scratch, 'fresh-app-home');
    const res = install(appHome);
    expect({ ok: res.ok, guide: read(guideIn(appHome)), report: guideReport(res) }).toEqual({
      ok: true,
      guide: GUIDE,
      report: { created: [ENGINE_GUIDE_FILE], overwritten: [], skipped: [] },
    });
  });
});

describe('Install examples replaces an installed guide whole, without asking (#276 I2)', () => {
  it('overwrites a guide that differs although nothing was ticked, keeping no line of the earlier copy', () => {
    mkdirSync(flowHomeDir(osHome), { recursive: true });
    writeFileSync(guideIn(osHome), STALE);
    const res = install(osHome);
    expect({ ok: res.ok, guide: read(guideIn(osHome)), report: guideReport(res) }).toEqual({
      ok: true,
      guide: GUIDE,
      report: { created: [], overwritten: [ENGINE_GUIDE_FILE], skipped: [] },
    });
  });

  it('leaves an installed guide untouched when the preview is never applied, as when the user cancels', () => {
    mkdirSync(flowHomeDir(osHome), { recursive: true });
    writeFileSync(guideIn(osHome), STALE);
    const preview = coordinatorFor(osHome).preview({ sessionId: SESSION_ID });
    expect({ previewed: preview.ok, guide: read(guideIn(osHome)) }).toEqual({ previewed: true, guide: STALE });
  });

  it('reports an already identical guide skipped and leaves it the built guide', () => {
    install(osHome);
    const again = install(osHome);
    expect({ ok: again.ok, guide: read(guideIn(osHome)), report: guideReport(again) }).toEqual({
      ok: true,
      guide: GUIDE,
      report: { created: [], overwritten: [], skipped: [ENGINE_GUIDE_FILE] },
    });
  });
});

describe('APP_HOME_DIR relocates the guide with the global flow tier (#276 I3)', () => {
  it('installs the guide beside the global flow under the overriding home, and none under the OS home', () => {
    const appHome = path.join(scratch, 'relocated-home');
    const flowGlobalDir = resolveAppHome({ HOME: osHome, [APP_HOME_DIR_ENV]: appHome }, osHome);
    install(flowGlobalDir);
    expect({
      guide: read(guideIn(appHome)),
      besideGlobalFlow: existsSync(path.join(path.dirname(guideIn(appHome)), FLOW_DEF_FILE)),
      underOsHome: existsSync(guideIn(osHome)),
    }).toEqual({ guide: GUIDE, besideGlobalFlow: true, underOsHome: false });
  });
});

describe('the preview lists the guide as always replaced, never as a consent decision (#276 I4)', () => {
  const guideInPreview = (preview: Extract<InstallExamplesPreview, { ok: true }>) => ({
    alwaysReplaced: filesOf(preview.alwaysReplaced, 'engineGuide'),
    asDestination: preview.destinations.some((d) => d.destination === 'engineGuide'),
  });

  it('lists the guide on a fresh, an identical and a differing target, and refuses a request to replace it', () => {
    const fresh = guideInPreview(previewOk(coordinatorFor(osHome).preview({ sessionId: SESSION_ID })));
    install(osHome);
    const identical = guideInPreview(previewOk(coordinatorFor(osHome).preview({ sessionId: SESSION_ID })));
    writeFileSync(guideIn(osHome), STALE);
    const coordinator = coordinatorFor(osHome);
    const differingPreview = previewOk(coordinator.preview({ sessionId: SESSION_ID }));
    const replaceGuide = coordinator.apply({ sessionId: SESSION_ID, previewId: differingPreview.previewId, replace: ['engineGuide'], removeRetired: false });
    const listed = { alwaysReplaced: [ENGINE_GUIDE_FILE], asDestination: false };
    expect({ fresh, identical, differing: guideInPreview(differingPreview), replaceGuideRefused: !replaceGuide.ok }).toEqual({
      fresh: listed,
      identical: listed,
      differing: listed,
      replaceGuideRefused: true,
    });
  });
});

describe('an unwritable guide destination fails the pre-write check before any write (#276 I5)', () => {
  const blockGuide = (): void => {
    mkdirSync(guideIn(osHome), { recursive: true });
  };
  const nothingElseWritten = (): boolean => !existsSync(path.join(flowHomeDir(osHome), FLOW_DEF_FILE)) && readdirSync(configRoot).length === 0;

  it('refuses the preview, naming the guide’s file, when a directory sits where the guide goes', () => {
    blockGuide();
    const preview = coordinatorFor(osHome).preview({ sessionId: SESSION_ID });
    expect({ ok: preview.ok, namesGuide: !preview.ok && preview.error.includes(ENGINE_GUIDE_FILE) }).toEqual({ ok: false, namesGuide: true });
  });

  it('refuses the preview naming the blocked file of a destination other than the guide', () => {
    mkdirSync(path.join(flowHomeDir(osHome), FLOW_DEF_FILE), { recursive: true });
    const preview = coordinatorFor(osHome).preview({ sessionId: SESSION_ID });
    expect({ ok: preview.ok, namesFile: !preview.ok && preview.error.includes(FLOW_DEF_FILE) }).toEqual({ ok: false, namesFile: true });
  });

  it('refuses the apply, naming the guide’s file and writing nothing, when the guide’s path is blocked after the preview', () => {
    const coordinator = coordinatorFor(osHome);
    const preview = previewOk(coordinator.preview({ sessionId: SESSION_ID }));
    blockGuide();
    const res = coordinator.apply({ sessionId: SESSION_ID, previewId: preview.previewId, replace: [], removeRetired: false });
    expect({ ok: res.ok, namesGuide: !res.ok && res.error.includes(ENGINE_GUIDE_FILE), nothingElseWritten: nothingElseWritten() }).toEqual({
      ok: false,
      namesGuide: true,
      nothingElseWritten: true,
    });
  });
});

describe('a refused install leaves the guide untouched (#276 Behaviour ruling 3)', () => {
  it('writes no guide when another destination changed after the preview and the apply is refused', () => {
    mkdirSync(flowHomeDir(osHome), { recursive: true });
    writeFileSync(guideIn(osHome), STALE);
    const coordinator = coordinatorFor(osHome);
    const preview = previewOk(coordinator.preview({ sessionId: SESSION_ID }));
    writeFileSync(path.join(flowHomeDir(osHome), FLOW_DEF_FILE), 'name: changed-after-preview\nsteps: []\n');
    const res = coordinator.apply({ sessionId: SESSION_ID, previewId: preview.previewId, replace: [], removeRetired: false });
    expect({ ok: res.ok, guide: read(guideIn(osHome)) }).toEqual({ ok: false, guide: STALE });
  });
});

describe('installing the guide never writes a .gitignore (#276 I6)', () => {
  it('creates none in the app-state home or its .agent-terminal directory', () => {
    install(osHome);
    expect({
      guide: read(guideIn(osHome)),
      gitignores: [osHome, flowHomeDir(osHome)].filter((dir) => existsSync(path.join(dir, '.gitignore'))),
    }).toEqual({ guide: GUIDE, gitignores: [] });
  });

  it('leaves an existing one in either place byte-for-byte unchanged', () => {
    const before = 'node_modules\n.env\n';
    mkdirSync(flowHomeDir(osHome), { recursive: true });
    for (const dir of [osHome, flowHomeDir(osHome)]) writeFileSync(path.join(dir, '.gitignore'), before);
    install(osHome);
    expect({
      guide: read(guideIn(osHome)),
      gitignores: [osHome, flowHomeDir(osHome)].map((dir) => read(path.join(dir, '.gitignore'))),
    }).toEqual({ guide: GUIDE, gitignores: [before, before] });
  });
});
