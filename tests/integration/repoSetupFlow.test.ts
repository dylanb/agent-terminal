import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyInstallExamples, exampleInstallDirs } from '../../src/main/installExamples';
import { resolveCatalogEntry } from '../../src/main/flowCatalog';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';
import { loadFlowDefinitionFromFile } from '../../src/main/flow';
import { REPO_SETUP_FLOW_ID } from '../../src/shared/setupCheck';

// The repo-setup flow the setup popup's Run setup loop starts ships in the bundle: after the app's own install,
// its catalog id resolves and its flow.yaml passes the app's loader. Load-validity only, never its configured
// values (CLAUDE.md § TDD carve-out); the loops it binds resolve in the bundled-loops sweep.

let home: string;
let configRoot: string;
let repo: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'repo-setup-flow-home-')));
  configRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'repo-setup-flow-cfg-')));
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'repo-setup-flow-repo-')));
});
afterEach(() => {
  for (const dir of [home, configRoot, repo]) rmSync(dir, { recursive: true, force: true });
});

describe('the bundled repo-setup flow, after Install examples', () => {
  it('resolves from the global catalog and loads through the flow loader', () => {
    const dirs = exampleInstallDirs(
      { packaged: false, appPath: process.cwd() },
      { flowGlobalDir: home, configDir: configRoot, codexHome: path.join(home, '.codex') },
    );
    applyInstallExamples(dirs, []);

    const entry = resolveCatalogEntry({ worktreeDir: repo, globalRoot: home }, REPO_SETUP_FLOW_ID);
    expect(entry).toMatchObject({ ok: true, tier: 'global' });
    if (!entry.ok) return;
    const load = loadFlowDefinitionFromFile(path.join(entry.flowDir, FLOW_DEF_FILE));
    expect(load.ok, load.ok ? '' : load.error).toBe(true);
  });
});
