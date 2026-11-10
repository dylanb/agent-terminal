/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFlowPickerHarness, type FlowPickerHarness } from './flowPickerHarness';
import { seedFakeAgentV2, seedFakeGhGit } from './fakeTools';

let h: FlowPickerHarness | undefined;
test.afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const pickerHost = (page: Page): Locator => page.locator('#app .rail:has(#flow-strip) #flow-picker');
const pickerTrigger = (page: Page): Locator => pickerHost(page).getByRole('button', { name: /flow/i });
const pickerOption = (page: Page, id: string): Locator => pickerHost(page).getByRole('option', { name: new RegExp(id) });
const flowControl = (page: Page): Locator => page.locator('#flow-strip .flow-control');
const flowError = (page: Page): Locator => page.locator('#flow-strip .flow-error');
const station = (page: Page, i: number): Locator => page.locator('#flow-strip .flow.vert .stn').nth(i);
const flowTerminate = (page: Page): Locator => page.locator('#flow-strip .flow-terminate');
const confirmModal = (page: Page): Locator => page.locator('#flow-confirm-host .flow-modal');
const inputModal = (page: Page): Locator => page.locator('#flow-modal-host .flow-modal');

async function openPicker(page: Page): Promise<void> {
  await expect(pickerTrigger(page)).toBeEnabled({ timeout: 10_000 });
  await pickerTrigger(page).click();
  await expect(pickerHost(page).getByRole('listbox')).toBeVisible();
}

test('a repo flow made of repo step definitions is picked, started and advanced to the end', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = harness.repo('agent-term-e2e-steps-run-');
  harness.seedRepoStep(repo, 'step-a', 'kind: manual\n');
  harness.seedRepoStep(repo, 'step-b', 'kind: manual\n');
  harness.seedRepoEntryYaml(repo, 'two-step', 'name: two-step\nsteps:\n  - step: step-a\n  - step: step-b\n');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await openPicker(page);
  await pickerOption(page, 'two-step').click();

  await expect(harness.stepName(1)).toHaveText('step-a', { timeout: 10_000 });
  await expect(harness.stepName(2)).toHaveText('step-b');
  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });
  await expect(station(page, 1)).toHaveClass(/\bactive\b/);
  await flowControl(page).click();
  await expect(station(page, 2)).toHaveClass(/\bactive\b/, { timeout: 10_000 });
  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Restart', { timeout: 10_000 });
});

test('a flow referencing a missing step definition shows the flow-load error naming the step', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = harness.repo('agent-term-e2e-steps-missing-');
  harness.seedRepoEntryYaml(repo, 'broken', 'name: broken\nsteps:\n  - step: nowhere\n');
  harness.selectFlow(repo, 'broken');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
  await expect(flowError(page)).toContainText('nowhere');
});

test('a repository step definition wins over a global one of the same name', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = harness.repo('agent-term-e2e-steps-clash-');
  harness.seedGlobalStep('only-global', 'kind: manual\n');
  harness.seedGlobalStep('step-a', 'kind: manual\n');
  harness.seedRepoStep(
    repo,
    'step-a',
    'kind: loop\nloop: infra-loop\nloop_namespace: app\ninputs:\n  - name: note\n    type: github-ticket\n    required: true\n',
  );
  harness.seedRepoEntryYaml(repo, 'global-only', 'name: global-only\nsteps:\n  - step: only-global\n');
  harness.seedRepoEntryYaml(repo, 'clash', 'name: clash\nsteps:\n  - step: step-a\n');
  harness.selectFlow(repo, 'global-only');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('only-global', { timeout: 10_000 });
  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });

  await flowTerminate(page).click();
  await expect(confirmModal(page)).toBeVisible();
  await confirmModal(page).locator('.confirm').click();
  await expect(flowControl(page)).toHaveText('Start', { timeout: 10_000 });
  await openPicker(page);
  await pickerOption(page, 'clash').click();
  await expect(harness.stepName(1)).toHaveText('step-a', { timeout: 10_000 });
  await flowControl(page).click();
  await expect(inputModal(page)).toBeVisible({ timeout: 10_000 });
  await expect(inputModal(page).locator('.field .nm')).toHaveText(['note']);
});

