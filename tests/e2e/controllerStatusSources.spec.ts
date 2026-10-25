import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { statusDeadline } from './controllerStatusDeadline';
import { autoGateFlowYaml, seedTrustedFlow } from './autoGateHarness';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

for (const title of ['available', 'unavailable', 'slow'] as const) {
  test(`real initial flow snapshot keeps issue identity with ${title} title`, { tag: '@ownapp' }, async () => {
    const h = await createControllerDesktopHarness();
    const repo = h.fixture.repositories[0];
    try {
      mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
      seedTrustedFlow(h.fixture.home, repo, 'ticket-flow', `name: ticket-flow\nsteps:\n  - id: implement\n    kind: manual\n    inputs:\n      - name: ticket\n        type: github-ticket\n      - name: pr\n        type: pr\n`);
      writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: implement\nstatus: not_started\ninputs:\n  ticket: "219"\n  pr: "236"\n');
      const gh = title === 'unavailable' ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh
${title === 'slow' ? 'touch "$TITLE_STARTED"; while [ ! -e "$TITLE_ALLOW" ]; do sleep 0.02; done' : ':'}
if [ "$1" = issue ]; then
  printf '%s\\n' '{"title":"Issue title for live status","body":"PRIVATE ISSUE BODY","url":"https://github.com/example/repo/issues/219"}'
else
  printf '%s\\n' '{"title":"Different pull request title","body":"PRIVATE PR BODY","url":"https://github.com/example/repo/pull/236"}'
fi
`;
      writeFileSync(join(h.fixture.root, 'bin', 'gh'), gh, { mode: 0o700 });
      h.fixture.env.TITLE_STARTED = join(h.fixture.root, 'title-started');
      h.fixture.env.TITLE_ALLOW = join(h.fixture.root, 'title-allow');
      h.fixture.env.PATH = `${join(h.fixture.root, 'bin')}:${process.env.PATH}`;
      const controller = await h.launch(controllerTarget, h.fixture.nonGit);
      writeFileSync(h.fixture.env.TITLE_ALLOW, 'setup lookup may finish');
      const initial = await h.launch(terminalTarget, repo);
      const control = initial.page.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      await control.click();
      await expect(control).toHaveText('Advance');
      await initial.app.close();
      rmSync(h.fixture.env.TITLE_ALLOW, { force: true });
      rmSync(h.fixture.env.TITLE_STARTED, { force: true });
      await controller.page.getByRole('button', { name: `Dismiss disconnected terminal ${repo}`, exact: true }).click();
      const initialStatus = await statusDeadline(controller.page, repo, [/#219/, /ticket-flow/, /implement/, ...(title === 'slow' ? [] : [title === 'available' ? /Issue title for live status/ : /title.*unavailable|unavailable.*title/i])], 'registration');
      const terminal = await h.launch(terminalTarget, repo);
      await expect(terminal.page.locator('#flow-strip .flow-control')).toHaveText('Advance');
      await expect.poll(() => terminal.page.evaluate(directory => window.flow.state(directory), repo)).toMatchObject({ runStarted: 'started', refs: { ticket: 219, pr: 236 } });
      const pane = controller.page.getByRole('button', { name: repo, exact: false });
      const { matched: shown } = await initialStatus();
      expect(shown).toHaveLength(title === 'slow' ? 3 : 4);
      expect.soft({ ['issue within the initial shared deadline']: shown[0] }).toEqual({ ['issue within the initial shared deadline']: true });
      expect.soft({ ['flow within the initial shared deadline']: shown[1] }).toEqual({ ['flow within the initial shared deadline']: true });
      expect.soft({ ['step within the initial shared deadline']: shown[2] }).toEqual({ ['step within the initial shared deadline']: true });
      if (title === 'slow') {
        expect(existsSync(h.fixture.env.TITLE_STARTED)).toBe(true);
        expect(existsSync(h.fixture.env.TITLE_ALLOW)).toBe(false);
      }
      if (title !== 'slow') expect.soft({ ['initial title availability within shared deadline']: shown[3] }).toEqual({ ['initial title availability within shared deadline']: true });
      const titleStatus = await statusDeadline(controller.page, repo, [title !== 'unavailable' ? /Issue title for live status/ : /title.*unavailable|unavailable.*title/i]);
      writeFileSync(h.fixture.env.TITLE_ALLOW, 'release title');
      expect.soft({ ['title within two seconds of releasing the external result']: (await titleStatus()).matched[0] }).toEqual({ ['title within two seconds of releasing the external result']: true });
      await expect.soft(pane).not.toContainText(/PRIVATE ISSUE BODY|PRIVATE PR BODY|Different pull request title/);
    } finally {
      if (h.fixture.env.TITLE_ALLOW) writeFileSync(h.fixture.env.TITLE_ALLOW, 'release during cleanup');
      await h.dispose();
    }
  });
}

test('real malformed flow remains an error rather than an unassigned terminal', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  const repo = h.fixture.repositories[0];
  try {
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    seedTrustedFlow(h.fixture.home, repo, 'broken-flow', 'name: broken-flow\nsteps: [\n');
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const errorStatus = await statusDeadline(controller.page, repo, [/error/i, /broken-flow|parse|yaml|invalid/i], 'registration');
    const terminal = await h.launch(terminalTarget, repo);
    await expect(terminal.page.locator('#flow-strip .flow-error')).toBeVisible();
    await expect.poll(() => terminal.page.evaluate(directory => window.flow.state(directory), repo)).toMatchObject({ status: 'error' });
    const source = await terminal.page.evaluate(directory => window.flow.state(directory), repo);
    const pane = controller.page.getByRole('button', { name: repo, exact: false });
    const errorShown = await errorStatus();
    expect.soft({ ['error within initial deadline']: errorShown.matched[0] }).toEqual({ ['error within initial deadline']: true });
    expect(source.error).toBeTruthy();
    expect.soft({ ['full error within same deadline']: errorShown.texts.some(text => text.includes(source.error!)) }).toEqual({ ['full error within same deadline']: true });
    await expect.soft(pane).not.toContainText(/unassigned/i);
  } finally { await h.dispose(); }
});

test('real PTY activity remains visible without a started flow and never implies attention', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  const repo = h.fixture.repositories[0];
  try {
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    seedTrustedFlow(h.fixture.home, repo, 'idle-flow', autoGateFlowYaml([{ id: 'work', kind: 'manual' }], 'idle-flow'));
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: work\nstatus: not_started\n');
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, repo);
    await expect(terminal.page.locator('#flow-strip .flow-control')).toHaveText('Start');
    await terminal.page.locator('.xterm-screen').click();
    await terminal.page.keyboard.type('while :; do printf "SCREEN_ACTIVITY_%s\\n" "$RANDOM"; sleep 0.1; done');
    const activityStatus = await statusDeadline(controller.page, repo, [/active/i, /unassigned/i]);
    await terminal.page.keyboard.press('Enter');
    await expect(terminal.page.locator('.xterm-rows')).toContainText('SCREEN_ACTIVITY_');
    const pane = controller.page.getByRole('button', { name: repo, exact: false });
    const { matched: activityShown } = await activityStatus();
    expect.soft({ ['active within shared deadline']: activityShown[0] }).toEqual({ ['active within shared deadline']: true });
    expect.soft({ ['unassigned within shared deadline']: activityShown[1] }).toEqual({ ['unassigned within shared deadline']: true });
    await terminal.page.keyboard.press('Control+c');
    await expect.soft(pane).toContainText(/idle|quiet/i);
    await expect.soft(pane).not.toContainText(/needs? (?:a )?human/i);
  } finally { await h.dispose(); }
});
