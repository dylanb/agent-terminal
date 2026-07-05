/// <reference lib="dom" />
// page.evaluate callbacks run in the renderer; DOM lib gives them window.monitor's type.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, statSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { CH, SESSION_ID } from '../../src/shared/ipc';
import { CLI_COMMAND_NAME } from '../../src/main/cliShim';
import { parseAuditStream, type AuditEvent } from '../../src/shared/audit';
import { turnDoneSentinel, TURN_DONE_FILENAME } from '../../src/shared/loopTurn';

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

// xterm routes keystrokes through a hidden textarea; under parallel-CI load, characters typed before
// that textarea takes focus are dropped, mistyping the command (e.g. "exit" → "ex"). Click, then wait
// for focus to land on it before typing — and always type with a per-key delay so each char registers.
async function focusTerminal(target: Page = page): Promise<void> {
  await target.locator('.xterm-screen').click();
  await expect.poll(() => target.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
}

async function typeCommand(cmd: string): Promise<void> {
  await focusTerminal();
  await page.keyboard.type(cmd, { delay: 20 });
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
  await focusTerminal();
  await page.keyboard.type('echo foobar', { delay: 20 });
  await page.keyboard.press('Alt+Backspace');
  await page.keyboard.type('done', { delay: 20 });
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
  await focusTerminal();
  await page.keyboard.type('sleep 30', { delay: 20 });
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

test('the app terminates when the hosted shell exits', async () => {
  // When the PTY's shell exits the whole app must terminate — the hosted shell IS the session. Use a
  // tiny startup-exit grace so the post-grace path is deterministic: in a fast environment the shell
  // can exit only a few hundred ms after spawn, which under the default 1s grace would be treated as
  // a startup failure (window kept open) and never terminate. A 1 ms grace exercises a normal exit.
  await app.close();
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_STARTUP_EXIT_GRACE_MS: '1' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  // Shell teardown → PTY exit → app quit can take a moment under CI load; wait past the default budget.
  await typeCommand('exit');
  await app.waitForEvent('close', { timeout: 20_000 });
  expect(app.windows()).toHaveLength(0);
});

test('an immediate shell startup failure keeps the app open (§5 grace exception)', async () => {
  // A shell that dies the instant it spawns (broken rc / bad APP_SHELL) is a startup failure: the
  // app must NOT vanish. `false` exits immediately, well within the startup grace, so the app stays
  // open rather than quitting. (The exit is too fast to assert the renderer diagnostic here — that
  // is covered by the within-grace test below, where the exit lands after the renderer has mounted.)
  // Pin a large grace so the assertion is deterministic: §5 measures uptime when the onExit callback
  // runs, which on a CPU-starved CI runner can be observed seconds after the spawn; a 60s grace makes
  // `false`'s instant exit unambiguously sub-grace regardless of that lag (the default 1s grace is
  // comparable to CI startup jitter, so it would intermittently misclassify the exit as a normal one).
  await app.close();
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'false', APP_SUBMIT_DELAY_MS: '100', APP_STARTUP_EXIT_GRACE_MS: '60000' },
  });
  page = await app.firstWindow();
  // The decision is in main and independent of the renderer: assert the app does NOT close within a
  // window comfortably under the grace. A close event here would mean it wrongly terminated.
  const closed = app
    .waitForEvent('close', { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  expect(await closed).toBe(false);
  expect(app.windows().length).toBeGreaterThan(0);
});

test('a within-grace shell exit keeps the app open AND shows the exit diagnostic (§5)', async () => {
  // The point of staying open is that the user can READ the diagnostic. With a large grace, a normal
  // shell exit (typed after the renderer has mounted) stays open and the `[process exited]` line is
  // visible — proving the diagnostic the grace exists to preserve actually renders.
  await app.close();
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_STARTUP_EXIT_GRACE_MS: '60000' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 }); // renderer mounted → pty:exit listener live
  await typeCommand('exit');
  await expect(termRows()).toContainText('[process exited: 0]', { timeout: 20_000 });
  // The monitor pane's session chip is the other half of the §9.2 exit signal: pty:exit flips it to
  // "exited". Asserted here (the only test where the window stays open after exit) so the chip's
  // exit-tracking has live coverage.
  await expect(page.locator('.status-chip[data-status="session"]')).toContainText('exited', {
    timeout: 20_000,
  });
  // Uptime at exit (a few seconds) is far under the 60s grace, so the app must NOT close.
  const closed = app.waitForEvent('close', { timeout: 3000 }).then(() => true).catch(() => false);
  expect(await closed).toBe(false);
  // The kept-open window still drives the renderer: a window resize sends a pty:resize to the now-dead
  // shell. Driving its closed master fd throws ioctl EBADF; uncaught in main that pops Electron's modal
  // error dialog, blocking the event loop so the app can no longer quit (§5). After the resize the main
  // process must stay responsive — a wedged app makes this evaluate hang until the test times out.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const [width, height] = w.getSize();
    w.setSize(width + 120, height + 80);
  });
  await expect.poll(() => app.evaluate(({ app: a }) => a.isReady()), { timeout: 8000 }).toBe(true);
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

