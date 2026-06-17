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

/**
 * cd into a throwaway directory so repo-scoped todos (§16.3) land there, not in the
 * project/HOME tree. Returns once the new prompt's OSC 7 has propagated the repo key
 * to the renderer (the Todo count chip exists). `marker` keys distinct temp dirs.
 */
async function cdToTempDir(marker: string): Promise<void> {
  const dir = `/tmp/agent-term-e2e-${marker}`;
  await typeCommand(`mkdir -p "${dir}" && cd "${dir}" && pwd`);
  // The exact pwd output row confirms the cd ran; waiting for quiescence guarantees
  // the following OSC 7 (emitted at the next prompt) has been parsed → repo key live.
  await expect(
    page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) }),
  ).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });
}

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SUBMIT_DELAY_MS: '100' },
  });
  page = await app.firstWindow();
  // Bash prompt is ready once the shell has produced any output.
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  // lastTab persists globally (§16.6), so a prior test that opened the Todo tab would
  // otherwise leave the Capture panel hidden here; reset to a known tab per test.
  await page.locator('#tab-capture').click();
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

  // Focus independence (§7.0): clicking into the docked action window must not clear it.
  await page.locator('#drawer').click();
  await expect(deco).toBeVisible();

  // Explicit clear is the only way it goes away (§7.5.1).
  await page.locator('#clear-selection').click();
  await expect(page.locator('.xterm-decoration')).toHaveCount(0);
});

