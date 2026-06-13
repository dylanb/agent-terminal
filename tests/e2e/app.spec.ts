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

async function findRowIndex(needle: string): Promise<number> {
  const rows = page.locator('.xterm-rows > div');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    if ((await rows.nth(i).textContent())?.trim() === needle) return i;
  }
  return -1;
}

/** Drag-select the whole visible row whose exact text is `needle`; returns its bounding box. */
async function selectRowContaining(needle: string): Promise<{ x: number; y: number; width: number; height: number }> {
  // Wait for the exact output row to render — a preceding toContainText can match the
  // echoed command line before the command's own output appears (avoids a select race).
  await expect.poll(() => findRowIndex(needle)).toBeGreaterThanOrEqual(0);
  const row = page.locator('.xterm-rows > div').nth(await findRowIndex(needle));
  const box = (await row.boundingBox())!;
  const cy = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, cy, { steps: 10 });
  await page.mouse.up();
  return box;
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

test('the terminal exposes an accessibility tree for screen readers', async () => {
  // screenReaderMode wires xterm's AccessibilityManager, which mounts this container.
  await expect(page.locator('.xterm-accessibility')).toHaveCount(1);
});

test('Send selection pastes the selected text as an editable command line', async () => {
  await typeCommand("echo 'echo send-payload-xyz'");
  await expect(termRows()).toContainText('echo send-payload-xyz');

  await selectRowContaining('echo send-payload-xyz');
  await page.locator('#send-selection').click();
  // The selection stays highlighted after Send (§7.5).
  await expect(page.locator('.xterm-decoration').first()).toBeVisible();

  // Pasted at the prompt, not executed — running it now yields the echo output on its own row.
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Enter');
  await expect(
    page.locator('.xterm-rows > div').filter({ hasText: /^\s*send-payload-xyz\s*$/ }),
  ).toHaveCount(1);
});

test('Escape clears an active selection but passes through to the agent otherwise (§7.5.1)', async () => {
  await typeCommand("echo 'esc-target-row'");
  await expect(termRows()).toContainText('esc-target-row');

  // With a selection active, Escape clears it and is NOT sent to the shell.
  await selectRowContaining('esc-target-row');
  await expect(page.locator('.xterm-decoration')).not.toHaveCount(0);
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.xterm-decoration')).toHaveCount(0);

  // With no selection, Escape passes through — cat -v renders the byte as ^[.
  await typeCommand('cat -v');
  await page.keyboard.press('Escape');
  await expect(termRows()).toContainText('^[');
  await page.keyboard.press('Control+D');
});

test('captured blocks are replayed to a reloaded monitor pane (§8.4)', async () => {
  await typeCommand("echo 'replay-me-block'");
  await expect(termRows()).toContainText('replay-me-block');
  await selectRowContaining('replay-me-block');
  await page.locator('#capture-selection').click();
  await expect(page.locator('.capture-block').last()).toContainText('replay-me-block');

  await page.reload();
  await expect(page.locator('.capture-block').filter({ hasText: 'replay-me-block' })).toHaveCount(1);
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

// ---- §15: command-output capture & semantic detection ----

test('a finished command appears in history; Capture → command block → Insert & submit re-drives the shell', async () => {
  await typeCommand("echo 'echo cmd-ok-456'");
  await expect(termRows()).toContainText('echo cmd-ok-456');

  // The command-history entry is pulled on the quiescence tick after the command finishes.
  const entry = page.locator('.command-entry').filter({ hasText: 'cmd-ok-456' });
  await expect(entry).toHaveCount(1, { timeout: 10_000 });
  await expect(entry).toContainText('exit 0');

  await entry.getByRole('button', { name: 'Capture' }).click();
  const block = page.locator('.capture-block[data-type="command-output"]').last();
  await expect(block).toContainText('echo cmd-ok-456');

  // Insert & submit the captured output → bash runs `echo cmd-ok-456`.
  await page.locator('#monitor').click();
  await block.getByRole('button', { name: 'Insert & submit' }).click();
  await expect(
    page.locator('.xterm-rows > div').filter({ hasText: /^\s*cmd-ok-456\s*$/ }),
  ).toHaveCount(1, { timeout: 10_000 });
});

test('a printed Claude-style permission box no longer produces a semantic block (v2.6)', async () => {
  await typeCommand(
    "printf '%s\\n' '╭──────────────────────────────╮' '│ Do you want to proceed?      │' '│ ❯ 1. Yes                     │' '│   2. No                      │' '╰──────────────────────────────╯'",
  );
  await expect(termRows()).toContainText('Do you want to proceed?');
  // Permission/question detection was removed; a box is chrome and (with shell
  // integration on) its output is a gated command span — no report/permission block.
  await expect(
    page.locator('.capture-block[data-type="permission-prompt"], .capture-block[data-type="report"]'),
  ).toHaveCount(0);
});

test('boring commands produce command history but zero agent-semantic badges (§15.8 budget)', async () => {
  await typeCommand('ls /');
  await typeCommand('echo boring-done');
  await expect(termRows()).toContainText('boring-done');
  await expect(page.locator('.command-entry').filter({ hasText: 'ls /' })).toHaveCount(1, {
    timeout: 10_000,
  });
  // No semantic block types should have been emitted by the scanner.
  const semantic = page.locator(
    '.capture-block[data-type="report"], .capture-block[data-type="finding"], .capture-block[data-type="tool-use"], .capture-block[data-type="diff"]',
  );
  await expect(semantic).toHaveCount(0);
});

test('a captured command-output block survives a monitor reload (replay)', async () => {
  await typeCommand("echo 'echo replay-cmd-out'");
  await expect(termRows()).toContainText('echo replay-cmd-out');
  const entry = page.locator('.command-entry').filter({ hasText: 'replay-cmd-out' });
  await expect(entry).toHaveCount(1, { timeout: 10_000 });
  await entry.getByRole('button', { name: 'Capture' }).click();
  await expect(page.locator('.capture-block[data-type="command-output"]')).toHaveCount(1);

  await page.reload();
  await expect(page.locator('.capture-block[data-type="command-output"]')).toHaveCount(1);
});

test('a scanner-detected report block (with findings) survives a monitor reload (scanner→store→replay)', async () => {
  // Integration off: no command spans, so the generic heuristic surfaces the printed
  // report deterministically (no span-gating race) and the scanner→store→replay path
  // is exercised end-to-end.
  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SUBMIT_DELAY_MS: '100', APP_SHELL_INTEGRATION: '0' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(
    "printf '%s\\n' 'Here is the summary of findings from this code review:' '- one important finding worth acting on' '- another finding to address before merge'",
  );
  const report = page.locator('.capture-block[data-type="report"]');
  await expect(report.first()).toBeVisible({ timeout: 10_000 });
  await expect(report.first().locator('.finding')).not.toHaveCount(0);

  await page.reload();
  await expect(report.first()).toBeVisible();
});

test('APP_SHELL_INTEGRATION=0 disables command capture (no history entries)', async () => {
  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SUBMIT_DELAY_MS: '100', APP_SHELL_INTEGRATION: '0' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand('echo no-marks-here');
  await expect(termRows()).toContainText('no-marks-here');
  // Give a quiescence tick a chance to pull commands, then assert none exist.
  await page.waitForTimeout(2_000);
  await expect(page.locator('.command-entry')).toHaveCount(0);
});
