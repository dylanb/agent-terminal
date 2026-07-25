/// <reference lib="dom" />
// page.evaluate callbacks run in the renderer; DOM lib gives them window.monitor's type.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, statSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { parseColor, contrastRatio, ringOver } from '../helpers/wcag';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { load } from 'js-yaml';
import { CH, SESSION_ID } from '../../src/shared/ipc';
import { CLI_COMMAND_NAME } from '../../src/main/cliShim';
import { parseAuditStream, type AuditEvent } from '../../src/shared/audit';
import { TURN_DONE_FILENAME } from '../../src/shared/loopTurn';
import { completionMarker } from '../../src/main/appWorkTurn';
import { exampleRoundReport, REPORT_GRAMMAR } from '../../src/shared/roundReport';

// §26 D42a — the retired printable done-signal sentinel. Kept here ONLY so a regression test can inject it
// into the PTY output and prove it no longer completes a turn (completion is the turn-done FILE alone).
const RETIRED_SENTINEL = (turnKey: string): string => `<<<agent-loop:turn-done:${turnKey}>>>`;

/** How long a falsely-completed work turn would need to fan the reviewers out. Comfortably longer than the
 *  chain's own settle, and well under the stall watchdog, so the absence it proves is a real absence. */
const FALSE_COMPLETION_GRACE_MS = 6_000;

// Full-loop e2e (§12 acceptance): real Electron, real node-pty, real bash.
// Every launch pins APP_SHELL=bash so the bash-only shell-integration path (OSC 7/133, §15.5)
// is exercised regardless of the host's $SHELL — host shell must not change e2e outcomes.

let app: ElectronApplication;
let page: Page;
// Per-test userData so persisted UI state (§20.2) never bleeds across runs or touches the dev's real
// ~/.config/Electron. HOME=temp tests instead get userData under their HOME.
let userDataDir: string;
/** Did the harness boot the default Electron for the test now running? The `@ownapp` contract below. */
let harnessBooted: boolean;
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


test.beforeEach(async ({}, testInfo) => {
  freshenedDirs = new Set();
  harnessBooted = false;
  userDataDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-ud-'));
  // An @ownapp test launches its own Electron with a bespoke env and never touches this one, so booting
  // it would spend a full startup — and the wait on its first paint — to be discarded (CODE-STANDARDS).
  if (testInfo.tags.includes('@ownapp')) return;
  harnessBooted = true;
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100' },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  // The drawer starts closed (§22.2); drawer-driven tests below assume it open on Capture. The
  // closed-on-startup default is asserted by its own fresh-relaunch test.
  await openQuickSend('capture');
});

test.afterEach(async () => {
  // An @ownapp test that threw before launching leaves `app` as the previous test's, already closed —
  // close() is then a no-op. Never leave an instance running: a stranded one is what kills a worker.
  await app?.close(); // stop writes before removing the userData dir
  rmSync(userDataDir, { recursive: true, force: true });
});

