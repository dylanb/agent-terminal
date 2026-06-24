/// <reference lib="dom" />
// page.evaluate callbacks run in the renderer; DOM lib gives them window.monitor's type.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CH, SESSION_ID } from '../../src/shared/ipc';

// Full-loop e2e (§12 acceptance): real Electron, real node-pty, real bash.
// Every launch pins APP_SHELL=bash so the bash-only shell-integration path (OSC 7/133, §15.5)
// is exercised regardless of the host's $SHELL — host shell must not change e2e outcomes.

let app: ElectronApplication;
let page: Page;
// Per-test userData so persisted UI state (§20.2) never bleeds across runs or touches the dev's real
// ~/.config/Electron. HOME=temp tests instead get userData under their HOME.
let userDataDir: string;
const launchArgs = (): string[] => ['out/main/index.js', `--user-data-dir=${userDataDir}`];

const termRows = () => page.locator('.xterm-rows');

async function typeCommand(cmd: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
}

// Snapshot all row texts in ONE call: a resize reflow changes the row count, so a
// count()-then-nth(i) loop can target a row that detached mid-iteration (a 30s nth timeout).
async function findRowIndex(needle: string): Promise<number> {
  const texts = await page.locator('.xterm-rows > div').allTextContents();
  return texts.findIndex((t) => t.trim() === needle);
}

/** First visible row whose text contains `needle`. */
async function findRowIndexContaining(needle: string): Promise<number> {
  const texts = await page.locator('.xterm-rows > div').allTextContents();
  return texts.findIndex((t) => t.includes(needle));
}

/** Drag-select the visible row whose exact text is `needle`; returns its bounding box. */
async function selectRowContaining(needle: string): Promise<{ x: number; y: number; width: number; height: number }> {
  // A toContainText can match the echoed command line before its output row renders; the exact-row
  // poll waits for the output row so the drag does not race it.
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

/** Capture is manual + single-slot (§21.1): nothing auto-emits, so a findings assertion must follow
 *  an on-demand capture. */
async function clickCaptureLast(): Promise<void> {
  await page.locator('#capture-last').click();
}

function inject(text: string, submit: boolean): Promise<void> {
  return page.evaluate(
    ([t, s]) => window.monitor.inject({ text: t as string, submit: s as boolean }),
    [text, submit] as const,
  );
}

/** Whether `sel` can take keyboard focus — the observable test for "inert when hidden" (§22.2):
 *  display:none / visibility:hidden elements refuse focus, so this is false for hidden content. */
function canFocus(sel: string): Promise<boolean> {
  return page.locator(sel).evaluate((e) => {
    (e as HTMLElement).focus();
    return document.activeElement === e;
  });
}

/** Open the quick-send drawer (closed on startup and reset to closed by relaunch/reload, §22.2). */
async function openQuickSend(tab: 'capture' | 'todo' = 'capture'): Promise<void> {
  await page.locator('#qs').click();
  await page.locator(`#tab-${tab}`).click();
}

/**
 * cd into a throwaway dir so repo-scoped todos (§16.3) land there, not in the project/HOME tree.
 * Resolves once the new prompt's OSC 7 has propagated the repo key to the renderer. `marker` keys
 * distinct temp dirs; each dir is wiped at most once per test so a within-test relaunch keeps its
 * todos.json while a fresh test starts clean from the fixed /tmp path.
 */
let freshenedDirs: Set<string>;
async function cdToTempDir(marker: string): Promise<void> {
  const dir = `/tmp/agent-term-e2e-${marker}`;
  const wipe = freshenedDirs.has(marker) ? '' : `rm -rf "${dir}" && `;
  freshenedDirs.add(marker);
  await typeCommand(`${wipe}mkdir -p "${dir}" && cd "${dir}" && pwd`);
  // Quiescence guarantees the next prompt's OSC 7 was parsed → repo key live before return.
  await expect(
    page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) }),
  ).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });
}

test.beforeEach(async () => {
  freshenedDirs = new Set();
  userDataDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-ud-'));
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  // The drawer starts closed (§22.2); drawer-driven tests below assume it open on Capture. The
  // closed-on-startup default is asserted by its own fresh-relaunch test.
  await openQuickSend('capture');
});

test.afterEach(async () => {
  await app.close(); // stop writes before removing the userData dir
  rmSync(userDataDir, { recursive: true, force: true });
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

  // Absolute-coordinate check: with 100 lines scrolled, viewport-relative math would mis-place this.
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

test('the native selection highlight is visible live mid-drag, before mouseup (§7.1)', async () => {
  await typeCommand('echo drag-highlight-marker');
  await expect(termRows()).toContainText('drag-highlight-marker');
  await expect.poll(() => findRowIndex('drag-highlight-marker')).toBeGreaterThanOrEqual(0);
  const row = page.locator('.xterm-rows > div').nth(await findRowIndex('drag-highlight-marker'));
  const box = (await row.boundingBox())!;
  const cy = box.y + box.height / 2;

  // The button is still DOWN (no mouse.up): the user must SEE the highlight as they drag,
  // which the app-owned decoration cannot provide mid-gesture (it churns faster than it paints).
  await page.mouse.move(box.x + 2, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, cy, { steps: 10 });

  // xterm's DOM renderer paints the live selection as .xterm-selection rectangles, coloured from
  // the now non-transparent selectionBackground — a visibly blue fill, not the black it blended
  // to while transparent (rgba(0,0,0,0) over the black bg → rgb(0,0,0), i.e. invisible).
  const rect = page.locator('.xterm-selection div').first();
  await expect(rect).toBeVisible();
  const [r, , b] = (await rect.evaluate((el) => getComputedStyle(el).backgroundColor))
    .match(/\d+/g)!
    .map(Number);
  expect(b).toBeGreaterThan(120); // visibly blue…
  expect(b).toBeGreaterThan(r + 60); // …not the black it was when transparent

  await page.mouse.up();
});

test('manual selection capture routes to the Todo tab; Send drives the shell (§16.2)', async () => {
  await cdToTempDir('inject');
  await typeCommand("echo 'echo injected-ok-123'");
  await expect(termRows()).toContainText('echo injected-ok-123');

  // Capture selection → straight to the Todo list, NOT a Capture card (§16.2).
  await selectRowContaining('echo injected-ok-123');
  await page.locator('#capture-selection').click();
  await page.locator('#tab-todo').click();
  const item = page.locator('.todo').filter({ hasText: 'echo injected-ok-123' });
  await expect(item).toHaveCount(1);

  // Send pastes the todo at the prompt WITHOUT submitting, so the user can edit it (§24.2.1).
  const outputRow = page.locator('.xterm-rows > div').filter({ hasText: /^\s*injected-ok-123\s*$/ });
  await page.locator('#drawer').click();
  await item.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.xterm-rows')).toContainText('echo injected-ok-123');
  await expect(outputRow).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(outputRow).toHaveCount(1);
});

test('injection honors bracketed-paste mode read live from the shadow (§9.3)', async () => {
  // Mode OFF (?2004l): an unfenced paste arrives with no bracket markers (§9.3). cat -v renders bytes.
  await typeCommand('printf "\\x1b[?2004l"; cat -v');
  await expect(page.locator('.status-chip[data-status="paste mode"]')).toContainText('off');
  await inject('plain-text-in', true);
  await expect(termRows()).toContainText('plain-text-in');
  expect(await termRows().innerText()).not.toContain('200~');

  // Mode ON (?2004h): the paste must be fenced by ESC[200~ … ESC[201~.
  await typeCommand('');
  await page.keyboard.press('Control+D');
  await typeCommand('printf "\\x1b[?2004h"; cat -v');
  await expect(page.locator('.status-chip[data-status="paste mode"]')).toContainText('on');
  await inject('fenced-in', true);
  await expect(termRows()).toContainText(/\[200~fenced-in.*\[201~/);
});

test('embedded ESC[201~ in injected content cannot break out of paste mode', async () => {
  await typeCommand('printf "\\x1b[?2004h"; cat -v');
  await expect(page.locator('.status-chip[data-status="paste mode"]')).toContainText('on');
  await inject('bad\x1b[201~rm', true);
  // The embedded ESC[201~ is stripped (§7.5/§9.3 breakout guard): payload arrives contiguous.
  await expect(termRows()).toContainText(/\[200~badrm.*\[201~/);
});

test('the terminal exposes an accessibility tree for screen readers', async () => {
  await expect(page.locator('.xterm-accessibility')).toHaveCount(1);
});

test('Send selection pastes the selected text as an editable command line', async () => {
  await typeCommand("echo 'echo send-payload-xyz'");
  await expect(termRows()).toContainText('echo send-payload-xyz');

  await selectRowContaining('echo send-payload-xyz');
  await page.locator('#send-selection').click();
  // The selection stays highlighted after Send (§7.5).
  await expect(page.locator('.xterm-decoration').first()).toBeVisible();

  // Pasted at the prompt, not executed (§9.3): the text only runs on a user Enter.
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Enter');
  await expect(
    page.locator('.xterm-rows > div').filter({ hasText: /^\s*send-payload-xyz\s*$/ }),
  ).toHaveCount(1);
});

test('Escape clears an active selection but passes through to the agent otherwise (§7.5.1)', async () => {
  await typeCommand("echo 'esc-target-row'");
  await expect(termRows()).toContainText('esc-target-row');

  // Selection active → Escape clears it and is NOT sent to the shell (§7.5.1).
  await selectRowContaining('esc-target-row');
  await expect(page.locator('.xterm-decoration')).not.toHaveCount(0);
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.xterm-decoration')).toHaveCount(0);

  // No selection → Escape passes through to the shell; cat -v renders the ESC byte as ^[.
  await typeCommand('cat -v');
  await page.keyboard.press('Escape');
  await expect(termRows()).toContainText('^[');
  await page.keyboard.press('Control+D');
});

test('Shift+Enter inserts a newline (ESC+CR) instead of submitting (§7.5.2)', async () => {
  // xterm's default Shift+Enter is a bare CR (no ESC); the rendered ^[ (cat -v) proves our ESC+CR ran.
  await typeCommand('cat -v');
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Shift+Enter');
  await expect(termRows()).toContainText('^[');
  await page.keyboard.press('Control+C');
});

test('Option/Alt+Backspace deletes the whole previous word at the prompt (§7.5.2)', async () => {
  // Word-delete leaves `echo `, so `done` runs as `echo done`; a char-delete or no-op would run
  // `echo foobadone` / `echo foobardone` — distinguishing the discriminating output below.
  await page.locator('.xterm-screen').click();
  await page.keyboard.type('echo foobar');
  await page.keyboard.press('Alt+Backspace');
  await page.keyboard.type('done');
  await page.keyboard.press('Enter');
  await expect(
    page.locator('.xterm-rows > div').filter({ hasText: /^\s*done\s*$/ }),
  ).toHaveCount(1);
});

test('the copy chord writes the terminal selection to the OS clipboard (§7.7)', async () => {
  // On Linux the resolved profile is PC-style → copy is Ctrl+Shift+C (the suite runs on Linux,
  // like the Control+1/2/3 tests). The selection is the app-owned one (§7), set by the drag.
  await typeCommand('echo copyme-12345');
  // Wait for quiescence so the OUTPUT row (not just the echoed command line) has rendered before
  // the exact-row drag-select runs.
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });
  await selectRowContaining('copyme-12345');
  // Focus the terminal (not a click — that would clear the app-owned selection) so the chord's
  // keydown reaches xterm's handler. The selection survives focus changes (§7.0).
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+C');
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
    .toContain('copyme-12345');
});

test('Ctrl+C still interrupts the foreground process — copy never hijacks it (§7.7)', async () => {
  // If Ctrl+C were intercepted as copy, `sleep 30` would keep running and the echo below could
  // not produce its own output row within the assertion timeout. Real SIGINT, end-to-end.
  await page.locator('.xterm-screen').click();
  await page.keyboard.type('sleep 30');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+C');
  await typeCommand('echo aftersigint');
  await expect(page.locator('.xterm-rows > div').filter({ hasText: /^\s*aftersigint\s*$/ })).toHaveCount(1);
});

test('the paste chord routes through our sanitized path, not the unsanitized native paste (§7.7/§9.3)', async () => {
  // The browser's native paste would leak an embedded bracketed-paste END marker straight to the PTY;
  // our handler runs stripPasteBreakout first. `cat -v` visualizes received control bytes (ESC -> ^[),
  // so a leaked marker would render as ^[[201~. The discriminator: our path joins the halves cleanly.
  await typeCommand('cat -v');
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });
  await app.evaluate(({ clipboard }) => clipboard.writeText('AAA\x1b[201~BBB'));
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Control+Shift+V');
  await expect(termRows()).toContainText('AAABBB'); // marker stripped, halves joined
  await expect(termRows()).not.toContainText('201~'); // the breakout never reached the PTY
  await page.keyboard.press('Control+C'); // leave cat
});

test('the select-all chord selects the whole buffer, which is then copyable (§7.7)', async () => {
  await typeCommand('echo selA-marker-one');
  await typeCommand('echo selB-marker-two');
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Control+Shift+A'); // select all (PC profile)
  await page.keyboard.press('Control+Shift+C'); // copy the selection
  const clip = await (async () => {
    let text = '';
    await expect.poll(async () => (text = await app.evaluate(({ clipboard }) => clipboard.readText()))).toContain('selA-marker-one');
    return text;
  })();
  expect(clip).toContain('selB-marker-two'); // both rows are in the whole-buffer selection
});

test('switching the keyboard profile to macOS-style makes Cmd+C copy on Linux (§7.7)', async () => {
  await app.evaluate(({ clipboard }) => clipboard.writeText('sentinel-unchanged'));
  await typeCommand('echo macprofile-7');
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });
  await selectRowContaining('macprofile-7');
  // The default profile on Linux is PC-style, where Meta+C (⌘C) is unbound. Forcing macOS-style via
  // the setting is the only reason ⌘C copies here — so a passing copy proves the switch took effect.
  await page.locator('[data-viewbtn="4"]').click(); // open the Keyboard settings view
  await page.locator('.seg').getByRole('button', { name: 'macOS' }).click();
  await page.locator('[data-viewbtn="1"]').click(); // back to the terminal (selection survives, §7.0)
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Meta+c');
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
    .toContain('macprofile-7');
});

