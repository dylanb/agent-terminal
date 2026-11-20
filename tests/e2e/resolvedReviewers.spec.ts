/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { createFlowPickerHarness, type FlowPickerHarness } from './flowPickerHarness';
import { seedAutoGateRepo } from './autoGateHarness';
import { FAKE_AGENT_READY, seedFakeAgentSteps, seedFakeGhGit } from './fakeTools';
import { seedResolvedLoop } from '../helpers/resolvedReviewerFixture';

let harness: FlowPickerHarness | undefined;
const cleanup: string[] = [];
test.afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const read = (file: string): string => existsSync(file) ? readFileSync(file, 'utf8') : '';
async function command(page: Page, text: string) {
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

for (const source of ['global-flow', 'global-repo-override', 'repo-override', 'shared-operator', 'edited-shipped'] as const) {
  test(`resolved reviewers: Start executes the ${source} charter and tools and reaches its gate`, { tag: '@ownapp' }, async () => {
    harness = createFlowPickerHarness();
    const repo = seedAutoGateRepo('resolved-review-e2e-', 'check');
    cleanup.push(repo);
    rmSync(join(repo, '.claude'), { recursive: true, force: true });
    const cfg = mkdtempSync(join(tmpdir(), 'resolved-review-config-'));
    cleanup.push(cfg);
    const { binDir, logFile } = seedFakeGhGit('resolved-review-bin-');
    cleanup.push(binDir);
    const flow = 'resolved-flow';
    const loop = source === 'edited-shipped' ? 'plan-loop' : 'custom-loop';
    const charter = `Resolved ${source} instructions.\n`;
    const loops = join(cfg, 'loops-v2');
    seedResolvedLoop(loops, loop, 'Lower priority charter.\n', ['Bash']);
    const winningRoot = source.includes('repo-override') ? join(repo, 'defs') : source === 'shared-operator' ? loops : join(loops, flow);
    const definition = seedResolvedLoop(winningRoot, loop, charter, ['Read', 'Grep']);
    const def = yaml.load(readFileSync(definition, 'utf8')) as { reviewers: unknown[] };
    (def.reviewers[0] as { persona: string }).persona = 'review-plan-principal';
    def.reviewers.push({ persona: 'review-plan-security', charter: 'other.md' });
    writeFileSync(join(dirname(definition), 'other.md'), 'Second resolved reviewer.\n');
    writeFileSync(definition, yaml.dump(def));
    if (source.includes('repo-override')) writeFileSync(join(repo, '.agent-loop.yaml'), `loops:\n  ${loop}: defs/${loop}/${loop}.yaml\n`);
    const catalogRoot = source === 'repo-override' ? repo : harness.home;
    const catalog = join(catalogRoot, '.agent-terminal/flows', flow);
    mkdirSync(catalog, { recursive: true });
    writeFileSync(join(catalog, 'flow.yaml'), `name: ${flow}\nsteps:\n  - id: check\n    kind: loop\n    loop: ${loop}\n    loop_namespace: app\n`);
    const globalAgents = join(cfg, 'agents');
    mkdirSync(globalAgents);
    writeFileSync(join(globalAgents, 'operator.md'), 'Keep my global agent.\n');
    const originalIgnore = read(join(repo, '.gitignore'));
    const evidence = join(binDir, 'reviewed.jsonl');
    const script = () => {
      const agents = join(repo, '.claude/agents');
      const files = existsSync(agents) ? readdirSync(agents) : [];
      const expected = files.flatMap((file) => {
        const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(join(agents, file)));
        if (!match) return [];
        const front = yaml.load(match[1]) as { name: string };
        const persona = match[2] === charter ? 'review-plan-principal' : match[2] === 'Second resolved reviewer.\n' ? 'review-plan-security' : null;
        return persona === null ? [] : [{ name: front.name, persona, charter: persona === 'review-plan-principal' ? charter : 'Second resolved reviewer.\n', tools: persona === 'review-plan-principal' ? ['Read', 'Grep'] : 'all' as const }];
      });
      seedFakeAgentSteps(binDir, { check: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: ['review-plan-principal', 'review-plan-security'], review: 'full', logInjected: true } }, { reviewers: { expected, evidence } });
      cpSync(join(binDir, 'fake-agent'), join(binDir, 'claude'));
    };
    script();
    const page = await harness.launch({ CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile });
    await harness.cdInto(repo);
    await page.locator('#flow-picker').getByRole('button', { name: /flow/i }).click();
    await page.locator('#flow-picker').getByRole('option', { name: new RegExp(flow) }).click();
    await command(page, 'claude');
    await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);
    await page.locator('#flow-strip .flow-control').click();
    const state = () => read(join(repo, '.agent-terminal/loop/run-state.yaml'));
    await expect.poll(state).toMatch(/status: (error|complete)/);
    script();
    await page.locator('.xterm-screen').click();
    await page.keyboard.press('Control+C');
    await command(page, 'claude');
    await page.locator('#flow-strip .loopstat').click();
    const beforeRetry = state();
    await page.locator('#loop-panel [data-app-route-out="retry"]').click();
    await expect.poll(state).not.toBe(beforeRetry);
    await expect.poll(state).toMatch(/status: (error|complete)/);
    expect.soft(state()).toContain('status: complete');
    expect.soft(read(evidence).trim().split('\n').filter(Boolean).map((line) => {
      const { name: _name, ...record } = JSON.parse(line);
      return record;
    })).toEqual([{ charter, tools: ['Read', 'Grep'] }, { charter: 'Second resolved reviewer.\n', tools: 'all' }]);
    expect.soft(read(join(repo, '.gitignore'))).toBe(originalIgnore);
    expect(readdirSync(globalAgents).map((file) => read(join(globalAgents, file)))).toEqual(['Keep my global agent.\n']);
  });
}

