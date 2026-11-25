import { markRunReviewersLoaded } from '../helpers/runReviewerSession';
/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

for (const change of ['charter', 'tools', 'deleted', 'restart-deleted', 'restart-stale', 'unchanged'] as const) {
  test(`reviewer refresh: ${change} across reviewed steps and flow Restart`, { tag: '@ownapp' }, async () => {
    harness = createFlowPickerHarness();
    const repo = seedAutoGateRepo('reviewer-refresh-', 'first');
    cleanup.push(repo);
    rmSync(join(repo, '.claude'), { recursive: true, force: true });
    const cfg = mkdtempSync(join(tmpdir(), 'reviewer-refresh-config-'));
    cleanup.push(cfg);
    const { binDir, logFile } = seedFakeGhGit('reviewer-refresh-bin-');
    cleanup.push(binDir);
    const flow = 'refresh-flow';
    const loops = join(cfg, 'loops-v2', flow);
    const first = seedResolvedLoop(loops, 'first-loop', 'First instructions.\n', ['Read']);
    const second = seedResolvedLoop(loops, 'second-loop', 'Second instructions.\n', ['Grep']);
    const catalog = join(harness.home, '.agent-terminal/flows', flow);
    mkdirSync(catalog, { recursive: true });
    writeFileSync(join(catalog, 'flow.yaml'), yaml.dump({ name: flow, steps: [
      { id: 'first', kind: 'loop', loop: 'first-loop', loop_namespace: 'app' },
      { id: 'second', kind: 'loop', loop: change === 'unchanged' || change.startsWith('restart') ? 'second-loop' : 'first-loop', loop_namespace: 'app' },
    ] }));
    const globalAgents = join(cfg, 'agents');
    mkdirSync(globalAgents);
    writeFileSync(join(globalAgents, 'operator.md'), 'Global agent.\n');
    const originalIgnore = read(join(repo, '.gitignore'));
    const evidence = join(binDir, 'reviewed.jsonl');
    const agents = join(repo, '.claude/agents');
    const records = () => read(evidence).trim().split('\n').filter(Boolean).map((line) => {
      const { name: _name, ...record } = JSON.parse(line);
      return record;
    });
    const script = () => {
      const expected = [first, second].flatMap((definition) => {
        const def = yaml.load(read(definition)) as { reviewers: { tools: string[] }[] };
        const charter = read(join(dirname(definition), 'charter.md'));
        return (existsSync(agents) ? readdirSync(agents) : []).flatMap((file) => {
          const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(join(agents, file)));
          if (!match || match[2] !== charter) return [];
          const front = yaml.load(match[1]) as { name: string };
          return [{ name: front.name, persona: 'review-result', charter, tools: def.reviewers[0].tools }];
        });
      });
      seedFakeAgentSteps(binDir, Object.fromEntries(['first', 'second'].map((step) => [step, { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete' as const, roster: ['review-result'], review: 'full' as const }])), { reviewers: { expected, evidence } });
      cpSync(join(binDir, 'fake-agent'), join(binDir, 'claude'));
    };
    script();
    const page = await harness.launch({ CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile });
    const state = () => read(join(repo, '.agent-terminal/loop/run-state.yaml'));
    const settle = () => expect.poll(state).toMatch(/status: (error|complete)/);
    const restartSession = async () => {
      script();
      const sessions = readdirSync(binDir).filter((file) => file.startsWith('reviewer-session-'));
      markRunReviewersLoaded(repo);
      await page.locator('.xterm-screen').click();
      await page.keyboard.press('Control+C');
      await command(page, 'claude');
      await expect.poll(() => readdirSync(binDir).filter((file) => file.startsWith('reviewer-session-')).length).toBe(sessions.length + 1);
      await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);
    };
    const retry = async () => {
      const before = state();
      await page.locator('#loop-panel [data-app-route-out="retry"]').click();
      await expect.poll(state).not.toBe(before);
      await settle();
    };
    const approve = async () => {
      await page.locator('#loop-panel [data-gate-option="approve"]').click();
    };
    await harness.cdInto(repo);
    await page.locator('#flow-picker').getByRole('button', { name: /flow/i }).click();
    await page.locator('#flow-picker').getByRole('option', { name: new RegExp(flow) }).click();
    await command(page, 'claude');
    await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);
    await page.locator('#flow-strip .flow-control').click();
    await settle();
    await page.locator('#flow-strip .loopstat').click();
    await restartSession();
    await retry();
    expect(state()).toContain('status: complete');
    expect(records()).toEqual([{ charter: 'First instructions.\n', tools: ['Read'] }]);

    if (change.startsWith('restart')) {
      await approve();
      await expect.poll(state).toContain('step: second');
      await settle();
      expect(state()).toContain('status: complete');
      await approve();
      await expect(page.locator('#flow-strip .flow-control')).toHaveText('Restart');
    }
    if (change === 'charter' || change === 'restart-stale') writeFileSync(join(dirname(first), 'charter.md'), 'Updated instructions.\n');
    const priorAgentFiles = readdirSync(agents);
    if (change === 'tools') {
      const def = yaml.load(read(first)) as { reviewers: { tools: string[] }[] };
      def.reviewers[0].tools = ['Bash'];
      writeFileSync(first, yaml.dump(def));
    }
    if (change === 'deleted' || change === 'restart-deleted') for (const file of readdirSync(agents)) rmSync(join(agents, file));
    const before = records();
    if (change.startsWith('restart')) await page.locator('#flow-strip .flow-control').click();
    else await approve();
    await expect.poll(state).toContain(change.startsWith('restart') ? 'step: first' : 'step: second');
    await settle();
    if (change !== 'unchanged') {
      expect.soft(state()).toContain('status: error');
      expect.soft(state()).toMatch(/restart.*session/i);
      await expect.soft(page.locator('#loop-panel')).toContainText(/restart.*session/i);
      expect.soft(records()).toEqual(before);
      if (state().includes('status: error')) {
        await restartSession();
        await retry();
      }
    }
    if (change === 'tools') for (const file of priorAgentFiles) expect.soft(existsSync(join(agents, file))).toBe(false);
    expect.soft(state()).toContain('status: complete');
    const charter = change === 'charter' || change === 'restart-stale' ? 'Updated instructions.\n' : change === 'unchanged' ? 'Second instructions.\n' : 'First instructions.\n';
    expect.soft(records().slice(before.length)).toEqual([{ charter, tools: change === 'tools' ? ['Bash'] : change === 'unchanged' ? ['Grep'] : ['Read'] }]);
    if (change.startsWith('restart') && state().includes('status: complete')) {
      await approve();
      await expect.poll(state).toContain('step: second');
      await settle();
      expect.soft(state()).toContain('status: complete');
      expect.soft(records().at(-1)).toEqual({ charter: 'Second instructions.\n', tools: ['Grep'] });
    }
    writeFileSync(join(agents, 'personal.md'), 'Keep personal agent');
    await page.locator('#flow-strip .flow-terminate').click();
    await page.locator('#flow-confirm-host .flow-modal .confirm').click();
    await expect(page.locator('#flow-strip .flow-control')).toHaveText('Start');
    expect.soft(readdirSync(agents)).toEqual(['personal.md']);
    expect.soft(read(join(repo, '.gitignore'))).toBe(originalIgnore);
    expect(readdirSync(globalAgents).map((file) => read(join(globalAgents, file)))).toEqual(['Global agent.\n']);
  });
}