test('rebinding the copy action to a custom chord takes effect (§7.7)', async () => {
  await app.evaluate(({ clipboard }) => clipboard.writeText('sentinel-rebind'));
  await typeCommand('echo rebindme-5');
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });
  await selectRowContaining('rebindme-5');
  // Record a custom copy chord (no profile binds Ctrl+Shift+Y by default). The settings view captures
  // the keypress at the document level, so it never reaches the terminal while recording.
  await page.locator('[data-viewbtn="4"]').click(); // open the Keyboard settings view
  await page.locator('[data-action="copy"] button').click();
  await page.keyboard.press('Control+Shift+Y');
  // The recorded chord now copies the (still-active) selection from the terminal.
  await page.locator('[data-viewbtn="1"]').click(); // back to the terminal (selection survives, §7.0)
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+Y');
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
    .toContain('rebindme-5');
});

test('the drawer toggles on Ctrl+Shift+K; bare Ctrl+K is left to the terminal as kill-line (§7.7)', async () => {
  const appEl = page.locator('#app');
  const isOpen = () => appEl.evaluate((el) => el.classList.contains('drawer-open'));
  await page.locator('.xterm-screen').click();
  const before = await isOpen();
  await page.keyboard.press('Control+K'); // readline kill-line — must NOT toggle the drawer
  expect(await isOpen()).toBe(before);
  await page.keyboard.press('Control+Shift+K'); // the PC-profile drawer chord
  expect(await isOpen()).toBe(!before);
});

test('the Keyboard settings view opens from the gear and Ctrl+,, rebinds live, and blocks conflicts (§7.7)', async () => {
  // Opens from the rail gear → view 4.
  await page.locator('[data-viewbtn="4"]').click();
  await expect(page.locator('[data-viewpane="4"]')).toBeVisible();
  await expect(page.locator('#kb-settings-view')).toContainText('Keyboard');
  await expect(page.locator('#kb-settings-view')).toContainText('Clipboard');

  // Return to the terminal, then reopen via the keyboard chord (Linux → PC profile → Ctrl+,).
  await page.locator('[data-viewbtn="1"]').click();
  await expect(page.locator('[data-viewpane="4"]')).toBeHidden();
  await page.keyboard.press('Control+Comma');
  await expect(page.locator('[data-viewpane="4"]')).toBeVisible();

  // Rebind "Word left" to Ctrl+Shift+B — its keycaps update live.
  const wordBack = page.locator('[data-action="wordBack"]');
  await wordBack.getByRole('button', { name: /record a new shortcut/i }).click();
  await expect(wordBack.locator('.kcapture')).toBeVisible();
  await page.keyboard.press('Control+Shift+B');
  await expect(wordBack.locator('.kc')).toHaveText(['Ctrl', 'Shift', 'B']);

  // Recording Copy's chord (Ctrl+Shift+C) for Paste is blocked and named — no rebind happens.
  const paste = page.locator('[data-action="paste"]');
  await paste.getByRole('button', { name: /record a new shortcut/i }).click();
  await page.keyboard.press('Control+Shift+C');
  await expect(paste.locator('.kcapture.bad')).toContainText('already maps to Copy');
});

