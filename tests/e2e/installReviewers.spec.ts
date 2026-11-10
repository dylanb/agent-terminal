/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { shellQuote } from '../../src/shared/shellQuote';
import { renderCodexReviewerAgent, renderReviewerAgent } from '../../src/main/reviewerAgents';
import { flowLocations, writeFlow, writeLoopDef } from '../helpers/flowFixtures';
import { codexReviewerInstructions } from '../helpers/reviewerContracts';
import { useInstalledRuntime } from './installedRuntime';
import { useInstalledLauncher } from './installedLauncher';
import { seedAutoGateRepo } from './autoGateHarness';
import { seedFakeAgentSteps, seedFakeGhGit } from './fakeTools';
import { prepareReviewerSession } from './reviewerSession';
import { controllerOf } from './registeredElectron';

const runtime = useInstalledRuntime();
const launcher = useInstalledLauncher(runtime, process.platform);
const cleanup: string[] = [];
runtime.onTeardown(async () => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function command(page: Page, text: string): Promise<void> {
  await page.locator('[data-viewbtn="1"]').click();
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

function text(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function tree(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return [file, readFileSync(file).toString('base64')];
    }));
}

function globalFixture() {
    const world = runtime.world();
    const folder = flowLocations.globalCatalogEntry(world.appHome, 'terminal-cedar');
    const flow = 'terminal-cedar-flow';
    const loop = 'quality-loop';
    writeFlow(folder, { name: flow, steps: [{ id: 'quality', kind: 'loop', loop }] });
    const loops = flowLocations.operatorLoops(world.configDir);
    const definition = writeLoopDef(loops, loop, {
      charters: ['review.md'], consolidator: 'consolidate.md', artifact: 'result',
      outputs: { result: 'result.md' }, gate: [{ option: 'approve' }],
    }, { flow });
    const charter = 'Report whether the cedar contract holds.\n';
    writeFileSync(join(dirname(definition), 'review.md'), charter);
    const before = { flow: tree(folder), loops: tree(loops) };
    const codex = join(world.home, '.codex');
    mkdirSync(codex);
    const spec = { flow, loop, persona: 'reviewer-1', charter, tools: 'all' as const };
    const claudeName = String((yaml.load(renderReviewerAgent(spec).split('---\n')[1]) as { name: string }).name);
    const codexName = String(parseToml(renderCodexReviewerAgent(spec)).name);
    const destinations = [join(world.configDir, 'agents', `${claudeName}.md`), join(codex, 'agents', `${codexName}.toml`)];
    return { world, folder, loops, before, charter, spec, claudeName, codexName, destinations };
}