test('captured monitor events restore on relaunch in the same directory (persist→terminate→restore)', async () => {
  // Unlike the reload test above (same main process, in-memory store survives), this terminates the
  // whole app — the in-memory store dies with the process — then relaunches in the SAME launch
  // directory and asserts the persisted events rebuilt the store. APP_LAUNCH_DIR pins the directory
  // the monitor-events file lives under; APP_SHELL_INTEGRATION=0 surfaces the report deterministically
  // (no span-gating race), as in the replay test.
  const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-')));
  const dirEnv = {
    ...process.env,
    APP_SHELL: 'bash',
    APP_SUBMIT_DELAY_MS: '100',
    APP_SHELL_INTEGRATION: '0',
    APP_LAUNCH_DIR: launchDir,
    // The terminate step below is via the real shell exit; pin a tiny grace so bash's exit (uptime
    // far above 1ms) deterministically terminates the app, with no default-1s-grace window for a
    // CPU-starved CI runner to misclassify (§5; cf. the 479 normal-exit test).
    APP_STARTUP_EXIT_GRACE_MS: '1',
  };
  try {
    await app.close();
    app = await electron.launch({ args: launchArgs(), env: dirEnv });
    page = await app.firstWindow();
    await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
    await openQuickSend('capture');

    await typeCommand(
      "printf '%s\\n' 'Here is the summary of findings from this code review:' '- one important finding worth acting on' '- another finding to address before merge'",
    );
    await expect(termRows()).toContainText('another finding to address before merge');
    await clickCaptureLast();
    await expect(page.locator('#monitor-blocks .finding').first()).toBeVisible({ timeout: 10_000 });

    // Terminate via the real shell-exit path (the app quits when the shell exits), then relaunch in
    // the same directory — proving restore survives the actual teardown, not just a graceful close.
    // Under heavy CI contention the first instance can already be tearing down by now; drive `exit`
    // only while the page is live (the assertion is restore-after-terminate, not the exact trigger),
    // and tolerate the close having already happened so a stale `app` never strands the afterEach.
    if (!page.isClosed()) await typeCommand('exit').catch(() => {});
    // The app terminates on the shell exit (grace=1ms): poll until it has no windows, resolving as
    // soon as it is gone and tolerating it having already terminated (a stale waitForEvent('close')
    // would otherwise hang on an already-emitted event).
    await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(0).catch(() => {});
    app = await electron.launch({ args: launchArgs(), env: dirEnv });
    page = await app.firstWindow();
    await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
    await openQuickSend('capture'); // the drawer starts closed after a relaunch (§22.2)

    // No re-capture: the events were rebuilt from disk and replayed into the fresh pane.
    await expect(page.locator('#monitor-blocks .finding').first()).toBeVisible({ timeout: 10_000 });
  } finally {
    rmSync(launchDir, { recursive: true, force: true });
  }
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

test('the viewer live-reloads an open artifact when it changes on disk, with no cd (§20.1)', async () => {
  // The bug: the viewer only re-pulls on a cwd change, so an on-disk edit to the open file is unseen.
  // A file changing under the tree root must reflect in the viewer with no cd and no manual refresh.
  const dir = '/tmp/agent-term-e2e-artlive';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}" && cd "${dir}" && git init -q && ` +
      `git config user.email t@t && git config user.name T && ` +
      `printf '# Live\\n\\nfirst paragraph.\\n' > doc.md && ` +
      `git add -A && git commit -qm init && printf 'edited\\n' >> doc.md && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.locator('[data-viewbtn="2"]').click();
  await expect(page.locator('[data-viewpane="2"]')).toBeVisible();
  const tree = page.locator('#artifacts .tree');
  await expect(tree.locator('.f').filter({ hasText: 'doc.md' })).toHaveCount(1);
  await tree.locator('.f').filter({ hasText: 'doc.md' }).click();
  const body = page.locator('#artifacts .vbody');
  await expect(body).toContainText('first paragraph');

  // Edit the open file on disk — no cd, no manual refresh. The live watcher must re-render it.
  appendFileSync(join(dir, 'doc.md'), '\nLIVERELOADMARKER\n');
  await expect(body).toContainText('LIVERELOADMARKER', { timeout: 6_000 });
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

test('curated tree is the superset: committed-in-PR files show tagged PR with base-relative changed lines (§20.1/§20.2)', async () => {
  // On a feature branch off main: feature.ts is COMMITTED (nothing uncommitted) yet must appear in the
  // curated tree tagged PR, and its lines must mark as changed relative to the PR base — not vs HEAD,
  // where a committed file reads as clean. The base resolves via the local-main fallback (no gh/PR).
  const dir = '/tmp/agent-term-e2e-prtree';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}/src" && cd "${dir}" && git init -q && git branch -M main && ` +
      `git config user.email t@t && git config user.name T && ` +
      `printf 'export const BASE = 1;\\n' > src/app.ts && ` +
      `git add -A && git commit -qm init && ` +
      `git checkout -q -b feature && ` +
      `printf 'export const FEATURE = 1;\\nexport const MORE = 2;\\n' > src/feature.ts && ` +
      `git add src/feature.ts && git commit -qm feat && ` +
      `printf 'export const WORKING = 9;\\n' >> src/app.ts && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  await expect(page.locator('[data-viewpane="2"]')).toBeVisible();
  const tree = page.locator('#artifacts .tree');

  // feature.ts is committed on the branch (clean working tree) but present + tagged PR (§20.1).
  const featureRow = tree.locator('.f').filter({ hasText: 'feature.ts' });
  await expect(featureRow).toHaveCount(1);
  await expect(featureRow).toContainText('PR');
  // app.ts is committed on the base and only edited in the working tree → changed, not PR.
  await expect(tree.locator('.f').filter({ hasText: 'app.ts' })).toContainText('changed');

  // The committed-in-PR file's lines mark as changed vs the base — both lines of the new file (§20.2).
  await featureRow.click();
  const body = page.locator('#artifacts .vbody');
  await expect(body.locator('.cm-editor')).toContainText('FEATURE');
  await expect(body.locator('.cm-changedLine')).toHaveCount(2);
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
    .poll(
      async () => {
        await typeCommand('echo cols-wide=$(tput cols)');
        const m = (await termRows().innerText()).match(/cols-wide=(\d+)/g)?.at(-1);
        return m ? Number(m.match(/\d+/)![0]) : docked;
      },
      // The undock resize is debounced (§7.1) and each poll iteration re-types a command, so give the
      // PTY resize generous wall-clock room to settle under CI load before it is treated as failed.
      { timeout: 30_000 },
    )
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

// §26.13 test seam — the orchestrator's in-app pickup (§26.9) shells real git/gh. e2e prepends a fake
// gh + git on PATH that record their argv and emit canned output (no network/auth/remote), so the run
// is deterministic on a real PTY: the PTY + shell are real, only the bootstrap helpers are stubbed.
// Returns the bin dir to prepend to PATH and the log file the fakes append every invocation to.
function seedFakeGhGit(prefix: string): { binDir: string; logFile: string } {
  const binDir = mkdtempSync(join(tmpdir(), prefix));
  const logFile = join(binDir, 'calls.log');
  const fakeGit =
    '#!/usr/bin/env bash\n' +
    'echo "git $*" >> "$FAKE_GHGIT_LOG"\n' +
    // status --porcelain emits nothing → a clean tree; every other op is a recorded no-op success.
    'exit 0\n';
  const fakeGh =
    '#!/usr/bin/env bash\n' +
    'echo "gh $*" >> "$FAKE_GHGIT_LOG"\n' +
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "main"; exit 0; fi\n' +
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then echo \'{"title":"Fake ticket","url":"https://example/issues/176"}\'; exit 0; fi\n' +
    // §26.9/L8 epic-promote — each `gh issue create` returns a fresh issue URL (a per-binDir counter file
    // seeded at 500) so the sub-issues carry distinct numbers the executor appends to linked_issues.
    'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then seq="$FAKE_GHGIT_LOG.issue-seq"; n=$(cat "$seq" 2>/dev/null || echo 500); n=$((n+1)); echo "$n" > "$seq"; echo "https://github.com/fake/repo/issues/$n"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/fake/repo/pull/4242"; exit 0; fi\n' +
    // §26.7/L8 CI run-don't-block — `gh pr checks` returns the current bucket state (one pending, one pass)
    // and exits non-zero (8) as real gh does when checks are pending; the app parses stdout regardless and
    // never waits. The invocation is logged (above) BEFORE the optional FAKE_GH_CHECKS_DELAY sleep, so a
    // test can hold the snapshot's RESULT back to prove the loop reaches its gate before the snapshot lands.
    'if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then [ -n "$FAKE_GH_CHECKS_DELAY" ] && sleep "$FAKE_GH_CHECKS_DELAY"; echo \'[{"bucket":"pass"},{"bucket":"pending"}]\'; exit 8; fi\n' +
    'exit 0\n';
  writeFileSync(join(binDir, 'git'), fakeGit, { mode: 0o755 });
  writeFileSync(join(binDir, 'gh'), fakeGh, { mode: 0o755 });
  return { binDir, logFile };
}

// §26.13 test seam — the deterministic fake hosted agent (the analogue of the engine's `fakeclaude`).
// Written into the same PATH-prepended bin dir as the fake gh/git; launched as the terminal's
// foreground REPL so the orchestrator's injected work-{phase} prompt reaches its stdin. Each injected
// line drives the scripted turn for `mode`: `write-plan` writes the artifact + emits BOTH done-signals
// (sentinel line + `.agent-loop/turn-done`), `plan-only` writes the artifact but NO signal (drives the
// manual mark-complete path), `noop` produces nothing (drives retry-then-error). The sentinel + file
// name are generated from the shared contract so the seam cannot drift from the detectors.
// The plan-loop reviewer roster (§26.4) — the real six personas the fan-out turn must satisfy. `missing`
// mode omits the last one so the orchestrator sees a partial fan-out and drives retry-then-error.
const PLAN_PERSONAS = [
  'review-principal',
  'review-security',
  'review-architecture',
  'review-intent',
  'review-maintainability',
  'review-contracts',
];

// Emit BOTH done-signals for `turnKey`: write the turn-done file and print the sentinel ALONE on a line
// (leading newline so it survives interleaving with the PTY echo of the injected prompt — the scanner
// only matches a full-line sentinel, echo-safety §26.3/D47a).
function doneSignal(turnKey: string): string {
  return `printf '%s' '${turnKey}' > .agent-loop/${TURN_DONE_FILENAME}; printf '\\n%s\\n' '${turnDoneSentinel(turnKey)}'`;
}

// Write ONLY the turn-done file — no sentinel line. Exercises the file half of the §26.3/D47a "line OR
// file" done-signal independently (the line scanner can never match because no sentinel is printed).
function fileOnlySignal(turnKey: string): string {
  return `printf '%s' '${turnKey}' > .agent-loop/${TURN_DONE_FILENAME}`;
}

function seedFakeAgent(
  binDir: string,
  opts: {
    work: 'write-plan' | 'file-only' | 'plan-only' | 'noop';
    reviews?: 'all' | 'missing';
    consolidate?: 'clean' | 'needs-work';
    // §26.6/L6 — when set, the consolidate turn writes this verdict INSTEAD of `consolidate` on any
    // iteration where state.yaml already carries `phase2_active: true` (a prior request-changes). Lets an
    // e2e drive the phase-2 triage branch: clean until phase-2, then needs-work once phase-2 is active.
    phase2Consolidate?: 'clean' | 'needs-work';
    // §26.8/L6 — the consolidated `findings_kept` the stuck detector signs. `stable` writes the same
    // finding every iteration (identical signature → stuck at x2); `changing` stamps the iteration into
    // the finding (a fresh signature each round → never stuck). Absent → no kept findings (empty signature).
    findings?: 'stable' | 'changing';
    // §26.10/L7 — when set, the work turn writes a deterministic session-JSONL token fixture into the
    // test-controlled log root ($APP_SESSION_LOG_ROOT) so the cost meter has tokens to price without an
    // LLM. 1,000,000 claude-sonnet-5 input tokens → exactly $3.00 against the checked-in pricing table.
    costFixture?: boolean;
    // §26.9/L8 — when set, the work turn writes a plan.md whose frontmatter classifies it an epic with a
    // three-sub-ticket breakdown, so epic-promote at the plan-approval gate creates the N-1 (=2) sub-issues.
    epicPlan?: boolean;
    // §26.11/L8 — when set, each turn appends to `.agent-loop/<turn>-ran` when it runs, so a resume e2e can
    // prove a completed turn was NOT re-executed (the marker for a skipped turn stays absent).
    turnMarkers?: boolean;
  },
): void {
  // A per-turn execution marker (§26.11 resume): its presence proves that turn actually ran this session.
  const mark = (turn: string): string => (opts.turnMarkers ? `mkdir -p .agent-loop; printf x >> .agent-loop/${turn}-ran; ` : '');
  const writePlan = opts.epicPlan
    ? "mkdir -p .agent-loop; printf '%s\\n' '---' 'classification: epic' 'sub_tickets:' " +
      "'  - title: Slice one' '  - title: Slice two' '  - title: Slice three' '---' '' '# Plan' > .agent-loop/plan.md"
    : "mkdir -p .agent-loop; printf '# Plan\\n\\nfake plan body\\n' > .agent-loop/plan.md";
  // The token log the §26.10 meter reads: one assistant event carrying the model + usage (Claude Code's
  // private JSONL shape). Guarded on the env var so only the L7 test (which sets it) writes a fixture.
  const writeTokens = opts.costFixture
    ? `; if [ -n "$APP_SESSION_LOG_ROOT" ]; then mkdir -p "$APP_SESSION_LOG_ROOT"; ` +
      `printf '%s\\n' '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":1000000,"output_tokens":0}}}' > "$APP_SESSION_LOG_ROOT/session.jsonl"; fi`
    : '';
  const workAct =
    opts.work === 'noop'
      ? ':'
      : opts.work === 'plan-only'
        ? `${mark('work')}${writePlan}${writeTokens}`
        : opts.work === 'file-only'
          ? `${mark('work')}${writePlan}${writeTokens}; ${fileOnlySignal('work-plan')}`
          : `${mark('work')}${writePlan}${writeTokens}; ${doneSignal('work-plan')}`;
  // §26.4/§26.13 L4 — reviews + consolidated are per-iteration (reviews/<iter>/…). The REPL derives the
  // iteration from the app-written state.yaml so a re-iteration (needs-work) writes reviews/<iter+1>/.
  const getIter = "iter=$(grep -m1 '^iteration:' .agent-loop/state.yaml | tr -dc '0-9')";
  // §26.4 — on the reviewers turn, write each roster persona's JSON for the iteration then signal done.
  // `missing` writes all but one so the fan-out is incomplete (retry-then-error); undefined = do nothing.
  const personas = opts.reviews === 'missing' ? PLAN_PERSONAS.slice(0, -1) : PLAN_PERSONAS;
  // §26.5/L6 — stamp the iteration into each review so a carried-forward (reused) review is distinguishable
  // from a freshly-written one: a pruned persona's reviews/<iter>/ file keeps the PRIOR iteration's stamp.
  const writeReviews =
    `${getIter}; mkdir -p .agent-loop/reviews/$iter; ` +
    personas
      .map((p) => `printf '{\"verdict\":\"clean\",\"seen_iter\":%s}' \"$iter\" > .agent-loop/reviews/$iter/${p}.json`)
      .join('; ');
  const reviewAct = opts.reviews === undefined ? ':' : `${mark('reviewers')}${writeReviews}; ${doneSignal('review-plan')}`;
  // §26.3/D45 — on the consolidate turn, write reviews/<iter>/consolidated.json with the scripted verdict
  // then signal done. undefined = do nothing (the turn never confirms → retry-then-error).
  // §26.6/L6 — the verdict is resolved at runtime so a phase2-conditional verdict can react to the
  // app-written `phase2_active` flag (grep the live state.yaml). Absent phase2Consolidate → static verdict.
  const verdictExpr = opts.phase2Consolidate
    ? `verdict='${opts.consolidate}'; if grep -q 'phase2_active: true' .agent-loop/state.yaml 2>/dev/null; then verdict='${opts.phase2Consolidate}'; fi`
    : `verdict='${opts.consolidate}'`;
  // §26.8/L6 — the kept findings the signature is computed over. `stable` is identical each iteration
  // (single-quoted, no expansion); `changing` stamps $iter (double-quoted so bash expands it).
  const keptAssign =
    opts.findings === 'stable'
      ? `kept='[{"severity":"major","message":"stable finding"}]'`
      : `kept="[{\\"severity\\":\\"major\\",\\"message\\":\\"iter $iter\\"}]"`;
  const findingsSetup = opts.findings ? `${keptAssign}; ` : '';
  const printfFmt = opts.findings ? `{\"verdict\":\"%s\",\"findings_kept\":%s}` : `{\"verdict\":\"%s\"}`;
  const printfArgs = opts.findings ? `\"$verdict\" \"$kept\"` : `\"$verdict\"`;
  const consolidateAct =
    opts.consolidate === undefined
      ? ':'
      : `${mark('consolidate')}${getIter}; ${verdictExpr}; ${findingsSetup}mkdir -p .agent-loop/reviews/$iter; ` +
        `printf '${printfFmt}' ${printfArgs} > .agent-loop/reviews/$iter/consolidated.json; ` +
        `${doneSignal('consolidate-plan')}`;
  // The injected prompt's done-signal instruction line carries `turn-done:<turnKey>` (inside the sentinel
  // it tells the agent to print), so the REPL keys its scripted turn off which sentinel marker it sees.
  const script =
    '#!/usr/bin/env bash\n' +
    '# Fake hosted agent REPL; each injected prompt line drives the scripted turn (§26.13).\n' +
    'while IFS= read -r line; do\n' +
    '  [ -z "$line" ] && continue\n' +
    '  case "$line" in\n' +
    // §26.3/D46 — record each injected `/clear` boundary so the e2e can assert the orchestrator issued it
    // (the echo scrolls out of the visible xterm-rows behind the next prompt, so a marker file is stable).
    '    /clear) mkdir -p .agent-loop; printf x >> .agent-loop/clear-seen ;;\n' +
    `    *turn-done:work-plan*) ${workAct} ;;\n` +
    `    *turn-done:review-plan*) ${reviewAct} ;;\n` +
    `    *turn-done:consolidate-plan*) ${consolidateAct} ;;\n` +
    '  esac\n' +
    'done\n';
  writeFileSync(join(binDir, 'fake-agent'), script, { mode: 0o755 });
}

// LoopDef resolution for e2e: $CLAUDE_CONFIG_DIR/loops/<name>/<name>.yaml, so the committed example
// defs (example/loops, real plan-loop/impl-loop) resolve when CLAUDE_CONFIG_DIR points at example/.
const exampleConfigDir = join(process.cwd(), 'example');

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

// §24.2.3 T7 — a single MANUAL step plus a state.yaml carrying a PR + linked_issues, so the
// ticket/PR refs resolve and surface even though the step is not a loop step. Returns the state.yaml
// path for the test to seed.
function seedRefsFlowRepo(prefix: string): { dir: string; stateFile: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: refs-flow\nsteps:\n  - id: groom\n    kind: manual\n  - id: work\n    kind: loop\n    loop: work-loop\n',
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

// Flow audit record (§25): the run's YAML lands under HOME/.agent-terminal/audit/<repo-basename>/.
const auditDir = (home: string, repo: string): string => join(home, '.agent-terminal', 'audit', basename(repo));
const auditRunFiles = (home: string, repo: string): string[] => {
  const dir = auditDir(home, repo);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')) : [];
};
const readAuditRun = (home: string, repo: string, file: string): { header: unknown; events: AuditEvent[] } =>
  parseAuditStream(readFileSync(join(auditDir(home, repo), file), 'utf8'));

test('flow Start opens an audit run file with a flow.started event (§25.4)', async () => {
  const repo = seedFlowRepo('agent-term-e2e-audit-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click();
  await expect(flowControl()).toHaveText('Advance');

  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);
  const run = readAuditRun(home, repo, auditRunFiles(home, repo)[0]);
  expect(run.header).toMatchObject({ flow: 'groom-flow', repo: basename(repo) });
  expect(run.events.map((e) => e.type)).toContain('flow.started');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// A run file accrues lifecycle events and go-back-after-done appends to the SAME file. (The
// new-file-per-flow:start case is integration-covered in auditRecorder.test: the UI never returns to
// not_started, so a second flow:start is not reachable from the strip.)
test('the audit run accrues lifecycle events and go-back appends to the same file (§25.4)', async () => {
  const repo = seedFlowRepo('agent-term-e2e-audit2-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit2-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start
  await expect(flowControl()).toHaveText('Advance');
  await flowControl().click(); // Advance → done (single step)
  await expect(flowControl()).toHaveText('Restart');

  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);
  await expect
    .poll(() => readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.map((e) => e.type))
    .toEqual(expect.arrayContaining(['flow.started', 'flow.status', 'flow.completed']));

  // Go back after done (Undo) appends to the SAME file — still one file, with the undo's status event.
  await page.locator('#flow-strip .flow-undo').click();
  await expect(flowControl()).toHaveText('Advance');
  expect(auditRunFiles(home, repo)).toHaveLength(1);
  await expect
    .poll(() => readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.filter((e) => e.type === 'flow.status').length)
    .toBe(2); // in_progress→done, then done→in_progress

  // Restart from done also appends to the same file (records its own done→in_progress).
  await flowControl().click(); // Advance → done
  await expect(flowControl()).toHaveText('Restart');
  await flowControl().click(); // Restart → in_progress
  await expect(flowControl()).toHaveText('Advance');
  await expect
    .poll(() => readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.filter((e) => e.type === 'flow.status').length)
    .toBe(4); // + in_progress→done (advance), + done→in_progress (restart)
  expect(auditRunFiles(home, repo)).toHaveLength(1);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('todo edits during an active flow are recorded; none when no flow is active (§25.5)', async () => {
  const repo = seedFlowRepo('agent-term-e2e-audit3-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit3-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  // No flow active yet: a todo edit records nothing (no audit dir for the repo).
  await typeCommand(`cd "${repo}"`);
  await openQuickSend('todo');
  await page.locator('#todo-new').fill('before the flow');
  await page.locator('#todo-add-btn').click();
  await expect(page.locator('.todo').filter({ hasText: 'before the flow' })).toHaveCount(1);
  expect(auditRunFiles(home, repo)).toHaveLength(0);

  // Start the flow → a run opens. Now todo edits accrue todo.* events.
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click();
  await expect(flowControl()).toHaveText('Advance');
  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);

  await page.locator('#todo-new').fill('during the flow');
  await page.locator('#todo-add-btn').click();
  const row = page.locator('.todo').filter({ hasText: 'during the flow' });
  await expect(row).toHaveCount(1);
  await row.locator('.chk').click(); // mark done → todo.status

  await expect
    .poll(() => readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.map((e) => e.type))
    .toEqual(expect.arrayContaining(['todo.created', 'todo.status']));
  // The pre-flow todo was NOT recorded (no created event for it).
  const created = readAuditRun(home, repo, auditRunFiles(home, repo)[0])
    .events.filter((e): e is Extract<AuditEvent, { type: 'todo.created' }> => e.type === 'todo.created')
    .map((e) => e.text);
  expect(created).toContain('during the flow');
  expect(created).not.toContain('before the flow');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// Phase 2 (§25.5): the agent-loop bridge feeds the run. Entering a loop step records the state.yaml
// mirror; a hand-edit (the human driving agent-loop) appends the change live.
test('a loop step records the state.yaml mirror and live edits append loop.status (§25.5)', async () => {
  const { dir: repo, stateFile } = seedLoopFlowRepo('agent-term-e2e-audit-loop-');
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: awaiting-human-pr-approval\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit-loop-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → groom (manual): run opens
  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);
  await flowControl().click(); // Advance → build (loop): the state.yaml mirror is observed

  const file = (): string => auditRunFiles(home, repo)[0];
  await expect
    .poll(() => readAuditRun(home, repo, file()).events.map((e) => e.type))
    .toEqual(expect.arrayContaining(['loop.status', 'loop.iteration', 'pr.assoc']));
  const pr = readAuditRun(home, repo, file()).events.find(
    (e): e is Extract<AuditEvent, { type: 'pr.assoc' }> => e.type === 'pr.assoc',
  );
  expect(pr?.pr).toBe(179);
  // The status change snapshots the .agent-loop/ files (path + bytes) — here state.yaml itself (§25.5).
  const snap = readAuditRun(home, repo, file()).events.find(
    (e): e is Extract<AuditEvent, { type: 'outputs.snapshot' }> => e.type === 'outputs.snapshot',
  );
  expect(snap?.files.map((f) => f.path)).toContain('.agent-loop/state.yaml');

  // A hand-edit of state.yaml (no app action) re-pulls the mirror and appends the status change.
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 11\nstatus: awaiting-human-impl-triage\n');
  await expect
    .poll(() => readAuditRun(home, repo, file()).events.filter((e) => e.type === 'loop.status').length)
    .toBeGreaterThanOrEqual(2);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('resolving a github-ticket input records input.resolved and ticket.assoc (§25.5)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-audit-input-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit-input-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await flowControl().click(); // Start → groom: run opens
  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);
  await flowControl().click(); // Advance → plan (bootstrap): the typed-input modal opens
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  const file = (): string => auditRunFiles(home, repo)[0];
  await expect
    .poll(() => readAuditRun(home, repo, file()).events.map((e) => e.type))
    .toEqual(expect.arrayContaining(['input.resolved', 'ticket.assoc']));
  const resolved = readAuditRun(home, repo, file()).events.find(
    (e): e is Extract<AuditEvent, { type: 'input.resolved' }> => e.type === 'input.resolved',
  );
  expect(resolved).toMatchObject({ name: 'ticket', value: '176' });
  const ticket = readAuditRun(home, repo, file()).events.find(
    (e): e is Extract<AuditEvent, { type: 'ticket.assoc' }> => e.type === 'ticket.assoc',
  );
  expect(ticket?.ticket).toBe(176);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('in-app pickup records a `pickup` command event with its exit (§26.9 / §25.5)', async () => {
  // The retired §24.2.3 T3 injected `agent-loop pickup` (recorded via an OSC-133 span). §26.9 runs
  // pickup out-of-band in the app, so the audit `command` event now comes from the runner directly,
  // with source `pickup` and exit 0 on success (the fake gh/git make it deterministic).
  const repo = seedBootstrapFlowRepo('agent-term-e2e-audit-cmd-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit-cmd-home-'));
  const { binDir } = seedFakeGhGit('agent-term-e2e-cmd-bin-');
  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: join(binDir, 'calls.log'),
    },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await flowControl().click(); // Start → groom: run opens
  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);
  await flowControl().click(); // Advance → plan (bootstrap): the typed-input modal opens
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  const file = (): string => auditRunFiles(home, repo)[0];
  await expect
    .poll(() => readAuditRun(home, repo, file()).events.filter((e) => e.type === 'command').length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  const cmd = readAuditRun(home, repo, file()).events.find(
    (e): e is Extract<AuditEvent, { type: 'command' }> => e.type === 'command',
  );
  expect(cmd?.source).toBe('pickup');
  expect(cmd?.cmd).toContain('176');
  expect(cmd?.exit).toBe(0); // fake gh/git succeed, so the pickup reports success

  await app.close();
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

test('entering a bootstrap loop step prompts for its input; Confirm runs in-app pickup: state.yaml + draft PR, mirror plan-draft, nothing injected (§26.9 / L1)', async () => {
  // L1 — the app OWNS state.yaml and bootstraps in-app. Confirm runs pickup (gh/git, driven by the real
  // plan-loop pickup_contract), opening a draft PR and WRITING the initial whole-document v4 state.yaml;
  // the T2 mirror renders plan-draft. The retired §24.2.3 T3 `agent-loop pickup` is NOT injected.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-l1boot-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-l1boot-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l1-bin-');
  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
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
  await expect(inputModal()).toHaveCount(0);

  // Land: a whole-document valid-v4 state.yaml is app-written (status plan-draft, bound_loop plan-loop).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''), { timeout: 15_000 }).toContain('status: plan-draft');
  const stateText = readFileSync(stateFile, 'utf8');
  expect(stateText).toContain('bound_loop: plan-loop');
  expect(stateText).toContain('schema_version: 4');

  // Land: a draft PR was opened (recorded by the fake gh), and pickup forked the templated branch.
  const calls = readFileSync(logFile, 'utf8');
  expect(calls).toContain('gh pr create --draft');
  expect(calls).toContain('git push -u origin plan-loop/issue-176');

  // Land: the T2 mirror renders the freshly-written state live (the watcher re-pull after the write) —
  // the rail read-out shows the tone + iteration, and the docked panel the exact v4 status string.
  await expect(loopReadout()).toContainText('iter 1', { timeout: 10_000 });
  await loopReadout().click();
  await expect(loopPanel()).toContainText('plan-draft', { timeout: 10_000 });

  // The retired T3 command is never typed into the PTY.
  await expect(termRows()).not.toContainText('agent-loop pickup');

  // The resolved input still persists to flow-state.yaml so it threads to later steps (§18.3).
  await expect.poll(() => readFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'utf8'), { timeout: 10_000 }).toContain('176');

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a busy shell does NOT block pickup: it runs out-of-band and still writes state.yaml (§26.2 / §26.6)', async () => {
  // §26 redefines "injectable" and runs pickup out-of-band (gh/git, not terminal injection), so unlike
  // the retired T3 injection a busy foreground process must NOT refuse it: state.yaml is still written.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-bootbusy-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-bootbusy-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-busy-bin-');
  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await flowControl().click(); // Start → groom

  // A live foreground process holds the shell off its ready prompt → busy (a live OSC-133 span).
  await typeCommand('echo BUSY_NOW; cat');
  await expect(termRows()).toContainText('BUSY_NOW');

  await flowControl().click(); // Advance → plan: the modal still prompts
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  // Out-of-band: pickup runs despite the busy shell — state.yaml gets written, no busy refusal, and
  // nothing is typed into the (busy) PTY.
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''), { timeout: 15_000 }).toContain('status: plan-draft');
  // No §19.3 busy refusal is raised for pickup (it is out-of-band), so the transient notice never shows.
  await expect(page.locator('#flow-strip .flow-notice')).toHaveCount(0);
  await expect(termRows()).not.toContainText('agent-loop pickup');

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26.13 / L2 — one work-agent turn + completion detection. The shared sequence: cd into the repo,
// launch the fake-agent REPL as the foreground program, then drive the flow into the bootstrap loop
// step. After pickup writes plan-draft (§26.9/L1) the orchestrator injects the work-plan prompt into
// the fake-agent and advances on the done-signal + plan.md (§26.3/D47a), retrying once then `error`.
async function driveToWorkTurn(
  repo: string,
  home: string,
  binDir: string,
  logFile: string,
  turnTimeoutMs: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: turnTimeoutMs,
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      ...extraEnv,
    },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await typeCommand('fake-agent'); // the hosted agent REPL now owns the prompt; injection reaches it

  await flowControl().click(); // Start → groom: opens the audit run
  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);
  await flowControl().click(); // Advance → plan (loop, bootstrap): the typed-input modal opens
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();
  await expect(inputModal()).toHaveCount(0);

  // Bootstrap landed: pickup wrote plan-draft, so the work turn is now requested + injected.
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''), { timeout: 15_000 }).toContain('status: plan-draft');
}

const turnEvents = (home: string, repo: string): Array<Extract<AuditEvent, { type: 'command' }>> => {
  const files = auditRunFiles(home, repo);
  if (files.length === 0) return [];
  return readAuditRun(home, repo, files[0]).events.filter(
    (e): e is Extract<AuditEvent, { type: 'command' }> => e.type === 'command' && e.source === 'turn',
  );
};

test('a work-agent turn injected after pickup advances on plan.md + the done-signal (§26.13 / L2)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l2-ok-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l2-ok-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l2-ok-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' }); // full chain: work → reviewers → consolidate
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  // Land: the fake-agent received the injected work-plan prompt and wrote plan.md, and the orchestrator
  // detected the done-signal and recorded the turn complete (exit 0) — never auto-erroring.
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'plan.md')), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => turnEvents(home, repo).map((e) => ({ cmd: e.cmd, exit: e.exit })), { timeout: 20_000 }).toEqual(
    expect.arrayContaining([expect.objectContaining({ exit: 0 })]),
  );
  expect(turnEvents(home, repo).some((e) => e.cmd.includes('complete'))).toBe(true);
  expect(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')).not.toContain('status: error');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a work turn that emits no done-signal retries once then stops in error (§26.13 / L2 / D48)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l2-err-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l2-err-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l2-err-bin-');
  seedFakeAgent(binDir, { work: 'noop' }); // produces nothing — no artifact, no done-signal
  await driveToWorkTurn(repo, home, binDir, logFile, '2500'); // short timeout so two attempts elapse fast

  // Land: after the initial attempt + one retry both time out, the run is written to `error` and the
  // turn failure is recorded (exit 1). The mirror renders the app-only error status.
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 20_000 }).toContain('status: error');
  expect(turnEvents(home, repo).some((e) => e.cmd.includes('failed') && e.exit === 1)).toBe(true);
  await loopReadout().click();
  await expect(loopPanel()).toContainText('error', { timeout: 10_000 });

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('the loop panel "mark turn complete" control advances a sentinel-less turn (§26.13 / L2 / D47a c)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l2-mark-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l2-mark-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l2-mark-bin-');
  seedFakeAgent(binDir, { work: 'plan-only', reviews: 'all', consolidate: 'clean' }); // plan.md but NO work signal; the chain settles after the manual advance
  await driveToWorkTurn(repo, home, binDir, logFile, '60000'); // long timeout: no auto-error races the click

  // The artifact is present but no done-signal fired, so the turn sits in flight. The operator's manual
  // control advances it: open the docked panel and click "mark turn complete".
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'plan.md')), { timeout: 20_000 }).toBe(true);
  expect(turnEvents(home, repo).length).toBe(0); // not yet completed automatically
  await loopReadout().click();
  await loopPanel().locator('[data-loop-mark-complete]').click();

  // Land: the manual override completes the turn (exit 0), and the run never errors.
  await expect.poll(() => turnEvents(home, repo).some((e) => e.cmd.includes('complete') && e.exit === 0), { timeout: 15_000 }).toBe(true);
  expect(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')).not.toContain('status: error');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a work turn completes on the turn-done FILE alone, with no sentinel line (§26.13 / L2 / D47a)', async () => {
  // §26.3/D47a's done-signal is "the sentinel LINE OR the turn-done FILE". The other L2 happy-path tests
  // emit both, so the file-watch path is never proven alone. Here the fake-agent writes plan.md and the
  // turn-done file but prints NO sentinel line, so completion can ONLY come via watchTurnDone.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l2-fileonly-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l2-fileonly-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l2-fileonly-bin-');
  seedFakeAgent(binDir, { work: 'file-only', reviews: 'all', consolidate: 'clean' });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'plan.md')), { timeout: 20_000 }).toBe(true);
  await expect
    .poll(() => turnEvents(home, repo).some((e) => e.cmd.includes('work-plan') && e.cmd.includes('complete') && e.exit === 0), {
      timeout: 20_000,
    })
    .toBe(true);
  expect(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')).not.toContain('status: error');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// The reviews/<iter> directory for the plan phase's fan-out (§26.4).
const reviewsDir = (repo: string): string => join(repo, '.agent-loop', 'reviews', '1');

test('the work turn chains into the reviewer fan-out; all persona JSONs advance it (§26.13 / L3)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l3-ok-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l3-ok-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l3-ok-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  // Land: the work turn completes on plan.md, then the orchestrator injects the spawn-reviewers prompt;
  // the fake-agent writes every roster persona's review JSON and the fan-out turn advances (exit 0).
  await expect.poll(() => existsSync(join(reviewsDir(repo), 'review-contracts.json')), { timeout: 20_000 }).toBe(true);
  for (const p of PLAN_PERSONAS) expect(existsSync(join(reviewsDir(repo), `${p}.json`))).toBe(true);
  await expect
    .poll(() => turnEvents(home, repo).some((e) => e.cmd.includes('review-plan') && e.cmd.includes('complete') && e.exit === 0), {
      timeout: 20_000,
    })
    .toBe(true);
  expect(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')).not.toContain('status: error');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a reviewer fan-out missing one persona JSON retries once then stops in error (§26.13 / L3 / D48)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l3-err-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l3-err-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l3-err-bin-');
  // The work turn completes cleanly; the reviewers turn writes only five of six persona JSONs.
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'missing' });
  await driveToWorkTurn(repo, home, binDir, logFile, '2500'); // short timeout so the two reviewer attempts elapse fast

  // Land: the fan-out is incomplete every attempt, so after retry the run stops in error and the loop
  // panel raises it. The missing persona never appears; the failed turn is recorded (exit 1).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 25_000 }).toContain('status: error');
  expect(existsSync(join(reviewsDir(repo), 'review-contracts.json'))).toBe(false);
  expect(turnEvents(home, repo).some((e) => e.cmd.includes('review-plan') && e.cmd.includes('failed') && e.exit === 1)).toBe(true);
  await loopReadout().click();
  await expect(loopPanel()).toContainText('error', { timeout: 10_000 });

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('the fan-out chains into consolidate; a clean verdict stops at the plan-approval gate (§26.13 / L4)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l4-clean-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l4-clean-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l4-clean-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  // Land: work → reviewers → /clear → consolidate writes a clean verdict → the orchestrator advances the
  // run to the phase's post-clean human gate and STOPs (it does not re-iterate to a second iteration).
  await expect.poll(() => existsSync(join(reviewsDir(repo), 'consolidated.json')), { timeout: 25_000 }).toBe(true);
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 25_000 })
    .toContain('status: awaiting-human-plan-approval');
  expect(readFileSync(stateFile, 'utf8')).toContain('iteration: 1'); // stopped, never re-iterated
  expect(readFileSync(stateFile, 'utf8')).not.toContain('status: error');
  // The orchestrator injected a /clear at the reviewers→consolidate boundary (D46): the fake instance
  // received it and recorded the marker (the terminal echo scrolls out of view behind the next prompt).
  expect(existsSync(join(repo, '.agent-loop', 'clear-seen'))).toBe(true);
  // The gate status is human-needed, so the docked panel renders the exact awaiting-human status string.
  await loopReadout().click();
  await expect(loopPanel()).toContainText('awaiting-human-plan-approval', { timeout: 10_000 });

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a needs-work verdict /clears and re-iterates to the next iteration (§26.13 / L4)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l4-needswork-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l4-needswork-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l4-needswork-bin-');
  // Every consolidate verdict is needs-work, so each iteration re-iterates; the run climbs past iter 1.
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'needs-work' });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  // Land: the first iteration's consolidate returns needs-work → the orchestrator writes the next
  // iteration and re-runs the work→reviewers→consolidate cycle, so a second iteration's consolidated.json
  // appears. It re-iterated rather than taking the clean branch (the post-clean approval gate), and never
  // errored. (At the def's iteration cap the run then routes to the triage gate, §26.8 — asserted by L6.)
  await expect
    .poll(() => existsSync(join(repo, '.agent-loop', 'reviews', '2', 'consolidated.json')), { timeout: 30_000 })
    .toBe(true);
  const stateText = readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8');
  expect(stateText).not.toContain('status: error');
  expect(stateText).not.toContain('awaiting-human-plan-approval'); // never took the clean branch
  // The /clear at the consolidate→re-iterate boundary (D46) reached the instance before the re-run.
  expect(existsSync(join(repo, '.agent-loop', 'clear-seen'))).toBe(true);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a needs-work verdict at the iteration cap routes to the plan-triage gate (§26.13 / L6)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l6-cap-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l6-cap-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l6-cap-bin-');
  // Every consolidate is needs-work. plan-loop's exit_predicate.severity_cap is 2: iteration 1 (below the
  // cap) re-iterates; iteration 2 (at the cap) routes a needs-work verdict to the triage gate (§26.8).
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'needs-work' });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 40_000 })
    .toContain('status: awaiting-human-plan-triage');
  const stateText = readFileSync(stateFile, 'utf8');
  expect(stateText).toContain('iteration: 2'); // reached the cap, then STOPped for the human
  expect(stateText).not.toContain('status: error');
  // The triage gate is a human-needed status, so the docked panel raises it with its option buttons.
  await loopReadout().click();
  await expect(loopPanel()).toContainText('awaiting-human-plan-triage', { timeout: 10_000 });

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a persona clean last iteration with an unchanged plan is pruned; its review is reused (§26.13 / L6 / §26.5)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l6-skip-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l6-skip-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l6-skip-bin-');
  // Every consolidate is needs-work (drives iteration 1 → 2) with the personas reviewing clean and the
  // work-agent writing an IDENTICAL plan.md each iteration. So on iteration 2 every persona is clean-at-1
  // with an unchanged plan digest → all pruned: the fan-out is skipped and iteration 1's reviews are
  // carried forward. Observable: reviews/2/<persona>.json keeps the iteration-1 stamp (reused, not re-run).
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'needs-work' });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  // Iteration 2 was reached (its consolidated.json exists) and its persona reviews are the reused ones.
  await expect
    .poll(() => existsSync(join(repo, '.agent-loop', 'reviews', '2', 'consolidated.json')), { timeout: 40_000 })
    .toBe(true);
  const reused = readFileSync(join(repo, '.agent-loop', 'reviews', '2', 'review-principal.json'), 'utf8');
  expect(reused).toContain('"seen_iter":1'); // carried forward from iteration 1, not freshly reviewed at 2
  // persona_state recorded the clean personas' skip footprints (§26.5).
  expect(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')).toContain('persona_state');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('two consecutive iterations with an identical finding signature flag the run stuck (§26.13 / L6 / §26.8)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l6-stuck-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l6-stuck-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l6-stuck-bin-');
  // needs-work every iteration with a STABLE finding: iteration 1 signs the finding once; iteration 2
  // signs the identical finding, so the signature repeats (x2) and the stuck detector flags it (§26.8) —
  // observable as impasse.consecutive_identical: 2 persisted in state.yaml, and a STOP at the triage gate.
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'needs-work', findings: 'stable' });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 40_000 })
    .toContain('consecutive_identical: 2');
  const stateText = readFileSync(stateFile, 'utf8');
  expect(stateText).toContain('last_findings_sig:'); // the running signature is persisted
  expect(stateText).toContain('status: awaiting-human-plan-triage'); // stuck STOPs for the human
  expect(stateText).not.toContain('status: error');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('request-changes activates phase-2; the next needs-work verdict routes to the triage gate (§26.13 / L6)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l6-phase2-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l6-phase2-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l6-phase2-bin-');
  // Iteration 1 consolidates clean → the plan-approval gate. request-changes sets phase2_active and
  // re-iterates; on iteration 2 the fake now consolidates needs-work (phase-2 is active), so the
  // orchestrator routes to the triage gate instead of auto-iterating (§26.6).
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', phase2Consolidate: 'needs-work' });
  await driveToPlanGate(repo, home, binDir, logFile);

  await gateButton('request-changes').click();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 40_000 })
    .toContain('status: awaiting-human-plan-triage');
  const stateText = readFileSync(stateFile, 'utf8');
  expect(stateText).toContain('phase2_active: true');
  expect(stateText).not.toContain('status: error');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26.13 / L5 — the human's gate decision, executed app-internally. Drive to the plan-approval gate
