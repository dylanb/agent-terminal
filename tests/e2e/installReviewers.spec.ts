/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import yaml from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { shellQuote } from '../../src/shared/shellQuote';
import { renderCodexReviewerAgent, renderReviewerAgent } from '../../src/main/reviewerAgents';
import { flowLocations, writeFlow, writeLoopDef, writeLoopRegistry } from '../helpers/flowFixtures';
import { codexReviewerInstructions } from '../helpers/reviewerContracts';
import { useInstalledRuntime } from './installedRuntime';
import { useInstalledLauncher } from './installedLauncher';
import { seedAutoGateRepo } from './autoGateHarness';
import { seedFakeAgentSteps, seedFakeGhGit } from './fakeTools';
import { prepareReviewerSession } from './reviewerSession';
import { ageInstalledReviewers, completedReviewerWrites, installedReviewerSnapshot } from '../helpers/reviewerInstallFiles';
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


async function terminalInstall(page: Page, installed: string, folder: string, answers: readonly ('y' | 'n' | 'eof' | 'interrupt')[], preload?: string) {
  const world = runtime.world();
  const transcript = join(world.root, `install-${transcriptId++}.txt`);
  const status = `${transcript}.status`;
  const args = [launcher.mark(), ...(preload === undefined ? [] : [`NODE_OPTIONS=--require=${preload}`]), installed, '--install-reviewers', folder];
  const invocation = ['env', ...args].map(shellQuote).join(' ');
  await command(page, `script -q -f -e -c ${shellQuote(invocation)} ${shellQuote(transcript)}; printf '%s' "$?" > ${shellQuote(status)}`);
  let prompts = 0;
  for (const answer of answers) {
    await expect.poll(() => existsSync(status) || (text(transcript).match(/\[y\/N\]/g) ?? []).length > prompts, { timeout: 0 }).toBe(true);
    if (existsSync(status)) break;
    prompts = (text(transcript).match(/\[y\/N\]/g) ?? []).length;
    if (answer === 'eof' || answer === 'interrupt') await page.keyboard.press(answer === 'eof' ? 'Control+d' : 'Control+c');
    else { await page.keyboard.type(answer); await page.keyboard.press('Enter'); }
  }
  await expect.poll(() => existsSync(status), { timeout: 0 }).toBe(true);
  return { status: text(status), output: text(transcript) };
}
let transcriptId = 0;

for (const ending of ['n', 'eof', 'interrupt'] as const) {
  test(`terminal ${ending} before approval reports cancellation and leaves targets absent`, { tag: '@ownapp' }, async () => {
    const { folder, destinations, before, loops } = globalFixture();
    const { app, page } = await launcher.launch();
    const installed = await launcher.install(page);
    const result = await terminalInstall(page, installed, folder, [ending]);
    const source = { flow: tree(folder), loops: tree(loops) };
    await app.close();
    expect.soft(result.status).toBe('3');
    expect.soft(result.output).toMatch(/cancel.*|interrupt.*/i);
    expect.soft(destinations.filter(existsSync)).toEqual([]);
    expect(source).toEqual(before);
  });
}

for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: accepted retry after a real partial write preserves successes and runs all reviewers`, { tag: '@ownapp' }, async () => {
    const { world, folder, loops, charter, claudeName, codexName, destinations, spec } = globalFixture();
    const definition = join(loops, spec.flow, spec.loop, `${spec.loop}.yaml`);
    const doc = yaml.load(readFileSync(definition, 'utf8')) as { reviewers: { persona: string; charter: string }[] };
    doc.reviewers.push({ persona: 'reviewer-2', charter: 'large.md' });
    writeFileSync(definition, yaml.dump(doc));
    const large = 'Assess the extended contract.\n';
    writeFileSync(join(dirname(definition), 'large.md'), large);
    const before = { flow: tree(folder), loops: tree(loops) };
    const secondSpec = { ...spec, persona: 'reviewer-2', charter: large };
    const secondClaude = String((yaml.load(renderReviewerAgent(secondSpec).split('---\n')[1]) as { name: string }).name);
    const secondCodex = String(parseToml(renderCodexReviewerAgent(secondSpec)).name);
    const secondDestinations = [join(dirname(destinations[0]), `${secondClaude}.md`), join(dirname(destinations[1]), `${secondCodex}.toml`)];
    const { app, page } = await launcher.launch();
    const installed = await launcher.install(page);
    const targets = [...destinations, ...secondDestinations];
    const preload = join(world.root, 'fail-second-write.cjs');
    writeFileSync(preload, `