for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: missing global reviewers offer the selected terminal install command and session recovery`, { tag: '@ownapp' }, async () => {
    const { folder } = globalFixture();
    const repo = seedAutoGateRepo('terminal-recovery-repo-', 'quality');
    const tools = seedFakeGhGit('terminal-recovery-tools-');
    cleanup.push(repo, tools.binDir);
    seedFakeAgentSteps(tools.binDir, {
      quality: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: ['reviewer-1'], sections: [], logInjected: true },
    });
    cpSync(join(tools.binDir, 'fake-agent'), join(tools.binDir, kind));
    const { app, page } = await launcher.launch();
    await command(page, `export PATH=${shellQuote(tools.binDir)}:"$PATH" FAKE_GHGIT_LOG=${shellQuote(tools.logFile)}; cd ${shellQuote(repo)}`);
    const picker = page.locator('#app .rail:has(#flow-strip) #flow-picker');
    await picker.getByRole('button', { name: /flow/i }).click();
    await picker.getByRole('option', { name: /terminal-cedar/ }).click();
    await command(page, kind);
    await page.locator('#flow-strip .flow-control').filter({ hasText: 'Start' }).click();
    const controller = controllerOf(app);
    await expect.poll(() => controller.loopMessage()?.kind, { timeout: 0 }).toBe('error');
    const reason = controller.loopMessage()?.reason;
    await app.close();
    expect.soft(reason).toContain('--install-reviewers');
    expect.soft(reason).toContain(folder);
    expect.soft(reason).toMatch(/restart.*session/i);
    expect.soft(reason).toContain('Retry');
  });

  test(`${kind}: terminal installation previews and installs a global flow before a fresh session runs its review`, { tag: '@ownapp' }, async () => {
    const { world, folder, loops, before, charter, claudeName, codexName, destinations } = globalFixture();
    const { app, page } = await launcher.launch();
    const installed = await launcher.install(page);
    const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const transcript = join(world.root, 'install.transcript');
    const output = (): string => text(transcript).split('\n').filter((line) => !/^Script (?:started|done) on /.test(line)).join('\n');
    const status = join(world.root, 'install.status');
    const marker = launcher.mark();
    const invocation = ['env', marker, installed, '--install-reviewers', folder].map(shellQuote).join(' ');
    await command(page, `script -q -f -e -c ${shellQuote(invocation)} ${shellQuote(transcript)}; printf '%s' "$?" > ${shellQuote(status)}`);
    await expect.poll(() => existsSync(status) || /\[[^\]]*[yYnN][^\]]*\]|\?\s*$/m.test(output()), { timeout: 0 }).toBe(true);
    const preview = output();
    expect.soft(preview).toContain(folder);
    for (const destination of destinations) expect.soft(preview).toContain(destination);
    expect.soft(destinations.filter(existsSync)).toEqual([]);
    if (!existsSync(status)) {
      await page.keyboard.type('y');
      await page.keyboard.press('Enter');
    }
    await expect.poll(() => existsSync(status), { timeout: 0 }).toBe(true);
    expect.soft(text(status)).toBe('0');
    const completion = output().slice(preview.length);
    expect.soft(completion).toMatch(/created/i);
    expect.soft(completion).toMatch(/(?:restart|fresh|new).*(?:session)/i);
    expect.soft(destinations.filter(existsSync)).toEqual(destinations);
    expect.soft({ flow: tree(folder), loops: tree(loops) }).toEqual(before);
    expect.soft(launcher.carriers(marker)).toEqual([]);
    expect.soft(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore);

    const repo = seedAutoGateRepo('terminal-review-repo-', 'quality');
    const tools = seedFakeGhGit('terminal-review-tools-');
    cleanup.push(repo, tools.binDir);
    const name = kind === 'claude' ? claudeName : codexName;
    const session = prepareReviewerSession(tools.binDir, kind === 'claude'
      ? { kind, agentsDir: dirname(destinations[0]), reviewers: [{ name, instructions: charter, tools: 'all' }] }
      : { kind, agentsDir: dirname(destinations[1]), reviewers: [{ name, instructions: codexReviewerInstructions(charter) }] });
    seedFakeAgentSteps(tools.binDir, {
      quality: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: ['reviewer-1'], sections: [], logInjected: true },
    }, session);
    cpSync(join(tools.binDir, 'fake-agent'), join(tools.binDir, kind));
    await command(page, `export PATH=${shellQuote(tools.binDir)}:"$PATH" FAKE_GHGIT_LOG=${shellQuote(tools.logFile)}; cd ${shellQuote(repo)}`);
    const picker = page.locator('#app .rail:has(#flow-strip) #flow-picker');
    await picker.getByRole('button', { name: /flow/i }).click();
    await picker.getByRole('option', { name: /terminal-cedar/ }).click();
    await command(page, kind);
    await page.locator('#flow-strip .flow-control').filter({ hasText: 'Start' }).click();
    await expect.poll(() => text(session.executions) !== '' || controllerOf(app).loopMessage()?.kind === 'error', { timeout: 0 }).toBe(true);
    const executions = text(session.executions).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
    await app.close();
    expect(executions).toContainEqual(expect.objectContaining({ name, instructions: kind === 'claude' ? charter : codexReviewerInstructions(charter) }));
  });
}