// (clean verdict), open the docked panel, click a gate button, and assert the transition + gh side-effect.
const gateButton = (option: string) => loopPanel().locator(`[data-gate-option="${option}"]`);

async function driveToPlanGate(repo: string, home: string, binDir: string, logFile: string): Promise<void> {
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 25_000 })
    .toContain('status: awaiting-human-plan-approval');
  await loopReadout().click();
  await expect(gateButton('approve')).toBeVisible({ timeout: 10_000 });
}

test('approve at the plan gate marks the PR ready and terminates the loop (§26.13 / L5)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l5-approve-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l5-approve-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l5-approve-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToPlanGate(repo, home, binDir, logFile);

  await gateButton('approve').click();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 15_000 }).toContain('status: plan-human-approved');
  expect(readFileSync(stateFile, 'utf8')).toContain('terminated: true');
  // The gate's mark-pr-ready action ran out of band (§26.6/D53): the fake gh recorded `pr ready`.
  await expect.poll(() => readFileSync(logFile, 'utf8'), { timeout: 10_000 }).toContain('pr ready');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('request-changes at the plan gate writes a human note, sets phase2, and re-iterates (§26.13 / L5)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l5-changes-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l5-changes-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l5-changes-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToPlanGate(repo, home, binDir, logFile);

  await gateButton('request-changes').click();

  // Land: the note is written for the critiqued iteration, phase2 is activated, and the loop re-iterates
  // (a second iteration's consolidated.json appears). No PR is readied (request-changes has no such action).
  await expect
    .poll(() => existsSync(join(repo, '.agent-loop', 'human-notes', '1.md')), { timeout: 15_000 })
    .toBe(true);
  await expect
    .poll(() => existsSync(join(repo, '.agent-loop', 'reviews', '2', 'consolidated.json')), { timeout: 30_000 })
    .toBe(true);
  const stateText = readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8');
  expect(stateText).toContain('phase2_active: true');
  expect(stateText).toContain('iteration: 2');
  expect(readFileSync(logFile, 'utf8')).not.toContain('pr ready');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('impasse at the plan gate terminates the loop at the impasse status (§26.13 / L5)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l5-impasse-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l5-impasse-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l5-impasse-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToPlanGate(repo, home, binDir, logFile);

  await gateButton('impasse').click();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 15_000 }).toContain('status: impasse');
  expect(readFileSync(stateFile, 'utf8')).toContain('terminated: true');
  expect(existsSync(join(repo, '.agent-loop', 'human-notes', '1.md'))).toBe(true);
  expect(readFileSync(logFile, 'utf8')).not.toContain('pr ready');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26.13 / L8 — epic-promote. The work-agent classifies the plan an epic (three sub-tickets) in plan.md;