// An Electron boot — real PTY, real bash, real renderer — is the most contended thing this suite does, and
// a test that launches its own with a bespoke env discards whatever was booted for it. `@ownapp` is that
// contract: the harness boots nothing, the test boots once. Pinned here so a beforeEach that regresses to
// booting unconditionally fails a test rather than quietly taxing every run (CODE-STANDARDS).
test('the harness boots no Electron for a test that launches its own (@ownapp)', { tag: '@ownapp' }, async () => {
  expect(harnessBooted).toBe(false);

  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100' },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
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

  // Explicit clear (Escape while a selection is active) is the only way it goes away (§7.5.1).
  await page.locator('.xterm-screen').click();
  await page.keyboard.press('Escape');
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

test('Send from a todo pastes an editable command line at the prompt without submitting (§24.2.1)', async () => {
  await cdToTempDir('inject');
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('echo injected-ok-123');
  await page.locator('#todo-add-btn').click();
  const item = page.locator('.todo').filter({ hasText: 'echo injected-ok-123' });
  await expect(item).toHaveCount(1);

  // Send pastes the todo at the prompt WITHOUT submitting, so the user can edit it (§24.2.1).
  const outputRow = page.locator('.xterm-rows > div').filter({ hasText: /^\s*injected-ok-123\s*$/ });
  await item.getByRole('button', { name: 'Send todo to agent' }).click();
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

test('the terminal view carries no selection toolbar (Send/Capture/Clear removed)', async () => {
  // The in-terminal selection toolbar was removed; selection is driven by the keyboard alone now
  // (Copy via the keymap, Clear via Escape) and capture-to-todo lives in the drawer / artifacts.
  await expect(page.locator('#toolbar')).toHaveCount(0);
  await expect(page.locator('#send-selection')).toHaveCount(0);
  await expect(page.locator('#capture-selection')).toHaveCount(0);
  await expect(page.locator('#clear-selection')).toHaveCount(0);
});

test('the CMD-3 Todos/Review-gate view is gone (view 3 + gate mock removed)', async () => {
  // The fixture-mocked view 3 (Todos beside the Review-gate mock) and its ⌘3 nav button were
  // removed; only views 1/2/4 remain. Todos live in the drawer Todo tab, the gate in the §26 panel.
  await expect(page.locator('[data-viewpane="3"]')).toHaveCount(0);
  await expect(page.locator('[data-viewbtn="3"]')).toHaveCount(0);
  await expect(page.locator('#gate-panel')).toHaveCount(0);
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

test('the drawer toggles on Ctrl+9 (Quick-send); bare Ctrl+K is left to the terminal as kill-line (§7.7)', async () => {
  // The rail wordmark is gone (§24.1C tidy-up) and the Quick-send chord label reads ⌘9.
  await expect(page.locator('.rail .mark')).toHaveCount(0);
  await expect(page.locator('#qs')).toContainText('⌘9');
  await expect(page.locator('.dhint')).toContainText('⌘9');
  await expect(page.locator('[data-viewbtn="4"]')).toContainText('⌘0');

  const appEl = page.locator('#app');
  const isOpen = () => appEl.evaluate((el) => el.classList.contains('drawer-open'));
  await page.locator('.xterm-screen').click();
  const before = await isOpen();
  await page.keyboard.press('Control+K'); // readline kill-line — must NOT toggle the drawer
  expect(await isOpen()).toBe(before);
  await page.keyboard.press('Control+9'); // the Quick-send drawer chord
  expect(await isOpen()).toBe(!before);
});

test('the Keyboard settings view opens from the gear and Ctrl+0, rebinds live, and blocks conflicts (§7.7)', async () => {
  // Opens from the rail gear → view 4.
  await page.locator('[data-viewbtn="4"]').click();
  await expect(page.locator('[data-viewpane="4"]')).toBeVisible();
  await expect(page.locator('#kb-settings-view')).toContainText('Keyboard');
  await expect(page.locator('#kb-settings-view')).toContainText('Clipboard');

  // Return to the terminal, then reopen via the keyboard chord (Linux → PC profile → Ctrl+0).
  await page.locator('[data-viewbtn="1"]').click();
  await expect(page.locator('[data-viewpane="4"]')).toBeHidden();
  await page.keyboard.press('Control+0');
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
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('persist-this-todo');
  await page.locator('#todo-add-btn').click();
  await expect(page.locator('.todo').filter({ hasText: 'persist-this-todo' })).toHaveCount(1);

  // Across a full restart, the in-repo todos.json is reread when the agent cd's back (§16.3).
  await app.close();
  app = await electron.launch({ args: launchArgs(), env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('the app terminates when the hosted shell exits', { tag: '@ownapp' }, async () => {
  // When the PTY's shell exits the whole app must terminate — the hosted shell IS the session. Use a
  // tiny startup-exit grace so the post-grace path is deterministic: in a fast environment the shell
  // can exit only a few hundred ms after spawn, which under the default 1s grace would be treated as
  // a startup failure (window kept open) and never terminate. A 1 ms grace exercises a normal exit.
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_STARTUP_EXIT_GRACE_MS: '1' },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  // Shell teardown → PTY exit → app quit can take a moment under CI load; wait past the default budget.
  const closed = app.waitForEvent('close', { timeout: 20_000 });
  await focusTerminal();
  await page.keyboard.type('exit', { delay: 20 });
  try {
    await page.keyboard.press('Enter');
  } catch (error) {
    if (!page.isClosed()) throw error;
  }
  await closed;
  expect(app.windows()).toHaveLength(0);
});

test('an immediate shell startup failure keeps the app open (§5 grace exception)', { tag: '@ownapp' }, async () => {
  // A shell that dies the instant it spawns (broken rc / bad APP_SHELL) is a startup failure: the
  // app must NOT vanish. `false` exits immediately, well within the startup grace, so the app stays
  // open rather than quitting. (The exit is too fast to assert the renderer diagnostic here — that
  // is covered by the within-grace test below, where the exit lands after the renderer has mounted.)
  // Pin a large grace so the assertion is deterministic: §5 measures uptime when the onExit callback
  // runs, which on a CPU-starved CI runner can be observed seconds after the spawn; a 60s grace makes
  // `false`'s instant exit unambiguously sub-grace regardless of that lag (the default 1s grace is
  // comparable to CI startup jitter, so it would intermittently misclassify the exit as a normal one).
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'false', APP_SUBMIT_DELAY_MS: '100', APP_STARTUP_EXIT_GRACE_MS: '60000' },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  // The decision is in main and independent of the renderer: assert the app does NOT close within a
  // window comfortably under the grace. A close event here would mean it wrongly terminated.
  const closed = app
    .waitForEvent('close', { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  expect(await closed).toBe(false);
  expect(app.windows().length).toBeGreaterThan(0);
});

test('a within-grace shell exit keeps the app open AND shows the exit diagnostic (§5)', { tag: '@ownapp' }, async () => {
  // The point of staying open is that the user can READ the diagnostic. With a large grace, a normal
  // shell exit (typed after the renderer has mounted) stays open and the `[process exited]` line is
  // visible — proving the diagnostic the grace exists to preserve actually renders.
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_STARTUP_EXIT_GRACE_MS: '60000' },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('a captured report (with findings) survives a monitor reload (capture:last→store→replay)', { tag: '@ownapp' }, async () => {
  // APP_SHELL_INTEGRATION=0: no command spans, so the report surfaces deterministically (no
  // span-gating race) and the capture:last→store→replay path runs end-to-end.
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_SHELL_INTEGRATION: '0' },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('captured monitor events restore on relaunch in the same directory (persist→terminate→restore)', { tag: '@ownapp' }, async () => {
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
    app = await electron.launch({ args: launchArgs(), env: dirEnv });
    page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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
    page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
    await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
    await openQuickSend('capture'); // the drawer starts closed after a relaunch (§22.2)

    // No re-capture: the events were rebuilt from disk and replayed into the fresh pane.
    await expect(page.locator('#monitor-blocks .finding').first()).toBeVisible({ timeout: 10_000 });
  } finally {
    rmSync(launchDir, { recursive: true, force: true });
  }
});

test('captures the visible report on the alternate screen buffer (full-screen agent, §13.4)', { tag: '@ownapp' }, async () => {
  // Claude Code 2.x draws full-screen on the alternate screen buffer, where capture was previously
  // inert (§15.9). On-demand "Capture last report" must read the visible alt frame. INTEGRATION=0 so
  // the printed report surfaces deterministically (no span-gating race), as in the replay test.
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_SHELL_INTEGRATION: '0' },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('capture ↔ terminal cross-highlight: double-click reveals each side (§16.8)', { tag: '@ownapp' }, async () => {
  // APP_SHELL_INTEGRATION=0 so the printed report surfaces deterministically (as in the replay test).
  app = await electron.launch({
    args: launchArgs(),
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_SHELL_INTEGRATION: '0' },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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
  await page.locator('#tab-todo').click();
  await page.locator('#todo-new').fill('A-side todo');
  await page.locator('#todo-add-btn').click();
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
  const v2 = page.locator('[data-viewpane="2"]');
  await expect(v1).toBeVisible();
  await expect(v2).toBeHidden();

  await page.keyboard.press('Control+2');
  await expect(v2).toBeVisible();
  await expect(v1).toBeHidden();
  await expect(page.locator('[data-viewbtn="2"]')).toHaveClass(/on/);

  await page.locator('[data-viewbtn="1"]').click();
  await expect(v1).toBeVisible();
  await expect(v2).toBeHidden();
});

test('switching to the terminal view focuses it, so the keyboard lands there to keep typing (§22.4)', async () => {
  await page.keyboard.press('Control+2');
  await expect(page.locator('[data-viewpane="2"]')).toBeVisible();
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

test('code in the viewer stays readable after the theme is toggled to dark (§20.2, WCAG 1.4.3)', async () => {
  // The library's fallback highlight style hard-codes light-background colors and the editor's own
  // text/gutter colors were pinned to the light tokens, so `data-theme="dark"` painted near-black
  // code on the near-black app background. Every glyph the user reads must clear 4.5:1 in dark.
  const dir = '/tmp/agent-term-e2e-artdark';
  await typeCommand(
    `rm -rf "${dir}" && mkdir -p "${dir}" && cd "${dir}" && git init -q && ` +
      `git config user.email t@t && git config user.name T && ` +
      `printf 'export const QUIET = 1;\\n' > code.ts && ` +
      `git add -A && git commit -qm init && printf '// trailing note\\n' >> code.ts && pwd`,
  );
  await expect(page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir}\\s*$`) })).not.toHaveCount(0);
  await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });

  await page.keyboard.press('Control+2');
  await page.locator('#artifacts .tree .f').filter({ hasText: 'code.ts' }).click();
  await expect(page.locator('#artifacts .vbody .cm-editor')).toBeVisible();

  await page.locator('#tg').click(); // toggle theme
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const worst = await page.evaluate(() => {
    const lin = (c: number): number => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const rgb = (v: string): [number, number, number, number] => {
      const p = v.match(/[\d.]+/g)!.map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    };
    const lum = ([r, g, b]: [number, number, number, number]): number =>
      0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    // A source alpha composited over an opaque backdrop (mirrors the unit test's `over`, §20.2).
    const over = (
      fg: [number, number, number, number],
      bg: [number, number, number, number],
    ): [number, number, number, number] => [
      fg[0] * fg[3] + bg[0] * (1 - fg[3]),
      fg[1] * fg[3] + bg[1] * (1 - fg[3]),
      fg[2] * fg[3] + bg[2] * (1 - fg[3]),
      1,
    ];
    const bodyBg = rgb(getComputedStyle(document.body).backgroundColor);
    const ratio = (fg: string, bg: [number, number, number, number]): number => {
      const a = lum(rgb(fg)) + 0.05;
      const b = lum(bg) + 0.05;
      return Math.max(a, b) / Math.min(a, b);
    };
    // A glyph on a changed line sits on --changed-wash over --bg, not the plain body background.
    const effectiveBg = (el: Element): [number, number, number, number] => {
      const changed = el.closest('.cm-changedLine');
      return changed ? over(rgb(getComputedStyle(changed).backgroundColor), bodyBg) : bodyBg;
    };
    const glyphs = [
      ...document.querySelectorAll('#artifacts .vbody .cm-line, #artifacts .vbody .cm-lineNumbers .cm-gutterElement, #artifacts .vbody [class*="cm-syn-"]'),
    ];
    const rated = glyphs.map((el) => ({
      text: (el.textContent ?? '').slice(0, 20),
      cls: el.className,
      ratio: ratio(getComputedStyle(el).color, effectiveBg(el)),
    }));
    return { count: rated.length, min: rated.reduce((m, r) => (r.ratio < m.ratio ? r : m)) };
  });

  expect(worst.count).toBeGreaterThan(3); // the highlighter ran: content, gutter, and syntax spans
  expect(worst.min.ratio).toBeGreaterThanOrEqual(4.5);
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

test('the viewer starts in sync with the terminal cwd, before any cd (§20.1)', { tag: '@ownapp' }, async () => {
  // bash spawns in $HOME (§5/§20.1): the viewer must discover there from the first paint, not in the
  // Electron process dir — so a marker placed in a controlled HOME must show with no cd.
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-home-'));
  writeFileSync(join(home, 'home-marker.md'), '# Home marker\n');
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('the quick-send drawer is closed on startup and inert while closed (§22.2)', { tag: '@ownapp' }, async () => {
  // beforeEach opens the drawer, so relaunch a fresh app to observe the real startup default (§22.2).
  app = await electron.launch({ args: launchArgs(), env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

  // Ctrl+9 undocks it (the Quick-send drawer chord, §7.7); the terminal pane stays on screen (no scrim).
  await page.keyboard.press('Control+9');
  await expect(appEl).not.toHaveClass(/drawer-open/);
  await expect(page.locator('.scrim, .backdrop')).toHaveCount(0);
  await expect(page.locator('#terminal')).toBeVisible();

  await page.locator('#qs').click();
  await expect(appEl).toHaveClass(/drawer-open/);
  await expect(page.locator('#panel-capture')).toBeVisible();
  await page.locator('#dclose').click();
  await expect(appEl).not.toHaveClass(/drawer-open/);
});

test('Ctrl+9 toggles the drawer even while the terminal is focused (§22.4 / §7.7)', async () => {
  const appEl = page.locator('#app');
  await page.locator('.xterm-screen').click();
  await expect(appEl).toHaveClass(/drawer-open/);

  // The shell intercepts the chord (capture phase) ahead of xterm, so the hotkey still reaches it.
  await page.keyboard.press('Control+9');
  await expect(appEl).not.toHaveClass(/drawer-open/);
  await page.keyboard.press('Control+9');
  await expect(appEl).toHaveClass(/drawer-open/);
});

test('the terminal refits its PTY when the drawer docks/undocks (§7.1)', async () => {
  await typeCommand('echo cols-docked=$(tput cols)');
  await expect(termRows()).toContainText(/cols-docked=\d+/);
  const docked = Number((await termRows().innerText()).match(/cols-docked=(\d+)/)![1]);

  // Use the close button, not ⌘9: the terminal has focus, so xterm would consume the chord. Undocking
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

// §26 D42a — a chain flow whose plan loop step is FOLLOWED by an `implement` loop step (no bootstrap):
// approving the plan gate reaches a success terminal, so the flow auto-advances plan → implement. Same
// pickup-driven plan step as seedBootstrapFlowRepo, plus the successor the auto-advance lands on.
function seedChainFlowRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: dev-flow\nsteps:\n' +
      '  - id: groom\n    kind: manual\n' +
      '  - id: plan\n    kind: loop\n    loop: plan-loop\n    bootstrap: pickup\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n' +
      '  - id: implement\n    kind: loop\n    loop: impl-loop\n',
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
    // The bootstrap port runs remote operations in a throwaway bare git dir, so the shim sees
    // `--git-dir <tmp>` ahead of the neutralizing -c pairs.
    'if [ "$1" = "--git-dir" ]; then shift 2; fi\n' +
    'while [ "$1" = "-c" ]; do shift 2; done\n' +
    'echo "git $*" >> "$FAKE_GHGIT_LOG"\n' +
    // status --porcelain emits nothing → a clean tree; when FAKE_GIT_DIRTY is set it emits a non-.agent-loop
    // porcelain line → a dirty tree, so pickup aborts (§26.9). Every other op is a recorded no-op success.
    'if [ "$1" = "status" ] && [ -n "$FAKE_GIT_DIRTY" ]; then echo " M src/app.ts"; exit 0; fi\n' +
    'if [ "$1" = "status" ] && [ "$2" = "--porcelain" ] && [ "$#" -eq 2 ] && [ -n "$FAKE_GIT_DIRTY_ONCE" ] && [ ! -e "$FAKE_GHGIT_LOG.dirty-seen" ]; then touch "$FAKE_GHGIT_LOG.dirty-seen"; echo " M src/app.ts"; exit 0; fi\n' +
    // branch --list prints the queried branch when FAKE_GIT_BRANCH_EXISTS is set → a pickup conflict (§26.9).
    'if [ "$1" = "branch" ] && [ "$2" = "--list" ]; then local_branch=$(cat "$FAKE_GHGIT_LOG.local-branch" 2>/dev/null || true); if [ -n "$FAKE_GIT_BRANCH_EXISTS" ] || [ "$local_branch" = "$3" ]; then echo "  $3"; fi; exit 0; fi\n' +
    'if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then echo "https://github.com/fake/repo.git"; exit 0; fi\n' +
    // show-ref --verify is the local half of the §27.10 conflict probe: exit 1 (not 128) when the ref is
    // absent, which is what the port distinguishes "no local branch" from "the probe itself failed" by.
    'if [ "$1" = "show-ref" ]; then ref=${!#}; local_branch=$(cat "$FAKE_GHGIT_LOG.local-branch" 2>/dev/null || true); if [ "$local_branch" = "${ref#refs/heads/}" ]; then exit 0; fi; exit 1; fi\n' +
    'if [ "$1" = "symbolic-ref" ]; then cat "$FAKE_GHGIT_LOG.current-branch" 2>/dev/null || echo main; exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then pwd -P; exit 0; fi\n' +
    // Origin is read from config, never `remote get-url` (which applies url.*.insteadOf). Real git exits 1
    // for an unset key, which is how the port tells "no separate push URL" from a broken config.
    'if [ "$1" = "config" ] && { [ "$2" = "--get" ] || [ "$2" = "--get-all" ]; }; then case "$3" in remote.origin.url) echo "https://github.com/fake/repo.git"; exit 0;; remote.origin.pushurl) exit 1;; esac; fi\n' +
    'if [ "$1" = "init" ]; then exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ]; then mkdir -p "$FAKE_GHGIT_LOG.objects"; echo "$FAKE_GHGIT_LOG.objects"; exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--show-object-format" ]; then echo sha1; exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "FETCH_HEAD" ]; then echo "1111111111111111111111111111111111111111"; exit 0; fi\n' +
    'if [ "$1" = "fetch" ]; then exit 0; fi\n' +
    'if [ "$1" = "rev-parse" ]; then echo "1111111111111111111111111111111111111111"; exit 0; fi\n' +
    'if [ "$1" = "commit-tree" ]; then echo "1111111111111111111111111111111111111111"; exit 0; fi\n' +
    'if [ "$1" = "update-ref" ] && [ "$2" = "--create-reflog" ]; then echo "${5#refs/heads/}" > "$FAKE_GHGIT_LOG.local-branch"; echo "$6" > "$FAKE_GHGIT_LOG.local-oid"; exit 0; fi\n' +
    'if [ "$1" = "update-ref" ]; then case "$2" in refs/heads/*) echo "${2#refs/heads/}" > "$FAKE_GHGIT_LOG.local-branch"; echo "$3" > "$FAKE_GHGIT_LOG.local-oid"; exit 0;; esac; fi\n' +
    'if [ "$1" = "branch" ] && [ "$3" = "FETCH_HEAD" ]; then echo "$2" > "$FAKE_GHGIT_LOG.local-branch"; exit 0; fi\n' +
    'if [ "$1" = "branch" ]; then case "$2" in --set-upstream-to=*) echo "${2#--set-upstream-to=}" > "$FAKE_GHGIT_LOG.upstream"; exit 0;; esac; fi\n' +
    'if [ "$1" = "checkout" ] && [ "$2" != "--detach" ]; then echo "$2" > "$FAKE_GHGIT_LOG.current-branch"; exit 0; fi\n' +
    'if [ "$1" = "branch" ] && [ "$2" = "-D" ]; then rm -f "$FAKE_GHGIT_LOG.local-branch"; exit 0; fi\n' +
    'if [ "$1" = "update-ref" ] && [ "$2" = "-d" ]; then rm -f "$FAKE_GHGIT_LOG.local-branch"; exit 0; fi\n' +
    'if [ "$1" = "push" ]; then for arg in "$@"; do case "$arg" in [0-9a-f]*:refs/heads/*) branch=${arg##*:refs/heads/}; oid=${arg%%:*}; echo "$branch" > "$FAKE_GHGIT_LOG.remote-branch"; echo "$oid" > "$FAKE_GHGIT_LOG.remote-oid"; exit 0;; esac; done; fi\n' +
    'if [ "$1" = "ls-remote" ]; then branch=${!#}; branch=${branch#refs/heads/}; remote_branch=$(cat "$FAKE_GHGIT_LOG.remote-branch" 2>/dev/null || true); if [ "$remote_branch" = "$branch" ]; then printf "%s\\t%s\\n" 1111111111111111111111111111111111111111 "refs/heads/$branch"; fi; exit 0; fi\n' +
    'if [ "$1" = "push" ]; then delete_next=; for arg in "$@"; do if [ -n "$delete_next" ]; then rm -f "$FAKE_GHGIT_LOG.remote-branch"; exit 0; fi; [ "$arg" = "--delete" ] && delete_next=1; done; fi\n' +
    'if [ "$1" = "push" ]; then for arg in "$@"; do case "$arg" in :refs/heads/*) rm -f "$FAKE_GHGIT_LOG.remote-branch" "$FAKE_GHGIT_LOG.remote-oid"; exit 0;; esac; done; fi\n' +
    'exit 0\n';
  const fakeGh =
    '#!/usr/bin/env bash\n' +
    'echo "gh $*" >> "$FAKE_GHGIT_LOG"\n' +
    'if [ "$1" = "repo" ] && [ "$2" = "view" ] && [[ "$*" = *nameWithOwner* ]]; then echo \'{"nameWithOwner":"fake/repo","url":"https://github.com/fake/repo","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo "main"; exit 0; fi\n' +
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then echo \'{"title":"Fake ticket","url":"https://github.com/fake/repo/issues/176"}\'; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then state=OPEN; [ -e "$FAKE_GHGIT_LOG.pr-$3-closed" ] && state=CLOSED; head_oid=5555555555555555555555555555555555555555; [ "$3" = "321" ] && head_oid=2222222222222222222222222222222222222222; closing_url=https://github.com/fake/repo/issues/176; [ -n "$FAKE_CLOSING_ISSUE_OTHER_REPO" ] && closing_url=https://github.com/other/repo/issues/176; printf \'{"number":%s,"url":"https://github.com/fake/repo/pull/%s","headRefName":"plan-loop/issue-176","headRefOid":"%s","state":"%s","closingIssuesReferences":[{"number":176,"url":"%s"}],"isCrossRepository":false,"headRepository":{"name":"Repo"},"headRepositoryOwner":{"login":"Fake"}}\\n\' "$3" "$3" "$head_oid" "$state" "$closing_url"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then if [ -n "$FAKE_GIT_BRANCH_EXISTS" ] && [ ! -e "$FAKE_GHGIT_LOG.pr-321-closed" ]; then echo \'[{"number":321,"url":"https://github.com/fake/repo/pull/321","headRefOid":"2222222222222222222222222222222222222222","isCrossRepository":false,"headRepository":{"name":"Repo"},"headRepositoryOwner":{"login":"Fake"}},{"number":999,"url":"https://github.com/contributor/fork/pull/999","headRefOid":"9999999999999999999999999999999999999999","isCrossRepository":true,"headRepository":{"name":"fork"},"headRepositoryOwner":{"login":"contributor"}}]\'; else echo \'[]\'; fi; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "close" ]; then touch "$FAKE_GHGIT_LOG.pr-$3-closed"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "edit" ] && [ "$4" = "--body-file" ] && [ "$5" = "-" ]; then cat > "$FAKE_GHGIT_LOG.pr-body"; exit 0; fi\n' +
    // §26.9/L8 epic-promote — each `gh issue create` returns a fresh issue URL (a per-binDir counter file
    // seeded at 500) so the sub-issues carry distinct numbers the executor appends to linked_issues.
    'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then seq="$FAKE_GHGIT_LOG.issue-seq"; n=$(cat "$seq" 2>/dev/null || echo 500); n=$((n+1)); echo "$n" > "$seq"; echo "https://github.com/fake/repo/issues/$n"; exit 0; fi\n' +
    'if [ "$1" = "issue" ] && [ "$2" = "edit" ] && [ "$4" = "--add-assignee" ]; then echo "$3:$5" > "$FAKE_GHGIT_LOG.issue-assignee"; exit 0; fi\n' +
    'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then value=$5; case "$value" in \\"*\\") value=${value#\\"}; value=${value%\\"};; esac; echo "$3:$4:$value" > "$FAKE_GHGIT_LOG.issue-label"; exit 0; fi\n' +
    // The `pr create` call is logged BEFORE an optional FAKE_PICKUP_DELAY sleep, so a test can hold the
    // pickup mid-flight (the branch is created, state.yaml not yet written) long enough to terminate the
    // flow and prove the async completion drops as stale (§26.9).
    'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then [ -n "$FAKE_PICKUP_DELAY" ] && sleep "$FAKE_PICKUP_DELAY"; [ -n "$FAKE_PR_CREATE_FAIL" ] && exit 1; echo 4242 > "$FAKE_GHGIT_LOG.pr-created"; echo "https://github.com/fake/repo/pull/4242"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then value=$5; case "$value" in \\"*\\") value=${value#\\"}; value=${value%\\"};; esac; echo "$3:$4:$value" > "$FAKE_GHGIT_LOG.pr-label"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then echo "$3" > "$FAKE_GHGIT_LOG.pr-ready"; exit 0; fi\n' +
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

// Signal a turn done by writing the turn-done FILE (§26.3/D47a — the sole completion signal since §26 D42a
// retired the printable sentinel line). Contents are exactly the turn key, which main key-matches.
function doneSignal(turnKey: string): string {
  return `printf '%s' '${turnKey}' > .agent-loop/${TURN_DONE_FILENAME}`;
}

// Alias kept for the tests that name the file half explicitly — identical to doneSignal now that
// completion is file-only.
function fileOnlySignal(turnKey: string): string {
  return `printf '%s' '${turnKey}' > .agent-loop/${TURN_DONE_FILENAME}`;
}

function seedFakeAgent(
  binDir: string,
  opts: {
    work: 'write-plan' | 'file-only' | 'plan-only' | 'noop';
    reviews?: 'all' | 'missing';
    consolidate?: 'clean' | 'needs-work';
    // §26.6/L6 — when set, iteration 1's consolidate verdict is this INSTEAD of `consolidate` (later
    // iterations use `consolidate`). Lets an e2e reach a gate at iteration 1 (e.g. clean → approval) and
    // then exercise needs-work cap routing on the following iterations without extra rounds.
    consolidateIter1?: 'clean' | 'needs-work';
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
    // §8.3/§26.2 — when set, the agent enters the alt screen and repaints an IDENTICAL idle frame on a
    // ~200ms timer (< QUIET_MS) from a background writer that never reads stdin, modelling a full-screen TUI
    // agent (Claude Code, Codex) that is never byte-silent even at rest. This is the one agent shape the
    // line-oriented REPL cannot otherwise produce. Under byte-presence quiescence the repaint pins
    // agentState 'active' forever, so the §26.2 gate reads `busy` and defers the work turn indefinitely;
    // content-diff quiescence (§8.3) sees an unchanged frame, reaches quiet, and the turn injects.
    idleRepaint?: boolean;
    // §26.3 — when set, the work turn STREAMS changing lines (~9s of new content faster than the stall
    // window) BEFORE it writes plan.md and signals done. Each changed line is a §8.3 content edge that
    // resets the stall watchdog, so a turn that runs far past a short APP_TURN_TIMEOUT_MS still advances.
    // Under a wall-clock deadline (or with the activity reset unwired) the same turn is killed mid-stream.
    slowWork?: boolean;
    // §26 D42a — when set, the work turn PRINTS the retired done-signal sentinel line (alone on a line) but
    // writes NO turn-done file. Pair with work:'plan-only' to reproduce the false-completion the retired
    // line-scanner caused (a real TUI reflowed the injected instruction's echo onto its own line): under
    // the fix, a printed sentinel must NOT complete the turn — only the file does.
    printBareSentinel?: boolean;
  },
): void {
  // A per-turn execution marker (§26.11 resume): its presence proves that turn actually ran this session.
  const mark = (turn: string): string => (opts.turnMarkers ? `mkdir -p .agent-loop; printf x >> .agent-loop/${turn}-ran; ` : '');
  const writePlan = opts.epicPlan
    ? "mkdir -p .agent-loop; printf '%s\\n' '---' 'classification: epic' 'sub_tickets:' " +
      "'  - title: Slice one' '  - title: Slice two' '  - title: Slice three' '---' '' '# Plan' > .agent-loop/plan.md"
    : "mkdir -p .agent-loop; printf '# Plan\\n\\nfake plan body\\n' > .agent-loop/plan.md";
  // The token log the §26.10 meter reads (Claude Code's private JSONL shape). Guarded on the env var so only
  // the L7 test (which sets it) writes a fixture. It reproduces the four shapes a real project dir holds:
  //   stale.jsonl    a session from BEFORE this flow began (opus, 1M input = $15) — outside the run's window
  //   session.jsonl  this run's work turn (sonnet-5, 1M input = $3.00), written TWICE under one billing
  //                  identity, as a resumed session replays it — the API billed it once
  //   subagents/     a reviewer subagent nested under the session dir (sonnet-5, 100k output = $1.50)
  //   <synthetic>    Claude Code's zero-token API-error turn — bills nothing, so no `+unknown`
  // A correctly scoped, deduped, recursive, synthetic-skipping meter reads exactly $4.50.
  const jsonl = (ts: string, id: string, model: string, usage: string): string =>
    `{"type":"assistant","timestamp":"${ts}","requestId":"req-${id}","message":{"id":"msg-${id}","model":"${model}","usage":{${usage}}}}`;
  const emit = (obj: string, file: string, redirect = '>'): string =>
    `printf '%s\\n' '${obj.replace(/NOW/, "'\"$NOW\"'")}' ${redirect} "${file}"; `;
  const root = '$APP_SESSION_LOG_ROOT';
  const writeTokens = opts.costFixture
    ? `; if [ -n "$APP_SESSION_LOG_ROOT" ]; then mkdir -p "${root}/session-uuid/subagents"; ` +
      // The current second at .999 — always at or after the instant the flow started, which lies in this
      // second or an earlier one, whatever the sub-second offset.
      `NOW=$(date -u +%Y-%m-%dT%H:%M:%S.999Z); ` +
      emit(jsonl('2020-01-01T00:00:00.000Z', 'stale', 'claude-opus-4-8', '"input_tokens":1000000'), `${root}/stale.jsonl`) +
      emit(jsonl('NOW', 'work', 'claude-sonnet-5', '"input_tokens":1000000,"output_tokens":0'), `${root}/session.jsonl`) +
      emit(jsonl('NOW', 'work', 'claude-sonnet-5', '"input_tokens":1000000,"output_tokens":0'), `${root}/session.jsonl`, '>>') +
      emit(jsonl('NOW', 'err', '<synthetic>', '"input_tokens":0,"output_tokens":0'), `${root}/session.jsonl`, '>>') +
      emit(jsonl('NOW', 'rev', 'claude-sonnet-5', '"output_tokens":100000'), `${root}/session-uuid/subagents/agent-x.jsonl`) +
      `fi`
    : '';
  // §26.3 — a stream of changing lines that outlasts a short stall window; each line is a §8.3 edge that
  // must reset the watchdog. Runs BEFORE plan.md so a killed turn leaves no artifact (a clean RED landing).
  const workStream = opts.slowWork ? "for i in $(seq 1 30); do printf 'working %s\\n' \"$i\"; sleep 0.3; done; " : '';
  // §26 D42a — print the retired sentinel alone on a line (no file). Proves a printed line never completes.
  const bareSentinel = opts.printBareSentinel ? `; printf '\\n<<<agent-loop:turn-done:work-plan>>>\\n'` : '';
  const workAct =
    opts.work === 'noop'
      ? ':'
      : opts.work === 'plan-only'
        ? `${mark('work')}${writePlan}${writeTokens}${bareSentinel}`
        : opts.work === 'file-only'
          ? `${mark('work')}${writePlan}${writeTokens}; ${fileOnlySignal('work-plan')}`
          : `${mark('work')}${workStream}${writePlan}${writeTokens}; ${doneSignal('work-plan')}`;
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
  const verdictExpr = opts.consolidateIter1
    ? `if [ "$iter" = "1" ]; then verdict='${opts.consolidateIter1}'; else verdict='${opts.consolidate}'; fi`
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
  // §8.3 — before the read loop, a repainting agent enters the alt screen and repaints an identical idle
  // frame every 200ms from a background writer redirected off stdin (so the REPL below still owns injected
  // input). The EXIT trap reaps the writer when the process closes. Bytes never stop; the frame never changes.
  const repaintPrelude = opts.idleRepaint
    ? "printf '\\x1b[?1049h'\n" +
      "( while :; do printf '\\x1b[2J\\x1b[Hclaude idle >'; sleep 0.2; done ) </dev/null &\n" +
      'RPID=$!\n' +
      "trap 'kill $RPID 2>/dev/null' EXIT\n"
    : '';
  const script =
    '#!/usr/bin/env bash\n' +
    '# Fake hosted agent REPL; each injected prompt line drives the scripted turn (§26.13).\n' +
    repaintPrelude +
    'while IFS= read -r line; do\n' +
    '  [ -z "$line" ] && continue\n' +
    '  case "$line" in\n' +
    // §26.3/D46 — record each injected `/clear` boundary so the e2e can assert the orchestrator issued it
    // (the echo scrolls out of the visible xterm-rows behind the next prompt, so a marker file is stable).
    '    /clear) mkdir -p .agent-loop; printf x >> .agent-loop/clear-seen ;;\n' +
    `    *turn-done:work-plan*) ${workAct} ;;\n` +
    `    *turn-done:review-plan*) ${reviewAct} ;;\n` +
    `    *turn-done:consolidate-plan*) ${consolidateAct} ;;\n` +
    // §26 D42a — record that the IMPL loop's first work prompt reached the agent, then COMPLETE the turn by
    // writing the turn-done file (the impl work turn produces code, not a plan.md deliverable, so completion
    // is the turn-done file alone — §26.3/D47a). Completing advances the run to the impl reviewers turn.
    `    *turn-done:work-impl*) mkdir -p .agent-loop; printf x >> .agent-loop/impl-work-ran; ${fileOnlySignal('work-impl')} ;;\n` +
    // Record that the impl REVIEWERS prompt reached the agent — proof the impl work turn completed on the
    // turn-done file and the run advanced into the impl loop's fan-out (turnKey review-impl).
    '    *turn-done:review-impl*) mkdir -p .agent-loop; printf x >> .agent-loop/impl-review-ran ;;\n' +
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
const statusActivity = () => page.locator('#status-bar .sb-activity');
const statusAlert = () => page.locator('#status-bar [data-status-alert]');

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

test('the flow strip follows the cwd: cd into a repo shows its flow and drives it (§24.2.2)', { tag: '@ownapp' }, async () => {
  // bash spawns in $HOME (§5); the flow follows the terminal cwd like todos (§16.3).
  const repo = seedFlowRepo('agent-term-e2e-flow-a-', 'groom-ticket');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('flow Start opens an audit run file with a flow.started event (§25.4)', { tag: '@ownapp' }, async () => {
  const repo = seedFlowRepo('agent-term-e2e-audit-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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
test('the audit run accrues lifecycle events and go-back appends to the same file (§25.4)', { tag: '@ownapp' }, async () => {
  const repo = seedFlowRepo('agent-term-e2e-audit2-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit2-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('todo edits during an active flow are recorded; none when no flow is active (§25.5)', { tag: '@ownapp' }, async () => {
  const repo = seedFlowRepo('agent-term-e2e-audit3-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit3-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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
test('a loop step records the state.yaml mirror and live edits append loop.status (§25.5)', { tag: '@ownapp' }, async () => {
  const { dir: repo, stateFile } = seedLoopFlowRepo('agent-term-e2e-audit-loop-');
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: awaiting-human-pr-approval\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit-loop-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('resolving a github-ticket input records input.resolved and ticket.assoc (§25.5)', { tag: '@ownapp' }, async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-audit-input-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit-input-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('in-app pickup records a `pickup` command event with its exit (§26.9 / §25.5)', { tag: '@ownapp' }, async () => {
  // The retired §24.2.3 T3 injected `agent-loop pickup` (recorded via an OSC-133 span). §26.9 runs
  // pickup out-of-band in the app, so the audit `command` event now comes from the runner directly,
  // with source `pickup` and exit 0 on success (the fake gh/git make it deterministic).
  const repo = seedBootstrapFlowRepo('agent-term-e2e-audit-cmd-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit-cmd-home-'));
  const { binDir } = seedFakeGhGit('agent-term-e2e-cmd-bin-');
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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('a multi-step flow walks the bookended rail: Start → Advance ×3 reaches done (§24.2.3 T1)', { tag: '@ownapp' }, async () => {
  // A 3-step flow's rail brackets the real steps with Not-started / Completed bookends → FIVE stations.
  const repo = seedMultiStepFlowRepo('agent-term-e2e-flow-multi-', ['groom', 'plan', 'implement']);
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-multi-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

// TODO(dylan): the flow-render and todo-template cases below originally landed green-first (#40); their
// RED observation cannot be reconstructed. Every #41 assertion (the loop/skill/command destinations, the
// grouped report, the per-destination consent step, the second-run skip) was added RED-first, observed
// failing in Podman against the single-destination installer. Recorded gap.

const installExamplesBtn = () => page.locator('#install-examples-view .kprofile button');
const installExamplesStatus = () => page.locator('#install-examples-view [role="status"]');
const installExamplesPrompt = () => page.locator('#install-examples-view .flow-modal');
const installExamplesConfirm = () => page.locator('#install-examples-view .flow-modal button.confirm');
const installReportGroup = (dest: string) =>
  page.locator(`#install-examples-view .install-report [data-destination="${dest}"]`);
const consentBox = (dest: string) =>
  page.locator(`#install-examples-view .flow-modal input[type="checkbox"][data-destination="${dest}"]`);

/** A temp HOME plus a temp Claude config root, so a green run can never write into the developer's own
 *  ~/.claude skills or commands directory (§24.2.3; CLAUDE_CONFIG_DIR is the engine's own redirect). */
function installEnv(home: string, configDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    APP_SHELL: 'bash',
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    APP_SUBMIT_DELAY_MS: '100',
  };
}

test('installing the bundled examples seeds the flow, app and legacy loop definitions, skills and commands (§18.1/§23.4/§26.5 #41/#78)', { tag: '@ownapp' }, async () => {
  // The tracer bullet: click the settings control against a temp HOME + temp config root, then prove
  // every destination was seeded and reported under its own group — and that a repo with no local flow
  // renders the bundled steps.
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex-cfg-'));
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex-repo-'));
  mkdirSync(join(repo, '.git'), { recursive: true }); // its own repo key; no local flow → global is used
  app = await electron.launch({ args: ['out/main/index.js'], env: installEnv(home, configDir) });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await page.locator('[data-viewbtn="4"]').click(); // open the settings view
  await expect(page.locator('#install-examples-view')).toBeVisible();
  await installExamplesBtn().focus();
  await installExamplesBtn().click();
  await expect(installExamplesStatus()).toContainText('created', { timeout: 15_000 });
  // Keyboard focus returns to the control after the install resolves (WCAG 2.4.3) — not stranded on <body>.
  await expect(installExamplesBtn()).toBeFocused();

  // Every destination is reported under its own group in the result panel.
  for (const dest of ['flow', 'appLoops', 'loops', 'skills', 'commands']) {
    await expect(installReportGroup(dest)).toBeVisible();
  }
  await expect(installReportGroup('appLoops')).toContainText('plan-loop.yaml');
  await expect(installReportGroup('loops')).toContainText('plan-loop.yaml');
  await expect(installReportGroup('commands')).toContainText('groom-ticket.md');

  // The bundled flow definition + its todo templates now exist in the global flow home.
  expect(existsSync(join(home, '.agent-terminal', 'flow.yaml'))).toBe(true);
  expect(existsSync(join(home, '.agent-terminal', 'todo-templates', 'ticket-grooming.md'))).toBe(true);
  expect(existsSync(join(configDir, 'loops-v2', 'groom-loop', 'groom-loop.yaml'))).toBe(true);
  expect(existsSync(join(configDir, 'loops-v2', 'plan-loop', 'plan-loop.yaml'))).toBe(true);
  expect(existsSync(join(configDir, 'loops-v2', 'impl-loop', 'impl-loop.yaml'))).toBe(true);
  expect(existsSync(join(configDir, 'loops', 'plan-loop', 'plan-loop.yaml'))).toBe(true);
  expect(existsSync(join(configDir, 'loops', 'impl-loop', 'impl-loop.yaml'))).toBe(true);
  expect(existsSync(join(configDir, 'loops', 'plan-loop', 'prompts', 'work-plan.md'))).toBe(true);
  // The persona skills fanned in to the location Claude Code loads skills from.
  expect(existsSync(join(configDir, 'skills', 'review-intent', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(configDir, 'skills', 'impl-review-tests', 'SKILL.md'))).toBe(true);
  // The bundled commands landed where Claude Code discovers a slash command.
  expect(existsSync(join(configDir, 'commands', 'groom-ticket.md'))).toBe(true);

  // A second click reports every file SKIPPED — not silently re-written — and never asks the user to decide
  // a replacement. The counts are what distinguish the two: a regression that overwrites byte-identical
  // files still says "created 0" and still contains the word "skipped".
  await installExamplesBtn().click();
  await expect(installExamplesStatus()).toContainText(/created 0, overwrote 0, skipped [1-9]\d*\./, {
    timeout: 15_000,
  });
  await expect(installExamplesPrompt()).toBeHidden();

  // Back to the terminal; cd into a repo with no local flow → the installed global flow renders its steps.
  await page.locator('[data-viewbtn="1"]').click();
  await typeCommand(`cd "${repo}"`);
  await expect(page.locator('#flow-strip .flow.vert .stn')).toHaveCount(5, {
    timeout: 10_000,
  });
  await expect(flowStepName()).toHaveText('groom');

  await app.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test('the shipped-flow migration is confirm-first and a decline preserves the existing flow (§18.1/§27.10 #41/#78)', { tag: '@ownapp' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex2-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex2-cfg-'));
  const customFlow = 'name: my-custom-flow\nsteps:\n  - id: mine\n    kind: manual\n';
  const customCommand = '# my own groom-ticket\n';
  mkdirSync(join(home, '.agent-terminal'), { recursive: true });
  writeFileSync(join(home, '.agent-terminal', 'flow.yaml'), customFlow); // present + differs from the bundle
  mkdirSync(join(configDir, 'commands'), { recursive: true });
  writeFileSync(join(configDir, 'commands', 'groom-ticket.md'), customCommand); // conflicts in a second destination
  app = await electron.launch({ args: ['out/main/index.js'], env: installEnv(home, configDir) });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await page.locator('[data-viewbtn="4"]').click();
  await installExamplesBtn().click();
  await expect(installExamplesPrompt()).toBeVisible({ timeout: 10_000 });

  // One decision per CONFLICTING destination; the clean ones offer none.
  await expect(consentBox('flow')).toBeVisible();
  await expect(consentBox('commands')).toBeVisible();
  await expect(consentBox('appLoops')).toHaveCount(0);
  await expect(consentBox('loops')).toHaveCount(0);

  await page.locator('#install-examples-view .flow-modal button.cancel').click();
  await expect(installExamplesPrompt()).toBeHidden();
  expect(readFileSync(join(home, '.agent-terminal', 'flow.yaml'), 'utf8')).toBe(customFlow);
  expect(readFileSync(join(configDir, 'commands', 'groom-ticket.md'), 'utf8')).toBe(customCommand);

  await installExamplesBtn().click();
  await expect(installExamplesPrompt()).toBeVisible({ timeout: 10_000 });
  await consentBox('flow').check(); // replace the flow; leave the command alone
  await installExamplesConfirm().click();
  await expect(installExamplesStatus()).toContainText('skipped', { timeout: 10_000 });

  // Consenting in one destination never replaced the other: the custom command survives byte-for-byte,
  // while the customized flow was replaced by the bundled one.
  expect(readFileSync(join(configDir, 'commands', 'groom-ticket.md'), 'utf8')).toBe(customCommand);
  const installedFlow = readFileSync(join(home, '.agent-terminal', 'flow.yaml'), 'utf8');
  expect(installedFlow).not.toBe(customFlow);
  expect(installedFlow).toContain('loop_namespace: app');
  expect(installedFlow).toContain('loop: groom-loop');
  expect(installedFlow).toContain('loop: plan-loop');
  expect(installedFlow).toContain('loop: impl-loop');
  expect(existsSync(join(home, '.agent-terminal', 'todo-templates', 'ticket-grooming.md'))).toBe(true);

  await app.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test('the REAL consent checkbox paints a focus ring, and the dialog footer stays reachable (WCAG 1.4.11, 2.1.1 #41)', { tag: '@ownapp' }, async () => {
  // The browser-project pin grades a probe whose classes are hand-written in the test, so a class rename
  // in the renderer would leave it green while the real control lost its ring. This drives the actual
  // dialog the app builds — and with the loops destination conflicting, its file manifest is the whole
  // bundle, which is exactly the content that pushed the footer off-screen.
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ring-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ring-cfg-'));
  // The manifest lists only files that are present AND differ, so seeding ONE conflicting file would
  // render a ONE-path manifest — and the footer assertion below would pass against content that never
  // overflowed anything. Conflict the WHOLE loops bundle, which is the content that clipped the footer.
  const seedConflicts = (src: string, dest: string): number => {
    let n = 0;
    mkdirSync(dest, { recursive: true });
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (e.isDirectory()) n += seedConflicts(join(src, e.name), join(dest, e.name));
      else if (e.isFile()) {
        writeFileSync(join(dest, e.name), `# mine — differs from the bundle\n${readFileSync(join(src, e.name), 'utf8')}`);
        n += 1;
      }
    }
    return n;
  };
  const conflicting = seedConflicts(join(process.cwd(), 'example', 'loops'), join(configDir, 'loops'));
  expect(conflicting).toBeGreaterThan(20); // the fixture must actually be the overflowing case
  app = await electron.launch({ args: ['out/main/index.js'], env: installEnv(home, configDir) });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await page.locator('[data-viewbtn="4"]').click();
  await installExamplesBtn().click();
  await expect(installExamplesPrompt()).toBeVisible({ timeout: 10_000 });

  const box = consentBox('loops');
  await expect(box).toBeVisible();
  // The dialog is genuinely rendering the long manifest — otherwise the footer check below grades a
  // dialog that never overflowed and cannot fail.
  const manifest = page.locator('#install-examples-view .flow-modal .ic-files').first();
  expect((await manifest.innerText()).length).toBeGreaterThan(500);

  // The dialog gives the first checkbox its INITIAL focus programmatically, and a programmatic focus need
  // not match :focus-visible. Focus has to ARRIVE by keyboard, so step off the control and come back.
  const el = box.first();
  await expect(el).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(el).not.toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(el).toBeFocused();

  const painted = await el.evaluate((n) => {
    const cs = getComputedStyle(n);
    let alpha = 1;
    for (let a: Element | null = n; a; a = a.parentElement) alpha *= parseFloat(getComputedStyle(a).opacity || '1');
    const bgOf = (start: Element | null): string => {
      for (let a = start; a; a = a.parentElement) {
        const c = getComputedStyle(a).backgroundColor;
        const m = c.match(/[\d.]+/g);
        if (m && (m[3] === undefined || Number(m[3]) === 1)) return c;
      }
      return 'rgb(255,255,255)';
    };
    return {
      focusVisible: n.matches(':focus-visible'),
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      behind: bgOf(n.parentElement),
      alpha,
    };
  });


  expect(painted.focusVisible).toBe(true);
  expect(painted.outlineWidth).toBe('2px');
  const ring = ringOver(painted.outlineColor, painted.alpha, parseColor(painted.behind));
  expect(contrastRatio(ring, parseColor(painted.behind))).toBeGreaterThanOrEqual(3);

  // The footer actions must remain on screen with the manifest rendered — a card that outgrows a centred
  // fixed modal is clipped, not scrolled, and Cancel/Install go where no input method can reach them.
  const confirmBox = await installExamplesConfirm().boundingBox();
  const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  expect(confirmBox).not.toBeNull();
  expect((confirmBox as { y: number; height: number }).y + (confirmBox as { height: number }).height).toBeLessThanOrEqual(viewport.height);

  await app.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test('dismissing the consent step without a choice returns focus to the install button (WCAG 2.4.3 #40)', { tag: '@ownapp' }, async () => {
  // Focus the button, then trigger the preview before the prompt opens. Dismissing the prompt via
  // Escape must restore focus to the button, not strand it on <body> (WCAG 2.4.3).
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex-focus-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex-focus-cfg-'));
  mkdirSync(join(home, '.agent-terminal'), { recursive: true });
  writeFileSync(join(home, '.agent-terminal', 'flow.yaml'), 'name: my-custom-flow\nsteps:\n  - id: mine\n    kind: manual\n'); // present + differs
  app = await electron.launch({ args: ['out/main/index.js'], env: installEnv(home, configDir) });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await page.locator('[data-viewbtn="4"]').click();
  await installExamplesBtn().focus();
  await installExamplesBtn().click();
  await expect(installExamplesPrompt()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(installExamplesPrompt()).toBeHidden();
  await expect(installExamplesBtn()).toBeFocused();

  await app.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test('the busy install button paints a focus ring that clears 3:1 on its own background (WCAG 2.1 SC 1.4.11 #41)', { tag: '@ownapp' }, async () => {
  // Grades the ring Chromium actually paints, not the stylesheet text: the unit contrast pin reads one
  // rule's declarations, so an `opacity` on a higher-specificity selector or an ancestor — or a later
  // equal-specificity rule reclaiming `color` — would dim the ring or the busy label with the pin green.
  //
  // It fires the REAL install to reach the busy state, so it relaunches into a temp HOME + config root like
  // every other install test: on the shared app it would seed the developer's own ~/.claude (installEnv).
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-busy-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-busy-cfg-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: installEnv(home, configDir) });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await page.locator('[data-viewbtn="4"]').click();
  await expect(page.locator('#install-examples-view')).toBeVisible();

  // Keyboard focus, so `:focus-visible` genuinely matches; a programmatic focus() need not.
  const btn = installExamplesBtn();
  for (let i = 0; i < 40 && !(await btn.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(btn).toBeFocused();

  // Arm a MutationObserver that snapshots the paint the INSTANT the app itself sets aria-busy, then fire
  // the real install with the keyboard (so :focus-visible survives — a mouse click would drop it). Setting
  // the attributes here instead would grade a state the test invented, and would stay green even if
  // setBusy() never applied it.
  await btn.evaluate((el) => {
    const w = window as unknown as { __busyPaint?: unknown };
    const snap = (): void => {
      const cs = getComputedStyle(el);
      let alpha = 1;
      for (let n: Element | null = el; n; n = n.parentElement) alpha *= parseFloat(getComputedStyle(n).opacity || '1');
      const probe = document.createElement('span');
      el.parentElement!.appendChild(probe);
      const token = (name: string): string => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      w.__busyPaint = {
        focusVisible: el.matches(':focus-visible'),
        ariaBusy: el.getAttribute('aria-busy'),
        ariaDisabled: el.getAttribute('aria-disabled'),
        outlineColor: cs.outlineColor,
        outlineWidth: cs.outlineWidth,
        labelColor: cs.color,
        alpha,
        card: token('--card'),
        dim: token('--dim'),
        signalText: token('--signal-text'),
      };
      probe.remove();
    };
    new MutationObserver(() => {
      if (el.getAttribute('aria-busy') === 'true' && !w.__busyPaint) snap();
    }).observe(el, { attributes: true, attributeFilter: ['aria-busy'] });
  });

  await page.keyboard.press('Enter');
  await expect
    .poll(() => btn.evaluate(() => (window as unknown as { __busyPaint?: unknown }).__busyPaint !== undefined))
    .toBe(true);

  const painted = await btn.evaluate(() => {
    const out = (window as unknown as { __busyPaint: {
      focusVisible: boolean; ariaBusy: string | null; ariaDisabled: string | null;
      outlineColor: string; outlineWidth: string; labelColor: string; alpha: number;
      card: string; dim: string; signalText: string;
    } }).__busyPaint;
    return out;
  });


  // The state was the APP's, not the test's: setBusy() put both attributes on the control.
  expect(painted.ariaBusy).toBe('true');
  expect(painted.ariaDisabled).toBe('true');
  expect(painted.focusVisible).toBe(true);
  expect(painted.outlineWidth).toBe('2px');
  // The ring survives the busy look at full strength, so its painted contrast clears the SC 1.4.11 floor.
  const ring = ringOver(painted.outlineColor, painted.alpha, parseColor(painted.card));
  expect(contrastRatio(ring, parseColor(painted.card))).toBeGreaterThanOrEqual(3);
  // And the busy state is still conveyed: the label moves off the idle accent onto --dim.
  expect(painted.labelColor).toBe(painted.dim);
  expect(painted.labelColor).not.toBe(painted.signalText);

  await app.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test('after install, the active step offers its bundled todo template as the picker default (§18.6 #40)', { tag: '@ownapp' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex3-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex3-cfg-'));
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-install-ex3-repo-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  app = await electron.launch({ args: ['out/main/index.js'], env: installEnv(home, configDir) });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await page.locator('[data-viewbtn="4"]').click();
  await installExamplesBtn().click();
  await expect(installExamplesStatus()).toContainText('created', { timeout: 15_000 });

  writeFileSync(
    join(home, '.agent-terminal', 'flow.yaml'),
    'name: todo-template-compat\nsteps:\n  - id: groom-ticket\n    kind: manual\n    todo_template: ticket-grooming\n',
  );
  await page.locator('[data-viewbtn="1"]').click();

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom-ticket', { timeout: 10_000 });
  await flowControl().click(); // Start → groom-ticket active (todo_template: ticket-grooming)

  await openQuickSend('todo');
  const toggle = page.locator('#todo-list .tmpl-toggle');
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  await toggle.click();
  await expect(page.locator('#todo-list .tmpl-pick')).toHaveValue('ticket-grooming'); // the step's bundled default
  await page.locator('#todo-list .tmpl-add').click();
  // Instantiating the bundled template resolves (§18.6) and yields todos from its content.
  await expect(page.locator('.todo').filter({ hasText: 'groom the ticket' })).not.toHaveCount(0, { timeout: 10_000 });

  await app.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test('advancing INTO a later step fires its entry action: the skill injects on Advance (§24.2.3 T3)', { tag: '@ownapp' }, async () => {
  // Entry-on-advance (the converse of T1's "advance does not fire onEnter"): advancing into step 2
  // injects its skill into the real PTY.
  const repo = seedSkillOnSecondStepFlowRepo('agent-term-e2e-flow-t3adv-', 'buildctl');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-t3adv-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('entering a bootstrap loop step prompts for its input; Confirm runs in-app pickup: state.yaml + draft PR, mirror plan-draft, nothing injected (§26.9 / L1)', { tag: '@ownapp' }, async () => {
  // L1 — the app OWNS state.yaml and bootstraps in-app. Confirm runs pickup (gh/git, driven by the real
  // plan-loop pickup_contract), opening a draft PR and WRITING the initial whole-document v4 state.yaml;
  // the T2 mirror renders plan-draft. The retired §24.2.3 T3 `agent-loop pickup` is NOT injected.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-l1boot-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-l1boot-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l1-bin-');
  seedFakeAgent(binDir, { work: 'noop' }); // present at the prompt so the post-pickup work turn injects (not `absent`) and sits in-flight, keeping plan-draft stable (§26.2)
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '60000', // long: the noop turn stays in-flight (never auto-errors) during the assertions
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await typeCommand('fake-agent'); // the hosted agent REPL owns the prompt (present), so the work turn injects rather than erroring

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
  expect(calls).toContain(
    'git push -u origin plan-loop/issue-176',
  );

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

test('a busy shell does NOT block pickup: it runs out-of-band and still writes state.yaml (§26.2 / §26.6)', { tag: '@ownapp' }, async () => {
  // §26 redefines "injectable" and runs pickup out-of-band (gh/git, not terminal injection), so unlike
  // the retired T3 injection a busy foreground process must NOT refuse it: state.yaml is still written.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-bootbusy-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-bootbusy-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-busy-bin-');
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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('a bootstrap pickup that cannot run (dirty tree) NEVER fails silently: it shows an error dialog, rolls the flow back to the previous step, and writes no state.yaml (§26.9)', { tag: '@ownapp' }, async () => {
  // Slice B — the async in-app pickup (§26.9) aborts on a dirty tree. The failure must be surfaced (a
  // blocking error dialog with the reason) and the half-entered loop step rolled back to the previous
  // step (Option C), never stranding the flow. No state.yaml is written and no PR is opened.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-bootdirty-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-bootdirty-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-dirty-bin-');
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
      FAKE_GIT_DIRTY: '1', // git status --porcelain reports a non-.agent-loop change → pickup aborts
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });

  await flowControl().click(); // Start → groom
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);

  await flowControl().click(); // Advance → plan (loop, bootstrap): the typed-input modal opens
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();
  await expect(inputModal()).toHaveCount(0);

  // The failure surfaces: a blocking error dialog carries the reason (never silent).
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await expect(errorDialog).toContainText('working tree is not clean');

  // The flow is rolled back to the previous step (groom), still in progress — not stranded on plan.
  await expect(flowStation(1)).toHaveClass(/\bactive\b/, { timeout: 10_000 });
  await expect(flowStation(2)).not.toHaveClass(/\bactive\b/);

  // No state.yaml was written and no PR was opened — the bootstrap aborted before either.
  expect(existsSync(join(repo, '.agent-loop', 'state.yaml'))).toBe(false);
  expect(readFileSync(logFile, 'utf8')).not.toContain('gh pr create');

  // Dismiss restores the app; the operator can fix the tree and re-advance.
  await errorDialog.locator('.dismiss').click();
  await expect(errorDialog).toHaveCount(0);

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a pickup that completes AFTER the operator terminates the flow drops as stale: no work turn is injected against the abandoned flow (§26.9)', { tag: '@ownapp' }, async () => {
  // §26.9 — the in-app pickup is fire-and-forget. If the operator TERMINATES the flow while pickup is still
  // running, its async completion must NOT drive a work turn against the now-abandoned flow (the
  // decidePickupAction stale-guard drops it). FAKE_PICKUP_DELAY holds `gh pr create` open so the terminate
  // lands mid-pickup; a hosted agent IS present, so a broken guard WOULD inject the work prompt and the
  // fake-agent would write plan.md — its absence is the observable proof the stale result was dropped.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-bootstale-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-bootstale-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-stale-bin-');
  seedFakeAgent(binDir, { work: 'write-plan' }); // present + would write plan.md if a work turn were injected
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '60000',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      FAKE_PICKUP_DELAY: '4', // gh pr create sleeps 4s → pickup stays in-flight long enough to terminate
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await typeCommand('fake-agent'); // a hosted agent IS at the prompt: a leaked work turn would inject here

  await flowControl().click(); // Start → groom
  await flowControl().click(); // Advance → plan (loop, bootstrap): typed-input modal
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();
  await expect(inputModal()).toHaveCount(0); // pickup fires and is now sleeping in `gh pr create`

  // Terminate the flow WHILE pickup is still in-flight (state.yaml is written only after the delayed PR create).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  expect(existsSync(stateFile)).toBe(false); // still mid-pickup
  await page.locator('#flow-strip .flow-terminate').click();
  const confirm = page.locator('#flow-confirm-host .flow-modal');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.locator('.confirm').click();
  await expect(confirm).toHaveCount(0);
  await expect(flowControl()).toHaveText('Start'); // flow terminated → not_started

  // Pickup runs to completion past the sleep and writes state.yaml — the positive signal its async `.then`
  // has executed.
  await expect.poll(() => existsSync(stateFile), { timeout: 20_000 }).toBe(true);

  // A FIFO happens-after barrier so the negative assertions can't false-pass on the injection round-trip's
  // latency: the fake-agent REPL reads its stdin in order, and no `/clear` precedes the FIRST work turn
  // (startWorkTurn does not clear). So a `/clear` typed now is drained AFTER any work prompt a broken guard
  // leaked — meaning `clear-seen` appears only once plan.md would already have been written. Waiting on it
  // converts the poll's incidental margin into an engineered one.
  await typeCommand('/clear');
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'clear-seen')), { timeout: 10_000 }).toBe(true);

  // The stale-guard must have dropped the result: NO work turn ran, so no plan.md, no turn audit event,
  // and nothing leaked into the shell.
  expect(existsSync(join(repo, '.agent-loop', 'plan.md'))).toBe(false); // stale → no work turn injected
  expect(turnEvents(home, repo)).toEqual([]); // no turn was ever requested
  await expect(termRows()).not.toContainText('# Work agent'); // nothing leaked into the shell

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a re-pickup onto an EXISTING branch (on_conflict: wipe-and-retry) asks first, then wipes + bootstraps on Confirm (§26.9)', { tag: '@ownapp' }, async () => {
  // §26.9 wipe-and-retry — the vendored plan-loop declares it. The wipe is destructive + outward-facing
  // (deletes the branch on origin, closes its PR), so the app CONFIRMS first: a conflict raises a confirm
  // dialog; Confirm wipes the branch and bootstraps cleanly (state.yaml plan-draft).
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-bootconf-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-bootconf-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-conf-bin-');
  seedFakeAgent(binDir, { work: 'noop' }); // present so the post-wipe work turn injects (not `absent`), keeping plan-draft stable
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '60000',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      FAKE_GIT_BRANCH_EXISTS: '1', // git branch --list reports the target branch → a pickup conflict
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await typeCommand('fake-agent');

  await flowControl().click(); // Start → groom
  await flowControl().click(); // Advance → plan (loop, bootstrap): typed-input modal
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();
  await expect(inputModal()).toHaveCount(0);

  // Ask first: a confirm dialog naming the conflicting branch — nothing wiped yet.
  const conflict = page.locator('#flow-confirm-host .flow-modal');
  await expect(conflict).toBeVisible({ timeout: 15_000 });
  await expect(conflict).toContainText('plan-loop/issue-176');
  await expect(conflict).toContainText('closes its PR');
  expect(readFileSync(logFile, 'utf8')).not.toContain('git branch -D plan-loop/issue-176'); // not wiped before confirmation

  // Confirm → the branch is wiped, then a clean bootstrap writes plan-draft.
  await conflict.locator('.confirm').click();
  await expect(conflict).toHaveCount(0);

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''), { timeout: 15_000 }).toContain('status: plan-draft');
  const calls = readFileSync(logFile, 'utf8');
  expect(calls).toContain('git branch -D plan-loop/issue-176'); // the wipe ran
  expect(calls).toContain('git push origin --delete plan-loop/issue-176');
  expect(calls).toContain('gh pr create --draft'); // a fresh PR opened after the wipe
  await expect(flowStation(2)).toHaveClass(/\bactive\b/); // flow stayed on the loop step

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a re-pickup conflict that the operator CANCELS wipes nothing and rolls the flow back (§26.9)', { tag: '@ownapp' }, async () => {
  // The safe half of confirm-first: declining the wipe must destroy nothing and never strand the flow.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-flow-bootcancel-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-bootcancel-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-cancel-bin-');
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
      FAKE_GIT_BRANCH_EXISTS: '1',
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });

  await flowControl().click(); // Start → groom
  await flowControl().click(); // Advance → plan
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  const conflict = page.locator('#flow-confirm-host .flow-modal');
  await expect(conflict).toBeVisible({ timeout: 15_000 });

  // Cancel → nothing wiped, no state.yaml, and the flow rolls back to the previous step.
  await conflict.locator('.cancel').click();
  await expect(conflict).toHaveCount(0);

  await expect(flowStation(1)).toHaveClass(/\bactive\b/, { timeout: 10_000 });
  await expect(flowStation(2)).not.toHaveClass(/\bactive\b/);
  expect(existsSync(join(repo, '.agent-loop', 'state.yaml'))).toBe(false);
  expect(readFileSync(logFile, 'utf8')).not.toContain('git branch -D plan-loop/issue-176'); // never wiped

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
  // §26.2 — when false, no hosted agent is started: the shell stays at a bare ready prompt, so the work
  // turn injected after pickup finds `no hosted agent` (`absent`) and stops in error instead of leaking
  // the prompt into the shell. The caller then asserts the error landing rather than plan-draft.
  startAgent = true,
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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  if (startAgent) await typeCommand('fake-agent'); // the hosted agent REPL now owns the prompt; injection reaches it

  await flowControl().click(); // Start → groom: opens the audit run
  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);
  await flowControl().click(); // Advance → plan (loop, bootstrap): the typed-input modal opens
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();
  await expect(inputModal()).toHaveCount(0);

  // With an agent present, bootstrap lands plan-draft and the work turn injects; without one the caller
  // asserts the `absent` error landing itself (pickup still writes plan-draft first, then the turn errors).
  if (startAgent) {
    const stateFile = join(repo, '.agent-loop', 'state.yaml');
    await expect.poll(() => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''), { timeout: 15_000 }).toContain('status: plan-draft');
  }
}

// §26 D42a — a printed done-signal sentinel line must NOT complete a turn; only the .agent-loop/turn-done
// FILE does. This regression pins the fix for the premature-completion bug: a real Claude Code TUI reflowed
// the injected prompt on echo so the retired line-scanner matched the sentinel inside its own "print this
// line" instruction and fired the NEXT turn while the agent was still working. Here the work turn writes
// plan.md (so the artifact check would PASS) and prints the sentinel alone on a line, but writes NO
// turn-done file — under the old line-scanner the reviewers fan-out would start; under the fix it must not.
test('a printed done-signal sentinel line never completes a turn — only the turn-done file does (§26 D42a)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-sentinel-nofile-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-sentinel-nofile-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-sentinel-nofile-bin-');
  // Work turn: write plan.md (artifact present) + print the retired sentinel alone on a line, but write NO
  // turn-done file. reviews would only appear if the printed line falsely completed the work turn.
  seedFakeAgent(binDir, { work: 'plan-only', printBareSentinel: true, reviews: 'all' });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  // The work turn produced plan.md and the sentinel was printed to the PTY…
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'plan.md')), { timeout: 15_000 }).toBe(true);
  await expect(termRows()).toContainText(RETIRED_SENTINEL('work-plan'), { timeout: 10_000 });
  // …but with no turn-done file the work turn never completes, so the reviewers fan-out never starts. Give
  // it a generous window (well under the stall watchdog) — the reviews dir must stay absent.
  await new Promise((r) => setTimeout(r, FALSE_COMPLETION_GRACE_MS));
  expect(existsSync(join(repo, '.agent-loop', 'reviews', '1'))).toBe(false);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

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

test('a repainting (never byte-silent) hosted agent still reaches quiet, so the work turn injects (§8.3 / §26.2)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-repaint-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-repaint-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-repaint-bin-');
  // A full-screen TUI agent: on the alt screen, repainting an identical idle frame faster than QUIET_MS
  // forever. Byte-presence quiescence would pin agentState 'active', so the §26.2 gate reads `busy` and
  // defers the work turn indefinitely — plan.md would never appear. This is the exact production shape
  // (Claude Code, Codex) the plain line-oriented REPL cannot model and that let the original bug ship.
  seedFakeAgent(binDir, { work: 'write-plan', idleRepaint: true });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  // Land: content-diff quiescence (§8.3) reaches quiet on the unchanged frame, the §26.2 gate reads `idle`,
  // and the injected work-plan prompt reaches the agent — which writes plan.md. plan.md is a file, immune to
  // the screen-clearing repaint, so its appearance is the stable proof injection happened. Never auto-errors.
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'plan.md')), { timeout: 25_000 }).toBe(true);
  expect(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')).not.toContain('status: error');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a work turn that streams past the stall window still advances to the reviewers on its done-signal (§26.3)', async () => {
  // The regression this guards: a turn that legitimately runs far longer than the (short, here) stall
  // window must NOT be killed as long as its screen keeps changing. The fake-agent streams changing lines
  // for ~9s — well past the 3s window — before it writes plan.md and signals. Each line is a §8.3 content
  // edge that resets the stall watchdog, so the done-signal lands while the turn is still in flight and the
  // work→reviewers chain runs. Under a wall-clock deadline (or with the §8.3 activity reset unwired) the
  // same turn stalls at 3s: plan.md never appears and no review is written.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-slow-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-slow-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-slow-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', slowWork: true, reviews: 'all', consolidate: 'clean' });
  await driveToWorkTurn(repo, home, binDir, logFile, '3000'); // stall window far shorter than the ~9s stream

  // §22.3.1 — while the work turn streams, the STATUS BAR shows what the engine is doing (a phrase + the
  // animated braille spinner) so an in-flight turn is visibly "doing work". The ~9s stream is a comfortable
  // window to observe it before plan.md lands. The rail shows no busy signal: one busy surface, one place.
  await expect(statusActivity()).toBeVisible({ timeout: 20_000 });
  await expect(statusActivity().locator('.phrase')).not.toBeEmpty();
  await expect(statusActivity().locator('.spin')).toHaveCount(1);
  await expect(page.locator('#flow-strip .flow-activity')).toHaveCount(0);

  // Decision 16 / §22.3.1: under space pressure the phrase FLOORS and ellipsizes — it never sheds to a
  // bare spinner. Squeeze hard and assert a legible phrase and its spinner both survive with real width.
  await page.setViewportSize({ width: 360, height: 700 });
  const phrase = statusActivity().locator('.phrase');
  await expect(phrase).toBeVisible();
  expect((await phrase.boundingBox())!.width).toBeGreaterThan(0);
  await expect(statusActivity().locator('.spin')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });

  // Land: plan.md appears only after the long stream, and the reviewers turn then runs (its per-persona
  // JSON is the proof the chain advanced past the work turn). Never auto-errors mid-stream.
  const reviewFile = join(repo, '.agent-loop', 'reviews', '1', 'review-contracts.json');
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'plan.md')), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => existsSync(reviewFile), { timeout: 30_000 }).toBe(true);
  expect(readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8')).not.toContain('status: error');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a work turn whose screen stays frozen for the stall window stops in a recoverable error (§26.3 / D48)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l2-err-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l2-err-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l2-err-bin-');
  seedFakeAgent(binDir, { work: 'noop' }); // produces nothing — no artifact, no output: the screen never changes

  await driveToWorkTurn(repo, home, binDir, logFile, '2500'); // short stall window: the silent turn stalls fast

  // Land: with no visible activity for the whole stall window, the run is written to `error` and the turn
  // failure is recorded (exit 1). The mirror renders the app-only error status with a recovery affordance.
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 20_000 }).toContain('status: error');
  expect(readFileSync(stateFile, 'utf8')).toContain('stalled: no terminal activity');
  expect(turnEvents(home, repo).some((e) => e.cmd.includes('failed') && e.exit === 1)).toBe(true);
  // §26.3/D48 (Theme B, v2.120) — a run-time turn failure is never silent: it raises the blocking error
  // dialog. Dismiss it so the modal does not trap focus over the panel exercised below.
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await errorDialog.locator('.dismiss').click();
  await expect(errorDialog).toHaveCount(0);
  await loopReadout().click();
  await expect(loopPanel()).toContainText('error', { timeout: 10_000 });

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a work turn with NO hosted agent at the prompt errors instead of leaking the prompt into the shell; the panel shows the reason + a Retry (§26.2 / D48)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-noagent-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-noagent-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-noagent-bin-');
  seedFakeAgent(binDir, { work: 'write-plan' }); // on PATH but never launched — the shell stays bare
  await driveToWorkTurn(repo, home, binDir, logFile, '30000', {}, /* startAgent */ false);

  // Land: no foreground agent occupies the prompt, so the injected work turn is refused — the run stops in
  // `error` with the reason, and NOTHING is typed into the shell (no plan.md, no leaked prompt echo).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''), { timeout: 20_000 }).toContain('status: error');
  expect(readFileSync(stateFile, 'utf8')).toContain('error_reason: no hosted agent at the prompt');
  expect(existsSync(join(repo, '.agent-loop', 'plan.md'))).toBe(false); // nothing produced the artifact
  await expect(termRows()).not.toContainText('# Work agent'); // the prompt never reached the shell

  // §26.3/D48 (v2.120) — a run-time turn failure is never silent: it raises the blocking error dialog with
  // the reason (the same surface bootstrap failures use), in addition to the panel pill. Dismiss it so it
  // does not trap focus over the panel/Retry exercised below.
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await expect(errorDialog).toContainText('no hosted agent at the prompt');
  await errorDialog.locator('.dismiss').click();
  await expect(errorDialog).toHaveCount(0);

  // The panel surfaces WHY + a recovery affordance (never a Terminate-only dead-end).
  await loopReadout().click();
  await expect(loopPanel()).toContainText('no hosted agent at the prompt', { timeout: 10_000 });
  await expect(loopPanel().locator('[data-loop-retry]')).toBeVisible();

  // D48 recovery — the whole point of Retry: start the agent so the prompt is now injectable, click Retry,
  // and observe the run actually RE-DRIVE (leave `error`, inject the work turn into the agent, produce
  // plan.md — which did not exist while the shell was bare). A regressed retryActiveTurn would leave the
  // run stuck in `error` with plan.md still absent, so this observes the recovery, not just the button.
  await typeCommand('fake-agent'); // the hosted agent REPL now owns the prompt
  await loopPanel().locator('[data-loop-retry]').click();
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 20_000 }).not.toContain('status: error');
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'plan.md')), { timeout: 20_000 }).toBe(true);

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

test('a work turn stranded in error with plan.md present is accepted after a relaunch, advancing to the reviewers without re-running the plan (§26.3 / D48)', { tag: '@ownapp' }, async () => {
  // The stranded-plan recovery (the live `.one` shape): a work turn that wrote plan.md but then stopped in
  // `error` (here: plan.md written, no done-signal, a short stall window). On a RELAUNCH the run is not
  // auto-driven, but the panel's "mark turn complete" must ACCEPT the present plan and advance to the
  // reviewers WITHOUT re-running the work turn — the whole point is to not regenerate a finished plan.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-accept-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-accept-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-accept-bin-');
  // turnMarkers so we can prove the work turn is NOT re-run on accept (its marker count stays put).
  seedFakeAgent(binDir, { work: 'plan-only', reviews: 'all', consolidate: 'clean', turnMarkers: true });
  await driveToWorkTurn(repo, home, binDir, logFile, '2500'); // short stall window: the silent post-plan turn errors

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => (existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''), { timeout: 20_000 }).toContain('status: error');
  expect(existsSync(join(repo, '.agent-loop', 'plan.md'))).toBe(true);
  const workRuns = (): number => {
    const f = join(repo, '.agent-loop', 'work-ran');
    return existsSync(f) ? readFileSync(f, 'utf8').length : 0;
  };
  const runsBeforeAccept = workRuns();
  expect(runsBeforeAccept).toBeGreaterThan(0); // the work turn ran once, live

  // Relaunch into the stranded repo with the fake-agent AS the shell so the accepted turn's chained
  // reviewers fan-out injects straight into the agent (no bootstrap, no live turn — a cold reopen).
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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });

  // The reconstructed error still shows in the panel with its recovery controls; accept it. (The fake-agent
  // shell prints nothing, so wait on the flow strip's loop read-out, not terminal text.)
  await expect(loopReadout()).toBeVisible({ timeout: 15_000 });
  await loopReadout().click();
  await expect(loopPanel()).toContainText('error', { timeout: 10_000 });
  await loopPanel().locator('[data-loop-mark-complete]').click();

  // Land: the reviewers fan-out ran (per-persona JSON), the run left error, and the work turn was NOT
  // re-run (its marker count is unchanged — the plan was accepted, not regenerated).
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'reviews', '1', 'review-contracts.json')), { timeout: 25_000 }).toBe(true);
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 20_000 }).not.toContain('status: error');
  expect(workRuns()).toBe(runsBeforeAccept);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26 D42a / §26.11 — resume/error-recovery must be keyed to the repo the operator is IN, not only the
// launch root. `resumeLoop` ran once at launch against launchRoot; if the operator launched elsewhere and
// cd'd into a repo whose run is stranded in `error`, the errored turn was never reconstructed, so the loop
// panel's Retry / mark-turn-complete (which need the reconstructed activeTurn) did nothing. Fix: re-run the
// resume reconstruction on cd-into-repo. Here the app launches in a NON-repo dir, then cd's into a repo
// stranded in `error`; Retry must reconstruct the work turn and re-drive it (the run leaves error).
test('cd into a repo stranded in error reconstructs the turn so Retry re-drives it (§26 D42a / §26.11)', { tag: '@ownapp' }, async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-cd-resume-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
  // The flow is parked at its plan loop step (so the loop mirror + its recovery controls render); its run
  // is stranded in `error`.
  writeFileSync(
    join(repo, '.agent-terminal', 'flow.yaml'),
    'name: dev-flow\nsteps:\n  - id: groom\n    kind: manual\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    bootstrap: pickup\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n',
  );
  writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), "step: plan\nstatus: in_progress\ninputs:\n  ticket: '176'\n");
  // A run stranded in `error` at the work turn: plan.md present (rewritten in place), but NO iteration-scoped
  // reviews, so the reconstruction infers the WORK turn stopped. bound_loop plan-loop resolves + has a
  // resume_contract.
  writeFileSync(
    join(repo, '.agent-loop', 'state.yaml'),
    ['schema_version: 4', 'status: error', 'iteration: 1', 'bound_loop: plan-loop', 'pr: 4242', 'branch: plan-loop/issue-176',
      'linked_issues:', '  - 176', 'phase2_active: false', 'persona_state: {}', 'impasse: {}', 'sessions: {}', 'terminated: false',
      'error_reason: done-signal received but the turn artifact is missing', ''].join('\n'),
  );
  writeFileSync(join(repo, '.agent-loop', 'plan.md'), '# Plan\n\nstranded mid-run\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-cd-resume-home-'));
  const launchDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-cd-resume-elsewhere-')); // NOT the repo
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-cd-resume-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', turnMarkers: true });

  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      APP_LAUNCH_DIR: launchDir, // launch OUTSIDE the stranded repo
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '30000',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`); // OSC-7 cwd change → resume reconstruction runs for THIS repo
  await typeCommand('fake-agent'); // host the agent so the re-driven turn injects

  // The reconstructed error surfaces its recovery controls; Retry re-drives the work turn.
  await expect(loopReadout()).toBeVisible({ timeout: 15_000 });
  await loopReadout().click();
  await expect(loopPanel()).toContainText('error', { timeout: 10_000 });
  await loopPanel().locator('[data-loop-retry]').click();

  // Land: the work turn re-ran (its execution marker appears) and the run left error — proving activeTurn
  // was reconstructed on cd (under the launch-root-only resume it would stay error, Retry a no-op).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'work-ran')), { timeout: 25_000 }).toBe(true);
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 20_000 }).not.toContain('status: error');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(launchDir, { recursive: true, force: true });
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
  // §26.3/D48 (Theme B, v2.120) — the incomplete fan-out error raises the blocking dialog; dismiss it so
  // the modal does not trap focus over the panel exercised below.
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await errorDialog.locator('.dismiss').click();
  await expect(errorDialog).toHaveCount(0);
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

function seedCompletedAppBootstrap(dir: string, issue = 176): void {
  mkdirSync(join(dir, '.agent-terminal', 'loop'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'loop', 'bootstrap.yaml'),
    `schema_version: 1\nstatus: complete\npr: 4242\nbranch: plan-loop/issue-${issue}\nissue: ${issue}\ninitial_status: planning\nupdated_at: 2026-07-23T00:00:00.000Z\n`,
  );
}

function seedPrebootstrappedAppLoopFlowRepo(prefix: string, loopName = 'plan-loop'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    `name: v2-work\nsteps:\n  - id: plan\n    kind: loop\n    loop: ${loopName}\n    loop_namespace: app\n    inputs:\n      - name: ticket\n        type: github-ticket\n`,
  );
  writeFileSync(
    join(dir, '.agent-terminal', 'flow-state.yaml'),
    'step: plan\nstatus: not_started\ninputs:\n  ticket: "176"\n',
  );
  seedCompletedAppBootstrap(dir);
  return dir;
}

// The plan-loop (§27) reviewer catalog + report structure the committed example def declares — the roster
// the round report must account for and the sections it must carry (example/loops-v2/plan-loop/plan-loop.yaml).
const PLAN_V2_ROSTER = ['review-plan-principal', 'review-plan-security'];
const PLAN_V2_SECTIONS = ['summary', 'findings', 'disposition'];
// The canonical report generator is the ONE anchor: the fake-agent emits exactly what the shared predicate
// (which gates the review turn's completion) accepts, so the e2e fixture cannot drift from the engine.
// `full` accounts for the whole roster (the first persona carries an issue, the second the empty marker —
// covering AC5's present-empty-still-completes); `omit-persona` drops a persona so the round is malformed.
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const FULL_REPORT_B64 = b64(exampleRoundReport({ sections: PLAN_V2_SECTIONS, roster: PLAN_V2_ROSTER }));
const OMIT_REPORT_B64 = b64(exampleRoundReport({ sections: PLAN_V2_SECTIONS, roster: [PLAN_V2_ROSTER[0]] }));
// A well-formed report that records the FIRST roster persona as FAILED TO RUN (§27.5/AC7) — the signal the
// consolidator clean-guard keys on. The second persona ran and found nothing (the empty marker).
const v2FailedReport = (): string => {
  const g = REPORT_GRAMMAR;
  return (
    ['## summary', '', '## findings', '', '## disposition', '',
      `### ${PLAN_V2_ROSTER[0]}`, '', g.failedMarker, '',
      `### ${PLAN_V2_ROSTER[1]}`, '', g.emptyMarker, ''].join('\n') + '\n'
  );
};
const FAILED_REPORT_B64 = b64(v2FailedReport());

// A scriptable §27 fake-agent (§27.15 test seam): on the app WORK prompt it produces the §27 completion
// artifact and/or the §27 done-file IN THE §27 LOOP AREA (.agent-terminal/loop/); on the chained REVIEW-AND-FIX
// prompt it writes the round-1 report + the review done-file. It records the boundary commands and bumps
// per-turn counters so an e2e can prove a turn was (or was NOT) re-run.
//   work:  complete — marker-bearing artifact + done-file → the work turn completes and chains review.
//          no-marker — artifact WITHOUT the marker + done-file → one work retry then error (no chain).
//          file-only — marker-bearing artifact but NO done-file → work stall→error with the artifact present.
//          noop — produce nothing → work stall→error.
//   review: full — a report accounting for the whole roster → the review turn completes (default).
//           omit-persona — a report dropping a roster persona → one review retry then error.
//           none — write nothing on the review turn → review stall/retry→error.
function seedFakeAgentV2(
  binDir: string,
  opts: {
    stepId: string;
    artifactRel: string;
    work: 'complete' | 'no-marker' | 'file-only' | 'noop';
    // Round-1 review report kind; `failed` records the first persona as failed-to-run (§27.5/AC7).
    review?: 'full' | 'omit-persona' | 'none' | 'failed';
    // Round-2 review report kind (multi-round runs), default `full`.
    review2?: 'full' | 'failed';
    // The consolidator output per round (index = round-1); each is the FULL verdict file content. Absent →
    // every round emits `verdict: clean` (so a plain work→review→consolidate run routes to the gate).
    verdicts?: string[];
    // When true, append every non-empty injected line to .agent-terminal/injected-log, so an e2e can prove a
    // prompt carried a given payload (e.g. the §27.9 request-changes feedback reaching the next review round).
    logInjected?: boolean;
  },
): void {
  const turnKey = `work-${opts.stepId}`;
  const reviewKey = `review-${opts.stepId}`;
  const consolidateKey = `consolidate-${opts.stepId}`;
  const marker = completionMarker(opts.stepId);
  const doneRel = `.agent-terminal/loop/${TURN_DONE_FILENAME}`;
  const writeArtifact = (withMarker: boolean): string =>
    `mkdir -p "$(dirname ${opts.artifactRel})"; ` +
    (withMarker
      ? `printf '%s\\n' '# plan' '${marker}' > ${opts.artifactRel}`
      : `printf '%s\\n' '# plan' 'no marker here' > ${opts.artifactRel}`);
  const done = (key: string): string => `mkdir -p .agent-terminal/loop; printf '%s' '${key}' > ${doneRel}`;
  const bump = 'mkdir -p .agent-terminal; printf x >> .agent-terminal/work-runs';
  const workAct =
    opts.work === 'noop'
      ? ':'
      : opts.work === 'file-only'
        ? `${bump}; ${writeArtifact(true)}`
        : opts.work === 'no-marker'
          ? `${bump}; ${writeArtifact(false)}; ${done(turnKey)}`
          : `${bump}; ${writeArtifact(true)}; ${done(turnKey)}`;
  const reviewBump = 'mkdir -p .agent-terminal; printf x >> .agent-terminal/review-runs';
  const reviewKind = opts.review ?? 'full';
  const r1B64 = reviewKind === 'failed' ? FAILED_REPORT_B64 : reviewKind === 'omit-persona' ? OMIT_REPORT_B64 : FULL_REPORT_B64;
  const r2B64 = (opts.review2 ?? 'full') === 'failed' ? FAILED_REPORT_B64 : FULL_REPORT_B64;
  // Round-aware report write: the round is read from the §27 run-state so a re-review (round 2) writes to
  // reports/2.md, keeping the last-two-report window real (§27.6/AC2).
  const writeReportRoundAware =
    'r=$(rnd); mkdir -p .agent-terminal/loop/reports; ' +
    `RB='${r1B64}'; case "$r" in 2) RB='${r2B64}' ;; esac; ` +
    'printf %s "$RB" | base64 -d > .agent-terminal/loop/reports/$r.md';
  const reviewAct =
    reviewKind === 'none' ? `${reviewBump}` : `${reviewBump}; ${writeReportRoundAware}; ${done(reviewKey)}`;
  // The consolidator writes its verdict output (round-keyed) then signals; the round is read from run-state
  // so a multi-round run emits the scripted verdict for each round (§27.6).
  const verdicts = opts.verdicts ?? ['verdict: clean\n'];
  const verdictCase = verdicts.map((v, i) => `${i + 1}) OUTB='${b64(v)}' ;;`).join(' ');
  const consolidateBump = 'mkdir -p .agent-terminal; printf x >> .agent-terminal/consolidate-runs';
  const consolidateAct =
    `${consolidateBump}; r=$(rnd); OUTB='${b64('verdict: clean\n')}'; case "$r" in ${verdictCase} esac; ` +
    'mkdir -p .agent-terminal/loop/consolidate; printf %s "$OUTB" | base64 -d > .agent-terminal/loop/consolidate/$r.md; ' +
    `${done(consolidateKey)}`;
  const logInjected = opts.logInjected ? 'mkdir -p .agent-terminal; printf "%s\\n" "$line" >> .agent-terminal/injected-log;\n' : '';
  const script =
    '#!/usr/bin/env bash\n' +
    'rnd() { r=$(grep -m1 "^round:" .agent-terminal/loop/run-state.yaml 2>/dev/null | tr -dc "0-9"); [ -z "$r" ] && r=1; printf %s "$r"; }\n' +
    'while IFS= read -r line; do\n' +
    '  [ -z "$line" ] && continue\n' +
    `  ${logInjected}` +
    '  case "$line" in\n' +
    '    /clear) mkdir -p .agent-terminal; printf x >> .agent-terminal/clear-seen ;;\n' +
    '    /compact*) mkdir -p .agent-terminal; printf x >> .agent-terminal/compact-seen ;;\n' +
    `    *turn-done:${consolidateKey}*) ${consolidateAct} ;;\n` +
    `    *turn-done:${reviewKey}*) ${reviewAct} ;;\n` +
    `    *turn-done:${turnKey}*) ${workAct} ;;\n` +
    '  esac\n' +
    'done\n';
  writeFileSync(join(binDir, 'fake-agent'), script, { mode: 0o755 });
}

const APP_ARTIFACT_REL = '.agent-terminal/loop/artifacts/plan.md';
const appReport1 = (repo: string): string => join(repo, '.agent-terminal', 'loop', 'reports', '1.md');
const appRunState = (repo: string): string => join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

test('a §27 app step runs work → review-and-fix → CONSOLIDATE → the clean gate, leaving §26 untouched (§27.3/§27.6 / AC1,2,3,5,6,10)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-work-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-work-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-work-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  // A prior §26 run sits on disk: the §27 engine must never touch it (AC10 — neither engine perturbs the other).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  const priorState = 'schema_version: 4\nstatus: planning\niteration: 3\npr: 42\nbranch: feat/prior\nbound_loop: plan-loop\nlinked_issues:\n  - 7\n';
  mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  writeFileSync(stateFile, priorState);
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent'); // a hosted agent IS at the prompt; the §27 work prompt reaches it

  await flowControl().click(); // Start → enter the app plan-loop step → the §27 work turn starts

  // The pre-work boundary (/clear) is issued, the work turn completes on its artifact, the engine crosses the
  // def-declared pre-review boundary (/compact) on its own, the review-and-fix turn writes the round report,
  // then the consolidator turn runs on its own (AC1) and — on a no-change round — emits `clean`, routing to
  // the gate with the verdict (AC5/AC6). status:complete first appears at that gate.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');
  expect(readIf(appRunState(repo))).toContain('verdict: clean'); // the consolidator judged the round and gated it
  expect(readIf(appRunState(repo))).toContain('turn_key: consolidate-plan'); // stopped at the consolidator's gate
  expect(existsSync(join(repo, '.agent-terminal', 'consolidate-runs'))).toBe(true); // the consolidator turn ran (AC1)
  expect(existsSync(join(repo, '.agent-terminal', 'clear-seen'))).toBe(true); // pre-work boundary issued
  expect(existsSync(join(repo, '.agent-terminal', 'compact-seen'))).toBe(true); // pre-review boundary issued (AC1)
  expect(readFileSync(join(repo, APP_ARTIFACT_REL), 'utf8')).toContain(completionMarker('plan'));
  // AC2/AC3 — the round report is written to the round-keyed, app-owned location, accounting for the full roster.
  expect(existsSync(appReport1(repo))).toBe(true);
  const report = readFileSync(appReport1(repo), 'utf8');
  for (const persona of PLAN_V2_ROSTER) expect(report).toContain(persona); // AC5 — every roster persona accounted for
  // The persisted run-state records the round number the consolidator judged.
  expect(readIf(appRunState(repo))).toContain('round: 1');

  // AC10 — the §26 state.yaml is byte-for-byte unchanged, and no §26 artifact was written.
  expect(readFileSync(stateFile, 'utf8')).toBe(priorState);
  expect(existsSync(join(repo, '.agent-loop', 'plan.md'))).toBe(false);

  // The loop panel reflects the completed review-and-fix round.
  await loopReadout().click();
  await expect(loopPanel()).toContainText('complete', { timeout: 10_000 });

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a §27 review-and-fix report omitting a roster persona drives one retry then error; Accept keeps the malformed report without re-running (§27.5/§27.12 / AC4,8)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-review-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-review-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-review-bin-');
  // Work completes, but the review turn writes a report that DROPS a roster persona → malformed.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'omit-persona' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');

  await flowControl().click(); // enter the app step → work turn → chains review-and-fix

  // The review report omits a persona → malformed → one re-injection → a SECOND malformed report → error.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: error');
  expect(readIf(appRunState(repo))).toContain('turn_key: review-plan'); // the ERRORED turn is the review turn
  expect(readIf(appRunState(repo))).toContain('round: 1');
  expect(readIf(join(repo, '.agent-terminal', 'review-runs')).length).toBe(2); // initial + one retry, then stop (AC4)

  // The turn failure is never silent: dismiss the blocking error dialog so it does not intercept the panel.
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await errorDialog.locator('.dismiss').click();
  await expect(errorDialog).toHaveCount(0);

  // The panel offers all three route-out affordances on the review error (§27.12c) — the same surface N2 built.
  await loopReadout().click();
  await expect(loopPanel().locator('[data-app-route-out="accept"]')).toBeVisible({ timeout: 10_000 });
  await expect(loopPanel().locator('[data-app-route-out="retry"]')).toBeVisible();
  await expect(loopPanel().locator('[data-app-route-out="terminate"]')).toBeVisible();

  const malformed = readFileSync(appReport1(repo), 'utf8'); // the malformed report on disk
  await loopPanel().locator('[data-app-route-out="accept"]').click();

  // AC8 — accept is the OVERRIDE: it advances the review turn keeping the malformed report, without re-running.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 15_000 }).toContain('status: complete');
  expect(readIf(join(repo, '.agent-terminal', 'review-runs')).length).toBe(2); // Accept never re-injected the review turn
  expect(readFileSync(appReport1(repo), 'utf8')).toBe(malformed); // the malformed report is kept, malformation included

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §27.9/§27.13 / N5 — a two-step flow whose first step is an app-namespace plan-loop declaring a `pr` typed
// input, plus a trailing manual step so "the flow advances off the loop step" is observable. The flow-state is
// pre-seeded with the PR and ticket resolved (not_started, so Start still drives the loop) and a completed
// bootstrap identity so plan-loop's approve side-effect (`gh pr ready <pr>`, §27.13) has a PR to flip.
function seedAppGateFlowRepo(prefix: string, pr: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: v2-gate\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n    inputs:\n      - name: ticket\n        type: github-ticket\n      - name: pr\n        type: pr\n  - id: done\n    kind: manual\n',
  );
  const prInput = pr === null ? '' : `  pr: "${pr}"\n`;
  writeFileSync(
    join(dir, '.agent-terminal', 'flow-state.yaml'),
    `step: plan\nstatus: not_started\ninputs:\n  ticket: "176"\n${prInput}`,
  );
  seedCompletedAppBootstrap(dir);
  return dir;
}

const readGhLog = (logFile: string): string => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
const appFlowState = (repo: string): string => join(repo, '.agent-terminal', 'flow-state.yaml');

test('a §27 app plan gate renders approve + request-changes, and approve runs the loop\'s gh side-effect → terminal accept → the flow advances (AC1,2,7)', { tag: '@ownapp' }, async () => {
  const repo = seedAppGateFlowRepo('agent-term-e2e-v2-approve-', '77');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-approve-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-approve-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  // A prior §26 run sits on disk: the §27 approve must never touch it (AC8 — the §26 executor never fires).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  const priorState = 'schema_version: 4\nstatus: planning\niteration: 3\npr: 42\nbranch: feat/prior\nbound_loop: plan-loop\nlinked_issues:\n  - 7\n';
  mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  writeFileSync(stateFile, priorState);
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // enter the app plan-loop step → work → review → consolidate → the clean gate

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  expect(readIf(appRunState(repo))).toContain('turn_key: consolidate-plan');

  // AC1 — the actionable gate renders exactly the def's options: approve + request-changes + redo + polish
  // (sub-ticket 3 widened the shipped defs), and never the §27-illegal impasse.
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });
  await expect(loopPanel().locator('[data-gate-option="request-changes"]')).toBeVisible();
  await expect(loopPanel().locator('[data-gate-option="redo"]')).toBeVisible();
  await expect(loopPanel().locator('[data-gate-option="polish"]')).toBeVisible();
  expect(await loopPanel().locator('[data-gate-option]').count()).toBe(4);
  await expect(loopPanel().locator('[data-gate-option="impasse"]')).toHaveCount(0);

  await loopPanel().locator('[data-gate-option="approve"]').click();

  // AC2 — approve runs the bound loop's declared gh side-effect (plan → PR non-draft flip) on the pr the flow
  // input resolved, reaches the terminal accept, and the flow advances off the loop step to the manual step.
  await expect.poll(() => readGhLog(logFile), { timeout: 15_000 }).toContain('gh pr ready 4242');
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 10_000 }).toContain('status: accepted');
  await expect.poll(() => readIf(appFlowState(repo)), { timeout: 10_000 }).toContain('step: done'); // advanced off the loop step

  // AC8 — the §26 state.yaml is byte-for-byte unchanged: the §27 approve never fired the §26 executor.
  expect(readFileSync(stateFile, 'utf8')).toBe(priorState);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §27.10/§27.9 / N6 (sub-ticket 1) — a pre-bootstrapped two-`app`-loop flow: an app plan-loop step (declaring a
// `pr` typed input so approve's `gh pr ready` side-effect has a PR to flip) chained to an app impl-loop step,
// which declares its `plan` artifact as a typed input (§27.10). plan-loop writes plan.md at the very path
// impl-loop reads it, so on approve→advance impl-loop's work turn is entered carrying plan-loop's output.
function seedAppChainFlowRepo(prefix: string, pr: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: v2-chain\nsteps:\n' +
      '  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n    inputs:\n      - name: ticket\n        type: github-ticket\n      - name: pr\n        type: pr\n' +
      '  - id: implement\n    kind: loop\n    loop: impl-loop\n    loop_namespace: app\n',
  );
  writeFileSync(
    join(dir, '.agent-terminal', 'flow-state.yaml'),
    `step: plan\nstatus: not_started\ninputs:\n  ticket: "176"\n  pr: "${pr}"\n`,
  );
  seedCompletedAppBootstrap(dir);
  return dir;
}

function seedAppBootstrapFlowRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: v2-bootstrap\nsteps:\n' +
      '  - id: groom\n    kind: manual\n' +
      '  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n',
  );
  return dir;
}

function seedOperatorPlanLoopConfig(prefix: string, transform: (yaml: string) => string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const target = join(root, 'loops-v2', 'plan-loop');
  cpSync(join(exampleConfigDir, 'loops-v2', 'plan-loop'), target, { recursive: true });
  const defFile = join(target, 'plan-loop.yaml');
  const before = readFileSync(defFile, 'utf8');
  const after = transform(before);
  expect(after).not.toBe(before);
  writeFileSync(defFile, after);
  return root;
}

// The shipped def's pickup block is replaced wholesale rather than by matching the lines a test happens to
// care about: a def that grows a key would otherwise leave an orphaned indented remainder behind, and the
// unparseable result reads as "the step never entered" rather than "the fixture is stale".
const PICKUP_BLOCK = /^pickup:\n[\s\S]*?(?=^inputs:)/m;

function withoutPickup(yaml: string): string {
  return yaml.replace(PICKUP_BLOCK, '');
}

function withPickup(yaml: string, block: string): string {
  return yaml.replace(PICKUP_BLOCK, block);
}

function seedRepoPlanLoopOverride(repo: string): void {
  const target = join(repo, 'defs', 'plan-loop');
  cpSync(join(exampleConfigDir, 'loops-v2', 'plan-loop'), target, { recursive: true });
  writeFileSync(join(repo, '.agent-loop.yaml'), 'loops:\n  plan-loop: defs/plan-loop/plan-loop.yaml\n');
}

test('entering a pickup-bearing §27 def bootstraps out-of-band into app-owned state, never §26 state or terminal injection (ST2 AC3/AC8)', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-bootstrap-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-bootstrap-home-'));
  const config = seedOperatorPlanLoopConfig('agent-term-e2e-v2-bootstrap-config-', (yaml) =>
    withPickup(
      yaml,
      'pickup:\n' +
        '  initial_status: planning\n' +
        '  branch_template: plan-loop/issue-{issue}\n' +
        '  initial_labels:\n' +
        '    - target: issue\n      action: add\n      label: agent-loop/in-progress,urgent\n' +
        '    - target: pr\n      action: remove\n      label: needs-triage\n',
    ),
  );
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-bootstrap-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '60000',
      CLAUDE_CONFIG_DIR: config,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await typeCommand('fake-agent');
  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  const bootstrapState = join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml');
  await expect.poll(() => readIf(bootstrapState), { timeout: 15_000 }).toContain('pr: 4242');
  expect(readIf(bootstrapState)).toContain('branch: plan-loop/issue-176');
  expect(readIf(bootstrapState)).toContain('issue: 176');
  expect(readIf(bootstrapState)).toContain('initial_status: planning');
  expect(readIf(`${logFile}.local-branch`).trim()).toBe('plan-loop/issue-176');
  expect(readIf(`${logFile}.remote-branch`).trim()).toBe('plan-loop/issue-176');
  expect(readIf(`${logFile}.remote-oid`).trim()).toBe('1111111111111111111111111111111111111111');
  expect(readIf(`${logFile}.upstream`).trim()).toBe('origin/plan-loop/issue-176');
  expect(readIf(`${logFile}.pr-created`).trim()).toBe('4242');
  // Assignment and labelling are best-effort work the session does AFTER persisting the identity and
  // entering work (§27.10), so they land after bootstrap.yaml rather than with it.
  await expect.poll(() => readIf(`${logFile}.issue-assignee`).trim(), { timeout: 15_000 }).toBe('176:@me');
  await expect
    .poll(() => readIf(`${logFile}.issue-label`).trim(), { timeout: 15_000 })
    .toBe('176:--add-label:agent-loop/in-progress,urgent');
  await expect
    .poll(() => readIf(`${logFile}.pr-label`).trim(), { timeout: 15_000 })
    .toBe('4242:--remove-label:needs-triage');
  expect(existsSync(join(repo, '.agent-loop', 'state.yaml'))).toBe(false);
  await expect(termRows()).not.toContainText('agent-loop pickup');

  await expect.poll(() => auditRunFiles(home, repo).length, { timeout: 10_000 }).toBe(1);
  const run = readAuditRun(home, repo, auditRunFiles(home, repo)[0]);
  const bootstrapEvents = run.events.filter((event) => event.type === 'command' && /§27 bootstrap plan/.test(event.cmd));
  expect(bootstrapEvents.map((event) => (event as Extract<AuditEvent, { type: 'command' }>).exit)).toEqual([null, 0]);

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  const illegalTransitions = await page.evaluate(async (repoKey) => {
    const rejected: boolean[] = [];
    for (const transition of ['restart', 'start'] as const) {
      try {
        await window.flow[transition](repoKey);
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
    }
    return rejected;
  }, repo);
  expect(illegalTransitions).toEqual([true, true]);
  await loopReadout().click();
  await loopPanel().locator('[data-gate-option="approve"]').click();
  await expect.poll(() => readIf(`${logFile}.pr-ready`).trim(), { timeout: 15_000 }).toBe('4242');
  await expect(flowControl()).toHaveText('Restart', { timeout: 10_000 });

  const beforeRestartProbes = (readGhLog(logFile).match(/^git status --porcelain$/gm) ?? []).length;
  writeFileSync(
    join(repo, '.agent-terminal', 'flow.yaml'),
    'name: v2-bootstrap-restart\nsteps:\n' +
      '  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n',
  );
  writeFileSync(
    appFlowState(repo),
    'step: plan\nstatus: not_started\ninputs:\n  ticket: "176"\n',
  );
  await page.evaluate(async (repoKey) => {
    await window.flow.state(repoKey);
    await window.flow.start(repoKey);
  }, repo);
  await expect
    .poll(() => (readGhLog(logFile).match(/^git status --porcelain$/gm) ?? []).length, {
      timeout: 10_000,
    })
    .toBe(beforeRestartProbes + 1);

  await app.close();
  for (const dir of [repo, home, config, binDir]) rmSync(dir, { recursive: true, force: true });
});

// §27.10 confirm-first wipe — the pickup target already exists (local branch, origin branch, and an open
// same-repo PR). The wipe is destructive and outward-facing, so the app names the exact resources and
// waits: nothing is deleted or closed until the operator confirms.
test('a §27 pickup onto existing resources (on_conflict: wipe-and-retry) confirms first, then wipes exactly those and bootstraps', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-wipe-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-wipe-home-'));
  const config = seedOperatorPlanLoopConfig('agent-term-e2e-v2-wipe-config-', (yaml) =>
    withPickup(
      yaml,
      'pickup:\n' +
        '  initial_status: planning\n' +
        '  branch_template: plan-loop/issue-{issue}\n' +
        '  on_conflict: wipe-and-retry\n',
    ),
  );
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-wipe-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  // The conflicting resources the operator will be asked about: a local branch, the same branch on
  // origin, and open PR 321 (which the fake `gh pr list` reports while FAKE_GIT_BRANCH_EXISTS is set).
  writeFileSync(`${logFile}.local-branch`, 'plan-loop/issue-176\n');
  writeFileSync(`${logFile}.remote-branch`, 'plan-loop/issue-176\n');
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '60000',
      CLAUDE_CONFIG_DIR: config,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      FAKE_GIT_BRANCH_EXISTS: '1',
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await typeCommand('fake-agent');
  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  // Ask first, naming every resource the wipe would destroy — and nothing destroyed yet.
  const conflict = page.locator('#flow-confirm-host .flow-modal');
  await expect(conflict).toBeVisible({ timeout: 20_000 });
  await expect(conflict).toContainText('plan-loop/issue-176');
  await expect(conflict).toContainText('#321');
  expect(existsSync(`${logFile}.pr-321-closed`)).toBe(false);
  expect(readGhLog(logFile)).not.toContain(':refs/heads/plan-loop/issue-176');
  expect(readIf(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml'))).toBe('');

  await conflict.locator('.confirm').click();

  // Confirmed: the open PR is closed, the origin branch is deleted under an exact lease naming the OID
  // the operator was shown, and the bootstrap then completes normally.
  await expect.poll(() => existsSync(`${logFile}.pr-321-closed`), { timeout: 20_000 }).toBe(true);
  expect(readGhLog(logFile)).toContain(
    '--force-with-lease=refs/heads/plan-loop/issue-176:1111111111111111111111111111111111111111',
  );
  const bootstrapState = join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml');
  await expect.poll(() => readIf(bootstrapState), { timeout: 20_000 }).toContain('pr: 4242');
  expect(readIf(bootstrapState)).toContain('branch: plan-loop/issue-176');

  await app.close();
  for (const dir of [repo, home, config, binDir]) rmSync(dir, { recursive: true, force: true });
});

// AC5's other half: declining destroys nothing and reverts the step. `declineWipe` is the one rollback
// path that deliberately does NOT emit an error, so the absence of the blocking dialog is observable
// only full-stack.
test('a §27 pickup conflict declined destroys nothing and reverts the step', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-decline-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-decline-home-'));
  const config = seedOperatorPlanLoopConfig('agent-term-e2e-v2-decline-config-', (yaml) =>
    withPickup(
      yaml,
      'pickup:\n' +
        '  initial_status: planning\n' +
        '  branch_template: plan-loop/issue-{issue}\n' +
        '  on_conflict: wipe-and-retry\n',
    ),
  );
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-decline-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  writeFileSync(`${logFile}.local-branch`, 'plan-loop/issue-176\n');
  writeFileSync(`${logFile}.remote-branch`, 'plan-loop/issue-176\n');
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '60000',
      CLAUDE_CONFIG_DIR: config,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      FAKE_GIT_BRANCH_EXISTS: '1',
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await typeCommand('fake-agent');
  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  const conflict = page.locator('#flow-confirm-host .flow-modal');
  await expect(conflict).toBeVisible({ timeout: 20_000 });
  await expect(conflict).toContainText('plan-loop/issue-176');

  await conflict.locator('.cancel').click();
  await expect(conflict).toBeHidden({ timeout: 10_000 });
  // Wait for the decline to be RECORDED before asserting absence: the wipe is asynchronous, so
  // asserting straight after the click passes whether the answer was honoured or ignored.
  const declineCommands = (): { cmd: string; exit: number | null }[] => {
    const files = auditRunFiles(home, repo);
    if (files.length !== 1) return [];
    return readAuditRun(home, repo, files[0])
      .events.filter(
        (e): e is Extract<AuditEvent, { type: 'command' }> => e.type === 'command',
      )
      .filter((e) => e.cmd.startsWith('§27 bootstrap plan'))
      .map((e) => ({ cmd: e.cmd, exit: e.exit }));
  };
  // The whole sequence, not a substring: `includes('decline')` matched the ROLLBACK event's detail
  // ("operator declined branch wipe"), so it passed without a decline event ever being recorded. The
  // exits carry the meaning — a decline is an ANSWER (0), the conflict is a pause awaiting one (null).
  await expect
    .poll(() => declineCommands().length, { timeout: 20_000 })
    .toBe(4);
  expect(declineCommands()).toEqual([
    { cmd: '§27 bootstrap plan started', exit: null },
    {
      cmd: '§27 bootstrap plan found a conflict: plan-loop/issue-176',
      exit: null,
    },
    { cmd: '§27 bootstrap plan wipe declined: plan-loop/issue-176', exit: 0 },
    {
      cmd: '§27 bootstrap plan rolled back: operator declined branch wipe',
      exit: 1,
    },
  ]);

  // Nothing destroyed: the PR was never closed, no ref delete was pushed, and both refs still stand.
  expect(existsSync(`${logFile}.pr-321-closed`)).toBe(false);
  expect(readGhLog(logFile)).not.toContain(':refs/heads/plan-loop/issue-176');
  expect(readIf(`${logFile}.local-branch`).trim()).toBe('plan-loop/issue-176');
  expect(readIf(`${logFile}.remote-branch`).trim()).toBe('plan-loop/issue-176');
  expect(readIf(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml'))).toBe('');

  // Reverted to the prior step with its typed input intact, and NO blocking error dialog — a decline is
  // an answer, not a failure. `ticket:` alone cannot fail here: provideInput persists it before the
  // conflict is raised, so it is present on the honoured-wipe path too. The step moving back off `plan`
  // is what distinguishes reverted from not-reverted.
  await expect
    .poll(() => readIf(appFlowState(repo)), { timeout: 15_000 })
    .toContain('step: groom');
  await expect(flowStation(1)).toHaveClass(/\bactive\b/, { timeout: 10_000 });
  await expect(flowStation(2)).not.toHaveClass(/\bactive\b/);
  expect(readIf(appFlowState(repo))).toContain("ticket: '176'");
  await expect(page.locator('#flow-error-host .flow-modal')).toBeHidden();

  await app.close();
  for (const dir of [repo, home, config, binDir]) rmSync(dir, { recursive: true, force: true });
});

test('a failed §27 pickup rolls back its named step with typed inputs preserved and a blocking route out (ST2 AC4/AC7)', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-bootstrap-fail-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-bootstrap-fail-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-bootstrap-fail-bin-');
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
      FAKE_GIT_DIRTY_ONCE: '1',
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  const failedPickupLogStart = readGhLog(logFile).length;
  await inputModal().locator('.confirm').click();

  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await expect(errorDialog).toContainText('working tree is not clean');
  await expect(errorDialog).toContainText(repo);
  await expect(errorDialog).toContainText('plan');
  await expect(flowStation(1)).toHaveClass(/\bactive\b/, { timeout: 10_000 });
  await expect(flowStation(2)).not.toHaveClass(/\bactive\b/);
  expect(readIf(appFlowState(repo))).toContain("ticket: '176'");
  expect(existsSync(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml'))).toBe(false);
  expect(existsSync(join(repo, '.agent-loop', 'state.yaml'))).toBe(false);
  expect(readGhLog(logFile).slice(failedPickupLogStart)).not.toContain(
    'gh pr create',
  );
  await expect.poll(() => auditRunFiles(home, repo).length, { timeout: 10_000 }).toBe(1);
  const failedRun = readAuditRun(home, repo, auditRunFiles(home, repo)[0]);
  const failedBootstrapEvents = failedRun.events.filter(
    (event) => event.type === 'command' && /§27 bootstrap plan/.test(event.cmd),
  );
  expect(
    failedBootstrapEvents.map((event) => ({
      cmd: (event as Extract<AuditEvent, { type: 'command' }>).cmd,
      exit: (event as Extract<AuditEvent, { type: 'command' }>).exit,
    })),
  ).toEqual([
    { cmd: '§27 bootstrap plan started', exit: null },
    { cmd: '§27 bootstrap plan failed: working tree is not clean', exit: 1 },
    { cmd: '§27 bootstrap plan rolled back: working tree is not clean', exit: 1 },
  ]);
  await errorDialog.locator('.dismiss').click();
  await expect(flowControl()).toHaveText('Advance', { timeout: 10_000 });
  await flowControl().click();
  // `issue: 176` lands with the bootstrap INTENT, which is written before the branch is created — so it
  // marks the start of the git work below, not its completion. Poll to the last command of the creation
  // sequence (fetch → update-ref → checkout) before reading the log, then assert against one snapshot.
  await expect.poll(() => readIf(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml')), { timeout: 15_000 }).toContain('issue: 176');
  await expect
    .poll(() => readGhLog(logFile), { timeout: 15_000 })
    .toContain('git checkout plan-loop/issue-176');
  const bootstrapLog = readGhLog(logFile);
  expect(bootstrapLog.match(/^git status --porcelain$/gm)).toHaveLength(2);
  // The pack program is pinned on the argv, not via remote.origin.*: these operations address the
  // remote by URL, so a `-c remote.origin.uploadpack` entry would bind to nothing.
  expect(bootstrapLog).toMatch(
    /git fetch --upload-pack=git-upload-pack --no-tags --no-recurse-submodules -- https:\/\/github\.com\/fake\/repo\.git refs\/heads\/main/,
  );
  expect(bootstrapLog).toContain(
    'git update-ref --create-reflog -m agent-terminal-bootstrap:',
  );

  await app.close();
  for (const dir of [repo, home, binDir]) rmSync(dir, { recursive: true, force: true });
});

test('a repo-resident pickup def is refused by the wired executor before any bootstrap git or gh operation (ST2 origin gate)', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-bootstrap-origin-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-bootstrap-origin-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-bootstrap-origin-bin-');
  seedRepoPlanLoopOverride(repo);
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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  const refusedPickupLogStart = readGhLog(logFile).length;
  await inputModal().locator('.confirm').click();

  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await expect(errorDialog).toContainText(/operator-authored|origin/i);
  const calls = readGhLog(logFile).slice(refusedPickupLogStart);
  expect(calls).not.toContain('git status --porcelain');
  expect(calls).not.toContain('gh repo view');
  expect(calls).not.toContain('gh issue view 176 --json title,url');
  expect(calls).not.toContain('gh issue edit');
  expect(calls).not.toContain('gh pr create');
  expect(existsSync(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml'))).toBe(false);

  await app.close();
  for (const dir of [repo, home, binDir]) rmSync(dir, { recursive: true, force: true });
});

test('repo-authored bootstrap.yaml cannot suppress the trusted §27 pickup executor (ST2 origin gate)', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-bootstrap-forged-state-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-bootstrap-forged-state-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-bootstrap-forged-state-bin-');
  seedCompletedAppBootstrap(repo);
  const forgedBootstrap = join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml');
  writeFileSync(forgedBootstrap, readFileSync(forgedBootstrap, 'utf8').replace('pr: 4242', 'pr: 77'));
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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  const forgedPickupLogStart = readGhLog(logFile).length;
  await inputModal().locator('.confirm').click();

  await expect
    .poll(
      () => readGhLog(logFile).slice(forgedPickupLogStart),
      { timeout: 15_000 },
    )
    .toMatch(/^git status --porcelain$/m);
  await expect
    .poll(() => readIf(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml')), { timeout: 15_000 })
    .toContain('pr: 4242');

  await app.close();
  for (const dir of [repo, home, binDir]) rmSync(dir, { recursive: true, force: true });
});

test('a §27 def with no pickup enters work without invoking bootstrap ports (ST2 AC3)', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-no-bootstrap-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-no-bootstrap-home-'));
  const config = seedOperatorPlanLoopConfig('agent-term-e2e-v2-no-bootstrap-config-', (yaml) =>
    withoutPickup(yaml),
  );
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-no-bootstrap-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'noop' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '60000',
      CLAUDE_CONFIG_DIR: config,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await typeCommand('fake-agent');
  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  const noPickupLogStart = readGhLog(logFile).length;
  await inputModal().locator('.confirm').click();

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 15_000 }).toContain('turn_key: work-plan');
  const calls = readGhLog(logFile).slice(noPickupLogStart);
  expect(calls).not.toContain('git status --porcelain');
  expect(calls).not.toContain('gh repo view');
  expect(calls).not.toContain('gh issue view 176 --json title,url');
  expect(calls).not.toContain('gh issue edit');
  expect(calls).not.toContain('gh pr create');
  expect(existsSync(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml'))).toBe(false);

  await app.close();
  for (const dir of [repo, home, config, binDir]) rmSync(dir, { recursive: true, force: true });
});

test('a stale flow input answer is inert at the main-process receiver (ST2 AC7)', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-bootstrap-stale-input-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-bootstrap-stale-input-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-bootstrap-stale-input-bin-');
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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  const staleInputLogStart = readGhLog(logFile).length;
  await page.evaluate(
    ([repoKey]) => window.flow.provideInput(repoKey, 'groom', { ticket: '999' }),
    [repo] as const,
  );

  await expect(inputModal()).toBeVisible();
  // Read the document the way the SUT wrote it rather than matching its text: `started_at` is epoch
  // millis, so a bare substring check trips on the clock, and a regex has to guess the writer's
  // quoting — the previous one admitted only a bare or double-quoted value while yaml.dump emits
  // single quotes, so it could not fail for the exact value it forbids.
  const staleState = load(readIf(appFlowState(repo))) as
    | { inputs?: Record<string, unknown> }
    | undefined;
  expect(Object.values(staleState?.inputs ?? {})).not.toContain('999');
  const calls = readGhLog(logFile).slice(staleInputLogStart);
  expect(calls).not.toContain('git status --porcelain');
  expect(calls).not.toContain('gh ');

  await app.close();
  for (const dir of [repo, home, binDir]) rmSync(dir, { recursive: true, force: true });
});

test('bootstrap-triggering flow IPC refuses a repository the main process never discovered (ST2 AC7)', async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-bootstrap-unknown-repo-');

  const statuses = await page.evaluate(async (repoKey) => {
    const started = await window.flow.start(repoKey);
    const advanced = await window.flow.advance(repoKey);
    const provided = await window.flow.provideInput(repoKey, 'plan', { ticket: '176' });
    return [started.status, advanced.status, provided.status];
  }, repo);

  expect(statuses).toEqual(['error', 'error', 'error']);
  expect(existsSync(appFlowState(repo))).toBe(false);
  expect(existsSync(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml'))).toBe(false);

  rmSync(repo, { recursive: true, force: true });
});

test('a delayed §27 bootstrap cannot cross a terminate-and-restart ABA into the new step occurrence (ST2 AC7)', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-bootstrap-aba-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-bootstrap-aba-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-bootstrap-aba-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '60000',
      CLAUDE_CONFIG_DIR: exampleConfigDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_GHGIT_LOG: logFile,
      FAKE_PICKUP_DELAY: '2',
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await typeCommand('fake-agent');

  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();
  await expect.poll(() => readGhLog(logFile), { timeout: 10_000 }).toContain('gh pr create');

  await page.locator('#flow-strip .flow-terminate').click();
  const confirm = page.locator('#flow-confirm-host .flow-modal');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.locator('.confirm').click();
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });

  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('177');
  await inputModal().locator('.confirm').click();

  await expect
    .poll(() => (readGhLog(logFile).match(/gh pr create/g) ?? []).length, { timeout: 15_000 })
    .toBe(2);
  await expect
    .poll(() => readIf(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml')), { timeout: 15_000 })
    .toContain('issue: 177');
  await expect
    .poll(() => readIf(join(repo, '.agent-terminal', 'work-runs')).length, { timeout: 30_000 })
    .toBe(1);
  const staleDialog = page.locator('#flow-error-host .flow-modal');
  await expect(staleDialog).toContainText(/no longer current|requires review/i, { timeout: 15_000 });

  await app.close();
  for (const dir of [repo, home, binDir]) rmSync(dir, { recursive: true, force: true });
});

test('a late ambiguous §27 pickup failure retains recovery and supersedes an open termination modal (ST2 AC4)', { tag: '@ownapp' }, async () => {
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-v2-bootstrap-pr-fail-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-bootstrap-pr-fail-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-bootstrap-pr-fail-bin-');
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
      FAKE_PICKUP_DELAY: '2',
      FAKE_PR_CREATE_FAIL: '1',
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await flowControl().click();
  await flowControl().click();
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();
  await expect.poll(() => readGhLog(logFile), { timeout: 10_000 }).toContain('gh pr create');

  await page.locator('#flow-strip .flow-terminate').click();
  const confirm = page.locator('#flow-confirm-host .flow-modal');
  await expect(confirm).toBeVisible({ timeout: 10_000 });

  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
  await expect(errorDialog).toContainText('Bootstrap failed');
  await expect(errorDialog).toContainText('draft PR creation failed');
  await expect(errorDialog).not.toContainText('Fake ticket');
  await expect(flowStation(1)).toHaveClass(/\bactive\b/, { timeout: 10_000 });
  await expect(flowStation(2)).not.toHaveClass(/\bactive\b/);
  expect(existsSync(`${logFile}.local-branch`)).toBe(true);
  expect(existsSync(`${logFile}.remote-branch`)).toBe(true);
  expect(readIf(join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml'))).toContain('status: pending');

  await app.close();
  for (const dir of [repo, home, binDir]) rmSync(dir, { recursive: true, force: true });
});

test('a §27 approve chains the approved loop\'s output into the next app loop\'s work turn, with the chained-transition audit event (§27.10 / AC1)', { tag: '@ownapp' }, async () => {
  const repo = seedAppChainFlowRepo('agent-term-e2e-v2-chain-', '77');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-chain-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-chain-bin-');
  // Drive the FIRST loop (plan-loop) to its gate; logInjected so we can prove the SECOND loop's work turn
  // carried plan-loop's output. The fake is keyed to step `plan`; the impl work prompt is logged, not driven.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full', logInjected: true });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // enter plan-loop → work → review → consolidate → the clean gate

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');
  expect(readIf(appRunState(repo))).toContain('verdict: clean');
  await loopReadout().click();
  await loopPanel().locator('[data-gate-option="approve"]').click();

  // AC1 — approve runs plan-loop's side-effect and advances to impl-loop, whose work turn is entered carrying
  // plan-loop's approved output (plan.md) as impl-loop's typed input (§27.10).
  await expect.poll(() => readGhLog(logFile), { timeout: 15_000 }).toContain('gh pr ready 4242');
  await expect.poll(() => readIf(appFlowState(repo)), { timeout: 15_000 }).toContain('step: implement'); // advanced onto the next app loop
  await expect
    .poll(() => readIf(join(repo, '.agent-terminal', 'injected-log')), { timeout: 40_000 })
    .toContain(`- plan: ${APP_ARTIFACT_REL}`); // impl-loop's work turn carries plan-loop's output as its input

  // The chained transition is recorded once in the §25 audit, naming the step it chained INTO (§6 identity).
  await expect.poll(() => auditRunFiles(home, repo).length, { timeout: 10_000 }).toBe(1);
  const run = readAuditRun(home, repo, auditRunFiles(home, repo)[0]);
  const chained = run.events.filter((e) => e.type === 'command' && /chained transition/i.test(e.cmd));
  expect(chained.length).toBe(1);
  expect((chained[0] as Extract<AuditEvent, { type: 'command' }>).cmd).toContain('implement');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §27.10 — STARTING a run at a step is not a chain advance: no upstream loop has run, so an artifact already
// sitting at a declared input path is left over from an earlier run (nothing clears the artifacts subtree) or
// committed by the repo. Carrying it would have the app vouch to the agent that "the previous loop produced
// this" about a file no previous loop in this run produced, and record a transition that never happened.
test('a §27 flow START does not carry a leftover artifact at a declared input path, and records no chained transition (§27.10)', { tag: '@ownapp' }, async () => {
  const repo = seedAppChainFlowRepo('agent-term-e2e-v2-stale-', '77');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-stale-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-stale-bin-');
  // A leftover groomed-ticket.md at exactly the path plan-loop declares as its typed input, as an earlier
  // run (or a repo that committed the artifacts subtree) would leave it.
  const staleRel = '.agent-terminal/loop/artifacts/groomed-ticket.md';
  mkdirSync(join(repo, '.agent-terminal', 'loop', 'artifacts'), { recursive: true });
  writeFileSync(join(repo, staleRel), '# a groomed ticket from some earlier run\n');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full', logInjected: true });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // START the run at plan-loop — not an advance from any upstream loop

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');
  // The leftover artifact is never announced to the work agent as the previous loop's output.
  expect(readIf(join(repo, '.agent-terminal', 'injected-log'))).not.toContain(staleRel);
  await expect.poll(() => auditRunFiles(home, repo).length, { timeout: 10_000 }).toBe(1);
  const run = readAuditRun(home, repo, auditRunFiles(home, repo)[0]);
  expect(run.events.filter((e) => e.type === 'command' && /chained transition/i.test(e.cmd))).toHaveLength(0);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a §27 request-changes opens the composer; submitting returns the loop to a review-and-fix round carrying the feedback, without advancing (§27.9 / AC4)', { tag: '@ownapp' }, async () => {
  const repo = seedAppGateFlowRepo('agent-term-e2e-v2-rc-', '77');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-rc-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-rc-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full', review2: 'full', logInjected: true });
  // §19.4 — a review todo the operator can curate into the feedback (a curated subset + free text). A second,
  // already-DONE todo is seeded to prove the composer surfaces only open review work, never resolved items.
  const TODO_TEXT = 'RCTODO-drop-the-dead-index';
  const DONE_TODO_TEXT = 'RCTODO-already-done-do-not-show';
  writeFileSync(
    join(repo, '.agent-terminal', 'todos.json'),
    JSON.stringify([
      { id: 'rc-todo-1', repoKey: repo, text: TODO_TEXT, status: 'active', order: 1, createdAt: '2026-07-20T00:00:00.000Z' },
      { id: 'rc-todo-done', repoKey: repo, text: DONE_TODO_TEXT, status: 'done', order: 2, createdAt: '2026-07-20T00:00:00.000Z' },
    ]),
  );
  // A prior §26 run sits on disk: the §27 request-changes must never touch it (AC8 — the §26 executor never fires).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  const priorState = 'schema_version: 4\nstatus: planning\niteration: 3\npr: 42\nbranch: feat/prior\nbound_loop: plan-loop\nlinked_issues:\n  - 7\n';
  mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  writeFileSync(stateFile, priorState);
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // enter the app plan-loop step → work → review round 1 → consolidate → clean gate

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  expect(readIf(appRunState(repo))).toContain('turn_key: consolidate-plan');

  // AC4 — request-changes opens the feedback composer (a two-step interaction), NOT a direct dispatch.
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="request-changes"]')).toBeVisible({ timeout: 10_000 });
  await loopPanel().locator('[data-gate-option="request-changes"]').click();
  const composer = page.locator('#feedback-composer-host .flow-modal');
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // §19.4 — the composer surfaces the repo's review todos to curate; select the todo AND add free text, so the
  // composed feedback carries both (a curated subset + free text).
  await expect(composer.locator('[data-todo]')).toContainText(TODO_TEXT, { timeout: 10_000 });
  // N6 — only OPEN review todos are curatable; the already-done one is filtered out (exactly one row shows).
  await expect(composer.locator('.todo-curate')).not.toContainText(DONE_TODO_TEXT);
  await expect(composer.locator('[data-todo]')).toHaveCount(1);
  await composer.locator('[data-todo] input[type="checkbox"]').first().check();
  const FEEDBACK = 'RCFEEDBACK-tighten-the-migration-section';
  await composer.locator('textarea').fill(FEEDBACK);
  // §19.4 — choose compose-with-agent so the delivered feedback is framed for the fixer to synthesize.
  await composer.locator('input[name="feedback-mode"][value="compose"]').check();
  await composer.locator('.confirm').click();
  await expect(composer).toBeHidden({ timeout: 10_000 }); // the composer closes on submit

  // AC4 — a NEW review-and-fix round runs (round 2), and the injected round-2 review prompt carried BOTH the
  // typed feedback and the curated review todo, framed by the compose-with-agent mode (§19.4/§27.9).
  await expect.poll(() => readIf(join(repo, '.agent-terminal', 'injected-log')), { timeout: 40_000 }).toContain(FEEDBACK);
  const injected = readIf(join(repo, '.agent-terminal', 'injected-log'));
  expect(injected).toContain(TODO_TEXT); // the curated subset rode along
  expect(injected).toContain('Synthesize'); // the compose-with-agent framing traveled in the feedback text
  await expect.poll(() => readIf(join(repo, '.agent-terminal', 'review-runs')).length, { timeout: 40_000 }).toBe(2);
  // The re-entered round runs to COMPLETION, not just to injection: round 2's review done-signal is heard (the
  // done-watch was armed for the re-entry), so the consolidator runs a SECOND time and the loop reaches a gate
  // again. Without the completion watch the round would hang at round-2 `working` with the suite otherwise green.
  await expect.poll(() => readIf(join(repo, '.agent-terminal', 'consolidate-runs')).length, { timeout: 40_000 }).toBe(2);
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');
  // The loop iterated: the run reaches round 2 (not round 1), and the flow did NOT advance off the step —
  // request-changes returns to iterate, it is not terminal (contrast approve, which advances to `done`).
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('round: 2');
  expect(readIf(appFlowState(repo))).toContain('step: plan'); // still on the loop step, not advanced to `done`
  expect(readGhLog(logFile)).not.toContain('gh pr ready'); // request-changes ran NO gh side-effect (that is approve's)

  // AC8 — the §26 state.yaml is byte-for-byte unchanged: the §27 request-changes never fired the §26 executor.
  expect(readFileSync(stateFile, 'utf8')).toBe(priorState);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a §27 redo opens the composer; submitting re-runs the WORK turn on a clean slate carrying the instruction, without advancing (§27.9 / AC5)', { tag: '@ownapp' }, async () => {
  const repo = seedAppGateFlowRepo('agent-term-e2e-v2-redo-', '77');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-redo-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-redo-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full', logInjected: true });
  // A prior §26 run sits on disk: the §27 redo must never touch it (AC8 — the §26 executor never fires).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  const priorState = 'schema_version: 4\nstatus: planning\niteration: 3\npr: 42\nbranch: feat/prior\nbound_loop: plan-loop\nlinked_issues:\n  - 7\n';
  mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  writeFileSync(stateFile, priorState);
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // enter the app plan-loop step → work → review round 1 → consolidate → clean gate

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  expect(readIf(appRunState(repo))).toContain('turn_key: consolidate-plan');
  expect(readIf(join(repo, '.agent-terminal', 'work-runs')).length).toBe(1); // the work turn ran exactly once so far

  // AC5 — redo opens the instruction composer (a two-step interaction), NOT a direct dispatch.
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="redo"]')).toBeVisible({ timeout: 10_000 });
  await loopPanel().locator('[data-gate-option="redo"]').click();
  const composer = page.locator('#redo-composer-host .flow-modal');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  const INSTRUCTION = 'REDOINSTR-restructure-the-plan-around-the-schema';
  await composer.locator('textarea').fill(INSTRUCTION);
  await composer.locator('.confirm').click();
  await expect(composer).toBeHidden({ timeout: 10_000 }); // the composer closes on a confirmed re-entry

  // AC5 — the WORK turn re-ran (work-runs → 2) on a clean slate; the re-injected work prompt carried the
  // operator's instruction and the redo framing (never a review round).
  await expect.poll(() => readIf(join(repo, '.agent-terminal', 'injected-log')), { timeout: 40_000 }).toContain(INSTRUCTION);
  expect(readIf(join(repo, '.agent-terminal', 'injected-log'))).toContain('REDO'); // the clean-slate framing traveled
  await expect.poll(() => readIf(join(repo, '.agent-terminal', 'work-runs')).length, { timeout: 40_000 }).toBe(2); // the work turn re-ran

  // redo is not terminal: the flow did NOT advance off the step and ran NO gh side-effect (that is approve's).
  expect(readIf(appFlowState(repo))).toContain('step: plan');
  expect(readGhLog(logFile)).not.toContain('gh pr ready');
  // AC8 — the §26 state.yaml is byte-for-byte unchanged: the §27 redo never fired the §26 executor.
  expect(readFileSync(stateFile, 'utf8')).toBe(priorState);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a §27 polish stands the orchestrator down, survives a relaunch, and approve ends it → terminal accept → advance (§27.9 / AC6,AC11)', { tag: '@ownapp' }, async () => {
  const repo = seedAppGateFlowRepo('agent-term-e2e-v2-polish-', '77');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-polish-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-polish-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  const priorState = 'schema_version: 4\nstatus: planning\niteration: 3\npr: 42\nbranch: feat/prior\nbound_loop: plan-loop\nlinked_issues:\n  - 7\n';
  mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  writeFileSync(stateFile, priorState);
  const polishFile = join(repo, '.agent-terminal', 'loop', 'polish.yaml');
  const launch = () =>
    electron.launch({
      args: ['out/main/index.js'],
      env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
    });

  app = await launch();
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // enter the app plan-loop step → work → review → consolidate → clean gate

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');

  // AC6 — choosing polish stands the orchestrator down: app-owned loop state is written and the panel shows the
  // polish view — only approve (which ends polish), never the other levers.
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="polish"]')).toBeVisible({ timeout: 10_000 });
  await loopPanel().locator('[data-gate-option="polish"]').click();
  await expect.poll(() => existsSync(polishFile), { timeout: 10_000 }).toBe(true); // the stand-down is persisted
  await expect(loopPanel().locator('[data-polish-standdown]')).toBeVisible({ timeout: 10_000 });
  await expect(loopPanel().locator('[data-gate-option="redo"]')).toHaveCount(0);
  await expect(loopPanel().locator('[data-gate-option="request-changes"]')).toHaveCount(0);
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible();
  // The run-state is untouched by polish — it stays at the gate (its own file carries the stand-down).
  expect(readIf(appRunState(repo))).toContain('status: complete');
  expect(readIf(appFlowState(repo))).toContain('step: plan'); // polish is not terminal — the flow did not advance

  await app.close();

  // AC11 — after a relaunch the polish stand-down is STILL active (the orchestrator still stands down): the
  // panel reconstructs the polish view (only approve), never the full gate.
  app = await launch();
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await typeCommand('fake-agent');
  await loopReadout().click();
  await expect(loopPanel().locator('[data-polish-standdown]')).toBeVisible({ timeout: 15_000 });
  await expect(loopPanel().locator('[data-gate-option="redo"]')).toHaveCount(0);
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible();
  expect(existsSync(polishFile)).toBe(true); // still standing down

  // AC6 — approve ends polish: it clears the stand-down, runs the loop's gh side-effect (plan → PR non-draft
  // flip), reaches the terminal accept, and the flow advances off the loop step.
  await loopPanel().locator('[data-gate-option="approve"]').click();
  await expect.poll(() => readGhLog(logFile), { timeout: 15_000 }).toContain('gh pr ready 77');
  await expect.poll(() => existsSync(polishFile), { timeout: 10_000 }).toBe(false); // polish ended
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 10_000 }).toContain('status: accepted');
  await expect.poll(() => readIf(appFlowState(repo)), { timeout: 10_000 }).toContain('step: done'); // advanced off the loop step

  // AC8 — the §26 state.yaml is byte-for-byte unchanged: the §27 polish/approve never fired the §26 executor.
  expect(readFileSync(stateFile, 'utf8')).toBe(priorState);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a failed §27 approve side-effect is surfaced and the flow still reaches its terminal accept — never a strand (AC3)', { tag: '@ownapp' }, async () => {
  // No pr resolved → plan-loop's mark-ready has no PR to flip → the side-effect fails best-effort.
  const repo = seedAppGateFlowRepo('agent-term-e2e-v2-approvefail-', null);
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-approvefail-home-'));
  const config = seedOperatorPlanLoopConfig('agent-term-e2e-v2-approvefail-config-', (yaml) =>
    withoutPickup(yaml),
  );
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-approvefail-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: config, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');

  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });
  await loopPanel().locator('[data-gate-option="approve"]').click();

  // AC3 — the failure is surfaced (the blocking loop-error dialog), yet the terminal accept is NOT aborted:
  // the run reaches `accepted` and the flow advances, so the step is never stranded.
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await expect(errorDialog).toContainText('side-effect failed');
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 10_000 }).toContain('status: accepted');
  await expect.poll(() => readIf(appFlowState(repo)), { timeout: 10_000 }).toContain('step: done'); // advanced despite the failure

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a malformed/unresolvable §27 def surfaces its reason and the flow keeps a route off the step (§27.15 / AC 6)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-fail-', 'no-such-v2-loop');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-fail-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, CLAUDE_CONFIG_DIR: exampleConfigDir, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → enter the step bound to an unresolvable §27 def: no turn starts (AC6)

  // The reason is readable in the panel, and the Advance control is still present — the route off the
  // failed step that needs no hand-editing of files on disk (AC 6). No §27 run state was written (no turn).
  await loopReadout().click();
  await expect(loopPanel()).toContainText('no-such-v2-loop', { timeout: 10_000 });
  expect(existsSync(appRunState(repo))).toBe(false);
  await expect(flowControl()).toHaveText('Advance');
  await flowControl().click(); // the route out completes the flow
  await expect(flowControl()).toHaveText('Restart', { timeout: 10_000 });

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('a §27 work turn with no valid artifact retries then errors, offering all three route-out affordances; Accept advances a present artifact without re-running (§27.12 / AC5,7)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-fail-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-fail-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-fail-bin-');
  // The fake agent fires the done-file but writes an artifact WITHOUT the completion marker → not well-formed.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'no-marker' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');

  await flowControl().click(); // enter the app step → §27 work turn

  // Done-signal + a marker-less artifact → one retry → error. The work prompt was injected twice (AC5).
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 30_000 }).toContain('status: error');
  expect(readIf(join(repo, '.agent-terminal', 'work-runs')).length).toBe(2); // initial + one retry, then stop

  // The turn failure is never silent: it raises the blocking error dialog (§26.3/D48 surface, reused).
  // Dismiss it so it does not intercept the panel controls exercised below.
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await errorDialog.locator('.dismiss').click();
  await expect(errorDialog).toHaveCount(0);

  // The panel offers all three route-out affordances (§27.12c) — never a Terminate-only dead-end.
  await loopReadout().click();
  await expect(loopPanel().locator('[data-app-route-out="retry"]')).toBeVisible({ timeout: 10_000 });
  await expect(loopPanel().locator('[data-app-route-out="accept"]')).toBeVisible();
  await expect(loopPanel().locator('[data-app-route-out="terminate"]')).toBeVisible();

  // The artifact is actually present now (the operator sees it is fine); make it well-formed and Accept it.
  writeFileSync(join(repo, APP_ARTIFACT_REL), `# plan\n${completionMarker('plan')}\n`);
  await loopPanel().locator('[data-app-route-out="accept"]').click();

  // Accept advances through the same chain a signalled completion takes — WITHOUT re-running the turn.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 15_000 }).toContain('status: complete');
  expect(readIf(join(repo, '.agent-terminal', 'work-runs')).length).toBe(2); // Accept never re-injected the work turn

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §27.12 / AC8 — a §27 work turn stranded in `error`, resumed after a RELAUNCH, must complete on its
// done-signal when Retry re-drives it: the resume/route-out path re-arms the §27 done-file watch, so the
// re-injected turn's turn-done file is observed. Without the re-arm the fresh process has no live watcher,
// so a perfect marker-bearing artifact + done-file is unseen and the turn can only stall to a second error.
test('a §27 error resumed after relaunch completes on its done-signal when Retry re-drives it (§27.12 / AC8)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-rearm-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-rearm-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-rearm-bin-');
  // Process 1: the fake agent fires the done-file but writes a marker-less artifact → one retry → error.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'no-marker' });
  const launch = () =>
    electron.launch({
      args: ['out/main/index.js'],
      env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', APP_TURN_TIMEOUT_MS: '4000', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
    });

  app = await launch();
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // enter the app step → §27 work turn → error (no valid artifact)
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 30_000 }).toContain('status: error');
  await app.close();

  // The operator fixes the agent; the retry after relaunch will now produce a marker-bearing artifact.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete' });

  // Relaunch = a fresh process with NO live §27 watcher. The persisted error reconstructs on the route-out.
  app = await launch();
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await typeCommand('fake-agent'); // host the agent so the re-driven turn injects

  await loopReadout().click();
  await expect(loopPanel().locator('[data-app-route-out="retry"]')).toBeVisible({ timeout: 15_000 });
  await loopPanel().locator('[data-app-route-out="retry"]').click();

  // Land: the re-armed watcher observes the retried WORK turn's done-file; the work turn completes, chains
  // the review-and-fix turn (which writes a full report), and the run advances to complete (not a second
  // stall→error). Under the pre-fix wiring the done-signal is unseen and this never reaches complete.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');
  expect(readFileSync(join(repo, APP_ARTIFACT_REL), 'utf8')).toContain(completionMarker('plan'));

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §27.12 / §27.15 / CWE-703/755 — a §27 turn left `working` when the app was killed mid-turn is
// DEFINITIONALLY stopped after a relaunch (its PTY is gone). Unlike an `error` turn, `working` is not
// human-needed, so pre-fix the panel showed no route-out at all: the run was recoverable only by hand-editing
// run-state.yaml. The derived view must reconstruct the stranded turn so the retry/terminate route-out
// renders, and Retry must re-arm the §27 done-watch so the re-driven turn completes on its done-signal.
test('a §27 turn stranded `working` by a relaunch surfaces a route-out and Retry drives it to completion (§27.12 / CWE-703/755)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-working-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-working-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-working-bin-');
  // Process 1: a noop agent produces nothing, so the work turn stays `working` (a long stall timeout keeps it
  // from erroring); the app is closed while it is still `working`, persisting the strand.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'noop' });
  const launch = (turnTimeoutMs: string) =>
    electron.launch({
      args: ['out/main/index.js'],
      env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', APP_TURN_TIMEOUT_MS: turnTimeoutMs, CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
    });

  app = await launch('60000'); // long: the noop turn stays `working`, never stalls to error
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // enter the app step → §27 work turn → stays `working`
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 30_000 }).toContain('status: working');
  await app.close(); // killed mid-turn: the disk holds `working`

  // The operator fixes the agent; the retry after relaunch will now produce a marker-bearing artifact.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete' });

  app = await launch('4000');
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await typeCommand('fake-agent'); // host the agent so the re-driven turn injects

  // Pre-fix the persisted `working` mirrored to a not-human-needed view with NO route-out — this never
  // appeared. Post-fix the derived view reconstructs the stranded turn and the retry affordance renders.
  await loopReadout().click();
  await expect(loopPanel().locator('[data-app-route-out="retry"]')).toBeVisible({ timeout: 15_000 });
  await loopPanel().locator('[data-app-route-out="retry"]').click();

  // Land: the re-armed §27 done-watch observes the retried work turn's done-file; the turn completes, chains
  // the review-and-fix + consolidate turns, and the run reaches the clean gate — never a silent idle.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');
  expect(readFileSync(join(repo, APP_ARTIFACT_REL), 'utf8')).toContain(completionMarker('plan'));

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §27.6 tracer bullet (b) — a round that fixed something → `another round` over the consolidator's chosen
// roster, and a SECOND review-and-fix round runs (its report is written to reports/2.md).
test('a §27 `another round` verdict crosses the boundary back into a second review-and-fix round (§27.6 / AC4)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-round2-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-round2-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-round2-bin-');
  seedFakeAgentV2(binDir, {
    stepId: 'plan',
    artifactRel: APP_ARTIFACT_REL,
    work: 'complete',
    verdicts: [`verdict: another round\nroster: ${PLAN_V2_ROSTER[0]}\n`, 'verdict: clean\n'],
  });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // enter the app step → work → review round 1 → consolidate

  // Round 1's `another round` loops back into a second review-and-fix round (reports/2.md is proof it ran),
  // then round 2's consolidator emits clean → the gate.
  await expect.poll(() => existsSync(join(repo, '.agent-terminal', 'loop', 'reports', '2.md')), { timeout: 40_000 }).toBe(true);
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');

  await app.close();
  for (const d of [repo, home, binDir]) rmSync(d, { recursive: true, force: true });
});

// §27.6 tracer bullet (c) — a report recording a persona that failed to run is never presented clean: a
// FRESH failure re-reviews, and a REPEAT failure (the same lens fails again) stops for a human.
test('a §27 failed reviewer is never read as clean: fresh re-reviews, repeat stops for a human (§27.5/§27.6 / AC7)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-failed-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-failed-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-failed-bin-');
  // Both rounds record review-plan-principal as failed-to-run; the consolidator says `clean` both times, but
  // the engine's failed-lens guard overrides: round 1 fresh → re-review, round 2 repeat → stop for a human.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'failed', review2: 'failed', verdicts: ['verdict: clean\n', 'verdict: clean\n'] });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // The fresh failure forces a re-review (round 2 runs), and the repeat failure routes to the human gate —
  // the loop is NEVER presented as clean despite the consolidator's `clean` verdict.
  await expect.poll(() => existsSync(join(repo, '.agent-terminal', 'loop', 'reports', '2.md')), { timeout: 40_000 }).toBe(true);
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: stop for a human');
  expect(readIf(appRunState(repo))).not.toContain('verdict: clean');

  await app.close();
  for (const d of [repo, home, binDir]) rmSync(d, { recursive: true, force: true });
});