test('a todo persists in-repo across an app restart (§16.3)', async () => {
  await cdToTempDir('persist');
  await typeCommand("echo 'persist-this-todo'");
  await expect(termRows()).toContainText('persist-this-todo');
  await selectRowContaining('persist-this-todo');
  await page.locator('#capture-selection').click();
  await page.locator('#tab-todo').click();
  await expect(page.locator('.todo').filter({ hasText: 'persist-this-todo' })).toHaveCount(1);

  // Across a full restart, the in-repo todos.json is reread when the agent cd's back (§16.3).
  await app.close();
  app = await electron.launch({ args: launchArgs(), env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await cdToTempDir('persist');
  await openQuickSend('todo'); // the drawer starts closed after a restart (§22.2)
  await expect(page.locator('.todo').filter({ hasText: 'persist-this-todo' })).toHaveCount(1);
});

test('monitor status strip tracks quiescence and alt-screen', async () => {
  const agentChip = page.locator('.status-chip[data-status="agent"]');
  const fsChip = page.locator('.status-chip[data-status="full-screen"]');

  // A single echo can flip working→quiet inside one poll cycle. Burst over ~1s at 0.2s cadence (under
  // QUIET_MS 1000) so "working" is reliably observable before it quiesces.
  await typeCommand('for i in 1 2 3 4 5; do echo burst; sleep 0.2; done');
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

// ---- §15: semantic capture & detection (rendered as mockup-exact .finding cards) ----

test('a printed Claude-style permission box produces no semantic capture card (v2.6)', async () => {
  await typeCommand(
    "printf '%s\\n' '╭──────────────────────────────╮' '│ Do you want to proceed?      │' '│ ❯ 1. Yes                     │' '│   2. No                      │' '╰──────────────────────────────╯'",
  );
  await expect(termRows()).toContainText('Do you want to proceed?');
  // Permission/question detection was removed (v2.6): a box is chrome, so capture surfaces no finding.
  await clickCaptureLast();
  await expect(page.locator('#monitor-blocks .finding')).toHaveCount(0);
});

test('boring commands produce zero agent-semantic captures (§15.8 budget)', async () => {
  await typeCommand('ls /');
  await typeCommand('echo boring-done');
  await expect(termRows()).toContainText('boring-done');
  await clickCaptureLast();
  await expect(page.locator('#monitor-blocks .finding')).toHaveCount(0);
});

test('a captured report (with findings) survives a monitor reload (capture:last→store→replay)', async () => {
  // APP_SHELL_INTEGRATION=0: no command spans, so the report surfaces deterministically (no
  // span-gating race) and the capture:last→store→replay path runs end-to-end.
  await app.close();
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_SHELL_INTEGRATION: '0' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await openQuickSend('capture'); // the drawer starts closed after a relaunch (§22.2)

  await typeCommand(
    "printf '%s\\n' 'Here is the summary of findings from this code review:' '- one important finding worth acting on' '- another finding to address before merge'",
  );
  await expect(termRows()).toContainText('another finding to address before merge');
  await clickCaptureLast();
  const findings = page.locator('#monitor-blocks .finding');
  await expect(findings.first()).toBeVisible({ timeout: 10_000 });
  expect(await findings.count()).toBeGreaterThan(0);

  // The single captured report is stored, so a reloaded pane replays it without a re-click (§21.1).
  await page.reload();
  await openQuickSend('capture'); // reload resets the drawer to closed (§22.2)
  await expect(page.locator('#monitor-blocks .finding').first()).toBeVisible();
});

test('captures the visible report on the alternate screen buffer (full-screen agent, §13.4)', async () => {
  // Claude Code 2.x draws full-screen on the alternate screen buffer, where capture was previously
  // inert (§15.9). On-demand "Capture last report" must read the visible alt frame. INTEGRATION=0 so
  // the printed report surfaces deterministically (no span-gating race), as in the replay test.
  await app.close();
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_SHELL_INTEGRATION: '0' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await openQuickSend('capture'); // the drawer starts closed after a relaunch (§22.2)

  // Enter the alternate screen, then print the report onto it. The status strip confirms the
  // full-screen regime — the one where capture used to return nothing.
  await typeCommand('printf "\\x1b[?1049h"');
  await expect(page.locator('.status-chip[data-status="full-screen"]')).toContainText('yes');
  await typeCommand(
    "printf '%s\\n' 'Here is the summary of findings from this code review:' '- one important finding worth acting on' '- another finding to address before merge'",
  );
  await expect(termRows()).toContainText('another finding to address before merge');

  await clickCaptureLast();
  const findings = page.locator('#monitor-blocks .finding');
  await expect(findings.first()).toBeVisible({ timeout: 10_000 });
  expect(await findings.count()).toBeGreaterThan(0);
});

test('native selection + copy work on the alternate screen buffer (§7.4)', async () => {
  // On the alt buffer registerMarker/registerDecoration return undefined, so the app-owned
  // PERSISTENT highlight + cross-highlight reveal are unavailable (§7.4, accepted). But the drag
  // gesture, text extraction, and copy all ride xterm's native selection, which is buffer-agnostic
  // — so "select and capture" still works. If getSelection() threw on the alt buffer (the §7.3
  // risk), onSelectionChange would bail and the app-owned model would stay empty, so copy would
  // write nothing and this poll would time out.
  await typeCommand('printf "\\x1b[?1049h"; echo altcopy-98765');
  await expect(page.locator('.status-chip[data-status="full-screen"]')).toContainText('yes');
  await expect(termRows()).toContainText('altcopy-98765');
  await selectRowContaining('altcopy-98765');
  // Focus the terminal (not a click — that would clear the app-owned selection) so the copy chord
  // reaches xterm's handler. The auto profile resolves from the running platform: ⌘C on macOS,
  // Ctrl+Shift+C on the Linux CI (§7.7).
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+Shift+C');
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
    .toContain('altcopy-98765');
});

test('the terminal scrollbar gutter matches the terminal background — no contrasting strip (§7.1)', async () => {
  // xterm paints the viewport (scrollbar gutter included) with its inline theme background; left at
  // xterm's #000 default it shows as a black strip a full-screen agent (alt buffer, no scrollback) can't
  // cover, against the themed --term-bg pane. terminal.ts seeds the theme background from --term-bg so
  // the gutter is the same colour as the terminal. Asserted via computed style (no PTY input needed) so
  // the fix itself is under test, not the shell.
  const viewportBg = await page
    .locator('#terminal .xterm-viewport')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const paneBg = await page
    .locator('#terminal-view')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(viewportBg).toBe(paneBg);
  expect(viewportBg).not.toBe('rgb(0, 0, 0)'); // not xterm's hardcoded-black default
});

test('the scrollbar gutter re-matches the terminal background after a live theme toggle (§7.1/§7.4)', async () => {
  // The gutter fill is xterm's inline theme background, seeded once at construction; --term-bg differs
  // per theme, so without re-seeding on the #tg toggle the strip would reappear one theme behind. Drives
  // the real renderer theme toggle (no PTY input) and re-asserts the gutter tracks the pane in the new
  // theme. Keyed off data-theme (the toggle's direct effect), not a pre-click bg snapshot, so the startup
  // persisted-theme load can't race the assertion.
  const viewportBg = () =>
    page.locator('#terminal .xterm-viewport').evaluate((el) => getComputedStyle(el).backgroundColor);
  const paneBg = () =>
    page.locator('#terminal-view').evaluate((el) => getComputedStyle(el).backgroundColor);
  const themeAttr = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));

  const start = await themeAttr();
  await page.locator('#tg').click();
  await expect.poll(themeAttr).not.toBe(start); // the toggle landed (theme genuinely changed)
  expect(await viewportBg()).toBe(await paneBg()); // gutter re-matched the pane in the new theme
  await page.locator('#tg').click(); // restore the starting theme for later tests
});

test('dragging a file over the terminal shows a drop-target affordance (§7.8)', async () => {
  // Slice 3: the drag affordance drives the real renderer wiring with no PTY input. Without the §7.8
  // handler the class never appears.
  const terminal = page.locator('#terminal');
  await expect(terminal).not.toHaveClass(/drag-over/);
  await terminal.dispatchEvent('dragenter');
  await expect(terminal).toHaveClass(/drag-over/);
  await terminal.dispatchEvent('dragleave');
  await expect(terminal).not.toHaveClass(/drag-over/);
});

test('dropping a file pastes its single-quoted path at the prompt, no submit (§7.8)', async () => {
  // Slices 1–2: a real File carrying an OS path (so the preload webUtils bridge resolves it) is obtained
  // via a hidden <input>, then dispatched as a native drop onto #terminal. The §7.8 handler pastes the
  // single-quoted path through term.paste(), which the shell echoes at the prompt (no Enter → not run).
  const tmpDir = mkdtempSync(join(tmpdir(), 'agent-term-drop-'));
  const dropped = join(tmpDir, 'shot.png');
  writeFileSync(dropped, 'x');

  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'e2e-drop-input';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
  });
  await page.locator('#e2e-drop-input').setInputFiles(dropped);
  await page.locator('#terminal .xterm-screen').click(); // prompt focus, so the pasted path lands there

  await page.evaluate(() => {
    const input = document.getElementById('e2e-drop-input') as HTMLInputElement;
    const dt = new DataTransfer();
    for (const f of Array.from(input.files ?? [])) dt.items.add(f);
    document
      .getElementById('terminal')!
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });

  await expect(termRows()).toContainText(`'${dropped}'`);
  rmSync(tmpDir, { recursive: true, force: true });
});

test('capture ↔ terminal cross-highlight: double-click reveals each side (§16.8)', async () => {
  // APP_SHELL_INTEGRATION=0 so the printed report surfaces deterministically (as in the replay test).
  await app.close();
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_SHELL_INTEGRATION: '0' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await openQuickSend('capture'); // the drawer starts closed after a relaunch (§22.2)

  // Feed the report through base64 so the finding phrases appear ONLY in the command's OUTPUT, not
  // its echoed input: with integration off the scanner captures the echo region too, so a literal
  // phrase would match twice (echo + output) and a terminal double-click could land on the echo.
  const reportB64 =
    'SGVyZSBpcyB0aGUgY3Jvc3MtaGlnaGxpZ2h0IHN1bW1hcnkgb2YgZmluZGluZ3MgYmVsb3c6Ci0gY3Jvc3MtaGlnaGxpZ2h0IGZpbmRpbmcgb25lIHdvcnRoIGFjdGluZyBvbiBub3cKLSBjcm9zcy1oaWdobGlnaHQgZmluZGluZyB0d28gdG8gYWRkcmVzcyBiZWZvcmUgbWVyZ2UK';
  await typeCommand(`echo '${reportB64}' | base64 -d`);
  await expect(termRows()).toContainText('finding two to address before merge');
  await clickCaptureLast();

  // Each list item splits into an individually-actionable .finding card; the report blob itself is
  // never a card (§24.1).
  const findingOne = page.locator('#monitor-blocks .finding', { hasText: 'finding one worth acting on now' });
  const findingTwo = page.locator('#monitor-blocks .finding', { hasText: 'finding two to address before merge' });
  await expect(findingOne).toHaveCount(1, { timeout: 10_000 });
  await expect(findingTwo).toHaveCount(1);

  // Capture → terminal: revealing a single finding decorates only that chunk's rows — a class
  // distinct from the selection decoration (§16.8).
  await findingOne.dblclick();
  await expect(page.locator('.xterm-decoration.reveal-highlight').first()).toBeVisible();

  // Terminal → capture: a word on that finding's row reveals the specific chunk, not the whole report.
  const rowIdx = await findRowIndex('- cross-highlight finding one worth acting on now');
  expect(rowIdx).toBeGreaterThanOrEqual(0);
  await page.locator('.xterm-rows > div').nth(rowIdx).dblclick();
  await expect(findingOne).toHaveClass(/revealed/);

  // Regression guard (§16.8): capture spans are anchored to xterm markers, which move with their
  // lines through reflow, so scan-time absolute rows can't go stale and mis-target. Narrowing the
  // window re-wraps the echoed input and pushes output findings to new absolute rows; re-running
  // terminal → capture against finding TWO would hit the wrong chunk under a stale-row mapping.
  await expect(findingOne).not.toHaveClass(/revealed/, { timeout: 12_000 }); // let the prior reveal self-clear
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 600));
  // Reflow keeps shifting rows over the 80 ms debounce and one dblclick can land between rows
  // mid-reflow — so retry find→dblclick→reveal as a unit until finding TWO's chunk resolves.
  await expect
    .poll(
      async () => {
        const r = await findRowIndexContaining('finding two');
        if (r < 0) return false;
        await page.locator('.xterm-rows > div').nth(r).dblclick();
        return ((await findingTwo.getAttribute('class')) ?? '').includes('revealed');
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(findingOne).not.toHaveClass(/revealed/); // mapped to TWO's chunk, not the whole report
});

// ---- §16: action window — todo lists, focus rule, layout ----

test('only the active tab’s panel is visible (§16.1)', async () => {
  const capture = page.locator('#panel-capture');
  const todo = page.locator('#panel-todo');

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
  const todo = (text: string) => page.locator('.todo').filter({ hasText: text });

  await cdToTempDir('repoA');
  await typeCommand("echo 'A-side todo'");
  await expect(termRows()).toContainText('A-side todo');
  await selectRowContaining('A-side todo');
  await page.locator('#capture-selection').click();
  await page.locator('#tab-todo').click();
  await expect(todo('A-side todo')).toHaveCount(1);

  // cd elsewhere → the list swaps to that dir's (empty) list (§16.3).
  await cdToTempDir('repoB');
  await expect(todo('A-side todo')).toHaveCount(0);

  // cd back → A's todo returns, reread from its repo-local store (§16.3).
  await typeCommand('cd "/tmp/agent-term-e2e-repoA"');
  await expect(todo('A-side todo')).toHaveCount(1);
});

// ---- §24.2.1: restored todo-panel functionality (manual add, reorder, two-step delete) ----

test('a manually-added todo persists across a reload (§24.2.1 manual add)', async () => {
  await cdToTempDir('manualadd');
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('hand-written e2e todo');
  await page.locator('#todo-add-btn').click();
  const row = page.locator('.todo').filter({ hasText: 'hand-written e2e todo' });
  await expect(row).toHaveCount(1);

  // Persisted to the repo's todos.json, so a reloaded pane re-pulls it (§24.2.1).
  await page.reload();
  await openQuickSend('todo');
  await expect(page.locator('.todo').filter({ hasText: 'hand-written e2e todo' })).toHaveCount(1);
});

test('two-step delete: Confirm then Undo keeps the todo, no server delete (§24.2.1)', async () => {
  await cdToTempDir('deltodo');
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('delete-me-e2e');
  await page.locator('#todo-add-btn').click();
  const row = page.locator('.todo').filter({ hasText: 'delete-me-e2e' });
  await expect(row).toHaveCount(1);

  await row.getByRole('button', { name: 'Delete todo' }).click();
  await page.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.locator('.todo-undo')).toBeVisible();
  await page.locator('.todo-undo').click();
  await expect(page.locator('.todo').filter({ hasText: 'delete-me-e2e' })).toHaveCount(1);

  // The reverted delete never reached the store, so a reload still shows it (§24.2.1).
  await page.reload();
  await openQuickSend('todo');
  await expect(page.locator('.todo').filter({ hasText: 'delete-me-e2e' })).toHaveCount(1);
});