// approving at the plan gate reuses the current PR for sub-ticket-1 and creates the remaining N-1 (=2)
// sub-issues out of band, appending them to linked_issues + recording `epic` in state.yaml.
test('approve on an epic plan creates N-1 sub-issues and records epic in state.yaml (§26.13 / L8)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l8-epic-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l8-epic-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l8-epic-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', epicPlan: true });
  await driveToPlanGate(repo, home, binDir, logFile);

  await gateButton('approve').click();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 15_000 }).toContain('status: plan-human-approved');
  const stateText = readFileSync(stateFile, 'utf8');
  // Epic-promote created the N-1 sub-issues (Slice one reuses the current PR) and recorded them.
  expect(stateText).toContain('epic:');
  expect(stateText).toContain('sub_issues:');
  expect(stateText).toContain('terminated: true');
  // The two created issue numbers (501, 502 from the fake-gh counter) are appended to linked_issues.
  expect(stateText).toContain('- 501');
  expect(stateText).toContain('- 502');
  // Exactly the two remaining sub-tickets were created out of band (sub-ticket-1 reused the PR).
  const calls = readFileSync(logFile, 'utf8');
  const creates = calls.split('\n').filter((l) => l.startsWith('gh issue create'));
  expect(creates).toHaveLength(2);
  expect(calls).toContain('--title Slice two');
  expect(calls).toContain('--title Slice three');
  expect(calls).not.toContain('--title Slice one');
  // The plan-approval mark-pr-ready still ran.
  expect(calls).toContain('pr ready');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26.13 / L7 — the cost meter. The fake-agent writes a deterministic session-JSONL token fixture at a
