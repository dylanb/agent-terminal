/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { electron } from './registeredElectron';
import { stopApp } from './stopApp';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { seedAutoGateRepo } from './autoGateHarness';
import { seedFakeAgentSteps, seedFakeGhGit } from './fakeTools';
import { prepareReviewerSession } from './reviewerSession';
import { writeFlow, writeLoopDef } from '../helpers/flowFixtures';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { renderCodexReviewerAgent, renderReviewerAgent } from '../../src/main/reviewerAgents';
import { shellQuote } from '../../src/shared/shellQuote';
import { codexReviewerInstructions } from '../helpers/reviewerContracts';

let app: ElectronApplication | undefined;
const cleanup: string[] = [];
test.afterEach(async ({}, info) => {
  await stopApp(app, info);
  app = undefined;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function command(page: Page, text: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: Settings installs independent bundled reviewers that fresh sessions execute`, { tag: '@ownapp' }, async ({}, info) => {
    const root = mkdtempSync(join(tmpdir(), 'reviewer-settings-'));
    cleanup.push(root);
    const home = join(root, 'home');
    const config = join(root, 'claude');
    const codex = join(root, 'codex');
    for (const dir of [home, codex]) mkdirSync(dir);
    const installed = join(root, 'app');
    cpSync(resolve('out'), join(installed, 'out'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(installed, 'node_modules'), 'dir');
    const main = join(installed, 'out', 'main');
    const loc = { packaged: false as const, appPath: main };
    const flows = resolveExampleFlowsDir(loc);
    const loops = resolveExampleLoopsV2Dir(loc);
    rmSync(flows, { recursive: true, force: true });
    rmSync(loops, { recursive: true, force: true });
    const charter = 'Return the contract result: cedar.\n';
    for (const flow of ['cedar', 'birch']) {
      writeFlow(join(flows, flow === 'cedar' ? 'feature-dev-v3' : 'birch-flow'), {
        name: flow, steps: [{ id: 'quality', kind: 'loop', loop: 'quality-loop' }],
      });
      const file = writeLoopDef(loops, 'quality-loop', {
        charters: ['review.md'], consolidator: 'consolidate.md', artifact: 'result',
        outputs: { result: 'result.md' }, gate: [{ option: 'approve' }],
      }, { flow });
      writeFileSync(join(dirname(file), 'review.md'), charter);
    }
    const tools = seedFakeGhGit('reviewer-settings-tools-');
    cleanup.push(tools.binDir);
    const launch = () => electron.launch({
      args: [join(main, 'index.js'), `--user-data-dir=${join(root, 'user-data')}`],
      env: { ...process.env, HOME: home, APP_HOME_DIR: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: codex,
        APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', PATH: `${tools.binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: tools.logFile },
    });
    app = await launch();
    let page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
    await expect(page.locator('.xterm-rows')).not.toHaveText('');
    await page.locator('[data-viewbtn="4"]').click();
    await page.locator('#install-examples-view .kprofile button').click();
    await expect(page.locator('#install-examples-view [role="status"]')).toContainText('created');
    await stopApp(app, info);
    app = undefined;
    const executedNames: string[] = [];
    for (const flow of ['cedar', 'birch']) {
      const repo = seedAutoGateRepo('reviewer-settings-repo-', 'quality');
      cleanup.push(repo);
      const spec = { flow, loop: 'quality-loop', persona: 'reviewer-1', tools: 'all' as const, charter };
      const name = kind === 'codex'
        ? String(parseToml(renderCodexReviewerAgent(spec)).name)
        : String((yaml.load(renderReviewerAgent(spec).split('---\n')[1]) as { name: string }).name);
      const session = prepareReviewerSession(tools.binDir, kind === 'codex'
        ? { kind, agentsDir: join(codex, 'agents'), reviewers: [{ name, instructions: codexReviewerInstructions(charter) }] }
        : { kind, agentsDir: join(config, 'agents'), reviewers: [{ name, instructions: charter, tools: 'all' }] });
      rmSync(session.executions, { force: true });
      seedFakeAgentSteps(tools.binDir, {
        quality: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: ['reviewer-1'], sections: [], logInjected: true },
      }, session);
      cpSync(join(tools.binDir, 'fake-agent'), join(tools.binDir, kind));
      app = await launch();
      page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
      await expect(page.locator('.xterm-rows')).not.toHaveText('');
      await page.locator('[data-viewbtn="1"]').click();
      await command(page, `cd ${shellQuote(repo)}`);
      const picker = page.locator('#app .rail:has(#flow-strip) #flow-picker');
      await picker.getByRole('button', { name: /flow/i }).click();
      await picker.getByRole('option', { name: new RegExp(flow === 'cedar' ? 'feature-dev-v3' : 'birch-flow') }).click();
      await command(page, kind);
      await page.locator('#flow-strip .flow-control').filter({ hasText: 'Start' }).click();
      await expect.poll(() => existsSync(session.executions) ? readFileSync(session.executions, 'utf8') : '').not.toBe('');
      const executed = readFileSync(session.executions, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { name: string; instructions: string });
      expect(executed).toContainEqual(expect.objectContaining({ name, instructions: kind === 'codex' ? codexReviewerInstructions(charter) : charter }));
      executedNames.push(executed[0].name);
      await stopApp(app, info);
      app = undefined;
    }
    expect(new Set(executedNames).size).toBe(2);

  });
}
