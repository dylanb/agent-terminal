import { expect } from '@playwright/test';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dump, load } from 'js-yaml';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { createControllerRegistrationRelay } from './controllerRegistrationRelay';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { shellQuote } from '../../src/shared/shellQuote';
import { controllerSnapshot } from './controllerSnapshot';
import { notificationEntries } from '../helpers/controllerHistory';

export const historyControllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
export const historyTerminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };

export async function historyGate() {
  const h = await createControllerDesktopHarness();
  const repo = seedAutoGateRepo('controller-history-', 'red');
  const { binDir, logFile } = seedFakeGhGit('controller-history-tools-', { realCommitOps: true });
  const controllerHome = join(h.fixture.root, 'controller-state');
  let relay: Awaited<ReturnType<typeof createControllerRegistrationRelay>> | undefined;
  const dispose = async () => {
    try { await h.dispose(); }
    finally {
      try { await relay?.dispose(); }
      finally { rmSync(repo, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); }
    }
  };
  try {
    const config = join(h.fixture.root, 'history-config');
    cpSync(exampleConfigDir, config, { recursive: true });
    const defPath = join(config, 'loops-v2', 'red-loop', 'red-loop.yaml');
    const def = load(readFileSync(defPath, 'utf8')) as Record<string, unknown>;
    def.gate = [{ option: 'approve' }, { option: 'request-changes' }];
    writeFileSync(defPath, dump(def));
    relay = await createControllerRegistrationRelay(h.fixture.home, controllerHome);
    seedTrustedFlow(h.fixture.home, repo, 'history-flow', autoGateFlowYaml([
      { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' }, { id: 'verify', kind: 'manual' },
    ], 'history-flow'));
    seedFakeAgentV2(binDir, {
      stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red',
      roster: loopRoster('red-loop'),
      verdicts: Array.from({ length: 6 }, () => exampleConsolidatorOutput('stop for a human', loopRoster('red-loop'))),
    });
    Object.assign(h.fixture.env, {
      PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile, CLAUDE_CONFIG_DIR: config,
      APP_SUBMIT_DELAY_MS: '100',
    });
    let controller = await h.launch(historyControllerTarget, h.fixture.nonGit, { env: { APP_HOME_DIR: controllerHome } });
    const terminal = await h.launch(historyTerminalTarget, repo);
    await terminal.page.locator('.xterm-screen').click();
    await terminal.page.keyboard.type(`cd ${shellQuote(repo)}; fake-agent`);
    await terminal.page.keyboard.press('Enter');
    const control = terminal.page.locator('#flow-strip .flow-control');
    await expect(control).toHaveText('Start'); await control.click();
    const state = () => terminal.page.evaluate(directory => window.flow.state(directory), repo);
    async function gate(round: number) {
      await expect.poll(async () => {
        const view = await state();
        return { human: view.loop?.humanNeeded, iteration: view.loop?.iteration, status: view.loop?.status };
      }, { timeout: 60_000 }).toEqual({ human: true, iteration: round, status: 'complete' });
      await expect.poll(async () => (await controllerSnapshot(controller.page)).find(t => t.launchDirectory === repo)?.notifications?.[0]?.message,
        { timeout: 30_000 }).toContain(`iter ${round}`);
      return (await controllerSnapshot(controller.page)).find(t => t.launchDirectory === repo)!.notifications![0];
    }
    const first = await gate(1);
    return {
      h, repo, terminal, first, state, dispose,
      controller: () => controller,
      entries: async () => notificationEntries((await controllerSnapshot(controller.page)).find(t => t.launchDirectory === repo)),
      async next(round: number) {
        const accepted = await terminal.page.evaluate(async directory => {
          const view = await window.flow.state(directory);
          const turn = view.loop!.appTurn!;
          return window.flow.appRequestChanges(directory, turn.step, turn.turnKey, 'Review the next proposal');
        }, repo);
        expect(accepted).toBe(true);
        return gate(round);
      },
      async resolve() {
        await terminal.page.evaluate(async directory => {
          const turn = (await window.flow.state(directory)).loop!.appTurn!;
          window.flow.appGateDecision(directory, turn.step, turn.turnKey, 'approve');
        }, repo);
        await expect(terminal.page.locator('#flow-strip')).toContainText('verify');
      },
      async disconnect() { const current = relay; relay = undefined; await current?.dispose(); },
      async reconnect() { relay = await createControllerRegistrationRelay(h.fixture.home, controllerHome); },
      async restartController() {
        await h.crash(controller.app);
        controller = await h.launch(historyControllerTarget, h.fixture.nonGit, { env: { APP_HOME_DIR: controllerHome }, profile: controller.profile });
      },
    };
  } catch (error) { await dispose(); throw error; }
}