// test-controlled log root ($APP_SESSION_LOG_ROOT); completing an iteration prices those tokens against the
// checked-in table, surfaces the dollars on the status-strip loop read-out, and records a §25 cost event.
test('completing an iteration prices the fixture tokens: strip readout + audit cost event (§26.13 / L7)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l7-cost-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l7-cost-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l7-cost-bin-');
  const logRoot = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l7-cost-logs-'));
  // A clean verdict stops at the plan-approval gate on iteration 1 — one completed iteration. The work turn
  // writes 1,000,000 claude-sonnet-5 input tokens → exactly $3.00 against the pricing table.
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', costFixture: true });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000', { APP_SESSION_LOG_ROOT: logRoot });

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 25_000 })
    .toContain('status: awaiting-human-plan-approval');
  // Land (state): the iteration boundary persisted the priced cost into the app-owned extension.
  expect(readFileSync(stateFile, 'utf8')).toContain('usd: 3');

  // Land (strip): the compact loop read-out shows the priced dollars ($3.00), formatted by the meter.
  await expect(loopReadout().locator('.loop-cost')).toHaveText('$3.00', { timeout: 15_000 });

  // Land (audit): the run's YAML carries the per-iteration cost event with the priced dollars.
  const costEvents = readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.filter(
    (e): e is Extract<AuditEvent, { type: 'loop.cost' }> => e.type === 'loop.cost',
  );
  expect(costEvents).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'loop.cost', iteration: 1, usd: 3, unpriced: [] })]),
  );

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(logRoot, { recursive: true, force: true });
});