/** A loop with no reviewers and no gate side effects, so its work turn is the whole loop. */
function writeFixtureLoop(repo: string, name: string, artifact: string, extra: string[]): string {
  const dir = join(repo, 'fixture-loops', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'work.md'), `Write ${artifact}.\n`);
  writeFileSync(
    join(dir, `${name}.yaml`),
    [
      'version: v2', `name: ${name}`, 'work:', '  recipe: work.md', `  artifact: ${artifact}`, 'reviewers: []', 'boundaries: []',
      'report:', '  sections: [summary]', 'gate:', '  - option: approve', '  - option: redo', ...extra, '',
    ].join('\n'),
  );
  return `fixture-loops/${name}/${name}.yaml`;
}

test('a two-step flow of referenced loop steps is picked, waits at the first gate, and carries its output into the second step', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = harness.repo('agent-term-e2e-steps-tracer-');
  const writeLoop = writeFixtureLoop(repo, 'note-writer', 'note', ['outputs:', '  - id: note', '    path: note.md']);
  const readLoop = writeFixtureLoop(repo, 'note-reader', 'summary', ['inputs:', '  - id: note', '    path: note.md', 'outputs:', '  - id: summary', '    path: summary.md']);
  writeFileSync(join(repo, '.agent-loop.yaml'), `loops:\n  note-writer: ${writeLoop}\n  note-reader: ${readLoop}\n`);
  harness.seedRepoStep(repo, 'step-a', 'kind: loop\nloop: note-writer\nloop_namespace: app\n');
  harness.seedRepoStep(repo, 'step-b', 'kind: loop\nloop: note-reader\nloop_namespace: app\n');
  harness.seedRepoEntryYaml(repo, 'two-step', 'name: two-step\nsteps:\n  - step: step-a\n  - step: step-b\n');
  const noteRel = '.agent-terminal/loop/artifacts/note.md';
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-steps-tracer-bin-');
  seedFakeAgentV2(binDir, { stepId: 'step-a', artifactRel: noteRel, work: 'complete', logInjected: true });
  const flowState = (): string => {
    const file = join(repo, '.agent-terminal', 'flow-state.yaml');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const injected = (): string => {
    const file = join(repo, '.agent-terminal', 'injected-log');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };

  try {
    const page = await harness.launch({ PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile });
    await harness.cdInto(repo);
    await openPicker(page);
    await pickerOption(page, 'two-step').click();
    await expect(harness.stepName(1)).toHaveText('step-a', { timeout: 10_000 });
    await expect(harness.stepName(2)).toHaveText('step-b');

    await page.locator('.xterm-screen').click();
    await page.keyboard.type('fake-agent', { delay: 20 });
    await page.keyboard.press('Enter');
    await flowControl(page).click();

    const loopReadout = page.locator('#flow-strip .loopstat');
    const loopPanel = page.locator('#loop-panel');
    await expect(loopReadout).toBeVisible({ timeout: 40_000 });
    await expect.poll(() => existsSync(join(repo, noteRel)), { timeout: 40_000 }).toBe(true);
    await loopReadout.click();
    await expect(loopPanel.locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 40_000 });
    expect(flowState()).toContain('step: step-a');
    expect(injected()).not.toContain(`- note: ${noteRel}`);
    await expect(station(page, 1)).toHaveClass(/\bactive\b/);

    await loopPanel.locator('[data-gate-option="approve"]').click();
    await expect(station(page, 2)).toHaveClass(/\bactive\b/, { timeout: 15_000 });
    await expect.poll(flowState, { timeout: 15_000 }).toContain('step: step-b');
    await expect.poll(injected, { timeout: 40_000 }).toContain(`- note: ${noteRel}`);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});