test('reorder: Move down swaps two todos and the new order persists (§24.2.1)', async () => {
  await cdToTempDir('reorder');
  await page.locator('#tab-todo').click();
  const add = async (t: string) => {
    await page.locator('#todo-new').fill(t);
    await page.locator('#todo-add-btn').click();
    await expect(page.locator('.todo').filter({ hasText: t })).toHaveCount(1);
  };
  await add('reorder-first-e2e');
  await add('reorder-second-e2e');

  const texts = () => page.locator('#panel-todo .todos .todo .tx').allInnerTexts();
  expect(await texts()).toEqual(['reorder-first-e2e', 'reorder-second-e2e']);

  await page.locator('.todo').filter({ hasText: 'reorder-first-e2e' }).getByRole('button', { name: 'Move down' }).click();
  await expect.poll(texts).toEqual(['reorder-second-e2e', 'reorder-first-e2e']);

  // Persisted to todos.json, so the swapped order survives a reload (§24.2.1).
  await page.reload();
  await openQuickSend('todo');
  await expect.poll(texts).toEqual(['reorder-second-e2e', 'reorder-first-e2e']);
});

test('tri-state: Send marks a todo in-progress (mixed), then the checkbox cycles it to done (§16.3)', async () => {
  await cdToTempDir('tristate');
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('tri-state-e2e');
  await page.locator('#todo-add-btn').click();
  const row = page.locator('.todo').filter({ hasText: 'tri-state-e2e' });
  const chk = row.locator('.chk');
  await expect(chk).toHaveAttribute('aria-checked', 'false'); // not started

  // Send marks the todo in_progress → the checkbox renders mixed (§16.3).
  await row.getByRole('button', { name: 'Send todo to agent' }).click();
  await page.locator('#tab-todo').click(); // Send revealed the terminal view — return to the list
  await expect(chk).toHaveAttribute('aria-checked', 'mixed');

  // A checkbox click on an in-progress todo completes it, persisted (§16.3).
  await chk.click();
  await expect(chk).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await openQuickSend('todo');
  await expect(page.locator('.todo').filter({ hasText: 'tri-state-e2e' }).locator('.chk')).toHaveAttribute('aria-checked', 'true');
});

// ---- §24.1C: the converged three-view shell (views, docked drawer, theme) ----

test('switches views via hotkey and nav button, showing one pane at a time (§22.4)', async () => {
  const v1 = page.locator('[data-viewpane="1"]');
  const v3 = page.locator('[data-viewpane="3"]');
  await expect(v1).toBeVisible();
  await expect(v3).toBeHidden();

  await page.keyboard.press('Control+3');
  await expect(v3).toBeVisible();
  await expect(v1).toBeHidden();
  await expect(page.locator('[data-viewbtn="3"]')).toHaveClass(/on/);

  await page.locator('[data-viewbtn="1"]').click();
  await expect(v1).toBeVisible();
  await expect(v3).toBeHidden();
});

test('switching to the terminal view focuses it, so the keyboard lands there to keep typing (§22.4)', async () => {
  await page.keyboard.press('Control+3');
  await expect(page.locator('[data-viewpane="3"]')).toBeVisible();
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused();

  await page.keyboard.press('Control+1');
  await expect(page.locator('[data-viewpane="1"]')).toBeVisible();
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
});

test('Send from a todo reveals + focuses the terminal so you can finish typing there (§16.2/§22.4)', async () => {
  await cdToTempDir('sendfocus');
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('send-focus-e2e');
  await page.locator('#todo-add-btn').click();
  const row = page.locator('.todo').filter({ hasText: 'send-focus-e2e' });
  await expect(row).toHaveCount(1);

  // Park on another view so a naive focus() would land on the hidden terminal (§22.4 guard).
  await page.keyboard.press('Control+2');
  await expect(page.locator('[data-viewpane="2"]')).toBeVisible();
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused();

  // Send injects without submitting (§16.2), reveals the terminal view, and focuses it (§22.4).
  await row.getByRole('button', { name: 'Send todo to agent' }).click();
  await expect(page.locator('[data-viewpane="1"]')).toBeVisible();
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await expect(termRows()).toContainText('send-focus-e2e'); // injected at the prompt, not run
});