// §27.6 tracer bullet (d) — malformed consolidator output → one retry then a human-needed error with a
// route out (the panel offers retry / accept / terminate).
test('malformed §27 consolidator output drives one retry then a recoverable error (§27.12 / AC3,12)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-cmalformed-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-cmalformed-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-cmalformed-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', verdicts: ['this consolidator output carries no verdict at all\n'] });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // The malformed output is re-injected once, then the consolidate turn stops in a human-needed error.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: error');
  expect(readIf(appRunState(repo))).toContain('turn_key: consolidate-plan');
  expect(readIf(join(repo, '.agent-terminal', 'consolidate-runs')).length).toBe(2); // initial + one retry

  // The error is never silent: dismiss the dialog, then the panel offers the §27 route-out (never a dead end).
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await errorDialog.locator('.dismiss').click();
  await expect(errorDialog).toHaveCount(0);
  await loopReadout().click();
  await expect(loopPanel().locator('[data-app-route-out="retry"]')).toBeVisible({ timeout: 10_000 });
  await expect(loopPanel().locator('[data-app-route-out="terminate"]')).toBeVisible();

  await page.evaluate(() =>
    window.monitor.capture({ text: 'route-out capture', range: null, source: 'selection' }),
  );
  await openQuickSend('todo');
  await page.locator('#todo-new').fill('route-out todo');
  await page.locator('#todo-add-btn').click();
  await page.locator('#qs').click();
  await loopPanel().locator('[data-app-route-out="terminate"]').click();
  await expect(confirmModal()).toBeVisible();
  await expect(confirmModal()).toContainText('1 todo');
  await expect(confirmModal()).toContainText('clears captured reports for this terminal');
  await expect(page.locator('#todo-list .todo')).toHaveCount(1);
  await confirmModal().locator('.confirm').click();
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await expect(page.locator('#todo-list .todo')).toHaveCount(0);
  await expect(page.locator('#monitor-blocks [data-event-id]')).toHaveCount(0);
  await expect
    .poll(() =>
      auditRunFiles(home, repo).length
        ? readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.map((event) => event.type)
        : [],
    )
    .toContain('flow.terminated');

  await app.close();
  for (const d of [repo, home, binDir]) rmSync(d, { recursive: true, force: true });
});