const fs = require('node:fs');
const targets = new Set(${JSON.stringify(targets)});
const rename = fs.renameSync;
let completed = 0;
fs.renameSync = function (from, to) {
  if (targets.has(String(to)) && completed === 1) fs.mkdirSync(to);
  const result = rename.apply(this, arguments);
  if (targets.has(String(to))) completed++;
  return result;
};
`);
    const failure = await terminalInstall(page, installed, folder, ['y'], preload);
    const completed = targets.filter((file) => existsSync(file) && statSync(file).isFile());
    const obstructed = targets.filter((file) => existsSync(file) && statSync(file).isDirectory());
    expect.soft(failure.status).toBe('1');
    expect.soft(completed).toHaveLength(1);
    expect.soft(obstructed).toHaveLength(1);
    expect.soft(completedReviewerWrites(failure.output)).toEqual(completed.map((file) => `created: ${dirname(file) === dirname(destinations[0]) ? 'agents' : 'codexAgents'}/${file.split('/').at(-1)}`).sort());
    expect.soft(failure.output).toMatch(/incomplete|unavailable/i);
    for (const file of obstructed) rmSync(file, { recursive: true });
    ageInstalledReviewers(completed);
    const preserved = installedReviewerSnapshot(completed);
    const retry = await terminalInstall(page, installed, folder, ['y']);
    expect.soft(retry.status).toBe('0');
    expect.soft(installedReviewerSnapshot(completed)).toEqual(preserved);
    expect.soft({ flow: tree(folder), loops: tree(loops) }).toEqual(before);
    const repo = seedAutoGateRepo('terminal-retry-repo-', 'quality');
    const tools = seedFakeGhGit('terminal-retry-tools-');
    cleanup.push(repo, tools.binDir);
    const name = kind === 'claude' ? claudeName : codexName;
    const secondName = kind === 'claude' ? secondClaude : secondCodex;
    const session = prepareReviewerSession(tools.binDir, kind === 'claude'
      ? { kind, agentsDir: dirname(destinations[0]), reviewers: [{ name, instructions: charter, tools: 'all' }, { name: secondName, instructions: large, tools: 'all' }] }
      : { kind, agentsDir: dirname(destinations[1]), reviewers: [{ name, instructions: codexReviewerInstructions(charter) }, { name: secondName, instructions: codexReviewerInstructions(large) }] });
    seedFakeAgentSteps(tools.binDir, {
      quality: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: ['reviewer-1', 'reviewer-2'], sections: [], logInjected: true },
    }, session);
    cpSync(join(tools.binDir, 'fake-agent'), join(tools.binDir, kind));
    await command(page, `export PATH=${shellQuote(tools.binDir)}:"$PATH" FAKE_GHGIT_LOG=${shellQuote(tools.logFile)}; cd ${shellQuote(repo)}`);
    const picker = page.locator('#app .rail:has(#flow-strip) #flow-picker');
    await picker.getByRole('button', { name: /flow/i }).click();
    await picker.getByRole('option', { name: /terminal-cedar/ }).click();
    await command(page, kind);
    await page.locator('#flow-strip .flow-control').filter({ hasText: 'Start' }).click();
    await expect.poll(() => text(session.executions).trim().split('\n').filter(Boolean).length >= 2 || controllerOf(app).loopMessage()?.kind === 'error', { timeout: 0 }).toBe(true);
    const executions = text(session.executions).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
    await app.close();
    expect.soft(executions).toContainEqual(expect.objectContaining({ name, instructions: kind === 'claude' ? charter : codexReviewerInstructions(charter) }));
    expect(executions).toContainEqual(expect.objectContaining({ name: secondName, instructions: kind === 'claude' ? large : codexReviewerInstructions(large) }));
  });
}


test('caught interruption after a completed write reports progress and can be retried', { tag: '@ownapp' }, async () => {
  const { world, folder, destinations } = globalFixture();
  const preload = join(world.root, 'interrupt-after-write.cjs');
  writeFileSync(preload, `