// §26.13 / L8 — CI runs, it does not block (§26.7). At the iteration boundary the app takes a best-effort,
// NON-BLOCKING `gh pr checks` snapshot of the non-draft PR and records it (display-only). A pending check
// must not stall the loop: it still reaches its gate on the same iteration, and the snapshot is recorded.
test('completing an iteration snapshots CI without blocking; records a loop.ci audit event (§26.13 / L8)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l8-ci-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l8-ci-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l8-ci-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  // Hold the `gh pr checks` RESULT back 5s (the invocation still logs immediately). A blocking snapshot
  // implementation could not reach the gate until that delay elapsed AND would record loop.ci by then;
  // the fire-and-forget one reaches the gate at once, with loop.ci landing only after the delay.
  await driveToWorkTurn(repo, home, binDir, logFile, '30000', { FAKE_GH_CHECKS_DELAY: '5' });

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  // Land (no block): despite `gh pr checks` reporting a pending check AND being held back 5s, the clean
  // iteration still reached the plan-approval gate on iteration 1 — the loop never waited on CI (§26.7).
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 25_000 })
    .toContain('status: awaiting-human-plan-approval');
  expect(readFileSync(stateFile, 'utf8')).toContain('iteration: 1');

  // Teeth for "without blocking": at the moment the gate is reached the snapshot is still in flight, so no
  // loop.ci event exists yet — a blocking impl would have recorded it before advancing. (`gh pr checks` was
  // already invoked — it logs before the delay — proving the snapshot fired, just hasn't returned.)
  await expect.poll(() => readFileSync(logFile, 'utf8'), { timeout: 10_000 }).toContain('pr checks');
  expect(
    readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.filter((e) => e.type === 'loop.ci'),
  ).toEqual([]);

  // Land (snapshot): once the held-back `gh pr checks` returns, the best-effort loop.ci event is recorded
  // with the current bucket counts (one pass, one pending).
  await expect
    .poll(
      () =>
        readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.filter((e) => e.type === 'loop.ci'),
      { timeout: 15_000 },
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'loop.ci', iteration: 1, total: 2, passed: 1, failed: 0, pending: 1 }),
      ]),
    );

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26.13 / L8 — auto-resume from state.yaml. A run interrupted mid-iteration (plan.md + all reviews on
// disk, consolidated absent) is resumed on launch at the consolidate turn — NOT re-running the completed
// work/reviewers turns. Proven on a real relaunch: the app launches into the repo (APP_LAUNCH_DIR) with the
// fake-agent AS the shell (APP_SHELL) so the resumed turn injects into the agent, and the run drives forward
// to its plan-approval gate while the work/reviewers execution markers stay absent (no double-execution).
function seedResumeRepo(
  prefix: string,
  opts: { iteration?: number; reviews?: 'all' | 'none'; consolidated?: boolean } = {},
): string {
  const iteration = opts.iteration ?? 1;
  const reviews = opts.reviews ?? 'all';
  const repo = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(repo, '.agent-loop', 'reviews', String(iteration)), { recursive: true });
  writeFileSync(
    join(repo, '.agent-loop', 'state.yaml'),
    [
      'schema_version: 4',
      'status: plan-draft',
      `iteration: ${iteration}`,
      'bound_loop: plan-loop',
      'pr: 4242',
      'branch: plan-loop/issue-176',
      'linked_issues:',
      '  - 176',
      'phase2_active: false',
      'persona_state: {}',
      'impasse: {}',
      'sessions: {}',
      'terminated: false',
      '',
    ].join('\n'),
  );
  // plan.md is always on disk (it is rewritten in place, so it can be stale from a prior iteration). What
  // varies is the iteration-scoped downstream evidence — reviews and the consolidated verdict.
  writeFileSync(join(repo, '.agent-loop', 'plan.md'), '# Plan\n\ninterrupted mid-run\n');
  if (reviews === 'all') {
    for (const p of PLAN_PERSONAS) {
      writeFileSync(join(repo, '.agent-loop', 'reviews', String(iteration), `${p}.json`), `{"verdict":"clean","seen_iter":${iteration}}`);
    }
  }
  if (opts.consolidated) {
    writeFileSync(join(repo, '.agent-loop', 'reviews', String(iteration), 'consolidated.json'), '{"verdict":"clean","findings_kept":[]}');
  }
  return repo;
}

test('an interrupted run resumes at the consolidate turn on launch without re-running completed turns (§26.13 / L8)', async () => {
  const repo = seedResumeRepo('agent-term-e2e-l8-resume-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l8-resume-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l8-resume-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', turnMarkers: true });

  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      // The fake-agent IS the shell, so the resumed turn injects straight into the agent REPL (no bash to
      // race). The app launches into the repo, so resumeLoop reads its state.yaml on startup.
      APP_SHELL: join(binDir, 'fake-agent'),
      APP_LAUNCH_DIR: repo,
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '30000',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
  page = await app.firstWindow();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  // Land (resumed forward): the consolidate turn ran, wrote consolidated.json, and the clean verdict drove
  // the run to its plan-approval gate — all from a cold launch, with no human action.
  await expect
    .poll(() => existsSync(join(repo, '.agent-loop', 'reviews', '1', 'consolidated.json')), { timeout: 25_000 })
    .toBe(true);
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 25_000 })
    .toContain('status: awaiting-human-plan-approval');
  expect(readFileSync(stateFile, 'utf8')).toContain('iteration: 1');

  // Land (no double-execution): the consolidate turn ran exactly once; the already-complete work and
  // reviewers turns were NOT re-run (their execution markers never appear).
  expect(existsSync(join(repo, '.agent-loop', 'consolidate-ran'))).toBe(true);
  expect(existsSync(join(repo, '.agent-loop', 'work-ran'))).toBe(false);
  expect(existsSync(join(repo, '.agent-loop', 'reviewers-ran'))).toBe(false);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26.13 / L8 — a re-iteration interrupted BEFORE its work turn rewrote plan.md leaves a stale prior-iteration
