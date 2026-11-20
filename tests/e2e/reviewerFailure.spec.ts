/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { createFlowPickerHarness, type FlowPickerHarness } from './flowPickerHarness';
import { seedAutoGateRepo } from './autoGateHarness';
import { FAKE_AGENT_READY, seedFakeAgentSteps, seedFakeGhGit } from './fakeTools';
import { recordDisposition } from '../../src/main/runDisposition';
import { seedResolvedLoop } from '../helpers/resolvedReviewerFixture';

let harness: FlowPickerHarness | undefined;
const cleanup: string[] = [];
test.afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const read = (file: string): string => existsSync(file) ? readFileSync(file, 'utf8') : '';

for (const operation of ['Start', 'Restart'] as const) {
for (const fault of ['missing', 'invalid-loop', 'empty-tools'] as const) {
  test(`failed reviewer installation at ${operation} stops reviewer-free initial work: ${fault}`, { tag: '@ownapp' }, async () => {
    harness = createFlowPickerHarness();
    const repo = seedAutoGateRepo('reviewer-failure-', 'first');
    cleanup.push(repo);
    rmSync(join(repo, '.claude'), { recursive: true, force: true });
    const cfg = mkdtempSync(join(tmpdir(), 'reviewer-failure-config-'));
    cleanup.push(cfg);
    const { binDir, logFile } = seedFakeGhGit('reviewer-failure-bin-');
    cleanup.push(binDir);
    const flow = 'failure-flow';
    const loops = join(cfg, 'loops-v2', flow);
    const first = seedResolvedLoop(loops, 'first-loop', 'First instructions.\n');
    const firstDef = yaml.load(read(first)) as Record<string, unknown>;
    firstDef.reviewers = [];
    firstDef.gate = [];
    delete firstDef.consolidator;
    writeFileSync(first, yaml.dump(firstDef));
    const second = seedResolvedLoop(loops, 'second-loop', 'Required instructions.\n', ['Read']);
    const charter = join(dirname(second), 'charter.md');
    if (fault === 'missing') rmSync(charter);
    if (fault === 'invalid-loop') writeFileSync(second, 'version: [invalid');
    if (fault === 'empty-tools') {
      const def = yaml.load(read(second)) as { reviewers: { tools: string[] }[] };
      def.reviewers[0].tools = [];
      writeFileSync(second, yaml.dump(def));
    }
    const catalog = join(harness.home, '.agent-terminal/flows', flow);
    mkdirSync(catalog, { recursive: true });
    writeFileSync(join(catalog, 'flow.yaml'), yaml.dump({ name: flow, steps: [
      { id: 'first', kind: 'loop', loop: 'first-loop', loop_namespace: 'app' },
      { id: 'second', kind: 'loop', loop: 'second-loop', loop_namespace: 'app' },
    ] }));
    if (operation === 'Restart') {
      harness.selectFlow(repo, flow);
      recordDisposition(repo, { source: 'catalog', tier: 'global', id: flow });
      writeFileSync(join(repo, '.agent-terminal/flow-state.yaml'), yaml.dump({ step: 'second', status: 'done', flow, started_at: 1 }));
    }
    const globalAgents = join(cfg, 'agents');
    mkdirSync(globalAgents);
    writeFileSync(join(globalAgents, 'operator.md'), 'Global instructions.\n');
    if (operation === 'Restart') rmSync(join(repo, '.gitignore'));
    const ignore = read(join(repo, '.gitignore'));
    const artifact = join(repo, '.agent-terminal/loop/artifacts/result.md');
    seedFakeAgentSteps(binDir, { first: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', review: 'none', roster: [] } });
    cpSync(join(binDir, 'fake-agent'), join(binDir, 'claude'));
    const page = await harness.launch({ CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile });
    await harness.cdInto(repo);
    if (operation === 'Start') {
      await page.locator('#flow-picker').getByRole('button', { name: /flow/i }).click();
      await page.locator('#flow-picker').getByRole('option', { name: new RegExp(flow) }).click();
    }
    await page.locator('.xterm-screen').click();
    await page.keyboard.type('claude');
    await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);
    await expect(page.locator('#flow-strip .flow-control')).toHaveText(operation);
    await page.locator('#flow-strip .flow-control').click();
    const state = () => read(join(repo, '.agent-terminal/loop/run-state.yaml'));
    await expect.poll(async () => /status: (error|complete)/.test(state()) || (!(await page.locator('#flow-strip .flow-control').allTextContents()).join('').includes('Advance') && (await page.locator('#flow-strip').innerText()).includes(fault === 'invalid-loop' ? second : charter))).toBe(true);
    expect.soft(read(artifact)).toBe('');
    await expect.soft(page.locator('#flow-strip')).toContainText(fault === 'invalid-loop' ? second : charter);
    await expect.soft(page.locator('#flow-strip')).toContainText(/retry/i);
    const beforeAdvance = await page.evaluate((dir) => window.flow.state(dir), repo);
    const advanced = await page.evaluate((dir) => window.flow.advance(dir), repo);
    expect.soft({ step: advanced.stepName, status: advanced.status }).toEqual({ step: beforeAdvance.stepName, status: beforeAdvance.status });
    expect.soft(existsSync(join(repo, '.gitignore'))).toBe(operation === 'Start');
    expect.soft(read(join(repo, '.gitignore'))).toBe(ignore);
    expect.soft(readdirSync(globalAgents)).toEqual(['operator.md']);
    expect.soft(read(join(globalAgents, 'operator.md'))).toBe('Global instructions.\n');
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all', '--', '.claude/agents'], { encoding: 'utf8' })).toBe('');
  });
}
}
