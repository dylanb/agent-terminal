import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallReviewers, type InstallReviewersDeps } from '../../src/main/installReviewers';
import { userConfigAgentsDir } from '../../src/main/userConfig';
import { codexAgentsDir } from '../../src/main/codexConfig';
import { flowLocations, writeFlow, writeLoopDef } from '../helpers/flowFixtures';

let root: string;
let folder: string;
let deps: InstallReviewersDeps;
let output: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-command-')));
  const appHome = join(root, 'app');
  const configDir = join(root, 'claude');
  const loops = join(root, 'loops');
  folder = flowLocations.globalCatalogEntry(appHome, 'cedar');
  writeFlow(folder, { name: 'cedar', steps: [{ id: 'quality', kind: 'loop', loop: 'quality-loop' }] });
  writeLoopDef(loops, 'quality-loop', { charters: ['review.md'], consolidator: 'consolidate.md' }, { flow: 'cedar' });
  const codexHome = join(root, 'codex');
  mkdirSync(codexHome);
  output = '';
  deps = { cwd: () => root, appHome, configDir, codexHome,
    loopTiers: { operator: loops, appBundled: join(root, 'bundle'), retired: null },
    write: (text) => { output += text; }, confirm: async () => true };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('creates reviewer files at the reader user branches when Claude has no root yet', async () => {
  rmSync(deps.configDir!, { recursive: true, force: true });
  const claude = userConfigAgentsDir(deps.configDir)!;
  const codex = codexAgentsDir(deps.codexHome!);
  deps.confirm = async () => {
    expect(output).toContain(folder);
    expect(output).toContain(claude);
    expect(output).toContain(codex);
    expect(existsSync(claude)).toBe(false);
    return true;
  };
  expect(await runInstallReviewers([folder], deps)).toBe(0);
  expect(readdirSync(claude)).toHaveLength(1);
  expect(readdirSync(codex)).toHaveLength(1);
  expect(output).toMatch(/created/i);
  expect(output).toMatch(/fresh.*session/i);
});

it('declining final confirmation leaves both destinations absent', async () => {
  deps.confirm = async () => false;
  expect(await runInstallReviewers([folder], deps)).toBe(3);
  expect(existsSync(userConfigAgentsDir(deps.configDir)!)).toBe(false);
  expect(existsSync(codexAgentsDir(deps.codexHome!))).toBe(false);
  expect(output).toMatch(/cancel/i);
});

it('wrong arity reports usage without writing', async () => {
  expect(await runInstallReviewers([], deps)).toBe(2);
  expect(output).toContain('--install-reviewers');
});