// §27.6 tracer bullet (e) — an armed interrupt routes to the gate at the next consolidate, stating the
// verdict it would otherwise have reached. Armed through the renderer's window.flow seam (the same IPC the
// panel's "hand back to me" button fires); the button itself is covered by the loopPanel DOM unit tests.
test('an armed §27 interrupt routes to the gate with the would-be verdict stated (§27.9 / AC9)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-arm-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-arm-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-arm-bin-');
  // Round 1's consolidator would return `another round` (loop back), but the armed interrupt diverts it.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', verdicts: [`verdict: another round\nroster: ${PLAN_V2_ROSTER[0]}\n`] });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');

  // Arm the interrupt BEFORE the run starts (queued, honored at the FIRST consolidate). It is persisted
  // independently of the run-state, so it is honored regardless of when the consolidate turn arrives.
  const repoKey = realpathSync(repo);
  await page.evaluate((key) => window.flow.armInterrupt(key, 'plan'), repoKey);

  await flowControl().click(); // enter the app step → work → review round 1 → consolidate (honors the arm)

  // The consolidator would have looped back (`another round`), but the armed interrupt routes to the gate
  // stating that would-be verdict — the loop stops at the consolidator's gate, not a new review round.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: another round');
  expect(readIf(appRunState(repo))).toContain('status: complete');
  expect(readIf(appRunState(repo))).toContain('turn_key: consolidate-plan');

  await app.close();
  for (const d of [repo, home, binDir]) rmSync(d, { recursive: true, force: true });
});