// plan.md with no iteration-scoped review for the new iteration. Resume must re-enter WORK (regenerating the
// plan), never skip to reviewers and grade the stale plan — plan.md is not iteration-stamped, so only a
// downstream artifact for the current iteration proves the work turn ran.
test('resume re-enters the work turn when a re-iteration has a stale plan but no review for the new iteration (§26.13 / L8)', async () => {
  const repo = seedResumeRepo('agent-term-e2e-l8-resume-stale-', { iteration: 2, reviews: 'none' });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l8-resume-stale-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l8-resume-stale-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', turnMarkers: true });

  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: join(binDir, 'fake-agent'),
      APP_LAUNCH_DIR: repo,
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '30000',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
  page = await app.firstWindow();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  // Land: the WORK turn ran this session (its marker appears) — resume did NOT skip to reviewers on the
  // stale plan — and the freshly-produced iteration drove forward to the plan-approval gate.
  await expect
    .poll(() => existsSync(join(repo, '.agent-loop', 'work-ran')), { timeout: 25_000 })
    .toBe(true);
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 25_000 })
    .toContain('status: awaiting-human-plan-approval');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26.13 / L8 — an interrupted run whose work, reviewers AND consolidate turns all completed (every
// iteration artifact on disk, including consolidated.json) resumes straight into the post-consolidate
// verdict branch: it re-injects NO turn, reads the recorded clean verdict, and drives to the gate.
test('resume runs only the post-consolidate branch when every iteration artifact already exists (§26.13 / L8)', async () => {
  const repo = seedResumeRepo('agent-term-e2e-l8-resume-post-', { iteration: 1, reviews: 'all', consolidated: true });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l8-resume-post-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l8-resume-post-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', turnMarkers: true });

  await app.close();
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: join(binDir, 'fake-agent'),
      APP_LAUNCH_DIR: repo,
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '30000',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
  page = await app.firstWindow();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  // Land: the recorded clean verdict drove the run to its gate with NO turn re-injected — every turn
  // marker stays absent (work/reviewers/consolidate all already complete on disk).
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 25_000 })
    .toContain('status: awaiting-human-plan-approval');
  expect(existsSync(join(repo, '.agent-loop', 'work-ran'))).toBe(false);
  expect(existsSync(join(repo, '.agent-loop', 'reviewers-ran'))).toBe(false);
  expect(existsSync(join(repo, '.agent-loop', 'consolidate-ran'))).toBe(false);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('Restart clears a resolved stage-transition input so the next entry re-prompts (§24.2.3 T3)', async () => {
  // The user supplies the plan step's ticket once; after completing and Restarting the flow, the
  // ticket must be re-requested — Restart wipes resolved inputs (unlike Undo).
  const repo = seedBootstrapFlowRepo('agent-term-e2e-restart-reprompt-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-restart-reprompt-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });

  await flowControl().click(); // Start → groom (manual, no prompt)
  await flowControl().click(); // Advance → plan (bootstrap): the typed-input modal opens
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();
  await expect(inputModal()).toHaveCount(0);
  // The resolved input persists to flow-state.yaml (no CLAUDE_CONFIG_DIR here, so pickup itself no-ops —
  // this test isolates the Restart-clears-input behavior, not the pickup side-effects).
  await expect
    .poll(() => readFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'utf8'), { timeout: 10_000 })
    .toContain('176');

  await flowControl().click(); // Advance → done (plan is the last step)
  await expect(flowControl()).toHaveText('Restart', { timeout: 10_000 });

  await flowControl().click(); // Restart → back to groom, with the resolved ticket wiped
  await expect(flowStepName()).toHaveText('groom');
  // The cleared input is persisted: flow-state.yaml no longer carries the stale ticket.
  await expect
    .poll(() => readFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'utf8'), { timeout: 10_000 })
    .not.toContain('176');

  await flowControl().click(); // Advance → plan again: because the input was cleared, the modal re-prompts
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await expect(inputModal().locator('.field .nm')).toHaveText('ticket');

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('loop-derived ticket + PR surface only once the flow enters the loop step (§24.2.3 T7)', async () => {
  // The loop's linked_issues ticket and state.yaml PR are agent-loop state: progress-gated, they stay
  // hidden on the pre-loop manual step and appear only once the flow enters a loop step (§24.2.3 T7).
  const { dir: repo, stateFile } = seedRefsFlowRepo('agent-term-e2e-refs-');
  writeFileSync(
    stateFile,
    'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: planning\nlinked_issues:\n  - 25\n',
  );
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refs-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → in_progress on the manual `groom` step
  await expect(flowStepName()).toHaveText('groom');
  // The loop step has not been entered, so nothing loop-derived shows — even though state.yaml carries it.
  await expect(loopReadout()).toHaveCount(0);

  await flowControl().click(); // Advance → enter the `work` loop step
  await expect(loopReadout()).toBeVisible({ timeout: 10_000 });
  // The docked popout's "Working on" section now carries the loop's ticket + PR (bare numbers, since the
  // temp repo is not on GitHub for gh to resolve titles/links).
  await loopReadout().click();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);
  await expect(loopPanel()).toContainText('Working on');
  const ticketRow = loopPanel().locator('.refs .rrow', { has: page.locator('.rk', { hasText: 'Ticket' }) });
  const prRow = loopPanel().locator('.refs .rrow', { has: page.locator('.rk', { hasText: 'PR' }) });
  await expect(ticketRow).toContainText('#25');
  await expect(prRow).toContainText('#179');

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('Terminate clears the ticket/PR display even though state.yaml still carries the loop (§24.2.3 T7)', async () => {
  // The prior run's PR/ticket lives on in the read-only state.yaml; Terminate resets the flow to its
  // first step, closing the loop-step gate, so the rail read-out and docked popout empty (loop
  // dismissed, not deleted).
  const { dir: repo, stateFile } = seedRefsFlowRepo('agent-term-e2e-refs-term-');
  writeFileSync(
    stateFile,
    'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: planning\nlinked_issues:\n  - 25\n',
  );
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refs-term-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → groom (manual)
  await flowControl().click(); // Advance → work (loop): the display appears
  await expect(loopReadout()).toBeVisible({ timeout: 10_000 });
  await loopReadout().click(); // open the docked popout
  await expect(loopPanel()).toContainText('Working on');

  await flowTerminate().click();
  await expect(confirmModal()).toBeVisible();
  await confirmModal().locator('.confirm').click();

  // Back at Not started: the loop step is no longer entered, so the display is gone — read-out removed,
  // popout closed and emptied — despite state.yaml still holding the PR.
  await expect(flowControl()).toHaveText('Start');
  await expect(loopReadout()).toHaveCount(0);
  await expect(page.locator('#app')).not.toHaveClass(/\bloop-open\b/);
  await expect(loopPanel()).not.toContainText('Working on');
  expect(readFileSync(stateFile, 'utf8')).toContain('pr: 179'); // the read-only mirror is untouched

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('Restart clears the ticket/PR display until the flow re-enters a loop step (§24.2.3 T7)', async () => {
  // Restart returns the flow to its first step, closing the loop-step gate; the display clears with no
  // state.yaml write and returns only once the flow re-enters the loop step — then reflecting whatever
  // loop state.yaml now holds (a fresh pickup).
  const { dir: repo, stateFile } = seedRefsFlowRepo('agent-term-e2e-refs-restart-');
  writeFileSync(
    stateFile,
    'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: planning\nlinked_issues:\n  - 25\n',
  );
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refs-restart-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → groom (manual)
  await flowControl().click(); // Advance → work (loop): the display appears
  await expect(loopReadout()).toBeVisible({ timeout: 10_000 });
  await flowControl().click(); // Advance → done (past the last step)
  await expect(flowControl()).toHaveText('Restart');
  await expect(loopReadout()).toBeVisible(); // still shown at done — the loop step was entered this run

  await flowControl().click(); // Restart → in_progress at the groom step
  await expect(flowStepName()).toHaveText('groom');
  await expect(loopReadout()).toHaveCount(0); // cleared — the loop step is no longer entered

  // A fresh pickup rewrites state.yaml; re-entering the loop step shows the NEW ticket/PR.
  writeFileSync(
    stateFile,
    'schema_version: 4\npr: 200\nbranch: agent-loop/issue-42\niteration: 1\nstatus: planning\nlinked_issues:\n  - 42\n',
  );
  await flowControl().click(); // Advance → work (loop): the new loop's display appears
  await expect(loopReadout()).toBeVisible({ timeout: 10_000 });
  await loopReadout().click();
  await expect(loopPanel()).toContainText('Working on');
  const ticketRow = loopPanel().locator('.refs .rrow', { has: page.locator('.rk', { hasText: 'Ticket' }) });
  const prRow = loopPanel().locator('.refs .rrow', { has: page.locator('.rk', { hasText: 'PR' }) });
  await expect(ticketRow).toContainText('#42');
  await expect(prRow).toContainText('#200');

  await app.close();
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
  // Rail: [Not started] · groom · build · [Completed]. Although state.yaml carries a PR, the
  // loop-derived display is progress-gated (§24.2.3 T7): the pre-loop manual `groom` step shows no
  // read-out at all, so there is certainly no loop STATUS pill (`.spill`) yet.
  await expect(page.locator('#flow-strip .flow.vert .stn')).toHaveCount(4, { timeout: 10_000 });
  await expect(flowStation(2).locator('.nm')).toHaveText('build');
  await expect(loopReadout().locator('.spill')).toHaveCount(0);

  await flowControl().click(); // Start → groom (manual): the loop step is not entered, so no read-out
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(loopReadout().locator('.spill')).toHaveCount(0);

  await flowControl().click(); // Advance → build (loop): the compact Loop STATUS read-out appears
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
  // Cold-start, the active-detection pipeline (busy loop output → shadow → agent-active → chip) is
  // occasionally bimodal — it either flips 'working' within a few seconds or races into a quiet-classified
  // start that never flips; the latter is a pre-existing flake this assertion retries out of (§8.3).
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('working', { timeout: 15_000 });

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

// ---- #26: Terminate — abandon a flow, resetting it to Not started ----

const flowTerminate = () => page.locator('#flow-strip .flow-terminate');
const confirmModal = () => page.locator('#flow-confirm-host .flow-modal');

test('Terminate abandons the flow: resets to Not started, clears todos + capture + audit (#26 tracer)', async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-', 'groom');
  // An external agent-loop engine file to prove Terminate never touches it (AC10).
  mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  const engineFile = join(repo, '.agent-loop', 'state.yaml');
  writeFileSync(engineFile, 'phase: impl\niteration: 3\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → in_progress
  await expect(flowControl()).toHaveText('Advance');

  // Capture some terminal output into the (global) capture tab (AC6).
  await page.evaluate(() => window.monitor.capture({ text: 'tracer captured output', range: null, source: 'selection' }));
  await expect(page.locator('#monitor-blocks [data-event-id]')).toHaveCount(1);

  // Todos in active, in-progress, and completed states (AC7): Send marks in_progress; the checkbox done.
  await openQuickSend('todo'); // the drawer starts closed after a relaunch (§22.2)
  for (const t of ['todo-active', 'todo-progress', 'todo-done']) {
    await page.locator('#todo-new').fill(t);
    await page.locator('#todo-add-btn').click();
    await expect(page.locator('.todo').filter({ hasText: t })).toHaveCount(1);
  }
  await page.locator('.todo').filter({ hasText: 'todo-progress' }).getByRole('button', { name: 'Send todo to agent' }).click();
  await page.locator('.todo').filter({ hasText: 'todo-done' }).getByRole('checkbox').click();

  // Activate Terminate and confirm; the confirmation states the deterministic count (AC3).
  await flowTerminate().click();
  await expect(confirmModal()).toBeVisible();
  await expect(confirmModal()).toContainText('3 todos');
  await confirmModal().locator('.confirm').click();

  // Flow returns to Not started (AC5), todos gone (AC7), capture cleared (AC6).
  await expect(flowControl()).toHaveText('Start');
  await expect(page.locator('#todo-list .todo')).toHaveCount(0); // the real list, not gate-panel step pills (also .todo)
  await expect(page.locator('#monitor-blocks [data-event-id]')).toHaveCount(0);

  // Audit gained a timestamped termination entry (AC8).
  await expect
    .poll(() => (auditRunFiles(home, repo).length ? readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.map((e) => e.type) : []))
    .toContain('flow.terminated');
  const terminated = readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.find((e) => e.type === 'flow.terminated')!;
  expect(terminated.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  // AC10: external agent-loop engine state untouched.
  expect(readFileSync(engineFile, 'utf8')).toBe('phase: impl\niteration: 3\n');

  // AC9: the shell process was neither interrupted nor killed — it still runs commands.
  await typeCommand('echo still-alive-after-terminate');
  await expect(termRows()).toContainText('still-alive-after-terminate');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('Terminate with no todos: the confirmation states zero and still resets to Not started (#26 AC3)', async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-zero-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-zero-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click();
  await expect(flowControl()).toHaveText('Advance');

  await openQuickSend('todo'); // the drawer starts closed after a relaunch (§22.2)
  await expect(page.locator('#todo-list .todo')).toHaveCount(0); // the real list, not gate-panel step pills (also .todo)

  await flowTerminate().click();
  await expect(confirmModal()).toBeVisible();
  await expect(confirmModal()).toContainText('0 todos');
  await confirmModal().locator('.confirm').click();

  await expect(flowControl()).toHaveText('Start');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('Terminate is keyboard-operable; focus moves into the dialog and Escape restores it (#26 AC13)', async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-kbd-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-kbd-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click();
  await expect(flowControl()).toHaveText('Advance');

  await flowTerminate().focus();
  await page.keyboard.press('Enter'); // operate by keyboard alone (WCAG 2.1.1)
  await expect(confirmModal()).toBeVisible();
  await expect(confirmModal()).toBeFocused(); // focus moved onto the dialog container (WCAG 2.4.3)

  await page.keyboard.press('Escape'); // dismiss with no change (AC13c / AC4)
  await expect(confirmModal()).toHaveCount(0);
  await expect(flowControl()).toHaveText('Advance'); // unchanged
  await expect(flowTerminate()).toBeFocused(); // focus restored to the Terminate control

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('after Terminate and relaunch the flow stays Not started and the next start opens a new audit run (#26 AC12/AC8)', async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-persist-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-persist-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click();
  await expect(flowControl()).toHaveText('Advance');
  await openQuickSend('todo'); // the drawer starts closed after a relaunch (§22.2)
  await page.locator('#todo-new').fill('persist-term-todo');
  await page.locator('#todo-add-btn').click();
  await expect(page.locator('.todo').filter({ hasText: 'persist-term-todo' })).toHaveCount(1);

  await flowTerminate().click();
  await confirmModal().locator('.confirm').click();
  await expect(flowControl()).toHaveText('Start');
  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);

  // Relaunch: the reset survives (AC12).
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 }); // still not_started
  await openQuickSend('todo');
  await expect(page.locator('.todo').filter({ hasText: 'persist-term-todo' })).toHaveCount(0); // todos gone

  // The next start opens a NEW audit run: the finalized terminated run + a fresh one (AC8/AC12).
  await flowControl().click();
  await expect(flowControl()).toHaveText('Advance');
  await expect.poll(() => auditRunFiles(home, repo).length).toBe(2);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('flow:terminate is inert from Not started: resolves to the benign view and clears nothing (#26 AC2 handler guard)', async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-inert-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-inert-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  // Capture the app's own resolved repo key (§16.3) so the direct IPC call targets the live repo.
  const repoKeyPromise = page.evaluate(
    () => new Promise<string>((resolve) => window.monitor.onCwdChanged((m) => { if (m.repoKey) resolve(m.repoKey); })),
  );
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 }); // not_started: the control is absent (AC2)
  await expect(flowTerminate()).toHaveCount(0);
  const repoKey = await repoKeyPromise;

  // Seed state that a destructive terminate would wipe: a repo todo + a captured block.
  await openQuickSend('todo'); // the drawer starts closed after a relaunch (§22.2)
  await page.locator('#todo-new').fill('inert-guard-todo');
  await page.locator('#todo-add-btn').click();
  await expect(page.locator('.todo').filter({ hasText: 'inert-guard-todo' })).toHaveCount(1);
  await page.evaluate(() => window.monitor.capture({ text: 'inert-guard captured', range: null, source: 'selection' }));
  await expect(page.locator('#monitor-blocks [data-event-id]')).toHaveCount(1);

  // Drive flow:terminate directly from not_started. The handler guard resolves to the benign current
  // view; remove the guard and the machine rejects the transition → the invoke (and this evaluate) reject.
  const status = await page.evaluate((k) => window.flow.terminate(k).then((v) => v.status), repoKey);
  expect(status).toBe('not_started');

  // Nothing cleared: flow still not_started, the todo and the capture both intact.
  await expect(flowControl()).toHaveText('Start');
  await expect(page.locator('.todo').filter({ hasText: 'inert-guard-todo' })).toHaveCount(1);
  await expect(page.locator('#monitor-blocks [data-event-id]')).toHaveCount(1);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('flow:terminate is inert in the load-error state: it never wipes todos or capture (#26 AC2 handler guard)', async () => {
  // A .git repo with NO flow.yaml + empty $HOME ⇒ the flow loads to the error state (§18.1). Unlike
  // not_started, the machine's terminate does NOT throw here — so without the pre-state guard the
  // handler would run todoStore.clear + store.clear and wipe an error-flow repo's todos and capture.
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-err-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-err-home-'));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const repoKeyPromise = page.evaluate(
    () => new Promise<string>((resolve) => window.monitor.onCwdChanged((m) => { if (m.repoKey) resolve(m.repoKey); })),
  );
  await typeCommand(`cd "${repo}"`);
  await expect(page.locator('#flow-strip .flow-error')).toHaveText(/.+/, { timeout: 10_000 }); // error state
  await expect(flowTerminate()).toHaveCount(0); // the control is absent in load-error too (AC2)
  const repoKey = await repoKeyPromise;

  // Seed repo state that a destructive terminate would wipe.
  await openQuickSend('todo'); // the drawer starts closed after a relaunch (§22.2)
  await page.locator('#todo-new').fill('err-guard-todo');
  await page.locator('#todo-add-btn').click();
  await expect(page.locator('.todo').filter({ hasText: 'err-guard-todo' })).toHaveCount(1);
  await page.evaluate(() => window.monitor.capture({ text: 'err-guard captured', range: null, source: 'selection' }));
  await expect(page.locator('#monitor-blocks [data-event-id]')).toHaveCount(1);

  // Drive flow:terminate directly from the error state: the guard returns the benign error view and
  // clears nothing. Remove the guard and the todo + capture below would be wiped.
  const status = await page.evaluate((k) => window.flow.terminate(k).then((v) => v.status), repoKey);
  expect(status).toBe('error');

  await expect(page.locator('#flow-strip .flow-error')).toHaveText(/.+/); // still error
  await expect(page.locator('.todo').filter({ hasText: 'err-guard-todo' })).toHaveCount(1);
  await expect(page.locator('#monitor-blocks [data-event-id]')).toHaveCount(1);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---- §23.4: launch-root resolution (root a launched instance at a target directory) ----

test('launching at a target directory roots the shell, viewer, and todo scope there — but the flow global dir stays at $HOME (§23.4/§18.1)', async () => {
  // The caller-supplied target arrives over the OS process boundary (APP_LAUNCH_DIR), not an IPC
  // channel — so this drives the real launch input, not a fixture standing in for it.
  const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-')));
  writeFileSync(join(launchDir, 'launch-marker.md'), '# launched here\n');
  // The flow GLOBAL dir is NOT a cwd surface: with a valid target L = launchDir ≠ $HOME, a global flow
  // resolves from $HOME, never from L. Pinned here by placing a competing flow under launchDir that
  // must NOT win and the real global under HOME that must — proving the launch target is the local-first
  // repo anchor's job, never the global one.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-home-')));
  mkdirSync(join(home, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(home, '.agent-terminal', 'flow.yaml'),
    'name: home-global-flow\nsteps:\n  - id: home-global-step\n    kind: manual\n',
  );
  mkdirSync(join(launchDir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(launchDir, '.agent-terminal', 'flow.yaml'),
    'name: launch-local-flow\nsteps:\n  - id: launch-local-step\n    kind: manual\n',
  );
  const noFlowRepo = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-noflow-')));
  mkdirSync(join(noFlowRepo, '.git'), { recursive: true });
  // afterEach owns the beforeEach `app`/userDataDir; this case needs its own launch (APP_LAUNCH_DIR
  // over the OS boundary, HOME=temp), so bind it locally and close+clean it in finally — never
  // double-close `app`, and never leak the fixtures on an assertion failure.
  const launched = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', HOME: home, APP_LAUNCH_DIR: launchDir },
  });
  try {
    page = await launched.firstWindow();
    await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

    // Artifact viewer root (§20.1) and todo/repo scope (§16.3) read the launch root, before any cd.
    expect(await page.evaluate(() => window.viewer.tree('curated').then((t) => t.root))).toBe(launchDir);
    expect(await page.evaluate(() => window.monitor.currentRepo())).toMatchObject({ repoKey: launchDir });
    await page.keyboard.press('Control+2');
    await expect(page.locator('[data-viewpane="2"]')).toBeVisible();
    await expect(page.locator('#artifacts .tree .f').filter({ hasText: 'launch-marker.md' })).toHaveCount(1);

    // At launch the cwd IS launchDir, so its LOCAL flow.yaml drives the strip — the local-first tier.
    await expect(flowStepName()).toHaveText('launch-local-step', { timeout: 10_000 });

    // Shell cwd (§5): pwd reports the launch dir before any cd.
    await page.keyboard.press('Control+1');
    await typeCommand('pwd');
    await expect(
      page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${launchDir}\\s*$`) }),
    ).not.toHaveCount(0);

    // Flow global dir (§18.1) = $HOME, not L: cd into a repo with no local flow; the global flow
    // resolves from HOME (home-global-step), NOT the launch dir's local flow.
    await typeCommand(`cd "${noFlowRepo}"`);
    await expect(flowStepName()).toHaveText('home-global-step', { timeout: 10_000 });
  } finally {
    await launched.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
    rmSync(launchDir, { recursive: true, force: true });
    rmSync(noFlowRepo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('launching at an unusable target falls back to $HOME across the surfaces (§23.4)', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-home-')));
  writeFileSync(join(home, 'home-fallback-marker.md'), '# home fallback\n');
  // Flow global dir (§18.1) = $HOME unconditionally: a global flow under home must resolve for a repo
  // with no local flow, never the bogus launch target (which only the cwd surfaces fall back off of).
  mkdirSync(join(home, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(home, '.agent-terminal', 'flow.yaml'),
    'name: global-fallback-flow\nsteps:\n  - id: global-step\n    kind: manual\n',
  );
  const noFlowRepo = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-norepo-')));
  mkdirSync(join(noFlowRepo, '.git'), { recursive: true });
  const bogus = join(home, 'does-not-exist-launch-target');
  // afterEach owns the beforeEach `app`/userDataDir; bind this case's HOME=temp launch locally and
  // close+clean it in finally so afterEach never double-closes `app` and the fixtures (incl. the
  // userData Electron writes under HOME=temp) never leak on an assertion failure.
  const launched = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      APP_SUBMIT_DELAY_MS: '100',
      HOME: home,
      APP_LAUNCH_DIR: bogus,
    },
  });
  try {
    page = await launched.firstWindow();
    await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

    // Viewer + repo scope fall back to F (= $HOME), not the bogus target.
    expect(await page.evaluate(() => window.viewer.tree('curated').then((t) => t.root))).toBe(home);
    expect(await page.evaluate(() => window.monitor.currentRepo())).toMatchObject({ repoKey: home });
    await page.keyboard.press('Control+2');
    await expect(page.locator('#artifacts .tree .f').filter({ hasText: 'home-fallback-marker.md' })).toHaveCount(1);

    // Shell cwd falls back to F too.
    await page.keyboard.press('Control+1');
    await typeCommand('pwd');
    await expect(
      page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${home}\\s*$`) }),
    ).not.toHaveCount(0);

    // Flow global dir (§18.1) = $HOME: cd into a repo with no local flow; the global flow under home
    // resolves — the bogus target never anchors the flow global dir.
    await typeCommand(`cd "${noFlowRepo}"`);
    await expect(flowStepName()).toHaveText('global-step', { timeout: 10_000 });
  } finally {
    await launched.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
    rmSync(home, { recursive: true, force: true });
    rmSync(noFlowRepo, { recursive: true, force: true });
  }
});

test('two concurrent instances each root at their own target directory (§23.4)', async () => {
  const dirA = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-A-')));
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-B-')));
  writeFileSync(join(dirA, 'marker-A.md'), 'A\n');
  writeFileSync(join(dirB, 'marker-B.md'), 'B\n');
  const udA = mkdtempSync(join(tmpdir(), 'agent-term-e2e-ud-A-'));
  const udB = mkdtempSync(join(tmpdir(), 'agent-term-e2e-ud-B-'));
  // afterEach owns the beforeEach `app`; both instances here are locally owned and closed + cleaned
  // in finally so afterEach never double-closes `app` and the fixtures never leak on a failure.
  const appA = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${udA}`],
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_LAUNCH_DIR: dirA },
  });
  const appB = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${udB}`],
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_LAUNCH_DIR: dirB },
  });
  try {
    const pageA = await appA.firstWindow();
    const pageB = await appB.firstWindow();
    await expect(pageA.locator('.xterm-rows')).not.toHaveText('', { timeout: 15_000 });
    await expect(pageB.locator('.xterm-rows')).not.toHaveText('', { timeout: 15_000 });

    // Each viewer roots at its own dir — neither instance's root affected by the other.
    expect(await pageA.evaluate(() => window.viewer.tree('curated').then((t) => t.root))).toBe(dirA);
    expect(await pageB.evaluate(() => window.viewer.tree('curated').then((t) => t.root))).toBe(dirB);

    // Each shell sits in its own dir.
    await focusTerminal(pageA);
    await pageA.keyboard.type('pwd', { delay: 20 });
    await pageA.keyboard.press('Enter');
    await expect(
      pageA.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dirA}\\s*$`) }),
    ).not.toHaveCount(0);
    await focusTerminal(pageB);
    await pageB.keyboard.type('pwd', { delay: 20 });
    await pageB.keyboard.press('Enter');
    await expect(
      pageB.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dirB}\\s*$`) }),
    ).not.toHaveCount(0);
  } finally {
    await appA.close();
    await appB.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(udA, { recursive: true, force: true });
    rmSync(udB, { recursive: true, force: true });
  }
});