const fs = require('node:fs');
const rename = fs.renameSync;
let sent = false;
fs.renameSync = function (from, to) {
  const result = rename.apply(this, arguments);
  if (!sent && String(to) === ${JSON.stringify(destinations[0])}) {
    sent = true;
    process.kill(process.pid, 'SIGINT');
  }
  return result;
};
`);
  const { app, page } = await launcher.launch();
  const installed = await launcher.install(page);
  const interrupted = await terminalInstall(page, installed, folder, ['y'], preload);
  const completed = destinations.filter(existsSync);
  expect.soft(completed).toContain(destinations[0]);
  expect.soft(interrupted.status).toBe('3');
  const completion = interrupted.output.slice(interrupted.output.lastIndexOf('[y/N]') + '[y/N]'.length);
  expect.soft(completion).toMatch(/interrupt|cancel/i);
  expect.soft(completedReviewerWrites(completion)).toEqual(completed.map((file) => `created: ${file === destinations[0] ? 'agents' : 'codexAgents'}/${file.split('/').at(-1)}`).sort());
  if (completed.length < destinations.length) expect.soft(completion).toMatch(/incomplete|unavailable|retry/i);
  ageInstalledReviewers(completed);
  const before = installedReviewerSnapshot(completed);
  const retry = await terminalInstall(page, installed, folder, ['y']);
  await app.close();
  expect.soft(retry.status).toBe('0');
  expect.soft(installedReviewerSnapshot(completed)).toEqual(before);
  expect(destinations.filter(existsSync)).toEqual(destinations);
});


for (const tier of ['global', 'repo', 'bundled'] as const) {
  test(`${tier}: installed launcher resolves a literal relative option-like flow folder in its selected tier`, { tag: '@ownapp' }, async () => {
    const { world, folder: globalFolder, spec, destinations } = globalFixture();
    const repo = join(world.root, '--help', "repo space ' $HOME; literal");
    const selected = tier === 'global' ? globalFolder : tier === 'repo'
      ? flowLocations.repoCatalogEntry(repo, 'selected')
      : flowLocations.bundledEntry(join(world.root, '--version', 'bundle space $HOME; literal'), 'selected');
    const expected = `${tier} selected contract.\n`;
    writeFlow(selected, { name: spec.flow, steps: [{ id: 'quality', kind: 'loop', loop: spec.loop }] });
    const operator = flowLocations.operatorLoops(world.configDir);
    const operatorDef = join(operator, spec.flow, spec.loop, `${spec.loop}.yaml`);
    writeFileSync(join(dirname(operatorDef), 'review.md'), tier === 'global' ? expected : 'WRONG operator tier');
    const repositoryDef = writeLoopDef(join(repo, 'overrides'), spec.loop, { charters: ['review.md'], consolidator: 'judge.md' });
    writeFileSync(join(dirname(repositoryDef), 'review.md'), tier === 'repo' ? expected : 'WRONG repository tier');
    writeLoopRegistry(repo, { [spec.loop]: relative(repo, repositoryDef) });
    if (tier === 'bundled') {
      const bundledDef = writeLoopDef(flowLocations.bundledLoops(join(world.root, '--version', 'bundle space $HOME; literal')), spec.loop,
        { charters: ['review.md'], consolidator: 'judge.md' }, { flow: spec.flow });
      writeFileSync(join(dirname(bundledDef), 'review.md'), expected);
    }
    const before = tree(selected);
    const { app, page } = await launcher.launch();
    const installed = await launcher.install(page);
    const cwd = tier === 'global' ? repo : world.root;
    await command(page, `cd ${shellQuote(cwd)}`);
    const result = await terminalInstall(page, installed, relative(cwd, selected), ['y']);
    const resultTree = tree(selected);
    const claude = existsSync(destinations[0]) ? text(destinations[0]) : '';
    const codex = existsSync(destinations[1]) ? parseToml(text(destinations[1])).developer_instructions : '';
    await app.close();
    expect.soft(result.status, result.output).toBe('0');
    expect.soft(claude).toContain(expected);
    expect.soft(claude).not.toContain('WRONG');
    expect.soft(codex).toBe(codexReviewerInstructions(expected));
    expect(resultTree).toEqual(before);
  });
}

test('noninteractive installed invocation cannot authorize creation, but can complete an unchanged retry', { tag: '@ownapp' }, async () => {
  const { world, folder, destinations } = globalFixture();
  const { app, page } = await launcher.launch();
  const installed = await launcher.install(page);
  const refused = await launcher.run(installed, ['--install-reviewers', folder], world.root);
  expect.soft(refused.status).toBe(3);
  expect.soft(destinations.filter(existsSync)).toEqual([]);
  expect.soft(refused.stdout).toMatch(/cancel/i);
  const piped = await launcher.run('bash', ['-c', `printf '%s\\n' y y | ${shellQuote(installed)} --install-reviewers ${shellQuote(folder)}`], world.root);
  expect.soft(piped.status).toBe(3);
  expect.soft(destinations.filter(existsSync)).toEqual([]);
  expect.soft(piped.stdout).toMatch(/cancel/i);
  expect.soft(launcher.survivors(piped)).toEqual([]);
  const accepted = await terminalInstall(page, installed, folder, ['y']);
  expect(accepted.status).toBe('0');
  ageInstalledReviewers(destinations);
  const before = installedReviewerSnapshot(destinations);
  const noop = await launcher.run(installed, ['--install-reviewers', folder], world.root);
  await app.close();
  expect.soft(noop.status).toBe(0);
  expect.soft(noop.stdout).toMatch(/unchanged/i);
  expect.soft(installedReviewerSnapshot(destinations)).toEqual(before);
  expect.soft(launcher.survivors(refused)).toEqual([]);
  expect(launcher.survivors(noop)).toEqual([]);
});