test('switching to the Artifacts view focuses the file tree for immediate keyboard nav (§22.4)', async () => {
  const dir = '/tmp/agent-term-e2e-artfocus';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}" && cd "${dir}" && git init -q && ` +
      `git config user.email t@t && git config user.name T && printf 'x\\n' > a.md && ` +
      `git add -A && git commit -qm init && printf 'more\\n' >> a.md && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  // Discovery is async, so the first visit has nothing for focus to land on yet.
  await page.keyboard.press('Control+2');
  await expect(page.locator('#artifacts .tree .f').filter({ hasText: 'a.md' })).toHaveCount(1);

  // Returning once the tree is loaded must land focus on it, not nowhere (§22.4).
  await page.keyboard.press('Control+1');
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.press('Control+2');
  await expect(page.locator('#artifacts [role="treeitem"]').first()).toBeFocused();
});

test('the artifact viewer discovers real repo files and sends a selection to a todo (§20.1/§20.2)', async () => {
  // doc.md is edited after commit (curated/changed); src/app.ts is committed-unchanged (whole-repo
  // only) — the two cases the curated-vs-all discovery distinction turns on (§20.1).
  const dir = '/tmp/agent-term-e2e-artrepo';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}/src" && cd "${dir}" && git init -q && ` +
      `git config user.email t@t && git config user.name T && ` +
      `printf '# Doc\\n\\nThe scanner carves tool calls.\\n' > doc.md && ` +
      `printf 'export const QUIET = 1;\\n' > src/app.ts && ` +
      `git add -A && git commit -qm init && printf 'more\\n' >> doc.md && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  await expect(page.locator('[data-viewpane="2"]')).toBeVisible();

  // Curated discovery (§20.1): the working-tree change is listed; the committed-unchanged file is not.
  const tree = page.locator('#artifacts .tree');
  await expect(tree.locator('.f').filter({ hasText: 'doc.md' })).toHaveCount(1);
  await expect(tree.locator('.f').filter({ hasText: 'app.ts' })).toHaveCount(0);
  await expect(tree.locator('.f').filter({ hasText: 'doc.md' })).toContainText('changed');

  // A passage selected in the rendered markdown routes to the todo list (§16.2 sink).
  const body = page.locator('#artifacts .vbody');
  await tree.locator('.f').filter({ hasText: 'doc.md' }).click();
  await expect(body.locator('h1')).toContainText('Doc');
  await body.locator('p').filter({ hasText: 'carves tool calls' }).selectText();
  await page.locator('#artifacts .art-todo').click();
  await page.locator('#tab-todo').click();
  await expect(page.locator('.todo').filter({ hasText: 'The scanner carves tool calls' })).toHaveCount(1);

  // The whole-repo scope reveals the committed file; code renders in CodeMirror (§20.1/§20.2).
  await page.locator('#artifacts .scope-toggle input').check();
  const appRow = tree.locator('.f').filter({ hasText: 'app.ts' });
  await expect(appRow).toHaveCount(1);
  await appRow.click();
  await expect(body.locator('.cm-editor')).toBeVisible();
  await expect(body.locator('.cm-editor')).toContainText('QUIET');
});

test('the viewer starts in sync with the terminal cwd, before any cd (§20.1)', async () => {
  // bash spawns in $HOME (§5/§20.1): the viewer must discover there from the first paint, not in the
  // Electron process dir — so a marker placed in a controlled HOME must show with no cd.
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-home-'));
  writeFileSync(join(home, 'home-marker.md'), '# Home marker\n');
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await page.keyboard.press('Control+2');
  await expect(page.locator('[data-viewpane="2"]')).toBeVisible();
  const tree = page.locator('#artifacts .tree');
  await expect(tree.locator('.f').filter({ hasText: 'home-marker.md' })).toHaveCount(1);
  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(home, { recursive: true, force: true });
});

test('outside a git repo the viewer shows the whole cwd tree (§20.1)', async () => {
  const dir = '/tmp/agent-term-e2e-plaindir';
  await typeCommand(`rm -rf "${dir}" && mkdir -p "${dir}" && cd "${dir}" && printf 'hello\\n' > scratch.md && pwd`);
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  const tree = page.locator('#artifacts .tree');
  await expect(tree.locator('.f').filter({ hasText: 'scratch.md' })).toHaveCount(1);
  // No curated/whole-repo distinction outside a repo — the scope toggle is hidden.
  await expect(page.locator('#artifacts .scope-toggle')).toBeHidden();
});

test('file names are rendered in full, not truncated with an ellipsis (§20.2)', async () => {
  const dir = '/tmp/agent-term-e2e-longname';
  const longName = 'a-really-extremely-long-artifact-file-name-that-exceeds-the-tree-pane-width.md';
  await typeCommand(`rm -rf "${dir}" && mkdir -p "${dir}" && cd "${dir}" && git init -q && printf 'x\\n' > "${longName}" && pwd`);
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  const fn = page.locator('#artifacts .treelist .f .fn').first();
  await expect(fn).toHaveText(longName);
  // scrollWidth ≈ clientWidth ⇒ nothing clipped behind an ellipsis (§20.2).
  const clipped = await fn.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(clipped).toBeLessThanOrEqual(1);
});

test('the code viewer marks changed lines with a gutter stripe and a line tint (§20.2)', async () => {
  // Only line 2 is modified post-commit: the viewer must mark it at its current-file position, not
  // as a diff (§20.2).
  const dir = '/tmp/agent-term-e2e-changedlines';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}/src" && cd "${dir}" && git init -q && ` +
      `git config user.email t@t && git config user.name T && ` +
      `printf 'const a = 1;\\nconst b = 2;\\nconst c = 3;\\n' > src/app.ts && ` +
      `git add -A && git commit -qm init && ` +
      `printf 'const a = 1;\\nconst b = 99;\\nconst c = 3;\\n' > src/app.ts && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  const row = page.locator('#artifacts .tree .f').filter({ hasText: 'app.ts' });
  await expect(row).toHaveCount(1);
  await row.click();
  const body = page.locator('#artifacts .vbody');
  await expect(body.locator('.cm-editor')).toBeVisible();
  await expect(body.locator('.cm-editor')).toContainText('99');
  // Only line 2 changed → exactly one tinted line and one gutter stripe.
  await expect(body.locator('.cm-changedLine')).toHaveCount(1);
  await expect(body.locator('.cm-changedGutter')).toHaveCount(1);
});

test('the viewer gates the sinks on a selection and steps through changed sections (§20.2)', async () => {
  // Two far-apart edits (lines 2 and 180) in a 200-line file: change 2 is off-screen at open, so the
  // readout/controls must follow the viewport, not a static index (§20.2).
  const dir = '/tmp/agent-term-e2e-changenav';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}/src" && cd "${dir}" && git init -q && ` +
      `git config user.email t@t && git config user.name T && ` +
      `seq 1 200 | sed 's|.*|// line &|' > src/app.ts && ` +
      `git add -A && git commit -qm init && ` +
      `sed -i '2s/$/ EDIT2/; 180s/$/ EDIT180/' src/app.ts && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  const row = page.locator('#artifacts .tree .f').filter({ hasText: 'app.ts' });
  await expect(row).toHaveCount(1);
  await row.click();
  const body = page.locator('#artifacts .vbody');
  await expect(body.locator('.cm-editor')).toBeVisible();

  // The sinks gate on a selection: disabled with nothing highlighted, enabled once a passage is selected.
  const send = page.locator('#artifacts .art-send');
  const todo = page.locator('#artifacts .art-todo');
  await expect(send).toBeDisabled();
  await expect(todo).toBeDisabled();

  // Open at the top → only change 1 on screen; change 2 (line 180) is below the fold.
  const count = page.locator('#artifacts .art-navcount');
  const prev = page.locator('#artifacts .art-prev');
  const next = page.locator('#artifacts .art-next');
  await expect(count).toHaveText('1 / 2');
  await expect(prev).toBeDisabled();
  await expect(next).toBeEnabled();

  await body.locator('.cm-line').filter({ hasText: 'EDIT2' }).selectText();
  await expect(send).toBeEnabled();
  await expect(todo).toBeEnabled();

  // Next jumps to the off-screen change → readout follows the viewport, boundaries flip (§20.2).
  await next.click();
  await expect(count).toHaveText('2 / 2');
  await expect(next).toBeDisabled();
  await expect(prev).toBeEnabled();
  await prev.click();
  await expect(count).toHaveText('1 / 2');
});

test('the viewer has a keyboard-accessible full-screen mode (§20.2)', async () => {
  const dir = '/tmp/agent-term-e2e-fullscreen';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}" && cd "${dir}" && git init -q && ` +
      `printf '# Doc\\n\\nbody\\n' > doc.md && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  const appEl = page.locator('#app');
  const rail = page.locator('#app .rail');
  const drawer = page.locator('#app #drawer');
  await expect(rail).toBeVisible();

  // Full screen hides all app chrome and collapses (inert) the header + tree (§20.2).
  const vbar = page.locator('#artifacts .vbar');
  const treePanel = page.locator('#artifacts .tree');
  await page.locator('#artifacts .art-fs').click();
  await expect(appEl).toHaveClass(/viewer-fullscreen/);
  await expect(rail).toBeHidden();
  await expect(drawer).toBeHidden();
  await expect(vbar).toHaveClass(/is-collapsed/);
  await expect(treePanel).toHaveClass(/is-collapsed/);

  // The edge strips pop the collapsed header and tree open.
  await page.locator('#artifacts .fs-strip-top').click();
  await expect(vbar).not.toHaveClass(/is-collapsed/);
  await page.locator('#artifacts .fs-strip-left').click();
  await expect(treePanel).not.toHaveClass(/is-collapsed/);

  await page.keyboard.press('Escape');
  await expect(appEl).not.toHaveClass(/viewer-fullscreen/);
  await expect(rail).toBeVisible();

  // Keyboard path (§20.2 a11y): on entering, focus lands on the top strip, so Enter there must pop
  // the header open — the whole flow must be reachable with no pointer.
  await page.locator('#artifacts .art-fs').focus();
  await page.keyboard.press('Enter');
  await expect(appEl).toHaveClass(/viewer-fullscreen/);
  await page.keyboard.press('Enter'); // top strip is focused → opens the header
  await expect(vbar).not.toHaveClass(/is-collapsed/);
  await page.locator('#artifacts .art-fs').click(); // the in-header exit control
  await expect(appEl).not.toHaveClass(/viewer-fullscreen/);
});

test('the viewer is keyboard-focusable and scrollable (§20.2 a11y)', async () => {
  // Tall markdown + tall code files so both scroll containers actually overflow.
  const dir = '/tmp/agent-term-e2e-a11yscroll';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}/src" && cd "${dir}" && git init -q && ` +
      `{ echo '# Doc'; for i in $(seq 1 300); do echo "para line $i"; done; } > doc.md && ` +
      `seq 1 300 | sed 's|.*|// line &|' > src/app.ts && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  const tree = page.locator('#artifacts .tree');
  const body = page.locator('#artifacts .vbody');

  // Markdown: the body itself is the focusable scroll region (§20.2 a11y).
  await tree.locator('.f').filter({ hasText: 'doc.md' }).click();
  await expect(body.locator('p').first()).toBeVisible();
  expect(await body.evaluate((e) => (e as HTMLElement).tabIndex)).toBe(0);
  await body.focus();
  expect(await body.evaluate((e) => document.activeElement === e)).toBe(true);
  await page.keyboard.press('End');
  await expect.poll(() => body.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);

  // Code: the editor's scroller is the focusable scroll region (§20.2 a11y).
  await page.locator('#artifacts .scope-toggle input').check();
  await tree.locator('.f').filter({ hasText: 'app.ts' }).click();
  const scroller = page.locator('#artifacts .cm-scroller');
  await expect(scroller).toBeVisible();
  expect(await scroller.evaluate((e) => (e as HTMLElement).tabIndex)).toBe(0);
  await scroller.focus();
  await page.keyboard.press('End');
  await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
});

test('the full-screen tree popout is resizable and remembers its width (§20.2)', async () => {
  const dir = '/tmp/agent-term-e2e-fspopout';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}" && cd "${dir}" && git init -q && printf '# Doc\\n' > doc.md && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  const split = page.locator('#artifacts .artsplit');
  const fsW = () => split.evaluate((e) => parseFloat((e as HTMLElement).style.getPropertyValue('--tree-w-fs')));
  const enterAndOpenTree = async (): Promise<void> => {
    await page.keyboard.press('Control+2');
    await page.locator('#artifacts .art-fs').click();
    await expect(page.locator('#app')).toHaveClass(/viewer-fullscreen/);
    await page.locator('#artifacts .fs-strip-left').click();
    await expect(page.locator('#artifacts .tree')).not.toHaveClass(/is-collapsed/);
  };

  await enterAndOpenTree();
  const before = await fsW();
  expect(before).toBeGreaterThanOrEqual(0.3 * (await page.evaluate(() => window.innerWidth))); // ≥30% default

  // Re-read the handle box per drag — it moves with the width it sets.
  const handle = page.locator('#artifacts .fs-tree-resize');
  const dragHandleBy = async (dx: number): Promise<void> => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
  };

  // The start width may sit at the viewport-dependent ceiling (clamped to FS_MAX_VIEWPORT_FRAC ×
  // innerWidth), leaving a rightward drag no room to grow — so shrink to a known-narrower baseline
  // first, then assert the rightward drag widens it from there.
  await dragHandleBy(-200);
  await expect.poll(fsW).toBeLessThan(before);
  const narrow = await fsW();

  await dragHandleBy(120);
  await expect.poll(fsW).toBeGreaterThan(narrow + 50);
  const resized = await fsW();

  // The width survives a renderer reload (persisted, §20.2).
  await page.keyboard.press('Escape');
  await page.reload();
  await enterAndOpenTree();
  await expect.poll(fsW).toBeGreaterThan(resized - 8);
});

test('full-screen collapse keeps the header and tree out of the tab order (§22.2)', async () => {
  const dir = '/tmp/agent-term-e2e-fsinert';
  await typeCommand(`rm -rf "${dir}" && mkdir -p "${dir}" && cd "${dir}" && git init -q && printf '# Doc\\n' > doc.md && pwd`);
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  await page.locator('#artifacts .art-fs').click();
  // Collapsed (slid-off) chrome is inert — its controls can't be tab-focused (§22.2).
  await expect.poll(() => canFocus('#artifacts .art-fs')).toBe(false);
  await expect.poll(() => canFocus('#artifacts .treesearch')).toBe(false);
  // Popping a panel open makes its controls reachable again.
  await page.locator('#artifacts .fs-strip-top').click();
  expect(await canFocus('#artifacts .art-fs')).toBe(true);
  await page.locator('#artifacts .fs-strip-left').click();
  expect(await canFocus('#artifacts .treesearch')).toBe(true);
});

test('the quick-send drawer is closed on startup and inert while closed (§22.2)', async () => {
  // beforeEach opens the drawer, so relaunch a fresh app to observe the real startup default (§22.2).
  await app.close();
  app = await electron.launch({ args: launchArgs(), env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const appEl = page.locator('#app');
  await expect(appEl).not.toHaveClass(/drawer-open/);
  await expect(page.locator('#drawer')).toBeHidden();
  expect(await canFocus('#tab-capture')).toBe(false);     // closed → controls out of the tab order (§22.2)
  await page.locator('#qs').click();
  await expect(appEl).toHaveClass(/drawer-open/);
  expect(await canFocus('#tab-capture')).toBe(true);
});

test('the changed-section controls leave the tab order when the file has no changes (§22.2)', async () => {
  const dir = '/tmp/agent-term-e2e-navinert';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}/src" && cd "${dir}" && git init -q && ` +
      `git config user.email t@t && git config user.name T && ` +
      `printf 'const a=1;\\nconst b=2;\\nconst c=3;\\n' > src/app.ts && git add -A && git commit -qm init && ` +
      `printf 'const a=1;\\nconst b=99;\\nconst c=3;\\n' > src/app.ts && printf '# Doc\\n' > doc.md && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  const tree = page.locator('#artifacts .tree');
  // Markdown has no changed sections → the nav controls hide and leave the tab order (§22.2).
  await tree.locator('.f').filter({ hasText: 'doc.md' }).click();
  await expect(page.locator('#artifacts .vnav')).toBeHidden();
  expect(await canFocus('#artifacts .art-prev')).toBe(false);
  // A changed code file shows the controls again.
  await tree.locator('.f').filter({ hasText: 'app.ts' }).click();
  await expect(page.locator('#artifacts .vnav')).toBeVisible();
});

test('the artifact tree pane is resizable by dragging its edge, and the width persists (§20.2)', async () => {
  await page.keyboard.press('Control+2');
  await expect(page.locator('[data-viewpane="2"]')).toBeVisible();
  const treeW = () => page.locator('#artifacts .artsplit').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--tree-w'));

  const div = page.locator('#artifacts .artsplit-divider');
  const box = (await div.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => treeW()).toBe('318px'); // 248 default + 70

  // Persisted — survives a renderer reload (§20.2).
  await page.reload();
  await page.keyboard.press('Control+2');
  await expect.poll(() => treeW()).toBe('318px');

  // Reset to default so the persisted width doesn't leak into later runs.
  await page.locator('#artifacts .artsplit-divider').dblclick();
  await expect.poll(() => treeW()).toBe('248px');
});

test('the quick-send drawer docks and undocks without a scrim, keeping the terminal visible (§16.8/§22.2)', async () => {
  const appEl = page.locator('#app');
  await expect(appEl).toHaveClass(/drawer-open/); // docked in setup (it starts closed, §22.2)

  // Ctrl+Shift+K undocks it (the PC drawer chord, §7.7); the terminal pane stays on screen (no scrim).
  await page.keyboard.press('Control+Shift+K');
  await expect(appEl).not.toHaveClass(/drawer-open/);
  await expect(page.locator('.scrim, .backdrop')).toHaveCount(0);
  await expect(page.locator('#terminal')).toBeVisible();

  await page.locator('#qs').click();
  await expect(appEl).toHaveClass(/drawer-open/);
  await expect(page.locator('#panel-capture')).toBeVisible();
  await page.locator('#dclose').click();
  await expect(appEl).not.toHaveClass(/drawer-open/);
});

test('Ctrl+Shift+K toggles the drawer even while the terminal is focused (§22.4 / §7.7)', async () => {
  const appEl = page.locator('#app');
  await page.locator('.xterm-screen').click();
  await expect(appEl).toHaveClass(/drawer-open/);

  // The shell intercepts the chord (capture phase) ahead of xterm, so the hotkey still reaches it.
  await page.keyboard.press('Control+Shift+K');
  await expect(appEl).not.toHaveClass(/drawer-open/);
  await page.keyboard.press('Control+Shift+K');
  await expect(appEl).toHaveClass(/drawer-open/);
});

test('the terminal refits its PTY when the drawer docks/undocks (§7.1)', async () => {
  await typeCommand('echo cols-docked=$(tput cols)');
  await expect(termRows()).toContainText(/cols-docked=\d+/);
  const docked = Number((await termRows().innerText()).match(/cols-docked=(\d+)/)![1]);

  // Use the close button, not ⌘K: the terminal has focus, so xterm would consume the chord. Undocking
  // widens the terminal column and the PTY must follow (§7.1).
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
  await page.keyboard.press('Control+3');
  const gate = page.locator('#gate-panel');
  await expect(gate.locator('button.app')).toHaveText(/Approve/);
  await expect(gate).toContainText('changes requested'); // the fixture's prior verdict

  await gate.locator('button.app').click(); // stubbed (§19.3): no injection, reflects locally only
  await expect(gate).toContainText('approved');
});

function seedFlowRepo(prefix: string, stepId: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true }); // a git root ⇒ its own repo key (§16.3)
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    `name: ${stepId}-flow\nsteps:\n  - id: ${stepId}\n    kind: manual\n`,
  );
  return dir;
}

// Multiple co-located templates under .agent-terminal/todo-templates/ (§18.6); each template's H1
// supplies the picker's display name.
function seedFlowRepoMultiTemplate(
  prefix: string,
  stepId: string,
  opts: { skill?: string; defaultRef?: string; templates: { ref: string; title: string; items: string[] }[] },
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  const td = join(dir, '.agent-terminal', 'todo-templates');
  mkdirSync(td, { recursive: true });
  for (const t of opts.templates) {
    writeFileSync(join(td, `${t.ref}.md`), `# ${t.title}\n\n` + t.items.map((i) => `- ${i}`).join('\n') + '\n');
  }
  let step = `  - id: ${stepId}\n    kind: manual\n`;
  if (opts.skill) step += `    skill: ${opts.skill}\n`;
  if (opts.defaultRef) step += `    todo_template: ${opts.defaultRef}\n`;
  writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), `name: ${stepId}-flow\nsteps:\n${step}`);
  return dir;
}