test('manual selection capture routes to the Todo tab; Insert & submit drives the shell (§16.2)', async () => {
  await cdToTempDir('inject');
  await typeCommand("echo 'echo injected-ok-123'");
  await expect(termRows()).toContainText('echo injected-ok-123');

  // Capture selection → straight to the Todo list, NOT a Capture-tab block (§16.2).
  await selectRowContaining('echo injected-ok-123');
  await page.locator('#capture-selection').click();
  await page.locator('#tab-todo').click();
  const item = page.locator('.todo-item').filter({ hasText: 'echo injected-ok-123' });
  await expect(item).toHaveCount(1);

  // Insert & submit from the todo drives the shell (focus stays in the action window).
  await page.locator('#drawer').click();
  await item.getByRole('button', { name: 'Insert & submit' }).click();
  await expect(
    page.locator('.xterm-rows > div').filter({ hasText: /^\s*injected-ok-123\s*$/ }),
  ).toHaveCount(1);
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

test('Shift+Enter inserts a newline (ESC+CR) instead of submitting (§7.5.2)', async () => {
  // cat -v echoes received control bytes visibly: ESC -> ^[. xterm's default for
  // Shift+Enter is a bare CR (no ^[), so the rendered ^[ proves our handler ran.
  await typeCommand('cat -v');
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Shift+Enter');
  await expect(termRows()).toContainText('^[');
  await page.keyboard.press('Control+C');
});

test('Option/Alt+Backspace deletes the whole previous word at the prompt (§7.5.2)', async () => {
  // Functional, end-to-end: word-delete leaves `echo `, so `done` runs as `echo done`.
  // A char-delete or no-op would instead run `echo foobadone` / `echo foobardone`.
  await page.locator('.xterm-screen').click();
  await page.keyboard.type('echo foobar');
  await page.keyboard.press('Alt+Backspace');
  await page.keyboard.type('done');
  await page.keyboard.press('Enter');
  await expect(
    page.locator('.xterm-rows > div').filter({ hasText: /^\s*done\s*$/ }),
  ).toHaveCount(1);
});

test('a todo persists in-repo across an app restart (§16.3)', async () => {
  await cdToTempDir('persist');
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('persist-this-todo');
  await page.locator('#todo-add-btn').click();
  await expect(page.locator('.todo-item').filter({ hasText: 'persist-this-todo' })).toHaveCount(1);

  // Restart the whole app (fresh main process + PTY): the in-repo todos.json is reread
  // when the agent cd's back into the repo, and the first OSC 7 re-broadcasts the key.
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await cdToTempDir('persist');
  await page.locator('#tab-todo').click();
  await expect(page.locator('.todo-item').filter({ hasText: 'persist-this-todo' })).toHaveCount(1);
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
  await page.locator('#drawer').click();
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

test('capture ↔ terminal cross-highlight: double-click reveals each side (§16.8)', async () => {
  // Integration off so the printed report surfaces deterministically (as in the replay test).
  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SUBMIT_DELAY_MS: '100', APP_SHELL_INTEGRATION: '0' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(
    "printf '%s\\n' 'Here is the cross-highlight summary of findings below:' '- cross-highlight finding one worth acting on now' '- cross-highlight finding two to address before merge'",
  );
  const report = page.locator('.capture-block[data-type="report"]').first();
  await expect(report).toBeVisible({ timeout: 10_000 });
  // The two list items split into individually-actionable findings (chunks).
  const findingOne = report.locator('.finding', { hasText: 'finding one worth acting on now' });
  await expect(findingOne).toHaveCount(1);

  // Capture → terminal: double-clicking a single finding draws the amber reveal decoration
  // over just that chunk's terminal rows (a class distinct from the blue selection one).
  await findingOne.dblclick();
  await expect(page.locator('.xterm-decoration.reveal-highlight').first()).toBeVisible();

  // Terminal → capture: double-clicking a word on that finding's terminal row reveals the
  // specific chunk, not the whole report — the finding itself gets the outline.
  const rowIdx = await findRowIndex('- cross-highlight finding one worth acting on now');
  expect(rowIdx).toBeGreaterThanOrEqual(0);
  await page.locator('.xterm-rows > div').nth(rowIdx).dblclick();
  await expect(findingOne).toHaveClass(/revealed/);
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

// ---- §16: action window — todo lists, focus rule, layout ----

test('only the active tab’s panel is visible (§16.1)', async () => {
  const capture = page.locator('#panel-capture');
  const todo = page.locator('#panel-todo');

  // beforeEach selects the Capture tab.
  await expect(capture).toBeVisible();
  await expect(todo).toBeHidden();

  await page.locator('#tab-todo').click();
  await expect(todo).toBeVisible();
  await expect(capture).toBeHidden();

  await page.locator('#tab-capture').click();
  await expect(capture).toBeVisible();
  await expect(todo).toBeHidden();
});

test('cd between directories swaps the repo-scoped todo list (§16.3)', async () => {
  const todo = (text: string) => page.locator('.todo-item').filter({ hasText: text });

  await cdToTempDir('repoA');
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('A-side todo');
  await page.locator('#todo-add-btn').click();
  await expect(todo('A-side todo')).toHaveCount(1);

  // cd elsewhere → the list swaps to that dir's (empty) list.
  await cdToTempDir('repoB');
  await expect(todo('A-side todo')).toHaveCount(0);

  // cd back → A's todo returns (persisted in repoA/.agent-terminal/todos.json).
  await typeCommand('cd "/tmp/agent-term-e2e-repoA"');
  await expect(todo('A-side todo')).toHaveCount(1);
});

test('Insert (no submit) on a todo moves focus to the terminal (§16.2 focus rule)', async () => {
  await cdToTempDir('focus');
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('echo focus-payload');
  await page.locator('#todo-add-btn').click();
  const item = page.locator('.todo-item:not(.done)').filter({ hasText: 'echo focus-payload' });
  await expect(item).toHaveCount(1);

  // Focus already sits in the action window (we just used the add input). Insert
  // (no submit) must move it to the terminal so the user can finish/submit there.
  const insert = item.getByRole('button', { name: 'Insert into agent' });
  await insert.scrollIntoViewIfNeeded();
  await insert.click();
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
});

// ---- §24.1C: the converged three-view shell (views, docked drawer, theme) ----

test('switches views via hotkey and nav button, showing one pane at a time (§22.4)', async () => {
  const v1 = page.locator('[data-viewpane="1"]');
  const v3 = page.locator('[data-viewpane="3"]');
  await expect(v1).toBeVisible();
  await expect(v3).toBeHidden();

  // ⌘/Ctrl+3 → Todos view.
  await page.keyboard.press('Control+3');
  await expect(v3).toBeVisible();
  await expect(v1).toBeHidden();
  await expect(page.locator('[data-viewbtn="3"]')).toHaveClass(/on/);

  // The nav button switches back to the terminal.
  await page.locator('[data-viewbtn="1"]').click();
  await expect(v1).toBeVisible();
  await expect(v3).toBeHidden();
});

test('the quick-send drawer docks and undocks without a scrim, keeping the terminal visible (§16.8/§22.2)', async () => {
  const appEl = page.locator('#app');
  await expect(appEl).toHaveClass(/drawer-open/); // docked by default

  // ⌘/Ctrl+K undocks it; the terminal pane stays on screen (no overlay/scrim).
  await page.keyboard.press('Control+k');
  await expect(appEl).not.toHaveClass(/drawer-open/);
  await expect(page.locator('.scrim, .backdrop')).toHaveCount(0);
  await expect(page.locator('#terminal')).toBeVisible();

  // The quick-send button re-docks; the close button undocks again.
  await page.locator('#qs').click();
  await expect(appEl).toHaveClass(/drawer-open/);
  await expect(page.locator('#panel-capture')).toBeVisible();
  await page.locator('#dclose').click();
  await expect(appEl).not.toHaveClass(/drawer-open/);
});

test('⌘/Ctrl+K toggles the drawer even while the terminal is focused (§22.4)', async () => {
  const appEl = page.locator('#app');
  await page.locator('.xterm-screen').click(); // focus the terminal
  await expect(appEl).toHaveClass(/drawer-open/);

  // The shell intercepts the chord ahead of xterm, so the hotkey still reaches it.
  await page.keyboard.press('Control+k');
  await expect(appEl).not.toHaveClass(/drawer-open/);
  await page.keyboard.press('Control+k');
  await expect(appEl).toHaveClass(/drawer-open/);
});

test('the terminal refits its PTY when the drawer docks/undocks (§7.1)', async () => {
  await typeCommand('echo cols-docked=$(tput cols)');
  await expect(termRows()).toContainText(/cols-docked=\d+/);
  const docked = Number((await termRows().innerText()).match(/cols-docked=(\d+)/)![1]);

  // Undocking the drawer (close button — the terminal has focus, so ⌘K would be
  // consumed by xterm) widens the terminal column; the PTY must follow (more cols).
  await page.locator('#dclose').click();
  await expect
    .poll(async () => {
      await typeCommand('echo cols-wide=$(tput cols)');
      const m = (await termRows().innerText()).match(/cols-wide=(\d+)/g)?.at(-1);
      return m ? Number(m.match(/\d+/)![0]) : docked;
    })
    .toBeGreaterThan(docked);
});

test('the mocked Review gate renders from the fixture and its Approve stub reflects a verdict (§19.3)', async () => {
  await page.keyboard.press('Control+3'); // Todos + gate view
  const gate = page.locator('#gate-panel');
  await expect(gate.locator('button.app')).toHaveText(/Approve/);
  await expect(gate).toContainText('changes requested'); // fixture's prior verdict

  await gate.locator('button.app').click(); // stubbed — no injection, reflects locally
  await expect(gate).toContainText('approved');
});

test('the theme toggle flips light/dark and persists across a reload (§16.6)', async () => {
  const html = page.locator('html');
  await page.locator('#tg').click();
  const toggled = await html.getAttribute('data-theme');
  expect(toggled).toBe('dark');

  await page.reload();
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark');

  // flip back so the persisted pref doesn't leak into later runs
  await page.locator('#tg').click();
  await expect(html).toHaveAttribute('data-theme', 'light');
});
