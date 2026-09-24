import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { flowHomeDir } from '../../src/main/flow';
import { readActiveFlow } from '../../src/main/activeFlowPointer';
import { createFlowPickerHarness, type FlowPickerHarness } from './flowPickerHarness';

// A3 (#134) — self-test of the @ownapp launch harness every flow-picker e2e boots through. If it stops relocating
// the home, stops keeping app-written state across a close and launch, or cannot `cd` into a path carrying shell
// metacharacters, this fails before any picker test can pass for the wrong reason.

let h: FlowPickerHarness | undefined;
test.afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

test('the flow-picker harness boots against a relocated home, follows a cd, and keeps app-written state across a close and launch', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  expect(existsSync(flowHomeDir(harness.home))).toBe(false);
  harness.seedGlobalEntry('harness-flow-a', ['harness-a1', 'harness-a2']);
  harness.seedGlobalEntry('harness-flow-b', ['harness-b1', 'harness-b2']);
  const repo = harness.repo('agent-term-e2e-a3-$HOME-`x`-harness-');
  harness.selectFlow(repo, 'harness-flow-b');

  const page = await harness.launch();
  await expect(harness.launch()).rejects.toThrow(/already running/);
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('harness-b1', { timeout: 10_000 });
  await expect(harness.stepName(2)).toHaveText('harness-b2');

  expect(await page.evaluate((rk) => window.flow.setActiveFlow(rk, 'harness-flow-a'), repo)).toEqual({ ok: true });
  await harness.close();
  expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: 'harness-flow-a' });

  await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('harness-a1', { timeout: 10_000 });
});