const flowStation = (i: number) => page.locator('#flow-strip .flow.vert .stn').nth(i);
const flowStepName = () => flowStation(1).locator('.nm'); // station 1 = the first real step (Not-started bookend at 0)
const flowControl = () => page.locator('#flow-strip .flow-control');

// Multi-step manual flow named by `stepIds` (§24.2.3 T1).
function seedMultiStepFlowRepo(prefix: string, stepIds: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  const steps = stepIds.map((id) => `  - id: ${id}\n    kind: manual\n`).join('');
  writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), `name: multi-flow\nsteps:\n${steps}`);
  return dir;
}

// §24.2.3 T3 — a 2-step manual flow whose SECOND step declares a `skill`, so Advance into it fires
// entry-on-advance (the converse of T1's "advance does not fire onEnter"). Step 1 has no skill.
function seedSkillOnSecondStepFlowRepo(prefix: string, skill: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    `name: entry-flow\nsteps:\n  - id: groom\n    kind: manual\n  - id: build\n    kind: manual\n    skill: ${skill}\n`,
  );
  return dir;
}

// §24.2.3 T3 — second step is a loop with `bootstrap: pickup` and a required typed input
// (§18.3/§18.4): entering prompts via the modal, Confirm injects `agent-loop pickup <input>`
// (subject to the §19.3 busy refusal) and persists the value.
function seedBootstrapFlowRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: dev-flow\nsteps:\n' +
      '  - id: groom\n    kind: manual\n' +
      '  - id: plan\n    kind: loop\n    loop: plan-loop\n    bootstrap: pickup\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n',
  );
  return dir;
}

const inputModal = () => page.locator('#flow-modal-host .flow-modal');

// §24.2.3 T2 — step 2 is a `loop` bound to a LoopDef, plus a real v4 agent-loop state.yaml the app
// mirrors read-only. Returns the state.yaml path so the test hand-edits it (standing in for the
// human driving agent-loop) and watches the strip update.
function seedLoopFlowRepo(prefix: string): { dir: string; stateFile: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: dev-flow\nsteps:\n  - id: groom\n    kind: manual\n  - id: build\n    kind: loop\n    loop: impl-loop\n',
  );
  // Hermetic LoopDef resolution (§18.1): a repo-local .agent-loop.yaml registry override points at a
  // working-tree LoopDef copy, so the gate model resolves without the machine's ~/.claude/loops install.
  writeFileSync(join(dir, '.agent-loop.yaml'), 'loops:\n  impl-loop: ./impl-loop.yaml\n');
  writeFileSync(
    join(dir, 'impl-loop.yaml'),
    'name: impl-loop\nschema_version: "4"\ngates:\n' +
      '  - id: awaiting-human-pr-approval\n    kind: approve-required\n    human_options: [approve, request-changes, impasse]\n    next_status_on_approve: awaiting-team-review\n' +
      '  - id: awaiting-human-impl-triage\n    kind: triage\n    human_options: [approve, request-changes, impasse]\n    next_status_on_approve: awaiting-team-review\n' +
      '  - id: awaiting-team-review\n    kind: terminal\n    human_options: []\n',
  );
  const loopDir = join(dir, '.agent-loop');
  mkdirSync(loopDir, { recursive: true });
  return { dir, stateFile: join(loopDir, 'state.yaml') };
}

const loopReadout = () => page.locator('#flow-strip .loopstat'); // compact rail read-out; click opens the panel
const loopPanel = () => page.locator('#loop-panel');
const attnCue = () => page.locator('#attn-cue'); // §24.2.3 T4

// Fire main's flow:revealLoop push directly (§24.2.3 T4) so the real renderer reveal path runs. The
// OS-notification CLICK that emits this in production is untestable Electron glue (its decision +
// activation are covered at the main integration layer in loopNotifier); this covers everything
// downstream of it.
const fireRevealLoop = (): Promise<void> =>
  app.evaluate(
    ({ BrowserWindow }, { ch, sid }) =>
      BrowserWindow.getAllWindows()[0].webContents.send(ch, { sessionId: sid }),
    { ch: CH.flowRevealLoop, sid: SESSION_ID },
  );

// Manual step with entry actions (§18.6): an optional `skill` and an optional `todo_template` whose
// markdown-list items are written to a repo-local file.
function seedFlowRepoWithEntry(
  prefix: string,
  stepId: string,
  opts: { skill?: string; templateItems?: string[] },
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  let step = `  - id: ${stepId}\n    kind: manual\n`;
  if (opts.skill) step += `    skill: ${opts.skill}\n`;
  if (opts.templateItems) {
    // Templates co-located with flow.yaml under todo-templates/ (§18.6); a bare ref resolves to `.md`.
    mkdirSync(join(dir, '.agent-terminal', 'todo-templates'), { recursive: true });
    writeFileSync(
      join(dir, '.agent-terminal', 'todo-templates', 'tmpl.md'),
      opts.templateItems.map((t) => `- ${t}`).join('\n') + '\n',
    );
    step += '    todo_template: tmpl\n';
  }
  writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), `name: ${stepId}-flow\nsteps:\n${step}`);
  return dir;
}