test('a legacy (§26) loop step still runs the §26 work path unchanged, writing no §27 loop state (§27.15 / AC10)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-v2-legacy-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-legacy-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-legacy-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToWorkTurn(repo, home, binDir, logFile, '60000');

  // The §26 work path runs exactly as today: it writes its §26 artifact under .agent-loop/.
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'plan.md')), { timeout: 20_000 }).toBe(true);
  // …and the §27 engine is entirely absent — no §27 loop state was written for a legacy step (AC10).
  expect(existsSync(appRunState(repo))).toBe(false);

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

test('request-changes resets the per-loop cap window; a following needs-work verdict re-iterates instead of routing to triage (§26.13 / L6)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l6-capreset-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l6-capreset-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l6-capreset-bin-');
  // plan-loop's severity_cap is 2, counted over the per-loop window `iteration - cap_baseline`. Iteration 1
  // consolidates clean → the approval gate; request-changes there RESETS the window (cap_baseline := 1) and
  // re-iterates. Iterations 2+ consolidate needs-work: under the RETIRED phase-2 routing the first would have
  // re-gated at iteration 2 at once; with the window reset, iteration 2 (window count 1) auto-iterates and the
  // run reaches iteration 3 — the observable that phase-2 is gone. Empty findings keep the stuck detector quiet.
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'needs-work', consolidateIter1: 'clean' });
  await driveToPlanGate(repo, home, binDir, logFile);

  await gateButton('request-changes').click();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  // The window reset let iteration 2's needs-work AUTO-ITERATE past the triage gate the retired phase-2
  // routing would have STOPped at; at iteration 3 the window (3 - 1 = 2) reaches the cap, so the run STOPs
  // at the triage gate rather than iterating unbounded — pinning BOTH that phase-2 is gone AND the reset
  // window still bounds the loop.
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 45_000 })
    .toContain('status: awaiting-human-plan-triage');
  const stateText = readFileSync(stateFile, 'utf8');
  expect(stateText).toContain('iteration: 3'); // auto-iterated past the iteration-2 phase-2 STOP
  expect(stateText).toContain('cap_baseline: 1'); // the window origin request-changes set at iteration 1
  expect(stateText).not.toContain('phase2_active: true'); // phase-2 routing is retired
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

