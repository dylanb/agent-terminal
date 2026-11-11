import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function errorsMatching(pattern: RegExp, code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => pattern.test(m.message)).length;
}

describe('the setup-check core decides from its injected seams', () => {
  const SEAM_ONLY = /setup-check core decides from its seam values only/;
  const CORE = 'src/main/setupCheck.ts';
  const core = (code: string, filePath = CORE) => errorsMatching(SEAM_ONLY, code, filePath);

  it('flags filesystem, process and command access, and value imports of the modules behind its seams', async () => {
    expect({
      fs: await core("import { readFileSync } from 'node:fs';\n"),
      childProcess: await core("import { execFile } from 'child_process';\n"),
      processGlobal: await core('export const on = process.env.APP_SETUP_CHECK;\n'),
      ignoreCheck: await core("import { agentTerminalIgnored } from './gitIgnoreCheck';\n"),
      capabilities: await core("import { loadLoopCapabilities } from './loopCapabilities';\n"),
      installer: await core("import { inspectExamplesCurrency } from './installExamples';\n"),
      dismissals: await core("import { createSetupDismissals } from './setupDismissals';\n"),
      repoKey: await core("import { findRepoRoot } from './repoKey';\n"),
      catalog: await core("import { resolveCatalogEntry } from './flowCatalog';\n"),
      require: await core("export const fs = require('node:fs');\n"),
      dynamicImport: await core("export const load = () => import('./gitIgnoreCheck');\n"),
    }).toEqual({ fs: 1, childProcess: 1, processGlobal: 1, ignoreCheck: 1, capabilities: 1, installer: 1, dismissals: 1, repoKey: 1, catalog: 1, require: 1, dynamicImport: 1 });
  });

  it('allows type imports, shared modules, errno narrowing and leaves the seams alone', async () => {
    expect({
      typeImport: await core("import type { LoopCapabilitiesLoad } from './loopCapabilities';\n"),
      shared: await core("import { silencedBy } from '../shared/setupCheck';\n"),
      errno: await core("import { errMsg } from './errno';\n"),
      catalogType: await core("import type { CatalogRoots } from './flowCatalog';\n"),
      ignoreCheckModule: await core("import { execFile } from 'node:child_process';\n", 'src/main/gitIgnoreCheck.ts'),
      dismissalsModule: await core("import { readFileSync } from 'node:fs';\n", 'src/main/setupDismissals.ts'),
    }).toEqual({ typeImport: 0, shared: 0, errno: 0, catalogType: 0, ignoreCheckModule: 0, dismissalsModule: 0 });
  });
});

describe('a setup-dialog test reads the screen through tests/helpers/setupCheckScreen.ts', () => {
  const THROUGH_HELPER = /setupCheckScreen\.ts/;
  const TEST = 'tests/unit/setupCheckDialog.test.ts';
  const dialogTest = (code: string, filePath = TEST) => errorsMatching(THROUGH_HELPER, code, filePath);

  it('flags a DOM query in the dialog tests', async () => {
    expect({
      querySelector: await dialogTest("export const d = (h: HTMLElement) => h.querySelector('.flow-modal');\n"),
      querySelectorAll: await dialogTest("export const b = (h: HTMLElement) => h.querySelectorAll('button');\n"),
      closest: await dialogTest("export const c = (e: HTMLElement) => e.closest('[role=dialog]');\n"),
      matches: await dialogTest("export const m = (e: HTMLElement) => e.matches('.mfoot button');\n"),
      byId: await dialogTest("export const i = () => document.getElementById('setup-title');\n"),
      byClass: await dialogTest("export const k = () => document.getElementsByClassName('pill');\n"),
      byTag: await dialogTest("export const t = () => document.getElementsByTagName('li');\n"),
      secondFile: await dialogTest("export const d = (h: HTMLElement) => h.querySelector('li');\n", 'tests/unit/setupCheckDialogRunSetup.test.ts'),
    }).toEqual({ querySelector: 1, querySelectorAll: 1, closest: 1, matches: 1, byId: 1, byClass: 1, byTag: 1, secondFile: 1 });
  });

  it('allows reading through the helper, and leaves the helper and other tests alone', async () => {
    expect({
      helperUse: await dialogTest("import { setupCheckScreen } from '../helpers/setupCheckScreen';\nexport const e = (h: HTMLElement) => setupCheckScreen(h).entries();\n"),
      mount: await dialogTest("export const host = () => document.body.appendChild(document.createElement('div'));\n"),
      helper: await dialogTest("export const d = (h: HTMLElement) => h.querySelector('li');\n", 'tests/helpers/setupCheckScreen.ts'),
      otherTest: await dialogTest("export const d = (h: HTMLElement) => h.querySelector('li');\n", 'tests/unit/confirmDialog.test.ts'),
    }).toEqual({ helperUse: 0, mount: 0, helper: 0, otherTest: 0 });
  });
});

describe('the setup dialog organism reaches the app only through its injected deps and its own host', () => {
  const INJECTED = /setup dialog reaches the app only through/i;
  const ORGANISM = 'src/renderer/src/setupCheckDialog.ts';
  const organism = (code: string, filePath = ORGANISM) => errorsMatching(INJECTED, code, filePath);

  it('flags the window and document globals in the organism', async () => {
    expect({
      windowSetup: await organism("export const s = () => window.setup.status({ sessionId: 's', repoKey: '/r' });\n"),
      documentQuery: await organism("export const o = () => document.querySelector('[aria-modal]');\n"),
      documentBody: await organism('export const b = () => document.body;\n'),
    }).toEqual({ windowSetup: 1, documentQuery: 1, documentBody: 1 });
  });

  it('allows the host document and leaves the composition root alone', async () => {
    expect({
      hostDocument: await organism("export const mk = (host: HTMLElement) => host.ownerDocument.createElement('div');\n"),
      root: await organism("export const s = () => window.setup;\n", 'src/renderer/src/index.ts'),
    }).toEqual({ hostDocument: 0, root: 0 });
  });
});
