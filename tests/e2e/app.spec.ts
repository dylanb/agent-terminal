/// <reference lib="dom" />
// page.evaluate callbacks run in the renderer; DOM lib gives them window.monitor's type.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import '../../src/shared/ipc';

// Full-loop e2e (§12 acceptance): real Electron, real node-pty, real bash.

let app: ElectronApplication;
let page: Page;

const termRows = () => page.locator('.xterm-rows');

async function typeCommand(cmd: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
}

/** Drag-select the whole visible row containing `needle`; returns its bounding box. */
async function selectRowContaining(needle: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const rows = page.locator('.xterm-rows > div');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const text = await rows.nth(i).textContent();
    if (text?.trim() === needle) {
      const box = (await rows.nth(i).boundingBox())!;
      const cy = box.y + box.height / 2;
      await page.mouse.move(box.x + 2, cy);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, cy, { steps: 10 });
      await page.mouse.up();
      return box;
    }
  }
  throw new Error(`no terminal row contains ${JSON.stringify(needle)}`);
}

function inject(text: string, submit: boolean): Promise<void> {
  return page.evaluate(
    ([t, s]) => window.monitor.inject({ text: t as string, submit: s as boolean }),
    [text, submit] as const,
  );
}

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SUBMIT_DELAY_MS: '100' },
  });
  page = await app.firstWindow();
  // Bash prompt is ready once the shell has produced any output.
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
});

test.afterEach(async () => {
  await app.close();
});

test('runs commands in an interactive bash with the right terminal identity', async () => {
  await typeCommand('echo "term=$TERM colors=$COLORTERM"');
  await expect(termRows()).toContainText('term=xterm-256color colors=truecolor');
});

test('resizing the window resizes the PTY (tput cols follows)', async () => {
  await typeCommand('echo cols-before=$(tput cols)');
  await expect(termRows()).toContainText(/cols-before=\d+/);
  const before = Number((await termRows().innerText()).match(/cols-before=(\d+)/)![1]);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 600));
  // 80ms renderer debounce (§7.1) + IPC; poll until the PTY answers differently.
  await expect
    .poll(async () => {
      await typeCommand('echo cols-now=$(tput cols)');
      const m = (await termRows().innerText()).match(/cols-now=(\d+)/g)?.at(-1);
      return m ? Number(m.match(/\d+/)![0]) : before;
    })
    .not.toBe(before);
});

test('selection survives focus changes and draws the app-owned highlight', async () => {
  await typeCommand('seq 1 100; echo select-me-marker');
  await expect(termRows()).toContainText('select-me-marker');

  const rowBox = await selectRowContaining('select-me-marker');

  // The app's own decoration is drawn over the selected row (absolute-coordinate check:
  // with 100 lines scrolled, viewport-relative math would place it elsewhere).
  const deco = page.locator('.xterm-decoration').first();
  await expect(deco).toBeVisible();
  const decoBox = (await deco.boundingBox())!;
  expect(Math.abs(decoBox.y + decoBox.height / 2 - (rowBox.y + rowBox.height / 2))).toBeLessThan(
    rowBox.height,
  );

  // Focus independence (§7.0): clicking into the monitor pane must not clear it.
  await page.locator('#monitor').click();
  await expect(deco).toBeVisible();

  // Explicit clear is the only way it goes away (§7.5.1).
  await page.locator('#clear-selection').click();
  await expect(page.locator('.xterm-decoration')).toHaveCount(0);
});

test('capture puts the selected text into the monitor pane; insert & submit drives the shell', async () => {
  await typeCommand("echo 'echo injected-ok-123'");
  await expect(termRows()).toContainText('echo injected-ok-123');

  await selectRowContaining('echo injected-ok-123');
  await page.locator('#capture-selection').click();
  const block = page.locator('.capture-block').last();
  await expect(block).toContainText('echo injected-ok-123');

  // Insert WITHOUT submit: lands at the prompt, runs nothing.
  const outputRow = page.locator('.xterm-rows > div').filter({ hasText: /^\s*injected-ok-123\s*$/ });
  await block.getByRole('button', { name: 'Insert into agent' }).click();
  await page.waitForTimeout(500); // let the paste land before asserting nothing ran
  await expect(outputRow).toHaveCount(0);

  // Clear the pending input line, then submit with the terminal pane unfocused —
  // the monitor path is renderer-independent (§4D).
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Control+U');
  await page.locator('#monitor').click();
  await block.getByRole('button', { name: 'Insert & submit' }).click();
  await expect(outputRow).toHaveCount(1);
});

test('injection honors bracketed-paste mode read live from the shadow (§9.3)', async () => {
  // Mode OFF: bash disables ?2004 while a command runs; cat -v makes received bytes visible.
  await typeCommand('printf "\\x1b[?2004l"; cat -v');
  await expect(page.locator('.status-chip[data-status="paste mode"]')).toContainText('off');
  await inject('plain-text-in', true);
  await expect(termRows()).toContainText('plain-text-in');
  expect(await termRows().innerText()).not.toContain('200~');

  // Mode ON (forced by the foreground "app"): markers must fence the paste.
  await typeCommand(''); // flush
  await page.keyboard.press('Control+D'); // leave cat
  await typeCommand('printf "\\x1b[?2004h"; cat -v');
  await expect(page.locator('.status-chip[data-status="paste mode"]')).toContainText('on');
  await inject('fenced-in', true);
  await expect(termRows()).toContainText(/\[200~fenced-in.*\[201~/);
});

test('embedded ESC[201~ in injected content cannot break out of paste mode', async () => {
  await typeCommand('printf "\\x1b[?2004h"; cat -v');
  await expect(page.locator('.status-chip[data-status="paste mode"]')).toContainText('on');
  await inject('bad\x1b[201~rm', true);
  // The end marker inside the content is stripped: payload arrives contiguous.
  await expect(termRows()).toContainText(/\[200~badrm.*\[201~/);
});

test('monitor status strip tracks quiescence and alt-screen', async () => {
  const agentChip = page.locator('.status-chip[data-status="agent"]');
  const fsChip = page.locator('.status-chip[data-status="full-screen"]');

  await typeCommand('echo burst');
  await expect(agentChip).toContainText('working');
  await expect(agentChip).toContainText('quiet', { timeout: 5_000 });

  await typeCommand('printf "\\x1b[?1049h"');
  await expect(fsChip).toContainText('yes');
  await typeCommand('printf "\\x1b[?1049l"');
  await expect(fsChip).toContainText('no');
});

test('shell exit notifies both panes', async () => {
  await typeCommand('exit');
  await expect(termRows()).toContainText('[process exited: 0]');
  await expect(page.locator('.status-chip[data-status="session"]')).toContainText('exited');
});