test('the flow strip follows the cwd: cd into a repo shows its flow and drives it (§24.2.2)', async () => {
  // bash spawns in $HOME (§5); the flow follows the terminal cwd like todos (§16.3).
  const repo = seedFlowRepo('agent-term-e2e-flow-a-', 'groom-ticket');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom-ticket', { timeout: 10_000 });
  await expect(flowStation(0)).toHaveClass(/\bactive\b/); // synthetic "Not started" bookend
  await expect(flowControl()).toHaveText('Start');

  await flowControl().click();
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(flowControl()).toHaveText('Advance');

  await flowControl().click();
  await expect(flowStation(2)).toHaveClass(/\bactive\b/); // synthetic "Completed" bookend
  await expect(flowControl()).toHaveText('Restart');

  await flowControl().click(); // Restart → back to the first step
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(flowControl()).toHaveText('Advance');
  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('a multi-step flow walks the bookended rail: Start → Advance ×3 reaches done (§24.2.3 T1)', async () => {
  // A 3-step flow's rail brackets the real steps with Not-started / Completed bookends → FIVE stations.
  const repo = seedMultiStepFlowRepo('agent-term-e2e-flow-multi-', ['groom', 'plan', 'implement']);
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-multi-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  // Rail: [Not started] · groom · plan · implement · [Completed].
  await expect(page.locator('#flow-strip .flow.vert .stn')).toHaveCount(5, { timeout: 10_000 });
  await expect(flowStation(1).locator('.nm')).toHaveText('groom');
  await expect(flowStation(3).locator('.nm')).toHaveText('implement');
  await expect(flowStation(0)).toHaveClass(/\bactive\b/); // Not started
  await expect(page.locator('#flow-strip .sect')).toHaveText('Flow — step 1 / 5');
  await expect(flowControl()).toHaveText('Start');

  await flowControl().click();
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(page.locator('#flow-strip .sect')).toHaveText('Flow — step 2 / 5');
  await expect(flowControl()).toHaveText('Advance');

  await flowControl().click();
  await expect(flowStation(1)).toHaveClass(/\bdone\b/);
  await expect(flowStation(2)).toHaveClass(/\bactive\b/);
  await expect(page.locator('#flow-strip .sect')).toHaveText('Flow — step 3 / 5');

  await flowControl().click();
  await expect(flowStation(2)).toHaveClass(/\bdone\b/);
  await expect(flowStation(3)).toHaveClass(/\bactive\b/);
  await expect(page.locator('#flow-strip .sect')).toHaveText('Flow — step 4 / 5');
  await expect(flowControl()).toHaveText('Advance'); // still Advance — not yet past the last step

  await flowControl().click();
  await expect(flowStation(1)).toHaveClass(/\bdone\b/);
  await expect(flowStation(2)).toHaveClass(/\bdone\b/);
  await expect(flowStation(3)).toHaveClass(/\bdone\b/);
  await expect(flowStation(4)).toHaveClass(/\bactive\b/); // Completed
  await expect(page.locator('#flow-strip .sect')).toHaveText('Flow — step 5 / 5');
  await expect(flowControl()).toHaveText('Restart');
  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('advancing INTO a later step fires its entry action: the skill injects on Advance (§24.2.3 T3)', async () => {
  // Entry-on-advance (the converse of T1's "advance does not fire onEnter"): advancing into step 2
  // injects its skill into the real PTY.
  const repo = seedSkillOnSecondStepFlowRepo('agent-term-e2e-flow-t3adv-', 'buildctl');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-t3adv-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });

  await flowControl().click(); // Start → groom: no skill, nothing injected
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(termRows()).not.toContainText('/buildctl');

  await flowControl().click(); // Advance → build: entry-on-advance injects its skill
  await expect(flowStation(2)).toHaveClass(/\bactive\b/);
  await expect(termRows()).toContainText('/buildctl', { timeout: 10_000 });

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('entering a bootstrap loop step prompts for its typed input; Confirm injects agent-loop pickup + persists (§24.2.3 T3)', async () => {
  // Ready-shell case: Confirm over a ready prompt injects and persists (contrast the busy-shell test).
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-t3boot-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-t3boot-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });

  await flowControl().click(); // Start → groom (manual): no input prompt
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(inputModal()).toHaveCount(0);

  await flowControl().click(); // Advance → plan (loop, bootstrap): the typed-input modal opens
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await expect(inputModal().locator('.field .nm')).toHaveText('ticket');
  await expect(inputModal().locator('.field .ty')).toHaveText('github-ticket');

  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  await expect(termRows()).toContainText('agent-loop pickup 176', { timeout: 10_000 });
  await expect(inputModal()).toHaveCount(0);
  // The value persists to flow-state.yaml so it threads to later steps and survives a relaunch (§18.3).
  await expect
    .poll(() => readFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'utf8'), { timeout: 10_000 })
    .toContain('176');

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('a busy shell refuses the bootstrap on Confirm: refusal notice, nothing injected (§19.3 / §24.2.3 T3)', async () => {
  // Busy-shell case: the input still prompts, but Confirm over a foreground process refuses to inject
  // the bootstrap (§19.3 notice, nothing typed into the PTY).
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-t3bootbusy-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-t3bootbusy-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await flowControl().click(); // Start → groom

  // A live foreground process holds the shell off its ready prompt → busy (a live OSC-133 span, §19.3).
  await typeCommand('echo BUSY_NOW; cat');
  await expect(termRows()).toContainText('BUSY_NOW');

  await flowControl().click(); // Advance → plan: the modal still prompts — input resolution precedes the busy check
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  await expect(page.locator('#flow-strip .flow-notice')).toContainText('busy', { timeout: 10_000 });
  await expect(termRows()).not.toContainText('agent-loop pickup'); // refused — nothing typed into the PTY

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('a loop step shows a Loop read-out that expands a docked state-mirror panel, live; advancing early warns (§24.2.3 T2)', async () => {
  // The app DRIVES NOTHING — it mirrors agent-loop's v4 state.yaml read-only, updating live as the
  // file changes (§24.2.3 T2).
  const { dir: repo, stateFile } = seedLoopFlowRepo('agent-term-e2e-loop-');
  writeFileSync(
    stateFile,
    'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: awaiting-human-pr-approval\n',
  );
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-loop-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  // Rail: [Not started] · groom · build · [Completed]. A manual step carries no Loop read-out.
  await expect(page.locator('#flow-strip .flow.vert .stn')).toHaveCount(4, { timeout: 10_000 });
  await expect(flowStation(2).locator('.nm')).toHaveText('build');
  await expect(loopReadout()).toHaveCount(0);

  await flowControl().click(); // Start → groom (manual)
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(loopReadout()).toHaveCount(0);

  await flowControl().click(); // Advance → build (loop): the compact Loop read-out appears
  await expect(flowStation(2)).toHaveClass(/\bactive\b/);
  await expect(loopReadout().locator('.spill')).toHaveText('awaiting', { timeout: 10_000 });
  await expect(loopReadout().locator('.spill')).toHaveClass(/\bawait\b/); // awaiting-human → needs-you tone
  await expect(loopReadout()).toContainText('iter 9');

  // Clicking the read-out opens the docked panel with the full v4 vocabulary (it starts closed).
  await expect(page.locator('#app')).not.toHaveClass(/\bloop-open\b/);
  await loopReadout().click();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);
  await expect(loopPanel()).toContainText('awaiting-human-pr-approval'); // exact status, not the tone
  await expect(loopPanel()).toContainText('#179');
  await expect(loopPanel()).toContainText('agent-loop/issue-176');
  // The bound LoopDef (resolved via the repo's .agent-loop.yaml registry) drives the gate-options row
  // from this gate's human_options [approve, request-changes, impasse].
  const gateRow = loopPanel().locator('.ldl .lrow', { has: page.locator('.lk', { hasText: 'gate options' }) });
  await expect(gateRow.locator('.lv')).toHaveText('approve · changes · impasse');

  // A hand-edit of state.yaml (no app write, no user action) must re-pull the open panel live.
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 11\nstatus: awaiting-human-impl-triage\n');
  await expect(loopPanel()).toContainText('awaiting-human-impl-triage', { timeout: 10_000 });
  await expect(loopPanel()).toContainText('11');

  // Advancing while the loop still needs a human is a §19.2 override: it warns but proceeds.
  await flowControl().click();
  await expect(page.locator('#flow-strip .flow-notice')).toContainText('still needs you', { timeout: 10_000 });
  await expect(flowStation(3)).toHaveClass(/\bactive\b/); // Completed — advanced anyway
  await expect(flowControl()).toHaveText('Restart');

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('the awaiting-human cue appears, re-fires after dismiss, and clears as the loop state changes (§24.2.3 T4)', async () => {
  // The cue tracks state.yaml with no manual refresh: a distinct human-needed entry re-fires it even
  // after a dismiss; a non-human status clears it (§24.2.3 T4).
  const { dir: repo, stateFile } = seedLoopFlowRepo('agent-term-e2e-cue-');
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: awaiting-human-pr-approval\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-cue-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await expect(attnCue()).toBeHidden(); // a manual step is not human-needed

  await flowControl().click(); // Start → groom (manual): still not human-needed
  await expect(attnCue()).toBeHidden();

  await flowControl().click(); // Advance → build (loop) at awaiting-human-pr-approval
  await expect(attnCue()).toBeVisible({ timeout: 10_000 });
  await expect(attnCue()).toContainText('awaiting-human-pr-approval');

  // Dismiss only hides it — it changes no loop state (the read-out stays) and injects nothing.
  await attnCue().locator('[data-attn-dismiss]').click();
  await expect(attnCue()).toBeHidden();
  await expect(loopReadout()).toHaveCount(1);
  // Dismiss must not strand focus on <body> (WCAG 2.4.3): it lands on the loop read-out toggle.
  await expect(loopReadout()).toBeFocused();

  // A distinct human-needed entry (new status, later iteration) re-fires the cue even after a dismiss.
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 11\nstatus: awaiting-human-impl-triage\n');
  await expect(attnCue()).toBeVisible({ timeout: 10_000 });
  await expect(attnCue()).toContainText('awaiting-human-impl-triage');

  // A terminal hand-off (not human-needed) clears the cue.
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 11\nstatus: awaiting-team-review\n');
  await expect(attnCue()).toBeHidden({ timeout: 10_000 });

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('the reveal signal lands the user on the loop read-out, from another view and from viewer-fullscreen with the strip hidden (§24.2.3 T4)', async () => {
  // Needs a real git repo so the artifact viewer's full-screen (which hides the rail/strip) works
  // (§24.2.3 T4).
  const { dir: repo, stateFile } = seedLoopFlowRepo('agent-term-e2e-reveal-');
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: awaiting-human-pr-approval\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-reveal-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(
    `cd "${repo}" && rm -rf .git && git init -q && git config user.email t@t && git config user.name T && ` +
      `git add -A && git commit -qm init && printf '# Doc\\n' > doc.md && pwd`,
  );
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await flowControl().click(); // Start → groom
  await flowControl().click(); // Advance → build (loop) active, human-needed
  await expect(loopReadout()).toHaveCount(1, { timeout: 10_000 });
  await expect(attnCue()).toBeVisible();
  await expect(page.locator('#app')).not.toHaveClass(/\bloop-open\b/); // the docked panel starts closed

  // Reveal from a non-Terminal view must land on Terminal with the read-out open.
  await page.keyboard.press('Control+3');
  await expect(page.locator('[data-viewpane="3"]')).toBeVisible();
  await fireRevealLoop();
  await expect(page.locator('[data-viewpane="1"]')).toBeVisible();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);
  await expect(loopPanel()).toContainText('awaiting-human-pr-approval');

  // Reveal from viewer-fullscreen (rail/strip hidden) must exit full-screen and re-open the read-out
  // on Terminal — and the cue must stay perceivable in the always-visible main region throughout.
  await loopReadout().click();
  await expect(page.locator('#app')).not.toHaveClass(/\bloop-open\b/);
  await page.keyboard.press('Control+2');
  await page.locator('#artifacts .art-fs').click();
  await expect(page.locator('#app')).toHaveClass(/\bviewer-fullscreen\b/);
  await expect(page.locator('#app .rail')).toBeHidden(); // the strip lives in the hidden rail…
  await expect(attnCue()).toBeVisible(); // …yet the cue is still perceivable in the main region

  await fireRevealLoop();
  await expect(page.locator('#app')).not.toHaveClass(/\bviewer-fullscreen\b/);
  await expect(page.locator('[data-viewpane="1"]')).toBeVisible();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('changing directories swaps flow state; each repo is independent and visiting writes nothing (§24.2.2 / §19.1)', async () => {
  // The reported bug: after cd-ing away, the flow must reflect the NEW repo, not the old one.
  const repoA = seedFlowRepo('agent-term-e2e-flow-A-', 'alpha');
  const repoB = seedFlowRepo('agent-term-e2e-flow-B-', 'beta');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-sw-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  // In repo A: start the flow (→ in progress).
  await typeCommand(`cd "${repoA}"`);
  await expect(flowStepName()).toHaveText('alpha', { timeout: 10_000 });
  await flowControl().click();
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);

  // cd into repo B: the strip shows B's step at NOT started — A's progress must not leak.
  await typeCommand(`cd "${repoB}"`);
  await expect(flowStepName()).toHaveText('beta', { timeout: 10_000 });
  await expect(flowStation(1)).toHaveClass(/\btodo\b/);

  // cd back into repo A: its in-progress state is preserved.
  await typeCommand(`cd "${repoA}"`);
  await expect(flowStepName()).toHaveText('alpha', { timeout: 10_000 });
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);

  // State is per-repo on disk; merely visiting B (never starting) wrote nothing there.
  expect(existsSync(join(repoA, '.agent-terminal', 'flow-state.yaml'))).toBe(true);
  expect(existsSync(join(repoB, '.agent-terminal', 'flow-state.yaml'))).toBe(false);
  expect(existsSync(join(home, '.agent-terminal', 'flow-state.yaml'))).toBe(false);
  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('cd into a directory with no flow.yaml shows an error and creates no .agent-terminal dir (§18.1)', async () => {
  // No local flow.yaml and an empty $HOME (no global): the strip errors with no control, the rest
  // of the app still runs, and just cd-ing there must NOT litter the dir with an empty .agent-terminal.
  const plain = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-none-'));
  mkdirSync(join(plain, '.git'), { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-none-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${plain}"`);
  const errored = page.locator('#flow-strip .flow-error');
  await expect(errored).toHaveText(/.+/, { timeout: 10_000 });
  await expect(page.locator('#flow-strip .flow.vert .stn')).toHaveCount(0);
  await expect(flowControl()).toHaveCount(0);
  expect(existsSync(join(plain, '.agent-terminal'))).toBe(false); // visiting wrote nothing
  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(plain, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('the definition falls back to the global flow.yaml, but state is still written local (§18.1/§19.1)', async () => {
  // A repo with no flow.yaml falls back to the $HOME default DEFINITION; the STATE is still
  // repo-local — Starting writes flow-state.yaml into the repo, never into HOME.
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-global-repo-'));
  mkdirSync(join(repo, '.git'), { recursive: true }); // a repo with NO flow.yaml
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-global-home-'));
  mkdirSync(join(home, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(home, '.agent-terminal', 'flow.yaml'),
    'name: global-default\nsteps:\n  - id: global-step\n    kind: manual\n',
  );
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('global-step', { timeout: 10_000 }); // definition from global $HOME
  await flowControl().click(); // Start
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);

  expect(existsSync(join(repo, '.agent-terminal', 'flow-state.yaml'))).toBe(true);
  expect(existsSync(join(home, '.agent-terminal', 'flow-state.yaml'))).toBe(false);
  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('flow progression persists across a relaunch, per repo (§24.2.2 S3 / §19.1)', async () => {
  const repo = seedFlowRepo('agent-term-e2e-flow-persist-', 'groom-ticket');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-persist-home-'));
  const launch = async (): Promise<void> => {
    app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
    page = await app.firstWindow();
    await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
    await typeCommand(`cd "${repo}"`);
    await expect(flowStepName()).toHaveText('groom-ticket', { timeout: 10_000 });
  };

  await app.close();
  await launch();
  await flowControl().click(); // Start
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);

  // Relaunch and cd back: progression resumed from the repo's flow-state.yaml.
  await app.close();
  await launch();
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(flowControl()).toHaveText('Advance');
  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const flowDerived = () => page.locator('#flow-strip .flow-derived');

test("the flow strip's derived n/m done moves as todos are checked, pushed live (§24.2.2 S5)", async () => {
  // The strip's "n / m done" count moves on its own as todos change — no manual refresh — proving
  // the live push path (§24.2.2 S5).
  const repo = seedFlowRepo('agent-term-e2e-flow-s5-', 'groom-ticket');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-s5-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom-ticket', { timeout: 10_000 });
  await flowControl().click(); // Start → in progress
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(flowDerived()).toContainText('0 / 0', { timeout: 10_000 }); // derived live status, no todos yet

  await openQuickSend('todo');
  await page.locator('#todo-new').fill('s5 first todo');
  await page.locator('#todo-add-btn').click();
  await page.locator('#todo-new').fill('s5 second todo');
  await page.locator('#todo-add-btn').click();
  await expect(flowDerived()).toContainText('0 / 2', { timeout: 10_000 }); // total moved via the push

  // Check the first todo — the strip count moves on its own; the test never refreshes the strip.
  await page.locator('.todo').filter({ hasText: 's5 first todo' }).locator('.chk').click();
  await expect(flowDerived()).toContainText('1 / 2', { timeout: 10_000 });

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('advancing with todos outstanding warns but still completes, and is undoable (§19.2 / §24.2.2 S5)', async () => {
  // Advancing with todos outstanding warns (no spec-section jargon in the UI) yet still reaches done
  // — the §19.2 human override — and the advance is undoable.
  const repo = seedFlowRepo('agent-term-e2e-flow-s5warn-', 'groom-ticket');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-s5warn-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom-ticket', { timeout: 10_000 });
  await flowControl().click(); // Start

  await openQuickSend('todo');
  await page.locator('#todo-new').fill('still outstanding');
  await page.locator('#todo-add-btn').click();
  await expect(flowDerived()).toContainText('0 / 1', { timeout: 10_000 }); // not ready

  await flowControl().click(); // Advance while NOT ready
  const notice = page.locator('#flow-strip .flow-notice');
  await expect(notice).toContainText('outstanding', { timeout: 10_000 });
  await expect(notice).not.toContainText('§'); // no internal spec-section reference leaks to the UI
  await expect(flowStation(2)).toHaveClass(/\bactive\b/); // synthetic "Completed" active — still reached done
  await expect(flowControl()).toHaveText('Restart');

  // Undo takes the advance back: the step returns to in-progress (its derived count is back).
  await page.locator('#flow-strip .flow-undo').click();
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(flowControl()).toHaveText('Advance');
  await expect(flowDerived()).toContainText('0 / 1', { timeout: 10_000 });

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('Start injects the skill on entry; todos come from the template ON DEMAND in the todo overlay (§4.1/§6/§9.1)', async () => {
  // Start injects the skill into the real PTY; the template picker is NOT in the flow strip (it
  // relocated to the todo overlay, §9.1); template todos appear only after the on-demand control.
  const repo = seedFlowRepoWithEntry('agent-term-e2e-flow-s4-', 'groom-ticket', {
    skill: 'groomctl',
    templateItems: ['Groom the ticket scope', 'Confirm acceptance criteria'],
  });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-s4-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom-ticket', { timeout: 10_000 });
  await expect(flowControl()).toHaveText('Start');

  await flowControl().click();
  await expect(termRows()).toContainText('/groomctl'); // skill injected on entry (§18.6)
  // The flow strip carries NO template control — it moved to the todo overlay (§9.1).
  await expect(page.locator('#flow-strip .flow-template-add')).toHaveCount(0);
  await expect(page.locator('#flow-strip .flow-template-pick')).toHaveCount(0);

  await openQuickSend('todo'); // the todo overlay now owns the picker
  const groomTodo = page.locator('.todo').filter({ hasText: 'Groom the ticket scope' });
  await expect(groomTodo).toHaveCount(0); // not auto-instantiated

  const toggle = page.locator('#todo-list .tmpl-toggle');
  await expect(toggle).toBeVisible({ timeout: 10_000 }); // disclosure present while the step is active
  await toggle.click();
  await page.locator('#todo-list .tmpl-add').click();
  await expect(groomTodo).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.todo').filter({ hasText: 'Confirm acceptance criteria' })).toHaveCount(1);

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('the todo overlay offers a picker of named templates; choosing one instantiates its todos (§4.1/§6)', async () => {
  // The picker lists every co-located template by its H1 name, defaults to the step's bound template,
  // and instantiating the CHOSEN one adds only its todos.
  const repo = seedFlowRepoMultiTemplate('agent-term-e2e-flow-pick-', 'groom-ticket', {
    skill: 'groomctl',
    defaultRef: 'ticket-grooming',
    templates: [
      { ref: 'ticket-grooming', title: 'Ticket grooming', items: ['Groom the ticket scope', 'Confirm acceptance criteria'] },
      { ref: 'pr-review', title: 'PR review checklist', items: ['Check the diff', 'Verify the tests'] },
    ],
  });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-pick-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom-ticket', { timeout: 10_000 });
  await flowControl().click(); // Start → step active

  await openQuickSend('todo');
  const toggle = page.locator('#todo-list .tmpl-toggle');
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  await toggle.click();

  const pick = page.locator('#todo-list .tmpl-pick');
  await expect(pick.locator('option')).toHaveText(['PR review checklist', 'Ticket grooming']); // by-ref order, H1 names
  await expect(pick).toHaveValue('ticket-grooming'); // defaults to the step's bound template

  await pick.selectOption('pr-review'); // choose a different list
  await page.locator('#todo-list .tmpl-add').click();
  await expect(page.locator('.todo').filter({ hasText: 'Check the diff' })).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.todo').filter({ hasText: 'Verify the tests' })).toHaveCount(1);
  await expect(page.locator('.todo').filter({ hasText: 'Groom the ticket scope' })).toHaveCount(0); // non-chosen not added

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('Start refuses to inject the skill over a busy shell, showing the refusal (§19.3)', async () => {
  // Start over a busy shell shows the §19.3 refusal notice and injects nothing.
  const repo = seedFlowRepoWithEntry('agent-term-e2e-flow-s4busy-', 'groom-ticket', { skill: 'groomctl' });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-s4busy-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom-ticket', { timeout: 10_000 });

  // A busy shell that keeps OUTPUT flowing (printf every 0.2s < QUIET_MS 1s), not a silent `cat`:
  // the running loop holds the OSC-133 command span open (so isShellBusy refuses Start) AND keeps the
  // agent stably 'active'. That matters because the §19.3 notice is transition-driven and any
  // flow:onStateChanged sweeps it — a silent block flips active→quiet, fires one, and clears the
  // notice before we can assert it (the flake). Staying active fires no flip, so the notice persists.
  await typeCommand('while true; do printf "BUSY_NOW "; sleep 0.2; done');
  await expect(termRows()).toContainText('BUSY_NOW');
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('working', { timeout: 6_000 });

  await flowControl().click();
  await expect(page.locator('#flow-strip .flow-notice')).toContainText('busy', { timeout: 10_000 });
  await expect(termRows()).not.toContainText('/groomctl'); // refused — nothing typed into the PTY

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
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