test('resolved reviewers: an unmodified shipped flow executes its reviewer and reaches its gate', { tag: '@ownapp' }, async () => {
  harness = createFlowPickerHarness();
  const repo = seedAutoGateRepo('shipped-review-e2e-', 'groom', { ticket: '176' });
  cleanup.push(repo);
  rmSync(join(repo, '.claude'), { recursive: true, force: true });
  const cfg = mkdtempSync(join(tmpdir(), 'shipped-review-config-'));
  cleanup.push(cfg);
  const { binDir, logFile } = seedFakeGhGit('shipped-review-bin-');
  cleanup.push(binDir);
  const catalog = join(harness.home, '.agent-terminal/flows/plan-only');
  cpSync(join(process.cwd(), 'example/flows/plan-only'), catalog, { recursive: true });
  const charter = readFileSync(join(process.cwd(), 'example/loops-v2/plan-only/groom-loop/charter/intent.md'), 'utf8');
  const evidence = join(binDir, 'reviewed.jsonl');
  const script = () => {
    const agents = join(repo, '.claude/agents');
    const expected = (existsSync(agents) ? readdirSync(agents) : []).flatMap((file) => {
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(join(agents, file)));
      if (!match || match[2] !== charter) return [];
      const front = yaml.load(match[1]) as { name: string };
      return [{ name: front.name, persona: 'review-plan-intent', charter, tools: 'all' as const }];
    });
    seedFakeAgentSteps(binDir, { groom: { artifactRel: '.agent-terminal/loop/artifacts/groomed-ticket.md', work: 'complete', roster: ['review-plan-intent'], review: 'full' } }, { reviewers: { expected, evidence } });
    cpSync(join(binDir, 'fake-agent'), join(binDir, 'claude'));
  };
  script();
  const page = await harness.launch({ CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile });
  await harness.cdInto(repo);
  await page.locator('#flow-picker').getByRole('button', { name: /flow/i }).click();
  await page.locator('#flow-picker').getByRole('option', { name: /plan-only/ }).click();
  await command(page, 'claude');
  await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);
  await page.locator('#flow-strip .flow-control').click();
  const state = () => read(join(repo, '.agent-terminal/loop/run-state.yaml'));
  await expect.poll(state).toContain('status: error');
  script();
  for (const file of readdirSync(join(repo, '.claude/agents'))) utimesSync(join(repo, '.claude/agents', file), new Date(0), new Date(0));
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Control+C');
  await command(page, 'claude');
  await page.locator('#flow-strip .loopstat').click();
  await page.locator('#loop-panel [data-app-route-out="retry"]').click();
  await expect.poll(state).toContain('status: complete');
  await expect(page.locator('#loop-panel [data-gate-option="approve"]')).toBeVisible();
  expect(read(evidence).trim().split('\n').filter(Boolean).map((line) => {
    const { name: _name, ...record } = JSON.parse(line);
    return record;
  })).toEqual([{ charter, tools: 'all' }]);
});