// §26 D42a (Slice 3 / Q3) — the FIRST work turn of a freshly-bootstrapped loop step is preceded by the same
// actor-boundary /clear (§26.3/D46) as every other loop-step entry, so the loop starts from a clean agent
// context (e.g. the human's grooming conversation is cleared before the plan work begins). `plan-only` never
// signals done, so the loop never advances past this first work turn — clear-seen can ONLY come from the
// bootstrap /clear, not a later reviewers/consolidate boundary. That isolates this slice's behavior.
test('the plan bootstrap first work turn is preceded by an actor-boundary /clear (§26 D42a)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-bootstrap-clear-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-bootstrap-clear-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-bootstrap-clear-bin-');
  seedFakeAgent(binDir, { work: 'plan-only' }); // no reviews/consolidate: the only possible /clear is the bootstrap work turn's
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');

  // The bootstrapped loop's first work turn injected /clear before its work prompt (clear-seen), and that
  // /clear preceded a REAL work prompt (plan.md written) — no other turn boundary has occurred.
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'clear-seen')), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'plan.md')), { timeout: 15_000 }).toBe(true);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

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

test('activating the status-bar alert opens the docked panel and lands focus on the gate decision (§22.3.1 / WCAG 2.4.3)', async () => {
  // The whole point of the alert→panel seam: a keyboard user who activates the red alert is routed ONTO
  // the decision, not merely shown the panel. This drives the REAL alert through the composition root
  // (openLoopPanel + the panel's own focusDecision) and observes focus land — the un-hide-then-focus
  // ordering jsdom cannot exercise.
  const repo = seedBootstrapFlowRepo('agent-term-e2e-alertfocus-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-alertfocus-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-alertfocus-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000');
  await expect
    .poll(() => readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8'), { timeout: 25_000 })
    .toContain('status: awaiting-human-plan-approval');

  // The panel is still closed; the alert is the status bar's attention state.
  await expect(statusAlert()).toBeVisible({ timeout: 10_000 });
  await statusAlert().click();
  await expect(gateButton('approve')).toBeVisible({ timeout: 10_000 });
  await expect(gateButton('approve')).toBeFocused(); // routed onto the decision, not left on the alert

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26 D42a — reaching a SUCCESS terminal (approve at the plan gate) auto-advances the flow into the next
// step (Slice 1), and entering that `implement` loop step — which has no `bootstrap: pickup` — RESUMES the
// existing run under impl-loop (Slice 2, `agent-loop resume --loop`): state.yaml is rebound to impl-loop at
// its impl-draft entry status with the per-loop internal counters reset to a new-run baseline — EXCEPT the
// run's MONOTONIC iteration, which carries forward (plan's 1 → impl's 2) — but the SAME PR/branch/issue
// carried, and the impl loop's first work turn is driven behind an actor-boundary /clear.
test('approve at the plan gate auto-advances the flow and resumes into the impl loop (§26 D42a)', async () => {
  const repo = seedChainFlowRepo('agent-term-e2e-chain-advance-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-chain-advance-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-chain-advance-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToPlanGate(repo, home, binDir, logFile);

  // Pre-approve: the flow is still at the plan step, bound to plan-loop.
  const flowStateFile = join(repo, '.agent-terminal', 'flow-state.yaml');
  expect(readFileSync(flowStateFile, 'utf8')).toContain('step: plan');

  await gateButton('approve').click();

  // Slice 1 — the success terminal auto-advanced the flow: the strip's active station moves to the
  // implement step and the progression persists to flow-state.yaml.
  await expect.poll(() => readFileSync(flowStateFile, 'utf8'), { timeout: 20_000 }).toContain('step: implement');
  await expect(page.locator('#flow-strip .stn.active .nm')).toHaveText('implement', { timeout: 10_000 });

  // Slice 2 — entering the non-pickup implement step rebound the run to impl-loop at impl-draft, carrying the
  // plan run's PR/branch/issue (a resume, never a fresh pickup). §26 D42a — iteration is a single MONOTONIC
  // counter across the whole run (ai-deque parity): the plan loop finished at iteration 1, so the impl loop
  // continues at iteration 2, NOT reset to 1. That climb is what keeps impl's reviews/<iter>/ from colliding
  // with the plan loop's (impl writes reviews/2/, not over reviews/1/).
  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 15_000 }).toContain('bound_loop: impl-loop');
  const stateText = readFileSync(stateFile, 'utf8');
  expect(stateText).toContain('status: impl-draft');
  expect(stateText).toMatch(/^iteration: 2$/m); // monotonic: carried forward from the plan loop's 1, never reset
  expect(stateText).toContain('cap_baseline: 1'); // the impl loop opens its OWN cap window at the plan loop's final iteration
  expect(stateText).toContain('branch: plan-loop/issue-176'); // same branch — resume kept the plan PR
  expect(stateText).toMatch(/linked_issues:\s*\n\s*- 176/); // the plan run's issue carried, not reset

  // The DISPLAYED iteration is the monotonic counter verbatim — the count climbs to "iter 2" and never
  // resets to 1 when the successor loop begins.
  await expect(loopReadout()).toContainText('iter 2', { timeout: 10_000 });

  // The actor-boundary /clear fired (§26.3/D46), THEN the impl loop's OWN work prompt reached the agent
  // (turnKey work-impl) — the resumed loop drove its first work turn.
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'clear-seen')), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'impl-work-ran')), { timeout: 15_000 }).toBe(true);
  // The impl WORK turn completed on the turn-done file ALONE (§26.3/D47a — impl produces code, not a plan.md
  // deliverable, so its completion is not gated on any .agent-loop artifact) and the run advanced into the
  // impl loop's reviewer fan-out: the review-impl prompt reached the agent.
  await expect.poll(() => existsSync(join(repo, '.agent-loop', 'impl-review-ran')), { timeout: 15_000 }).toBe(true);
  // Resume, not pickup: no new impl branch was created (the fake git/gh log carries no impl-loop branch).
  expect(readFileSync(logFile, 'utf8')).not.toContain('impl-loop/');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26.6 — the exec gate action (ticket-body publish). The vendored plan-loop's plan-approve gate carries