// ---- §23.4 / #25: the agent-terminal CLI launch shim (install in-app, launch a new instance) ----

function isExecutable(p: string): boolean {
  return (statSync(p).mode & 0o111) !== 0;
}

test('the in-app install action puts an executable agent-terminal on PATH; the instance stays open (§23.4)', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-cliinstall-home-')));
  await app.close();
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  try {
    await page.locator('[data-viewbtn="4"]').click();
    await expect(page.locator('[data-viewpane="4"]')).toBeVisible();
    await page.locator('#cli-install-view button').click();

    const cmd = join(home, '.agent-terminal', 'bin', CLI_COMMAND_NAME);
    await expect.poll(() => existsSync(cmd)).toBe(true);
    expect(isExecutable(cmd)).toBe(true);
    await expect(page.locator('#cli-install-view [role="status"]')).toContainText('agent-terminal');

    // Disabling the focused button during install must not strand keyboard focus on <body> (WCAG 2.4.3).
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.querySelector('#cli-install-view button')))
      .toBe(true);

    // The original instance stays open and responsive after install.
    await page.locator('[data-viewbtn="1"]').click();
    await typeCommand('echo still-here');
    await expect(termRows()).toContainText('still-here');
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the in-app install affordance is reachable in the scrolling Settings column, not stranded below the fold (§23.5)', async () => {
  await page.locator('[data-viewbtn="4"]').click();
  await expect(page.locator('[data-viewpane="4"]')).toBeVisible();

  const within = await page.evaluate(() => {
    const pane = document.querySelector('[data-viewpane="4"]') as HTMLElement;
    const btn = document.querySelector('#cli-install-view button') as HTMLElement;
    const column = (document.querySelector('#kb-settings-view') as HTMLElement).parentElement as HTMLElement;
    column.scrollTop = column.scrollHeight;
    const b = btn.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && b.top >= p.top - 1 && b.bottom <= p.bottom + 1;
  });
  expect(within).toBe(true);
});
