/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';
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
async function clickAvailable(control: Locator): Promise<void> {
  if (await control.count() === 1 && await control.isVisible() && await control.isEnabled()) await control.click();
}
async function command(page: Page, text: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('initial reviewer refusal supports back-out and a real Retry before any loop work', { tag: '@ownapp' }, async () => {
  harness = createFlowPickerHarness();
  const repo = seedAutoGateRepo('reviewer-initial-recovery-', 'first');
  cleanup.push(repo);
  rmSync(join(repo, '.claude'), { recursive: true, force: true });
  const cfg = mkdtempSync(join(tmpdir(), 'reviewer-initial-config-'));
  cleanup.push(cfg);
  const { binDir, logFile } = seedFakeGhGit('reviewer-initial-bin-');
  cleanup.push(binDir);
  const flow = 'initial-recovery';
  const loops = join(cfg, 'loops-v2', flow);
  const first = seedResolvedLoop(loops, 'first-loop', 'Reviewer-free work.\n');
  const firstDef = yaml.load(read(first)) as Record<string, unknown>;
  firstDef.reviewers = [];
  delete firstDef.consolidator;
  writeFileSync(first, yaml.dump(firstDef));
  const second = seedResolvedLoop(loops, 'second-loop', 'Required reviewer.\n', ['Read']);
  const charter = join(dirname(second), 'charter.md');
  rmSync(charter);
  const catalog = join(harness.home, '.agent-terminal/flows', flow);
  mkdirSync(catalog, { recursive: true });
  writeFileSync(join(catalog, 'flow.yaml'), yaml.dump({ name: flow, steps: [
    { id: 'first', kind: 'loop', loop: 'first-loop', loop_namespace: 'app' },
    { id: 'second', kind: 'loop', loop: 'second-loop', loop_namespace: 'app' },
  ] }));
  const globalAgents = join(cfg, 'agents');
  mkdirSync(globalAgents);
  writeFileSync(join(globalAgents, 'operator.md'), 'Global instructions.\n');
  const originalIgnore = read(join(repo, '.gitignore'));
  const agents = join(repo, '.claude/agents');
  const evidence = join(binDir, 'reviewed.jsonl');
  const records = () => read(evidence).trim().split('\n').filter(Boolean).map((line) => {
    const { name: _name, ...record } = JSON.parse(line);
    return record;
  });
  const script = () => {
    const expected = (existsSync(agents) ? readdirSync(agents) : []).flatMap((file) => {
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(join(agents, file)));
      if (!match || match[2] !== 'Repaired initial reviewer.\n') return [];
      const front = yaml.load(match[1]) as { name: string };
      return [{ name: front.name, persona: 'review-result', charter: 'Repaired initial reviewer.\n', tools: ['Read'] }];
    });
    seedFakeAgentSteps(binDir, {
      first: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: [], review: 'none' },
      second: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: ['review-result'], review: 'full' },
    }, { reviewers: { expected, evidence } });
    cpSync(join(binDir, 'fake-agent'), join(binDir, 'claude'));
  };
  script();
  const page = await harness.launch({ CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile });
  const state = () => read(join(repo, '.agent-terminal/loop/run-state.yaml'));
  const artifact = join(repo, '.agent-terminal/loop/artifacts/result.md');
  const retry = page.getByRole('button', { name: /^Retry\b/i });
  await harness.cdInto(repo);
  await page.locator('#flow-picker').getByRole('button', { name: /flow/i }).click();
  await page.locator('#flow-picker').getByRole('option', { name: new RegExp(flow) }).click();
  await command(page, 'claude');
  await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);
  await page.locator('#flow-strip .flow-control').click();
  await expect(page.locator('#flow-strip')).toContainText(charter);
  await expect.poll(() => state() === '' || /status: (complete|error)/.test(state())).toBe(true);
  const backout = page.getByRole('button', { name: /^(Terminate|Cancel|Back(?: out)?)$/ });
  await expect.soft(backout).toBeEnabled();
  await clickAvailable(backout);
  await clickAvailable(page.locator('#flow-confirm-host .flow-modal .confirm'));
  await expect.soft(page.locator('#flow-picker').getByRole('button', { name: /flow/i })).toBeEnabled();
  await expect.soft(page.locator('#flow-strip .flow-control')).toHaveText('Start');
  rmSync(artifact, { force: true });
  await clickAvailable(page.locator('#flow-strip .flow-control').filter({ hasText: /^Start$/ }));
  await expect.soft(page.locator('#flow-strip')).toContainText(charter);
  await clickAvailable(page.locator('#flow-strip .loopstat'));
  await expect.soft(retry).toBeEnabled();
  await clickAvailable(retry);
  await expect.soft(page.locator('#flow-strip')).toContainText(charter);
  expect.soft(read(artifact)).toBe('');
  expect.soft(records()).toEqual([]);
  writeFileSync(charter, 'Repaired initial reviewer.\n');
  await clickAvailable(retry);
  await expect.soft.poll(state).toMatch(/status: (complete|error)/);
  if (!(await page.locator('#loop-panel').isVisible())) await clickAvailable(page.locator('#flow-strip .loopstat'));
  await clickAvailable(page.locator('#loop-panel [data-gate-option="approve"]'));
  await expect.soft.poll(state).toContain('step: second');
  await expect.soft.poll(state).toMatch(/status: (complete|error)/);
  script();
  for (const file of existsSync(agents) ? readdirSync(agents) : []) utimesSync(join(agents, file), new Date(0), new Date(0));
  const sessions = readdirSync(binDir).filter((file) => file.startsWith('reviewer-session-')).length;
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Control+C');
  await command(page, 'claude');
  await expect.poll(() => readdirSync(binDir).filter((file) => file.startsWith('reviewer-session-')).length).toBe(sessions + 1);
  if (!(await page.locator('#loop-panel').isVisible())) await clickAvailable(page.locator('#flow-strip .loopstat'));
  await expect.soft(retry).toBeEnabled();
  await clickAvailable(retry);
  await expect.soft.poll(records).toEqual([{ charter: 'Repaired initial reviewer.\n', tools: ['Read'] }]);
  await expect.soft.poll(state).toContain('status: complete');
  expect.soft(read(join(repo, '.gitignore'))).toBe(originalIgnore);
  expect.soft(readdirSync(globalAgents).map((file) => read(join(globalAgents, file)))).toEqual(['Global instructions.\n']);
  expect(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all', '--', '.claude/agents'], { encoding: 'utf8' })).toBe('');
});