// `exec: [gh, issue, edit, {{state.linked_issues[0]}}, --body-file, {{artifact.ticket-body}}]`; approving
// interpolates it against the run (issue 176, .agent-loop/ticket.md) and runs it out of band. Allowed by
// default; a repo opts a loop out via `.agent-loop.yaml` loops_deny_exec.
test('approve at the plan gate runs the exec ticket-body publish out of band (§26.6)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-exec-on-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-exec-on-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-exec-on-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToPlanGate(repo, home, binDir, logFile);

  await gateButton('approve').click();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 15_000 }).toContain('status: plan-human-approved');
  // The exec ran: fake gh recorded `gh issue edit 176 --body-file <repo>/.agent-loop/ticket.md`, its
  // placeholders resolved from the run's linked issue + the LoopDef ticket-body artifact path.
  await expect.poll(() => readFileSync(logFile, 'utf8'), { timeout: 10_000 }).toContain('issue edit 176 --body-file');
  expect(readFileSync(logFile, 'utf8')).toContain(join('.agent-loop', 'ticket.md'));

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('a repo that opts the loop out via loops_deny_exec runs no exec at the plan gate (§26.6)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-exec-off-');
  // Opt plan-loop out of exec; no `loops:` registry, so LoopDef resolution still falls back to config dir.
  writeFileSync(join(repo, '.agent-loop.yaml'), 'loops_deny_exec:\n  plan-loop: true\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-exec-off-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-exec-off-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToPlanGate(repo, home, binDir, logFile);

  await gateButton('approve').click();

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect.poll(() => readFileSync(stateFile, 'utf8'), { timeout: 15_000 }).toContain('status: plan-human-approved');
  // The transition + mark-pr-ready still ran, but the opted-out exec did not. Scope to the exec's
  // `--body-file` ticket-body publish — pickup legitimately runs `gh issue edit` for label/assignee moves.
  await expect.poll(() => readFileSync(logFile, 'utf8'), { timeout: 10_000 }).toContain('pr ready');
  expect(readFileSync(logFile, 'utf8')).not.toContain('issue edit 176 --body-file');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('request-changes at the plan gate writes a human note, resets the cap window, and re-iterates (§26.13 / L5)', async () => {
  const repo = seedBootstrapFlowRepo('agent-term-e2e-l5-changes-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l5-changes-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l5-changes-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean' });
  await driveToPlanGate(repo, home, binDir, logFile);

  await gateButton('request-changes').click();

  // Land: the note is written for the critiqued iteration (1), the per-loop cap window resets to that
  // iteration (cap_baseline: 1), and the loop re-iterates (a second iteration's consolidated.json appears).
  // No PR is readied (request-changes has no such action).
  await expect
    .poll(() => existsSync(join(repo, '.agent-loop', 'human-notes', '1.md')), { timeout: 15_000 })
    .toBe(true);
  await expect
    .poll(() => existsSync(join(repo, '.agent-loop', 'reviews', '2', 'consolidated.json')), { timeout: 30_000 })
    .toBe(true);
  const stateText = readFileSync(join(repo, '.agent-loop', 'state.yaml'), 'utf8');
  expect(stateText).toContain('cap_baseline: 1');
  expect(stateText).not.toContain('phase2_active: true');
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
  // §26 D42a — impasse is a human-owned FAILURE terminal: the flow does NOT auto-advance (it stays at the
  // plan step, never advancing to `done`), so the human resolves the impasse rather than the flow marching on.
  const flowStateText = readFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'utf8');
  expect(flowStateText).toContain('step: plan');
  expect(flowStateText).not.toContain('status: done');

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
  // writes the §26.10 session-log fixture: $3.00 of work tokens (replayed twice under one billing identity)
  // + $1.50 of reviewer-subagent tokens, beside $15 of a session that predates this flow and a zero-token
  // `<synthetic>` turn. Only this run's distinct, priced turns count → exactly $4.50, with no pricing gap.
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', costFixture: true });
  await driveToWorkTurn(repo, home, binDir, logFile, '30000', { APP_SESSION_LOG_ROOT: logRoot });

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 25_000 })
    .toContain('status: awaiting-human-plan-approval');
  // Land (state): the iteration boundary persisted the priced cost into the app-owned extension.
  expect(readFileSync(stateFile, 'utf8')).toContain('usd: 4.5');

  // Land (strip): the read-out shows this run's dollars — the pre-flow session, the replayed turn, and the
  // zero-token `<synthetic>` model all excluded, the reviewer subagent's tokens included.
  const cost = loopReadout().locator('.loop-cost');
  await expect(cost).toHaveText('$4.50', { timeout: 15_000 });

  // Land (strip layout): a value too wide for the 200px rail must stay on ONE line and overflow the row,
  // never wrap inside itself. A shrinkable flex item breaks mid-value, interleaving `iter N` and the dollars
  // into unreadable columns (the reported defect: `iter $4104.09` above `1 +unknown`). Drive the widest
  // readout the meter can produce through the real state.yaml → reader → strip path.
  const widened = readFileSync(stateFile, 'utf8').replace('usd: 4.5\n  unpriced: []', 'usd: 4104.09\n  unpriced:\n    - claude-made-up-9');
  expect(widened, 'the cost block moved; re-anchor this rewrite').toContain('usd: 4104.09');
  writeFileSync(stateFile, widened);
  await expect(cost).toHaveText('$4104.09 +unknown', { timeout: 15_000 });
  for (const value of [cost, loopReadout().locator('.loop-iter')]) {
    const lines = await value.evaluate((el) => {
      const one = parseFloat(getComputedStyle(el).fontSize) * 2; // a generous single line box
      return { height: el.getBoundingClientRect().height, oneLine: one };
    });
    expect(lines.height, 'loop read-out value wrapped onto a second line').toBeLessThan(lines.oneLine);
  }

  // Land (audit): the run's YAML carries the per-iteration cost event with the priced dollars.
  const costEvents = readAuditRun(home, repo, auditRunFiles(home, repo)[0]).events.filter(
    (e): e is Extract<AuditEvent, { type: 'loop.cost' }> => e.type === 'loop.cost',
  );
  expect(costEvents).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'loop.cost', iteration: 1, usd: 4.5, unpriced: [] })]),
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

test('an interrupted run resumes at the consolidate turn on launch without re-running completed turns (§26.13 / L8)', { tag: '@ownapp' }, async () => {
  const repo = seedResumeRepo('agent-term-e2e-l8-resume-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l8-resume-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l8-resume-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', turnMarkers: true });

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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });

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
test('resume re-enters the work turn when a re-iteration has a stale plan but no review for the new iteration (§26.13 / L8)', { tag: '@ownapp' }, async () => {
  // Alone among the resume tests this one re-enters at WORK and drives the FULL chain (work → reviewers →
  // consolidate → gate) from a cold launch. Its first poll lands on `work-ran`, an EARLY artifact, so the
  // gate poll below must absorb the entire reviewers→consolidate→gate tail on its own — a 3-turn tail where
  // the single-turn siblings' gate poll covers one. 25s (the siblings' budget) is too tight for that tail
  // under Podman/Xvfb load, and widening it collides with the 60s global per-test cap; grant this test the
  // proportionally larger wall-clock budget the longest chain needs.
  test.setTimeout(90_000);
  const repo = seedResumeRepo('agent-term-e2e-l8-resume-stale-', { iteration: 2, reviews: 'none' });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l8-resume-stale-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l8-resume-stale-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', turnMarkers: true });

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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });

  const stateFile = join(repo, '.agent-loop', 'state.yaml');
  // Land: the WORK turn ran this session (its marker appears) — resume did NOT skip to reviewers on the
  // stale plan — and the freshly-produced iteration drove forward to the plan-approval gate.
  await expect
    .poll(() => existsSync(join(repo, '.agent-loop', 'work-ran')), { timeout: 25_000 })
    .toBe(true);
  // The whole reviewers→consolidate→gate tail runs inside THIS poll (work-ran, above, is an early artifact),
  // so it gets the full-chain budget, not the single-turn siblings' 25s.
  await expect
    .poll(() => readFileSync(stateFile, 'utf8'), { timeout: 45_000 })
    .toContain('status: awaiting-human-plan-approval');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// §26.13 / L8 — an interrupted run whose work, reviewers AND consolidate turns all completed (every
// iteration artifact on disk, including consolidated.json) resumes straight into the post-consolidate
// verdict branch: it re-injects NO turn, reads the recorded clean verdict, and drives to the gate.
test('resume runs only the post-consolidate branch when every iteration artifact already exists (§26.13 / L8)', { tag: '@ownapp' }, async () => {
  const repo = seedResumeRepo('agent-term-e2e-l8-resume-post-', { iteration: 1, reviews: 'all', consolidated: true });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-l8-resume-post-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-l8-resume-post-bin-');
  seedFakeAgent(binDir, { work: 'write-plan', reviews: 'all', consolidate: 'clean', turnMarkers: true });

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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });

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

test('Restart clears a resolved stage-transition input so the next entry re-prompts (§24.2.3 T3)', { tag: '@ownapp' }, async () => {
  // The user supplies the plan step's ticket once; after completing and Restarting the flow, the
  // ticket must be re-requested — Restart wipes resolved inputs (unlike Undo).
  const repo = seedBootstrapFlowRepo('agent-term-e2e-restart-reprompt-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-restart-reprompt-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('loop-derived ticket + PR surface only once the flow enters the loop step (§24.2.3 T7)', { tag: '@ownapp' }, async () => {
  // The loop's linked_issues ticket and state.yaml PR are agent-loop state: progress-gated, they stay
  // hidden on the pre-loop manual step and appear only once the flow enters a loop step (§24.2.3 T7).
  const { dir: repo, stateFile } = seedRefsFlowRepo('agent-term-e2e-refs-');
  writeFileSync(
    stateFile,
    'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: planning\nlinked_issues:\n  - 25\n',
  );
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refs-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → in_progress on the manual `groom` step
  await expect(flowStepName()).toHaveText('groom');
  // The loop step has not been entered, so nothing loop-derived shows — even though state.yaml carries it.
  await expect(loopReadout()).toHaveCount(0);

  await flowControl().click(); // Advance → enter the `work` loop step
  await expect(loopReadout()).toBeVisible({ timeout: 10_000 });
  // A display-only loop step (no resumable def/run) must NOT pop a blocking error dialog — entering it is a
  // legitimate no-op, not a failure (§26 D42a; the round-1 raise regressed this by intercepting all clicks).
  await expect(page.locator('#flow-error-host .flow-modal')).toHaveCount(0);
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

test('Terminate clears the ticket/PR display even though state.yaml still carries the loop (§24.2.3 T7)', { tag: '@ownapp' }, async () => {
  // The prior run's PR/ticket lives on in the read-only state.yaml; Terminate resets the flow to its
  // first step, closing the loop-step gate, so the rail read-out and docked popout empty (loop
  // dismissed, not deleted).
  const { dir: repo, stateFile } = seedRefsFlowRepo('agent-term-e2e-refs-term-');
  writeFileSync(
    stateFile,
    'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: planning\nlinked_issues:\n  - 25\n',
  );
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refs-term-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('Restart clears the ticket/PR display until the flow re-enters a loop step (§24.2.3 T7)', { tag: '@ownapp' }, async () => {
  // Restart returns the flow to its first step, closing the loop-step gate; the display clears with no
  // state.yaml write and returns only once the flow re-enters the loop step — then reflecting whatever
  // loop state.yaml now holds (a fresh pickup).
  const { dir: repo, stateFile } = seedRefsFlowRepo('agent-term-e2e-refs-restart-');
  writeFileSync(
    stateFile,
    'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: planning\nlinked_issues:\n  - 25\n',
  );
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refs-restart-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('a loop step shows a Loop read-out that expands a docked state-mirror panel, live; advancing early warns (§24.2.3 T2)', { tag: '@ownapp' }, async () => {
  // The app DRIVES NOTHING — it mirrors agent-loop's v4 state.yaml read-only, updating live as the
  // file changes (§24.2.3 T2).
  const { dir: repo, stateFile } = seedLoopFlowRepo('agent-term-e2e-loop-');
  writeFileSync(
    stateFile,
    'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: awaiting-human-pr-approval\n',
  );
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-loop-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('a flow transition whose write cannot land surfaces a blocking error and stays retryable (§19.1)', { tag: '@ownapp' }, async () => {
  // persist() throws when the write cannot land; the name-save path surfaces that, and so must a
  // Start/Advance — a transition that silently no-ops leaves the user clicking into the void.
  // `.agent-terminal` is a symlink: the flow.yaml behind it LOADS (readFileSync follows the link), but
  // atomicWriteFileSync REFUSES a symlinked container, so Start's persist() throws.
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-txerr-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const real = mkdtempSync(join(tmpdir(), 'agent-term-e2e-txerr-real-'));
  writeFileSync(join(real, 'flow.yaml'), 'name: manual\nsteps:\n  - id: groom\n    kind: manual\n');
  symlinkSync(real, join(repo, '.agent-terminal'));
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-txerr-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await flowControl().click(); // Start → persist() throws (symlinked container)

  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 10_000 });
  await expect(errorDialog).toContainText('Flow action failed');
  await errorDialog.locator('.dismiss').click();
  await expect(flowControl()).toBeEnabled(); // retryable, not stuck

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(real, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('the reveal signal lands the user on the loop read-out, from another view and from viewer-fullscreen with the strip hidden (§24.2.3 T4)', { tag: '@ownapp' }, async () => {
  // Needs a real git repo so the artifact viewer's full-screen (which hides the rail/strip) works
  // (§24.2.3 T4).
  const { dir: repo, stateFile } = seedLoopFlowRepo('agent-term-e2e-reveal-');
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: awaiting-human-pr-approval\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-reveal-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(
    `cd "${repo}" && rm -rf .git && git init -q && git config user.email t@t && git config user.name T && ` +
      `git add -A && git commit -qm init && printf '# Doc\\n' > doc.md && pwd`,
  );
  await expect(flowStepName()).toHaveText('groom', { timeout: 10_000 });
  await flowControl().click(); // Start → groom
  await flowControl().click(); // Advance → build (loop) active, human-needed
  await expect(loopReadout()).toHaveCount(1, { timeout: 10_000 });
  await expect(statusAlert()).toBeVisible();
  await expect(page.locator('#app')).not.toHaveClass(/\bloop-open\b/); // the docked panel starts closed

  // Reveal from a non-Terminal view must land on Terminal with the read-out open.
  await page.keyboard.press('Control+2');
  await expect(page.locator('[data-viewpane="2"]')).toBeVisible();
  await fireRevealLoop();
  await expect(page.locator('[data-viewpane="1"]')).toBeVisible();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);
  await expect(loopPanel()).toContainText('awaiting-human-pr-approval');

  // Reveal from viewer-fullscreen (rail/strip hidden) must exit full-screen and re-open the read-out
  // on Terminal — and the alert must stay perceivable in the always-visible main region throughout.
  await loopReadout().click();
  await expect(page.locator('#app')).not.toHaveClass(/\bloop-open\b/);
  await page.keyboard.press('Control+2');
  await page.locator('#artifacts .art-fs').click();
  await expect(page.locator('#app')).toHaveClass(/\bviewer-fullscreen\b/);
  await expect(page.locator('#app .rail')).toBeHidden(); // the strip lives in the hidden rail…
  await expect(statusAlert()).toBeVisible(); // …yet the alert is still perceivable in the main region

  await fireRevealLoop();
  await expect(page.locator('#app')).not.toHaveClass(/\bviewer-fullscreen\b/);
  await expect(page.locator('[data-viewpane="1"]')).toBeVisible();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('changing directories swaps flow state; each repo is independent and visiting writes nothing (§24.2.2 / §19.1)', { tag: '@ownapp' }, async () => {
  // The reported bug: after cd-ing away, the flow must reflect the NEW repo, not the old one.
  const repoA = seedFlowRepo('agent-term-e2e-flow-A-', 'alpha');
  const repoB = seedFlowRepo('agent-term-e2e-flow-B-', 'beta');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-sw-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('cd into a directory with no flow.yaml shows an error and creates no .agent-terminal dir (§18.1)', { tag: '@ownapp' }, async () => {
  // No local flow.yaml and an empty $HOME (no global): the strip errors with no control, the rest
  // of the app still runs, and just cd-ing there must NOT litter the dir with an empty .agent-terminal.
  const plain = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-none-'));
  mkdirSync(join(plain, '.git'), { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-none-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('the definition falls back to the global flow.yaml, but state is still written local (§18.1/§19.1)', { tag: '@ownapp' }, async () => {
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
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('flow progression persists across a relaunch, per repo (§24.2.2 S3 / §19.1)', { tag: '@ownapp' }, async () => {
  const repo = seedFlowRepo('agent-term-e2e-flow-persist-', 'groom-ticket');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-persist-home-'));
  const launch = async (): Promise<void> => {
    app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
    page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
    await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
    await typeCommand(`cd "${repo}"`);
    await expect(flowStepName()).toHaveText('groom-ticket', { timeout: 10_000 });
  };

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

test("the flow strip's derived n/m done moves as todos are checked, pushed live (§24.2.2 S5)", { tag: '@ownapp' }, async () => {
  // The strip's "n / m done" count moves on its own as todos change — no manual refresh — proving
  // the live push path (§24.2.2 S5).
  const repo = seedFlowRepo('agent-term-e2e-flow-s5-', 'groom-ticket');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-s5-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('advancing with todos outstanding warns but still completes, and is undoable (§19.2 / §24.2.2 S5)', { tag: '@ownapp' }, async () => {
  // Advancing with todos outstanding warns (no spec-section jargon in the UI) yet still reaches done
  // — the §19.2 human override — and the advance is undoable.
  const repo = seedFlowRepo('agent-term-e2e-flow-s5warn-', 'groom-ticket');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-s5warn-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('Start injects the skill on entry; todos come from the template ON DEMAND in the todo overlay (§4.1/§6/§9.1)', { tag: '@ownapp' }, async () => {
  // Start injects the skill into the real PTY; the template picker is NOT in the flow strip (it
  // relocated to the todo overlay, §9.1); template todos appear only after the on-demand control.
  const repo = seedFlowRepoWithEntry('agent-term-e2e-flow-s4-', 'groom-ticket', {
    skill: 'groomctl',
    templateItems: ['Groom the ticket scope', 'Confirm acceptance criteria'],
  });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-s4-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('the todo overlay offers a picker of named templates; choosing one instantiates its todos (§4.1/§6)', { tag: '@ownapp' }, async () => {
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
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('Start refuses to inject the skill over a busy shell, showing the refusal (§19.3)', { tag: '@ownapp' }, async () => {
  // Start over a busy shell shows the §19.3 refusal notice and injects nothing.
  const repo = seedFlowRepoWithEntry('agent-term-e2e-flow-s4busy-', 'groom-ticket', { skill: 'groomctl' });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-flow-s4busy-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('Terminate abandons the flow: resets to Not started, clears todos + capture + audit (#26 tracer)', { tag: '@ownapp' }, async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-', 'groom');
  // An external agent-loop engine file to prove Terminate never touches it (AC10).
  mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  const engineFile = join(repo, '.agent-loop', 'state.yaml');
  writeFileSync(engineFile, 'phase: impl\niteration: 3\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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
  await expect(page.locator('#todo-list .todo')).toHaveCount(0); // scope to the drawer's real todo list
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

test('Terminate with no todos: the confirmation states zero and still resets to Not started (#26 AC3)', { tag: '@ownapp' }, async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-zero-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-zero-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click();
  await expect(flowControl()).toHaveText('Advance');

  await openQuickSend('todo'); // the drawer starts closed after a relaunch (§22.2)
  await expect(page.locator('#todo-list .todo')).toHaveCount(0); // scope to the drawer's real todo list

  await flowTerminate().click();
  await expect(confirmModal()).toBeVisible();
  await expect(confirmModal()).toContainText('0 todos');
  await confirmModal().locator('.confirm').click();

  await expect(flowControl()).toHaveText('Start');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('Terminate is keyboard-operable; focus moves into the dialog and Escape restores it (#26 AC13)', { tag: '@ownapp' }, async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-kbd-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-kbd-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('after Terminate and relaunch the flow stays Not started and the next start opens a new audit run (#26 AC12/AC8)', { tag: '@ownapp' }, async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-persist-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-persist-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('flow:terminate is inert from Not started: resolves to the benign view and clears nothing (#26 AC2 handler guard)', { tag: '@ownapp' }, async () => {
  const repo = seedFlowRepo('agent-term-e2e-term-inert-', 'groom');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-inert-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('flow:terminate is inert in the load-error state: it never wipes todos or capture (#26 AC2 handler guard)', { tag: '@ownapp' }, async () => {
  // A .git repo with NO flow.yaml + empty $HOME ⇒ the flow loads to the error state (§18.1). Unlike
  // not_started, the machine's terminate does NOT throw here — so without the pre-state guard the
  // handler would run todoStore.clear + store.clear and wipe an error-flow repo's todos and capture.
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-err-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-term-err-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('launching at a target directory roots the shell, viewer, and todo scope there — but the flow global dir stays at $HOME (§23.4/§18.1)', { tag: '@ownapp' }, async () => {
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
    page = await launched.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('launching at an unusable target falls back to $HOME across the surfaces (§23.4)', { tag: '@ownapp' }, async () => {
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
    page = await launched.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('two concurrent instances each root at their own target directory (§23.4)', { tag: '@ownapp' }, async () => {
  const dirA = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-A-')));
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-launch-B-')));
  writeFileSync(join(dirA, 'marker-A.md'), 'A\n');
  writeFileSync(join(dirB, 'marker-B.md'), 'B\n');
  const udA = mkdtempSync(join(tmpdir(), 'agent-term-e2e-ud-A-'));
  const udB = mkdtempSync(join(tmpdir(), 'agent-term-e2e-ud-B-'));
  // @ownapp: no harness instance exists. Both are locally owned and closed + cleaned in finally, so the
  // fixtures never leak on a failure — and this test hosts two Electrons, never a third it does not use.
  const appA = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${udA}`],
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_LAUNCH_DIR: dirA },
  });
  const appB = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${udB}`],
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', APP_LAUNCH_DIR: dirB },
  });
  try {
    const pageA = await appA.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
    const pageB = await appB.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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

test('the in-app install action puts an executable agent-terminal on PATH; the instance stays open (§23.4)', { tag: '@ownapp' }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-e2e-cliinstall-home-')));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
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
