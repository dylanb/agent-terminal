/// <reference lib="dom" />
// page.evaluate callbacks run in the renderer; DOM lib gives them window.monitor's type.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, statSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseColor, contrastRatio, ringOver } from '../helpers/wcag';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { load } from 'js-yaml';
import { CH, SESSION_ID } from '../../src/shared/ipc';
import { CLI_COMMAND_NAME } from '../../src/main/cliShim';
import { parseAuditStream, type AuditEvent } from '../../src/shared/audit';
import { TURN_DONE_FILENAME } from '../../src/shared/loopTurn';
import { completionMarker } from '../../src/main/appWorkTurn';
import { exampleRoundReport, REPORT_GRAMMAR } from '../../src/shared/roundReport';
import { examplePhaseResult } from '../../src/shared/phaseResult';
import type { PhaseOutcome } from '../../src/shared/phaseOutcome';
import type { BuildOutcome } from '../../src/shared/buildOutcome';
import { readBaselineCommit, recordBaselineCommit, readChangedTests } from '../../src/main/appLoopState';


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
  // removed; only views 1/2/4 remain. Todos live in the drawer Todo tab, the gate in the docked loop panel.
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
// A §27 loop step (explicit `loop_namespace: app`) with a REQUIRED github-ticket input, so entering it
// opens the typed-input modal (§18.4). Bound to `impl-loop`, which declares NO `pickup:` block, so entry
// runs only a work turn (no git/gh bootstrap ports) — the input-resolution and input-clearing behaviours
// under test are engine-neutral and unaffected by that turn.
function seedBootstrapFlowRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: dev-flow\nsteps:\n' +
      '  - id: groom\n    kind: manual\n' +
      '  - id: plan\n    kind: loop\n    loop: impl-loop\n    loop_namespace: app\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n',
  );
  return dir;
}

const inputModal = () => page.locator('#flow-modal-host .flow-modal');

// The §27 bootstrap shells real git/gh. e2e prepends a fake gh + git on PATH that record their argv
// and emit canned output (no network/auth/remote), so the run is deterministic on a real PTY: the PTY
// + shell are real, only the bootstrap helpers are stubbed.
// Returns the bin dir to prepend to PATH and the log file the fakes append every invocation to.
function seedFakeGhGit(prefix: string, opts: { realCommitOps?: boolean } = {}): { binDir: string; logFile: string } {
  const binDir = mkdtempSync(join(tmpdir(), prefix));
  const logFile = join(binDir, 'calls.log');
  // Resolve REAL git once from the test process (whose PATH lacks binDir, so this is never the shim) rather
  // than hard-coding a path — keeps the shim-escape without coupling to the container base image's git location.
  const realGit = opts.realCommitOps
    ? execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    : '';
  const fakeGit =
    '#!/usr/bin/env bash\n' +
    // Skip ALL leading git GLOBAL options so `$1` is the subcommand real git would dispatch: the bootstrap
    // port's throwaway `--git-dir <tmp>`, the neutralizing `-c <k=v>` pairs, and `--no-replace-objects` (the §28
    // reads' tamper-evidence flag — workingTreeTestPaths/changedTestPaths/baselineCapabilities send it ahead of
    // the -c pairs). A case-loop handles them in any order, so a new global flag on a delegated read is skipped.
    'while :; do case "$1" in --git-dir) shift 2;; -c) shift 2;; --no-replace-objects) shift;; *) break;; esac; done\n' +
    // §28.3 — the `commit` side-effect's porcelain ops delegate to REAL git so HEAD genuinely advances in the
    // repo, while every bootstrap/remote op below stays canned. These subcommands are never used by the drive.
    // §28.5.1/§28.5.3 delegates the commit side-effect's real ops to real git: add/reset/commit, rev-list (the
    // baseline sha+parent capture), ls-files (the working-tree RED test detection + the GREEN frozen check's
    // untracked arm, filter-free), diff (workingTreeTestPaths' --numstat arm AND the GREEN frozen check's
    // baseline↔working-tree name-only arm), and ls-tree/cat-file (the GREEN frozen check's baselineCapabilities
    // reads the committed loop-capabilities.yaml as a blob). rev-parse is delegated ONLY for the object-resolve
    // form `--verify --end-of-options <rev>` (4 args): the pre-commit HEAD the parent-linkage guard compares
    // against AND the baseline `<sha>^{commit}` resolve baselineCapabilities does — the canned bootstrap/flow
    // rev-parse arms below (and the plain `rev-parse HEAD` the drive uses) never take that form, so they keep
    // their scripted answer; a blanket rev-parse delegation breaks the drive (the loop never starts).
    (opts.realCommitOps ? `case "$1" in add|reset|commit|diff|rev-list|ls-files|ls-tree|cat-file) exec ${realGit} "$@";; esac\n` : '') +
    (opts.realCommitOps ? `if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "--end-of-options" ] && [ "$#" -eq 4 ]; then exec ${realGit} "$@"; fi\n` : '') +
    // §28.5.1 — the frozen baseline's branch key: `rev-parse --abbrev-ref HEAD` (commit adapter's capture +
    // the engine's currentGitBranch) delegates to real git so both read the REAL branch; delegated by its EXACT
    // form only, so every canned bootstrap/flow-detection rev-parse arm below keeps its scripted answer.
    (opts.realCommitOps ? `if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ] && [ "$3" = "HEAD" ] && [ "$#" -eq 3 ]; then exec ${realGit} "$@"; fi\n` : '') +
    'echo "git $*" >> "$FAKE_GHGIT_LOG"\n' +
    // status --porcelain emits nothing → a clean tree; when FAKE_GIT_DIRTY is set it emits a non-.agent-loop
    // porcelain line → a dirty tree, so the bootstrap's clean-tree gate aborts. Every other op is a recorded no-op success.
    'if [ "$1" = "status" ] && [ -n "$FAKE_GIT_DIRTY" ]; then echo " M src/app.ts"; exit 0; fi\n' +
    'if [ "$1" = "status" ] && [ "$2" = "--porcelain" ] && [ "$#" -eq 2 ] && [ -n "$FAKE_GIT_DIRTY_ONCE" ] && [ ! -e "$FAKE_GHGIT_LOG.dirty-seen" ]; then touch "$FAKE_GHGIT_LOG.dirty-seen"; echo " M src/app.ts"; exit 0; fi\n' +
    // branch --list prints the queried branch when FAKE_GIT_BRANCH_EXISTS is set → a bootstrap branch conflict.
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
    // The wipe deletes the local branch with the PORCELAIN `git branch -D` (only it knows git's full
    // "branch is in use" rule), and reads back the object it removed to re-establish the lease.
    // Upstream is configured as the pair `git push -u` writes, not via --set-upstream-to, which resolves
    // through the remote's fetch refspec and refuses on a single-branch clone.
    'if [ "$1" = "config" ]; then case "$2" in branch.*.remote|branch.*.merge) echo "$2=$3" >> "$FAKE_GHGIT_LOG.upstream"; exit 0;; esac; fi\n' +
    'if [ "$1" = "branch" ] && [ "$2" = "-D" ]; then name=${!#}; rm -f "$FAKE_GHGIT_LOG.local-branch" "$FAKE_GHGIT_LOG.local-oid"; echo "Deleted branch $name (was 1111111111111111111111111111111111111111)."; exit 0; fi\n' +
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
    // epic-promote — each `gh issue create` returns a fresh issue URL (a per-binDir counter file
    // seeded at 500) so the sub-issues carry distinct numbers the executor appends to linked_issues.
    'if [ "$1" = "issue" ] && [ "$2" = "create" ]; then seq="$FAKE_GHGIT_LOG.issue-seq"; n=$(cat "$seq" 2>/dev/null || echo 500); n=$((n+1)); echo "$n" > "$seq"; echo "https://github.com/fake/repo/issues/$n"; exit 0; fi\n' +
    'if [ "$1" = "issue" ] && [ "$2" = "edit" ] && [ "$4" = "--add-assignee" ]; then echo "$3:$5" > "$FAKE_GHGIT_LOG.issue-assignee"; exit 0; fi\n' +
    'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then value=$5; case "$value" in \\"*\\") value=${value#\\"}; value=${value%\\"};; esac; echo "$3:$4:$value" > "$FAKE_GHGIT_LOG.issue-label"; exit 0; fi\n' +
    // The `pr create` call is logged BEFORE an optional FAKE_PICKUP_DELAY sleep, so a test can hold the
    // bootstrap mid-flight (the branch is created, app state not yet written) long enough to terminate the
    // flow and prove the async completion drops as stale.
    'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then [ -n "$FAKE_PICKUP_DELAY" ] && sleep "$FAKE_PICKUP_DELAY"; [ -n "$FAKE_PR_CREATE_FAIL" ] && exit 1; echo 4242 > "$FAKE_GHGIT_LOG.pr-created"; echo "https://github.com/fake/repo/pull/4242"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then value=$5; case "$value" in \\"*\\") value=${value#\\"}; value=${value%\\"};; esac; echo "$3:$4:$value" > "$FAKE_GHGIT_LOG.pr-label"; exit 0; fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then echo "$3" > "$FAKE_GHGIT_LOG.pr-ready"; exit 0; fi\n' +
    // CI run-don't-block — `gh pr checks` returns the current bucket state (one pending, one pass)
    // and exits non-zero (8) as real gh does when checks are pending; the app parses stdout regardless and
    // never waits. The invocation is logged (above) BEFORE the optional FAKE_GH_CHECKS_DELAY sleep, so a
    // test can hold the snapshot's RESULT back to prove the loop reaches its gate before the snapshot lands.
    'if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then [ -n "$FAKE_GH_CHECKS_DELAY" ] && sleep "$FAKE_GH_CHECKS_DELAY"; echo \'[{"bucket":"pass"},{"bucket":"pending"}]\'; exit 8; fi\n' +
    'exit 0\n';
  writeFileSync(join(binDir, 'git'), fakeGit, { mode: 0o755 });
  writeFileSync(join(binDir, 'gh'), fakeGh, { mode: 0o755 });
  return { binDir, logFile };
}

// LoopDef resolution for e2e: $CLAUDE_CONFIG_DIR/loops/<name>/<name>.yaml, so the committed example
// defs (example/loops, real plan-loop/impl-loop) resolve when CLAUDE_CONFIG_DIR points at example/.
const exampleConfigDir = join(process.cwd(), 'example');

// §24.2.3 T7 — refs come from the flow's TYPED INPUTS now (§18.4); the retired engine's state-mirror
// source (linked_issues/pr) went with the bridge (§F item 12). A pre-loop MANUAL `groom` step then a
// `work` step declaring the ticket/PR typed inputs, whose values are pre-resolved in flow-state.yaml, so
// the refs are progress-gated on entering `work` (they render as the §24.2.3 T7 "Flow" refs read-out). A
// residual `.agent-terminal/loop/run-state.yaml` sits on disk that the app never writes — a test proves the
// display clears without that run-state being touched. Returns its path for that assertion.
function seedRefsFlowRepo(prefix: string, ticket = '25', pr = '179'): { dir: string; runStateFile: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: refs-flow\nsteps:\n  - id: groom\n    kind: manual\n' +
      '  - id: work\n    kind: manual\n    inputs:\n' +
      '      - name: ticket\n        type: github-ticket\n      - name: pr\n        type: pr\n',
  );
  writeFileSync(
    join(dir, '.agent-terminal', 'flow-state.yaml'),
    `step: groom\nstatus: not_started\ninputs:\n  ticket: "${ticket}"\n  pr: "${pr}"\n`,
  );
  const loopDir = join(dir, '.agent-terminal', 'loop');
  mkdirSync(loopDir, { recursive: true });
  const runStateFile = join(loopDir, 'run-state.yaml');
  writeFileSync(runStateFile, 'schema_version: 1\nloop: work-loop\nstep: work\nturn_key: t1\nstatus: complete\nround: 9\n');
  return { dir, runStateFile };
}

const loopReadout = () => page.locator('#flow-strip .loopstat'); // compact rail read-out; click opens the panel
const loopPanel = () => page.locator('#loop-panel');
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

// APP_HOME_DIR (§23.4) relocates the app-state home — the global flow.yaml (§18.1) AND the audit tree
// (§25) — independently of $HOME and the launch cwd. A repo with no local flow reads the GLOBAL flow from
// the overridden home, and its run's audit lands there, never under the real $HOME (which has no flow at all).
test('APP_HOME_DIR relocates the global flow.yaml and the audit tree off the real home (§23.4)', { tag: '@ownapp' }, async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'agent-term-e2e-apphome-'));
  mkdirSync(join(appHome, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(appHome, '.agent-terminal', 'flow.yaml'),
    'name: relocated-flow\nsteps:\n  - id: relocated-step\n    kind: manual\n',
  );
  const realHome = mkdtempSync(join(tmpdir(), 'agent-term-e2e-realhome-')); // no flow.yaml lives here
  const workdir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-apphome-work-'));
  mkdirSync(join(workdir, '.git'), { recursive: true }); // its own repo key, with NO local flow → the global wins
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: realHome, APP_HOME_DIR: appHome, APP_SUBMIT_DELAY_MS: '100' },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${workdir}"`);
  // The global flow resolved from APP_HOME_DIR, not $HOME (which has none) — the step id proves the source.
  await expect(flowStepName()).toHaveText('relocated-step', { timeout: 10_000 });

  await expect(flowControl()).toHaveText('Start');
  await flowControl().click();
  await expect(flowControl()).toHaveText('Advance');

  // The run's audit file lands under APP_HOME_DIR, and NOT under the real $HOME.
  await expect.poll(() => auditRunFiles(appHome, workdir).length).toBe(1);
  expect(readAuditRun(appHome, workdir, auditRunFiles(appHome, workdir)[0]).header).toMatchObject({ flow: 'relocated-flow' });
  expect(auditRunFiles(realHome, workdir)).toHaveLength(0);

  await app.close();
  rmSync(appHome, { recursive: true, force: true });
  rmSync(realHome, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
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

// Phase 2 (§25.5): the §27 engine's run-state feeds the audit. Entering a loop step records the run
// state; its status changes append live.
test('a §27 loop step records its run-state and its status changes append loop.status + an empty outputs.snapshot (§25.5)', { tag: '@ownapp' }, async () => {
  // The §27 engine's OWN run-state changes (through `working` to the `complete` gate) are what the §25
  // recorder observes now — the retired external state-mirror source is gone (§F). Driven by a real turn.
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-audit-loop-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-audit-loop-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-audit-loop-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent'); // a hosted agent is at the prompt for the work turn
  await flowControl().click(); // Start → enter the app plan-loop step → run opens, the §27 work turn starts
  await expect.poll(() => auditRunFiles(home, repo).length).toBe(1);
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');

  const file = (): string => auditRunFiles(home, repo)[0];
  // loop.status appends on each run-state status change; the round the consolidator judged appends
  // loop.iteration. pr.assoc CANNOT fire — the §27 run-state carries no PR number (§F).
  await expect
    .poll(() => readAuditRun(home, repo, file()).events.map((e) => e.type))
    .toEqual(expect.arrayContaining(['loop.status', 'loop.iteration']));
  expect(readAuditRun(home, repo, file()).events.some((e) => e.type === 'pr.assoc')).toBe(false);
  // The turn passes through `working` then `complete`, so at least two distinct loop.status events append.
  await expect
    .poll(() => readAuditRun(home, repo, file()).events.filter((e) => e.type === 'loop.status').length)
    .toBeGreaterThanOrEqual(2);
  // Each status change still snapshots the retired .agent-loop/ area read-only (§25.5); a §27 repo has no
  // such directory, so the snapshot is empty — a documented residue of the retired engine (§F).
  const snap = readAuditRun(home, repo, file()).events.find(
    (e): e is Extract<AuditEvent, { type: 'outputs.snapshot' }> => e.type === 'outputs.snapshot',
  );
  expect(snap?.files).toEqual([]);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
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

test('installing the bundled examples seeds the flow, app and commands (§18.1/§23.4 #41/#78)', { tag: '@ownapp' }, async () => {
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
  for (const dest of ['flow', 'appLoops', 'commands']) {
    await expect(installReportGroup(dest)).toBeVisible();
  }
  await expect(installReportGroup('appLoops')).toContainText('plan-loop.yaml');
  await expect(installReportGroup('commands')).toContainText('groom-ticket.md');

  // The bundled flow definition + its todo templates now exist in the global flow home.
  expect(existsSync(join(home, '.agent-terminal', 'flow.yaml'))).toBe(true);
  expect(existsSync(join(home, '.agent-terminal', 'todo-templates', 'ticket-grooming.md'))).toBe(true);
  expect(existsSync(join(configDir, 'loops-v2', 'groom-loop', 'groom-loop.yaml'))).toBe(true);
  expect(existsSync(join(configDir, 'loops-v2', 'plan-loop', 'plan-loop.yaml'))).toBe(true);
  expect(existsSync(join(configDir, 'loops-v2', 'impl-loop', 'impl-loop.yaml'))).toBe(true);
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
  // 9 flow steps (preparation, groom, plan-bundle, infra, red, green, refactor, integration-slice,
  // finalize) render as 11 stations — the Not-started and Completed caps bracket the steps.
  await expect(page.locator('#flow-strip .flow.vert .stn')).toHaveCount(11, {
    timeout: 10_000,
  });
  await expect(flowStepName()).toHaveText('preparation');

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
  expect(installedFlow).toContain('loop: plan-bundle-loop');
  expect(installedFlow).toContain('loop: infra-loop');
  expect(installedFlow).toContain('loop: red-loop');
  expect(installedFlow).toContain('loop: green-loop');
  expect(installedFlow).toContain('loop: refactor-loop');
  expect(installedFlow).toContain('loop: integration-slice-loop');
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
  // The manifest lists only files that are present AND differ, so a one-file conflict would render a
  // one-path manifest — and the footer assertion below would pass against content that never overflowed
  // anything. Conflict the WHOLE example bundle across all three install destinations (flow, appLoops,
  // commands), which is the content that clipped the footer (§27.15: the loops tier is loops-v2 now).
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
  const ex = join(process.cwd(), 'example');
  const conflicting =
    seedConflicts(join(ex, 'flow'), join(home, '.agent-terminal')) +
    seedConflicts(join(ex, 'loops-v2'), join(configDir, 'loops-v2')) +
    seedConflicts(join(ex, 'commands'), join(configDir, 'commands'));
  expect(conflicting).toBeGreaterThan(20); // the fixture must actually be the overflowing case
  app = await electron.launch({ args: ['out/main/index.js'], env: installEnv(home, configDir) });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await page.locator('[data-viewbtn="4"]').click();
  await installExamplesBtn().click();
  await expect(installExamplesPrompt()).toBeVisible({ timeout: 10_000 });

  // Grade the FIRST consent checkbox — the one the dialog gives initial focus. Destinations render in the
  // contract's order (flow, appLoops, commands), so with all three conflicting the first box is `flow`.
  const box = consentBox('flow');
  await expect(box).toBeVisible();
  // The dialog is genuinely rendering the long manifest — otherwise the footer check below grades a
  // dialog that never overflowed and cannot fail. Sum every destination's file list (the first section is
  // `flow`'s short one), so the length reflects the whole manifest that pushed the footer off-screen.
  const manifestText = (await page.locator('#install-examples-view .flow-modal .ic-files').allInnerTexts()).join('');
  expect(manifestText.length).toBeGreaterThan(500);

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
  await expect(page.locator('.todo').filter({ hasText: 'run grooming skill' })).not.toHaveCount(0, { timeout: 10_000 });

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

// A pre-loop MANUAL `groom` step then a pre-bootstrapped §27 `build` loop step — so a test can watch the
// loop read-out appear only once the flow ENTERS the loop step (progress-gating, §24.2.3 T2), driven by a
// real §27 turn. The bound loop's ticket input is pre-resolved so entry drives the turn without a modal.
function seedManualThenAppLoopFlowRepo(prefix: string, loopName = 'plan-loop'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    `name: dev-flow\nsteps:\n  - id: groom\n    kind: manual\n  - id: build\n    kind: loop\n    loop: ${loopName}\n    loop_namespace: app\n    inputs:\n      - name: ticket\n        type: github-ticket\n`,
  );
  writeFileSync(
    join(dir, '.agent-terminal', 'flow-state.yaml'),
    'step: groom\nstatus: not_started\ninputs:\n  ticket: "176"\n',
  );
  seedCompletedAppBootstrap(dir);
  return dir;
}

// The plan-loop (§27) reviewer catalog + report structure the committed example def declares — the roster
// the round report must account for and the sections it must carry (example/loops-v2/plan-loop/plan-loop.yaml).
const PLAN_V2_ROSTER = [
  'review-plan-principal',
  'review-plan-security',
  'review-plan-architecture',
  'review-plan-intent',
  'review-plan-maintainability',
  'review-plan-contracts',
];
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
  const parts = ['## summary', '', '## findings', '', '## disposition', ''];
  // The first persona is recorded as FAILED TO RUN; every other roster persona ran and found nothing, so the
  // report stays well-formed (full-roster accounting) while carrying the failed-lens signal the clean-guard keys on.
  PLAN_V2_ROSTER.forEach((persona, idx) => {
    parts.push(`### ${persona}`, '', idx === 0 ? g.failedMarker : g.emptyMarker, '');
  });
  return parts.join('\n') + '\n';
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
    work: 'complete' | 'no-marker' | 'file-only' | 'noop' | 'red' | 'green' | 'refactor';
    // §28.5.5 — the classified outcome the fake writes into the phase-result file, read back by every
    // result-producing work mode's completion gate (red/green/refactor). `writeTest` is RED-only: whether the
    // turn authors a test-glob file this turn (the "a test was added" async clause).
    resultOutcome?: PhaseOutcome;
    writeTest?: boolean;
    // §28.5.3 GREEN work mode (work: 'green'): the build classification written alongside `resultOutcome`
    // (default 'built'), and whether the turn MODIFIES a committed test-glob file (`touchTest`, the frozen-check
    // detection) vs a non-test file. Ignored unless work === 'green'. `resultOutcome` defaults to 'passed'.
    buildOutcome?: BuildOutcome;
    touchTest?: boolean;
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
  // §28.5.5 — the RED work turn: (optionally) author a test-glob file this turn, then write the phase-result
  // file the completion:red gate classifies. The result content is the ONE canonical examplePhaseResult (the
  // same generator the prompt few-shot and the predicate happy-path use), base64'd so its newlines/`#` survive
  // the single-line injected shell. The test file sits OUTSIDE .agent-terminal (so it is a real test path and
  // rides into the approve commit); the result file sits UNDER it (gitignored + isUnderAppStateDir-excluded).
  // Its BODY is never executed — the engine only asks git which test-glob paths changed (§28.5.4), so the
  // `add`-referencing assertion is inert on-disk text, present only so the path matches the test glob.
  // Fragments are terminator-free like their `bump`/`done`/`writeArtifact` siblings; redAct joins with `; `.
  const redResultB64 = b64(examplePhaseResult(opts.resultOutcome ?? 'failed-assertion'));
  const writeRedTest =
    opts.writeTest === false
      ? ''
      : `mkdir -p tests; printf '%s\\n' 'test("adds", () => { expect(add(1, 1)).toBe(3); });' > tests/red_added.test.ts`;
  const writeRedResult =
    `mkdir -p "$(dirname ${opts.artifactRel})"; printf %s '${redResultB64}' | base64 -d > ${opts.artifactRel}`;
  const redAct = [bump, writeRedTest, writeRedResult, done(turnKey)].filter((s) => s.length > 0).join('; ');
  // §28.5.3 — the GREEN work turn: implement (touch a committed test-glob file when `touchTest`, else a non-test
  // file), then write the phase-result classifying `passed` + `built`. The frozen check diffs the committed
  // baseline against the working tree, so editing the committed tests/frozen.test.ts is what raises the flag.
  const greenResultB64 = b64(examplePhaseResult(opts.resultOutcome ?? 'passed', { build: opts.buildOutcome ?? 'built' }));
  const writeGreenChange =
    opts.touchTest === true
      ? `mkdir -p tests; printf '%s\\n' 'test("adds", () => { expect(add(1, 1)).toBe(2); });' 'extra' >> tests/frozen.test.ts`
      : `printf '%s\\n' 'export const y = 2;' > feature.ts`;
  const writeGreenResult =
    `mkdir -p "$(dirname ${opts.artifactRel})"; printf %s '${greenResultB64}' | base64 -d > ${opts.artifactRel}`;
  const greenAct = [bump, writeGreenChange, writeGreenResult, done(turnKey)].filter((s) => s.length > 0).join('; ');
  const workAct =
    opts.work === 'noop'
      ? ':'
      : opts.work === 'green'
        ? greenAct
        : opts.work === 'red'
          ? redAct
          : opts.work === 'refactor'
            ? // §28.5.3/§28.6 — a refactor loop's work turn is a `commits` turn: it just signals done and the
              // engine chains the review round (where the refactor result gate lives). No artifact.
              `${bump}; ${done(turnKey)}`
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
  // §28.5.3 — a REFACTOR loop's review ROUND additionally writes the round-keyed phase-result the gate reads
  // ({report ∧ passed}, softer than GREEN — no build line) and makes a behavior-preserving change so the approve
  // commit has content: a non-test file (clean) or the committed test (touchTest → the frozen-check flag).
  const refactorResultB64 = b64(examplePhaseResult(opts.resultOutcome ?? 'passed'));
  const writeRefactorResult =
    'r=$(rnd); mkdir -p .agent-terminal/loop/refactor-results; ' +
    `printf %s '${refactorResultB64}' | base64 -d > .agent-terminal/loop/refactor-results/$r.md`;
  const writeRefactorChange =
    opts.touchTest === true
      ? `mkdir -p tests; printf '%s\\n' 'test("adds", () => { expect(add(1, 1)).toBe(2); });' 'extra' >> tests/frozen.test.ts`
      : `printf '%s\\n' 'export const y = 2;' > feature.ts`;
  const reviewAct =
    reviewKind === 'none'
      ? `${reviewBump}`
      : opts.work === 'refactor'
        ? `${reviewBump}; ${writeReportRoundAware}; ${writeRefactorChange}; ${writeRefactorResult}; ${done(reviewKey)}`
        : `${reviewBump}; ${writeReportRoundAware}; ${done(reviewKey)}`;
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

test('a §27 app step runs work → review-and-fix → CONSOLIDATE → the clean gate, leaving a pre-existing .agent-loop/state.yaml untouched (§27.3/§27.6 / AC1,2,3,5,6,10)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-v2-work-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-v2-work-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-v2-work-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  // A pre-existing legacy .agent-loop/state.yaml sits on disk: the §27 engine must never touch it (AC10 — the app never writes that file).
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

  // AC10 — the legacy .agent-loop/state.yaml is byte-for-byte unchanged, and no legacy artifact was written.
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
  // A pre-existing legacy .agent-loop/state.yaml sits on disk: the §27 approve must never touch it (AC8 — the app never writes that file).
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

  // AC8 — the legacy .agent-loop/state.yaml is byte-for-byte unchanged: the §27 approve wrote nothing to it.
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

test('entering a pickup-bearing §27 def bootstraps out-of-band into app-owned state, never writing .agent-loop/state.yaml or injecting into the terminal (ST2 AC3/AC8)', { tag: '@ownapp' }, async () => {
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
  expect(readIf(`${logFile}.upstream`)).toContain(
    'branch.plan-loop/issue-176.remote=origin',
  );
  expect(readIf(`${logFile}.upstream`)).toContain(
    'branch.plan-loop/issue-176.merge=refs/heads/plan-loop/issue-176',
  );
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

test('a def resolved from the REPOSITORY tier declaring a pickup contract bootstraps — branch, draft PR and its own initial_labels reach gh (§B.13a / §F item 18)', { tag: '@ownapp' }, async () => {
  // The operator's origin decision made visible (§F item 18): the executor no longer refuses a
  // non-operator-tier def, so a repo whose .agent-loop.yaml maps the bound name to an IN-REPO v2 def with a
  // pickup: block reaches branch creation and the draft PR. The repo def's initial_labels are DISTINCT from
  // the app-bundled def's, so a passing label assertion can only have come from the repo def (§B.13a).
  const repo = seedAppBootstrapFlowRepo('agent-term-e2e-repo-pickup-');
  const repoDef = join(repo, 'loops', 'plan-loop');
  cpSync(join(exampleConfigDir, 'loops-v2', 'plan-loop'), repoDef, { recursive: true });
  const defFile = join(repoDef, 'plan-loop.yaml');
  writeFileSync(
    defFile,
    withPickup(
      readFileSync(defFile, 'utf8'),
      'pickup:\n' +
        '  initial_status: planning\n' +
        '  branch_template: plan-loop/issue-{issue}\n' +
        '  initial_labels:\n' +
        '    - target: issue\n      action: add\n      label: repo-tier/active\n' +
        '    - target: pr\n      action: remove\n      label: repo-tier/stale\n' +
        '  on_conflict: wipe-and-retry\n',
    ),
  );
  // The repo registry the resolver reads FIRST (loopDefV2 repoCandidate), pointing at the in-repo def.
  writeFileSync(join(repo, '.agent-loop.yaml'), 'loops:\n  plan-loop: ./loops/plan-loop/plan-loop.yaml\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-repo-pickup-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-repo-pickup-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  // No CLAUDE_CONFIG_DIR: the operator tier is empty and the repo tier resolves the def (proving the repo
  // route). The def carries its own prompts (copied), so the work turn resolves without an operator config.
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', APP_TURN_TIMEOUT_MS: '60000', PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await typeCommand('fake-agent');
  await flowControl().click(); // Start → groom
  await flowControl().click(); // Advance → plan (loop): the required-input modal opens
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  // The repo-tier def's pickup reaches branch creation and the draft PR — the origin gate no longer refuses it.
  const bootstrapState = join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml');
  await expect.poll(() => readIf(bootstrapState), { timeout: 15_000 }).toContain('pr: 4242');
  expect(readIf(bootstrapState)).toContain('branch: plan-loop/issue-176');
  expect(readIf(`${logFile}.local-branch`).trim()).toBe('plan-loop/issue-176');
  expect(readIf(`${logFile}.remote-branch`).trim()).toBe('plan-loop/issue-176');
  expect(readIf(`${logFile}.pr-created`).trim()).toBe('4242');
  // The REPO def's DISTINCT initial_labels reach gh under the operator's own credentials — proving the repo
  // def (not the app bundle) resolved, and grading the widened blast radius the origin-gate deletion opens.
  await expect.poll(() => readIf(`${logFile}.issue-label`).trim(), { timeout: 15_000 }).toBe('176:--add-label:repo-tier/active');
  await expect.poll(() => readIf(`${logFile}.pr-label`).trim(), { timeout: 15_000 }).toBe('4242:--remove-label:repo-tier/stale');
  expect(existsSync(join(repo, '.agent-loop', 'state.yaml'))).toBe(false); // §27 writes no legacy mirror

  await app.close();
  for (const dir of [repo, home, binDir]) rmSync(dir, { recursive: true, force: true });
});

// AC 6 tracer, assertion (a) + the bootstrap half of (f) — the sweep's grep-invisible AC 10 change made
// visible end-to-end. A pre-N1 flow file that names NO loop_namespace now binds the SURVIVING §27 engine
// (absence → app, §B.4) and runs to its gate; before the sweep the same file bound the retired in-terminal
// engine. Its `bootstrap: pickup` entry action still sets up the branch + draft PR (AC 10). Full-stack
// acceptance pin; its RED sibling is the committed namespace-vocabulary unit test (a namespace-less binding
// selected the retired engine pre-sweep, §B.4) and the position-4 bootstrap-preparer test. A hosted agent
// holds the shell here (busy, §19.3), so a
// `skill` would be refused — the skill half of (f) is proven at a ready prompt in the next test.
test('a NAMESPACE-LESS loop step binds §27, sets up its bootstrap: pickup branch and runs to its clean gate — AC 6 tracer (a)/(f) (§B.4 / AC 10)', { tag: '@ownapp' }, async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tracer-a-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(repo, '.agent-terminal', 'flow.yaml'),
    'name: tracer-a\nsteps:\n' +
      '  - id: groom\n    kind: manual\n' +
      // NO loop_namespace on this loop step — absence binds the surviving engine (§B.4).
      '  - id: build\n    kind: loop\n    loop: plan-loop\n' +
      '    bootstrap: pickup\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n',
  );
  writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: groom\nstatus: not_started\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tracer-a-home-'));
  const config = seedOperatorPlanLoopConfig('agent-term-e2e-tracer-a-config-', (yaml) =>
    withPickup(yaml, 'pickup:\n  initial_status: planning\n  branch_template: plan-loop/issue-{issue}\n'),
  );
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-tracer-a-bin-');
  seedFakeAgentV2(binDir, { stepId: 'build', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', APP_TURN_TIMEOUT_MS: '60000', CLAUDE_CONFIG_DIR: config, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent'); // a hosted agent is at the prompt for the work-prompt injection

  await flowControl().click(); // Start → enter groom (manual)
  await flowControl().click(); // Advance → enter the NAMESPACE-LESS build loop step → prompts for the ticket
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  // (f) bootstrap: pickup — the namespace-less step set up its branch + draft PR through the surviving
  // engine's own bootstrap contract; the fake gh/git recorded both.
  const bootstrapState = join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml');
  await expect.poll(() => readIf(bootstrapState), { timeout: 20_000 }).toContain('pr: 4242');
  expect(readIf(bootstrapState)).toContain('branch: plan-loop/issue-176');
  expect(readIf(`${logFile}.local-branch`).trim()).toBe('plan-loop/issue-176');
  expect(readIf(`${logFile}.pr-created`).trim()).toBe('4242');

  // (a) binds §27 and reaches its gate — only the surviving engine drives work → review → consolidate to a
  // `verdict: clean` gate; the retired engine never produced that run-state. Reaching it proves the
  // namespace-less step bound §27.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  expect(existsSync(join(repo, '.agent-loop', 'state.yaml'))).toBe(false); // and wrote no legacy mirror

  await app.close();
  for (const dir of [repo, home, config, binDir]) rmSync(dir, { recursive: true, force: true });
});

// AC 6 tracer, the skill half of (f) — a namespace-less step's `skill` entry action is honoured too. At a
// READY prompt (no hosted agent holding the shell, so the §19.3 refusal does not fire) the coordinator
// injects the skill on its bootstrap-success hand-off (§B.5 item 6), so its invocation reaches the PTY while
// the SAME step's `bootstrap: pickup` sets up the branch. Before the sweep the app dispatch short-circuited
// both (§D.4 row 2844 RED). A raised submit delay keeps the injected skill line alone in the viewport: its
// own submit `\r` — and the work prompt the coordinator chains after it — land after this test observes it.
test('a NAMESPACE-LESS step injects its skill on the bootstrap hand-off while pickup sets up the branch — AC 6 tracer (f) (§B.5 item 6 / AC 10)', { tag: '@ownapp' }, async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tracer-f-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(repo, '.agent-terminal', 'flow.yaml'),
    'name: tracer-f\nsteps:\n' +
      '  - id: groom\n    kind: manual\n' +
      // NO loop_namespace → binds §27 (§B.4) — declaring BOTH per-step entry actions AC 10 preserves.
      '  - id: build\n    kind: loop\n    loop: plan-loop\n' +
      '    skill: /tracer-skill\n    bootstrap: pickup\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n',
  );
  writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: groom\nstatus: not_started\n');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tracer-f-home-'));
  const config = seedOperatorPlanLoopConfig('agent-term-e2e-tracer-f-config-', (yaml) =>
    withPickup(yaml, 'pickup:\n  initial_status: planning\n  branch_template: plan-loop/issue-{issue}\n'),
  );
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-tracer-f-bin-');
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '3000', APP_TURN_TIMEOUT_MS: '60000', CLAUDE_CONFIG_DIR: config, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  // No hosted agent is started — the shell stays at a ready prompt, so the skill is injected on the hand-off.
  await flowControl().click(); // Start → enter groom (manual)
  await flowControl().click(); // Advance → enter the NAMESPACE-LESS build loop step → prompts for the ticket
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();

  // bootstrap: pickup ran out-of-band and set up the branch + draft PR.
  const bootstrapState = join(repo, '.agent-terminal', 'loop', 'bootstrap.yaml');
  await expect.poll(() => readIf(bootstrapState), { timeout: 20_000 }).toContain('pr: 4242');
  expect(readIf(`${logFile}.local-branch`).trim()).toBe('plan-loop/issue-176');

  // The skill invocation reached the PTY on the coordinator's success hand-off (§B.5 item 6).
  await expect(termRows()).toContainText('/tracer-skill', { timeout: 15_000 });

  await app.close();
  for (const dir of [repo, home, config, binDir]) rmSync(dir, { recursive: true, force: true });
});

// AC 6 tracer, assertions (c) + (d) — the shipped app-namespace flow still drives on a machine that never
// migrated its config, and the named cost of the re-point is PAID by migrating rather than failing (AC 5).
// The config carries ONLY the retired operator tier (loops/), no loops-v2/, so the app-namespace step
// resolves plan-loop from the APP BUNDLE, writes its own copy into the surviving loops-v2 tier, tells the
// operator once, and runs to its gate — while the retired tree is left byte-for-byte untouched (§B.6).
test('a shipped app-namespace flow on a RETIRED-TIER-ONLY config migrates its def, notifies once and drives to its gate — AC 6 tracer (c)/(d) (§B.6 / AC 5)', { tag: '@ownapp' }, async () => {
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-tracer-cd-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tracer-cd-home-'));
  // A config carrying ONLY the retired operator tier (loops/), and NO surviving loops-v2/ — the un-migrated
  // machine AC 5 / AC 6 exist for.
  const config = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tracer-cd-config-'));
  const retiredDir = join(config, 'loops', 'plan-loop');
  mkdirSync(retiredDir, { recursive: true });
  const retiredDef = join(retiredDir, 'plan-loop.yaml');
  const retiredContent = 'schema_version: 4\nname: plan-loop\n# retired-schema customization the app must NOT read or carry across\n';
  writeFileSync(retiredDef, retiredContent);
  const migratedDef = join(config, 'loops-v2', 'plan-loop', 'plan-loop.yaml');
  expect(existsSync(migratedDef)).toBe(false); // the surviving tier is absent on this first-run machine
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-tracer-cd-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', APP_TURN_TIMEOUT_MS: '60000', CLAUDE_CONFIG_DIR: config, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // Start → enter the app plan-loop step: resolves from the app bundle → migrates

  // (d) the app wrote its OWN copy of the def into the SURVIVING tier (loops-v2), and told the operator once.
  await expect.poll(() => existsSync(migratedDef), { timeout: 15_000 }).toBe(true);
  await expect(page.locator('#flow-strip .flow-notice')).toContainText('Copied the built-in', { timeout: 10_000 });
  await expect(page.locator('#flow-strip .flow-notice')).toContainText('plan-loop');
  // The retired tier is left byte-for-byte untouched — the app does not read, move or rewrite files it retired.
  expect(readFileSync(retiredDef, 'utf8')).toBe(retiredContent);

  // (c) the shipped flow still drives — the migrated def runs work → review → consolidate to its clean gate.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');

  await app.close();
  for (const dir of [repo, home, config, binDir]) rmSync(dir, { recursive: true, force: true });
});

// AC 6 tracer, assertion (b) — a step that names the RETIRED namespace fails per-step with a route out and
// strands nothing, while a MISSPELLED namespace fails the whole load with a reason naming the real cause
// (§B.3/§B.4 / AC 4). RED siblings: the committed namespace-vocabulary + flowDefinition load-reason units.
test('a legacy-bound step surfaces a per-step reason with a route out; a misspelled namespace fails the whole load — AC 6 tracer (b) (§B.4 / AC 4)', { tag: '@ownapp' }, async () => {
  const legacyRepo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tracer-b-legacy-'));
  mkdirSync(join(legacyRepo, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(legacyRepo, '.agent-terminal', 'flow.yaml'),
    'name: legacy-flow\nsteps:\n  - id: build\n    kind: loop\n    loop: plan-loop\n    loop_namespace: legacy\n',
  );
  writeFileSync(join(legacyRepo, '.agent-terminal', 'flow-state.yaml'), 'step: build\nstatus: not_started\n');
  const badRepo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tracer-b-bad-'));
  mkdirSync(join(badRepo, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(badRepo, '.agent-terminal', 'flow.yaml'),
    'name: bad-ns-flow\nsteps:\n  - id: build\n    kind: loop\n    loop: plan-loop\n    loop_namespace: aap\n',
  );
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-tracer-b-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  // The legacy-bound step LOADS (the retired namespace is still recognized, §B.4) and enters, but its loop
  // view is an error naming the retired engine — with the rest of the flow still operable (Advance routes out).
  await typeCommand(`cd "${legacyRepo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → enter the legacy-bound step → error loop view, no turn
  await loopReadout().click();
  await expect(loopPanel()).toContainText('retired "legacy" engine', { timeout: 10_000 });
  await expect(flowControl()).toHaveText('Advance'); // a route off the step, no file hand-editing
  await flowControl().click();
  await expect(flowControl()).toHaveText('Restart', { timeout: 10_000 }); // the flow still advanced to done

  // A MISSPELLED namespace is unrecognized → the WHOLE file is rejected at load, with a reason naming the
  // real cause (the unrecognized value), not a bare parse error.
  await typeCommand(`cd "${badRepo}"`);
  await expect(page.locator('#flow-strip .flow-error')).toContainText('unrecognized def namespace "aap"', { timeout: 10_000 });

  await app.close();
  for (const dir of [legacyRepo, badRepo, home]) rmSync(dir, { recursive: true, force: true });
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
  await inputModal().locator('.confirm').click();

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 15_000 }).toContain('turn_key: work-plan');
  // AC3 constrains the bootstrap's outward-facing MUTATIONS (§27.10), not the read-only git/gh the viewer (§20)
  // and ticket popout (§24.2.3 T7) run on step entry — so a `git status` command-sniff false-matches the viewer's
  // working-tree read. Assert the mutation sidecars stay absent; the with-`pickup` sibling proves each is written
  // when bootstrap runs.
  for (const mutation of ['local-branch', 'remote-branch', 'pr-created', 'issue-assignee', 'issue-label', 'pr-label']) {
    expect(existsSync(`${logFile}.${mutation}`), `bootstrap mutation .${mutation} fired for a no-pickup def`).toBe(false);
  }
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
  // A pre-existing legacy .agent-loop/state.yaml sits on disk: the §27 request-changes must never touch it (AC8 — the app never writes that file).
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

  // AC8 — the legacy .agent-loop/state.yaml is byte-for-byte unchanged: the §27 request-changes wrote nothing to it.
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
  // A pre-existing legacy .agent-loop/state.yaml sits on disk: the §27 redo must never touch it (AC8 — the app never writes that file).
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
  // AC8 — the legacy .agent-loop/state.yaml is byte-for-byte unchanged: the §27 redo wrote nothing to it.
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

  // AC8 — the legacy .agent-loop/state.yaml is byte-for-byte unchanged: the §27 polish/approve wrote nothing to it.
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

  // The reason surfaces on the shared blocking loop-error dialog (the §27 error surface for a def that
  // never resolved), naming the def that could not be found. The Advance control stays present behind it —
  // the route off the failed step that needs no hand-editing of files on disk (AC 6). No §27 run state was
  // written (no turn ran). Dismiss the dialog so it does not intercept the control exercised below.
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toContainText('no-such-v2-loop', { timeout: 10_000 });
  expect(existsSync(appRunState(repo))).toBe(false);
  await errorDialog.locator('.dismiss').click();
  await expect(errorDialog).toHaveCount(0);
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

  // The turn failure is never silent: it raises the shared blocking error-dialog surface.
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

const gateButton = (option: string) => loopPanel().locator(`[data-gate-option="${option}"]`);

test('activating the status-bar alert opens the docked panel and lands focus on the gate decision (§22.3.1 / WCAG 2.4.3)', { tag: '@ownapp' }, async () => {
  // The whole point of the alert→panel seam: a keyboard user who activates the red alert is routed ONTO
  // the decision, not merely shown the panel. This drives the REAL alert through the composition root
  // (openLoopPanel + the panel's own focusDecision) and observes focus land — the un-hide-then-focus
  // ordering jsdom cannot exercise. Re-driven onto a §27 consolidator gate (the retired in-terminal work path is gone).
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-alertfocus-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-alertfocus-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-alertfocus-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent'); // a hosted agent IS at the prompt; the §27 work prompt reaches it
  await flowControl().click(); // Start → enter the app plan-loop step → work → review → consolidate → the clean gate

  // The run stops at the consolidator's clean gate, awaiting a human decision (the human-needed state).
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');
  expect(readIf(appRunState(repo))).toContain('turn_key: consolidate-plan');

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

test('Restart clears a resolved stage-transition input so the next entry re-prompts (§24.2.3 T3)', { tag: '@ownapp' }, async () => {
  // The user supplies the plan step's ticket once (a §27 loop step's REQUIRED typed input, resolved via the
  // modal); after completing and Restarting the flow, the ticket must be re-requested — Restart wipes
  // resolved inputs (unlike Undo). A fake agent completes the driven §27 turn so it reaches a clean gate
  // rather than erroring for want of a hosted agent; that is incidental to the Restart-clears-input behavior.
  const repo = mkdtempSync(join(tmpdir(), 'agent-term-e2e-restart-reprompt-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(repo, '.agent-terminal', 'flow.yaml'),
    'name: dev-flow\nsteps:\n  - id: groom\n    kind: manual\n' +
      '  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n' +
      '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n',
  );
  seedCompletedAppBootstrap(repo);
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-restart-reprompt-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-restart-reprompt-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowStation(1).locator('.nm')).toHaveText('groom', { timeout: 10_000 });
  await typeCommand('fake-agent'); // a hosted agent is at the prompt for the §27 work turn

  await flowControl().click(); // Start → groom (manual, no prompt)
  await flowControl().click(); // Advance → plan (loop): the required-input modal opens
  await expect(inputModal()).toBeVisible({ timeout: 10_000 });
  await inputModal().locator('.field input').fill('176');
  await inputModal().locator('.confirm').click();
  await expect(inputModal()).toHaveCount(0);
  // The resolved input persists to flow-state.yaml; the driven §27 turn runs to its clean gate (no error).
  await expect
    .poll(() => readFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'utf8'), { timeout: 10_000 })
    .toContain('176');
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');

  await flowControl().click(); // Advance → done (plan is the last step; a §19.2 warn at the gate, proceeds)
  await expect(flowControl()).toHaveText('Restart', { timeout: 10_000 });

  await flowControl().click(); // Restart → back to groom, with the resolved ticket wiped
  await expect(flowStation(1).locator('.nm')).toHaveText('groom');
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
  rmSync(binDir, { recursive: true, force: true });
});

test('typed-input ticket + PR surface only once the flow enters the step that declares them (§24.2.3 T7)', { tag: '@ownapp' }, async () => {
  // Refs are the flow's typed inputs (§18.4): progress-gated, they stay hidden on the pre-`work` step and
  // appear only once the flow enters the `work` step that declares them — even though the resolved values
  // sit in flow-state.yaml from the start (§24.2.3 T7).
  const { dir: repo } = seedRefsFlowRepo('agent-term-e2e-refs-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refs-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → in_progress on the manual `groom` step
  await expect(flowStepName()).toHaveText('groom');
  // The `work` step has not been entered, so nothing ref-derived shows — even though flow-state carries it.
  await expect(loopReadout()).toHaveCount(0);

  await flowControl().click(); // Advance → enter the `work` step that declares the typed inputs
  await expect(loopReadout()).toBeVisible({ timeout: 10_000 });
  // Entering a ref-bearing step must NOT pop a blocking error dialog — it is a legitimate no-op.
  await expect(page.locator('#flow-error-host .flow-modal')).toHaveCount(0);
  // The docked popout's "Working on" section carries the ticket + PR (bare numbers, since the temp repo is
  // not on GitHub for gh to resolve titles/links).
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

test('Terminate clears the ticket/PR display even though the loop run-state still carries it (§24.2.3 T7)', { tag: '@ownapp' }, async () => {
  // Terminate resets the flow to its first step and wipes the resolved typed inputs, so the rail read-out
  // and docked popout empty — the refs display is a projection, not the source. The residual loop
  // run-state.yaml the app never writes is untouched by the clear.
  const { dir: repo, runStateFile } = seedRefsFlowRepo('agent-term-e2e-refs-term-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refs-term-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → groom (manual)
  await flowControl().click(); // Advance → work: the refs display appears
  await expect(loopReadout()).toBeVisible({ timeout: 10_000 });
  await loopReadout().click(); // open the docked popout
  await expect(loopPanel()).toContainText('Working on');

  await flowTerminate().click();
  await expect(confirmModal()).toBeVisible();
  await confirmModal().locator('.confirm').click();

  // Back at Not started: the `work` step is no longer entered and its inputs are wiped, so the display is
  // gone — read-out removed, popout closed and emptied — while the loop's run-state.yaml still holds it.
  await expect(flowControl()).toHaveText('Start');
  await expect(loopReadout()).toHaveCount(0);
  await expect(page.locator('#app')).not.toHaveClass(/\bloop-open\b/);
  await expect(loopPanel()).not.toContainText('Working on');
  expect(readFileSync(runStateFile, 'utf8')).toContain('status: complete'); // the run-state the app never writes is untouched

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('Restart clears the ticket/PR display and wipes its resolved inputs (§24.2.3 T7 / §18.4)', { tag: '@ownapp' }, async () => {
  // Restart returns the flow to its first step and wipes resolved inputs (§18.4, unlike Undo). The refs
  // display clears with no run-state write, and — because the source is the wiped inputs, not a re-read
  // external mirror — it stays cleared on re-entry until the inputs are provided again.
  const { dir: repo, runStateFile } = seedRefsFlowRepo('agent-term-e2e-refs-restart-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refs-restart-home-'));
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await flowControl().click(); // Start → groom (manual)
  await flowControl().click(); // Advance → work: the refs display appears
  await expect(loopReadout()).toBeVisible({ timeout: 10_000 });
  await flowControl().click(); // Advance → done (past the last step)
  await expect(flowControl()).toHaveText('Restart');
  await expect(loopReadout()).toBeVisible(); // still shown at done — the `work` step was entered this run

  await flowControl().click(); // Restart → in_progress at the groom step, resolved inputs wiped
  await expect(flowStepName()).toHaveText('groom');
  await expect(loopReadout()).toHaveCount(0); // cleared — the `work` step is no longer entered

  // Re-entering `work` shows nothing: Restart wiped the inputs, and (unlike the retired mirror) there is no
  // external source to re-read — flow-state.yaml no longer carries the ticket/PR.
  expect(readFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'utf8')).not.toContain('179');
  await flowControl().click(); // Advance → work again
  await expect(flowStation(2)).toHaveClass(/\bactive\b/); // on `work` (station 2), yet…
  await expect(loopReadout()).toHaveCount(0); // …no refs: the inputs were wiped and there is nothing to re-read
  expect(readFileSync(runStateFile, 'utf8')).toContain('status: complete'); // the run-state the app never writes is untouched

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('a §27 loop step shows a Loop read-out that expands a docked panel reflecting the run-state; advancing at the gate warns (§24.2.3 T2 / §19.2)', { tag: '@ownapp' }, async () => {
  // The read-out is progress-gated: absent on the pre-loop `groom` step, it appears once the flow enters
  // the `build` loop step and reflects the §27 engine's run-state (driven by a real turn). Advancing while
  // the loop sits at its (human-needed) gate is a §19.2 override: it warns but proceeds.
  const repo = seedManualThenAppLoopFlowRepo('agent-term-e2e-loop-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-loop-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-loop-bin-');
  seedFakeAgentV2(binDir, { stepId: 'build', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(`cd "${repo}"`);
  // Rail: [Not started] · groom · build · [Completed]. The pre-loop manual `groom` step shows no read-out.
  await expect(page.locator('#flow-strip .flow.vert .stn')).toHaveCount(4, { timeout: 10_000 });
  await expect(flowStation(2).locator('.nm')).toHaveText('build');
  await expect(loopReadout().locator('.spill')).toHaveCount(0);

  await flowControl().click(); // Start → groom (manual): the loop step is not entered, so no read-out
  await expect(flowStation(1)).toHaveClass(/\bactive\b/);
  await expect(loopReadout().locator('.spill')).toHaveCount(0);

  await typeCommand('fake-agent'); // a hosted agent is at the prompt for the work turn
  await flowControl().click(); // Advance → build (loop): the §27 work turn runs to its gate
  await expect(flowStation(2)).toHaveClass(/\bactive\b/);
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');
  // The compact Loop STATUS read-out appears, reflecting the run-state.
  await expect(loopReadout().locator('.spill')).toBeVisible({ timeout: 10_000 });
  await expect(loopReadout()).toContainText('iter 1');

  // Clicking the read-out opens the docked panel with the run's status and the def's gate options.
  await expect(page.locator('#app')).not.toHaveClass(/\bloop-open\b/);
  await loopReadout().click();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);
  await expect(loopPanel()).toContainText('complete'); // the run-state status, not the tone
  // The bound §27 def drives the gate-options row from plan-loop's gate [approve, request-changes, redo, polish].
  const gateRow = loopPanel().locator('.ldl .lrow', { has: page.locator('.lk', { hasText: 'gate options' }) });
  await expect(gateRow.locator('.lv')).toHaveText('approve · changes · redo · polish');

  // Advancing while the loop still sits at its (human-needed) gate is a §19.2 override: it warns but proceeds.
  await flowControl().click();
  await expect(page.locator('#flow-strip .flow-notice')).toContainText('still needs you', { timeout: 10_000 });
  await expect(flowStation(3)).toHaveClass(/\bactive\b/); // Completed — advanced anyway
  await expect(flowControl()).toHaveText('Restart');

  await app.close(); // HOME=temp ⇒ Electron writes userData under it; stop writes before removing it
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
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
  // Needs a real git repo so the artifact viewer's full-screen (which hides the rail/strip) works. The §27
  // loop is driven to its (human-needed) gate so the status-bar alert is present throughout (§24.2.3 T4).
  const repo = seedPrebootstrappedAppLoopFlowRepo('agent-term-e2e-reveal-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-reveal-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-reveal-bin-');
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile } });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  await typeCommand(
    `cd "${repo}" && rm -rf .git && git init -q && git config user.email t@t && git config user.name T && ` +
      `git add -A && git commit -qm init && printf '# Doc\\n' > doc.md && pwd`,
  );
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent'); // a hosted agent is at the prompt for the work turn
  await flowControl().click(); // Start → enter the plan loop → the §27 work turn drives to its gate
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: complete');
  await expect(loopReadout()).toHaveCount(1, { timeout: 10_000 });
  await expect(statusAlert()).toBeVisible();
  await expect(page.locator('#app')).not.toHaveClass(/\bloop-open\b/); // the docked panel starts closed

  // Reveal from a non-Terminal view must land on Terminal with the read-out open.
  await page.keyboard.press('Control+2');
  await expect(page.locator('[data-viewpane="2"]')).toBeVisible();
  await fireRevealLoop();
  await expect(page.locator('[data-viewpane="1"]')).toBeVisible();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);
  await expect(loopPanel()).toContainText('complete');

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
  rmSync(binDir, { recursive: true, force: true });
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

// ─── §28.3 — the `commit` gate side-effect, end-to-end (tracer bullet) ─────────────────────────────────
// A REAL git repo + a plan-loop whose approve gate declares a `commit` side-effect (swapped into a per-test
// CLAUDE_CONFIG_DIR copy of `example/`, so the shared `gh`-gate def other tests depend on is untouched). The
// fake-agent drives to a clean gate; approve fires the commit APP-SIDE, agent-uninvolved. The gate side-effect
// yaml is FLAT — `kind` + `label` are siblings (a nested `args:` would leave se.args.label undefined).
function seedCommitGateConfig(prefix: string): string {
  const cfg = mkdtempSync(join(tmpdir(), prefix));
  cpSync(exampleConfigDir, cfg, { recursive: true });
  const defPath = join(cfg, 'loops-v2', 'plan-loop', 'plan-loop.yaml');
  const def = readFileSync(defPath, 'utf8');
  const swapped = def.replace(
    '      - kind: gh\n        action: mark-ready',
    '      - kind: commit\n        label: "GREEN: s2-tracer"',
  );
  if (swapped === def) throw new Error('seedCommitGateConfig: plan-loop gh gate not found to swap');
  writeFileSync(defPath, swapped);
  return cfg;
}

const gitIn = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const gitCount = (repo: string): number => Number(gitIn(repo, 'rev-list', '--count', 'HEAD'));

// A REAL git repo carrying the same flow/bootstrap `.agent-terminal` state the fake-git gate test uses, so
// the drive (canned via the fake git+gh) reaches a clean gate while the commit side-effect's delegated ops
// land in a genuine repo. `.gitignore` excludes the engine state dirs (so AC1's tree-clean survives
// advanceFlow's post-commit write); `withChange` leaves one uncommitted file the commit will record;
// `capabilities`, when given, is a §28.5.4 loop-capabilities.yaml committed INTO the baseline (the RED
// working-tree check sources its test globs from it). Shared by the §28.3 commit and §28.5 RED tracers so the
// flow/flow-state literals have one home.
function seedCommitFlowRepo(prefix: string, opts: { withChange: boolean; capabilities?: string; seedTestFile?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const g = (...args: string[]): void => void execFileSync('git', args, { cwd: dir });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'T');
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '.agent-terminal/\n.agent-loop/\n');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  if (opts.capabilities !== undefined) writeFileSync(join(dir, 'loop-capabilities.yaml'), opts.capabilities);
  // §28.5.3 — a test-glob file committed INTO the baseline (default: none), so the GREEN frozen check
  // (baseline↔working-tree) sees a change when a later turn edits it. A no-op for the S2/S3 callers.
  if (opts.seedTestFile !== undefined) {
    mkdirSync(join(dir, dirname(opts.seedTestFile)), { recursive: true });
    writeFileSync(join(dir, opts.seedTestFile), 'test("baseline", () => {});\n');
  }
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: v2-gate\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    loop_namespace: app\n    inputs:\n      - name: ticket\n        type: github-ticket\n      - name: pr\n        type: pr\n  - id: done\n    kind: manual\n',
  );
  writeFileSync(
    join(dir, '.agent-terminal', 'flow-state.yaml'),
    'step: plan\nstatus: not_started\ninputs:\n  ticket: "176"\n  pr: "77"\n',
  );
  seedCompletedAppBootstrap(dir);
  g('add', '-A');
  g('commit', '-qm', 'baseline');
  if (opts.withChange) writeFileSync(join(dir, 'feature.ts'), 'export const x = 1;\n');
  return dir;
}

test('§28.3 — approve on a gate declaring a commit side-effect advances HEAD by exactly one with the phase label, tree clean, .gitignore untouched', { tag: '@ownapp' }, async () => {
  const repo = seedCommitFlowRepo('agent-term-e2e-commit-', { withChange: true });
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-commit-home-'));
  const cfg = seedCommitGateConfig('agent-term-e2e-commit-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-commit-bin-', { realCommitOps: true });
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);
  const gitignoreBefore = readFileSync(join(repo, '.gitignore'), 'utf8');

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });
  await loopPanel().locator('[data-gate-option="approve"]').click();

  // AC1 — the commit side-effect fired app-side: HEAD advanced by EXACTLY one carrying the declared label.
  await expect.poll(() => gitCount(repo), { timeout: 15_000 }).toBe(before + 1);
  expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('GREEN: s2-tracer');
  expect(gitIn(repo, 'status', '--porcelain')).toBe(''); // tree left clean (engine state gitignored)
  expect(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')).toContain('feature.ts');
  // AC2 — a pre-existing .gitignore is byte-for-byte unchanged.
  expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(gitignoreBefore);

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

test('§28.3 / AC3 — approve with nothing to commit surfaces a Notice (not a Loop error) and does not advance HEAD', { tag: '@ownapp' }, async () => {
  const repo = seedCommitFlowRepo('agent-term-e2e-commit-noop-', { withChange: false }); // clean tree — nothing to stage
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-commit-noop-home-'));
  const cfg = seedCommitGateConfig('agent-term-e2e-commit-noop-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-commit-noop-bin-', { realCommitOps: true });
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'complete', review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });
  await loopPanel().locator('[data-gate-option="approve"]').click();

  // AC3 — nothing to commit is surfaced as a NOTICE (not a failure) and no empty commit is made.
  const dialog = page.locator('#flow-error-host .flow-modal');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText('Notice');
  await expect(dialog).toContainText('nothing to commit');
  await expect(dialog).not.toContainText('Loop error');
  expect(gitCount(repo)).toBe(before); // HEAD did not advance — no empty commit

  await dialog.locator('.dismiss').click();
  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

// ─── §28.5 — the RED loop, end-to-end (the S3 tracer bullet) ───────────────────────────────────────────
// A REAL git repo + the plan-loop set to `work.completion: red` whose approve gate declares a `commit` side-
// effect (so the phase commit records the §28.5.1 baseline). A `loop-capabilities.yaml` supplies the test
// globs the working-tree RED check sources. The fake-agent authors a test file + writes the phase-result file
// the completion:red gate classifies; the git shim delegates the real ops (add/commit/rev-list/ls-files/diff)
// to real git so HEAD genuinely advances and the working-tree test detection sees the added file.
// Clone the example config, set the plan-loop's work.completion, and swap its gh mark-ready gate for a commit
// side-effect carrying `label` — the shared shape of the §28.5 RED (S3) and GREEN (S4) tracer configs; they
// differ only in the completion value and the commit label.
function seedCompletionGateConfig(prefix: string, completion: 'red' | 'green' | 'refactor', label: string): string {
  const cfg = mkdtempSync(join(tmpdir(), prefix));
  cpSync(exampleConfigDir, cfg, { recursive: true });
  const defPath = join(cfg, 'loops-v2', 'plan-loop', 'plan-loop.yaml');
  const def = readFileSync(defPath, 'utf8');
  const withCompletion = def.replace('work:\n  recipe: prompts/work.md\n  artifact: plan\n', `work:\n  recipe: prompts/work.md\n  artifact: plan\n  completion: ${completion}\n`);
  if (withCompletion === def) throw new Error(`seedCompletionGateConfig: plan-loop work block not found to set completion: ${completion}`);
  const swapped = withCompletion.replace('      - kind: gh\n        action: mark-ready', `      - kind: commit\n        label: "${label}"`);
  if (swapped === withCompletion) throw new Error('seedCompletionGateConfig: plan-loop gh gate not found to swap for commit');
  writeFileSync(defPath, swapped);
  return cfg;
}
const seedRedGateConfig = (prefix: string): string => seedCompletionGateConfig(prefix, 'red', 'RED: s3-tracer');

// The RED flow repo: seedCommitFlowRepo with NO pre-seeded change (the fake-agent authors the test file this
// turn — the untracked change the working-tree RED check sees and the approve commit records) plus a
// loop-capabilities.yaml (test globs = `tests/**`) baked into the baseline.
const seedRedFlowRepo = (prefix: string): string =>
  seedCommitFlowRepo(prefix, {
    withChange: false,
    capabilities: 'test_globs:\n  - tests/**\ntest_command: pnpm test\nbuild_command: pnpm run build\n',
  });

test('§28.5 — a RED loop completes on a newly-authored failing test + a failed-assertion result; approve advances HEAD by one and records the §28.5.1 baseline, the result file staying out of the tree', { tag: '@ownapp' }, async () => {
  const repo = seedRedFlowRepo('agent-term-e2e-red-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-red-home-'));
  const cfg = seedRedGateConfig('agent-term-e2e-red-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-red-bin-', { realCommitOps: true });
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'red', resultOutcome: 'failed-assertion', writeTest: true, review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // The RED work turn's failed-assertion result + the authored test satisfied the completion gate, so the loop
  // drove through review/consolidate to the clean gate (a passing result would have retried-then-errored).
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });
  await loopPanel().locator('[data-gate-option="approve"]').click();

  // approve fired the commit side-effect app-side: HEAD advanced by EXACTLY one carrying the RED label, and the
  // authored test file rode into that commit.
  await expect.poll(() => gitCount(repo), { timeout: 15_000 }).toBe(before + 1);
  const head = gitIn(repo, 'rev-parse', 'HEAD');
  expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('RED: s3-tracer');
  expect(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')).toContain('tests/red_added.test.ts');
  // AC3 versioned-both-directions: the raw phase-result is durably on disk under the loop area, but is NOT in
  // the commit (it lives under .agent-terminal/, gitignored + isUnderAppStateDir-excluded — CWE-200).
  const durable = readFileSync(join(repo, APP_ARTIFACT_REL), 'utf8');
  expect(durable).toContain('outcome: failed-assertion'); // the classification
  expect(durable).toContain('AssertionError'); // AND the RAW captured run itself (AC3's subject), not just the outcome line
  expect(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('plan.md');
  // §28.5.1 — approve recorded the baseline: the EXACT sha the side-effect made, under the decision's step.
  const baseline = readBaselineCommit(repo);
  expect(baseline?.sha).toBe(head);
  expect(baseline?.branch).toBe(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'));

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

test('§28.5 / AC2 — a RED loop whose test PASSES never completes: it retries then routes out as a loop error, HEAD unchanged and no baseline recorded', { tag: '@ownapp' }, async () => {
  const repo = seedRedFlowRepo('agent-term-e2e-red-sad-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-red-sad-home-'));
  const cfg = seedRedGateConfig('agent-term-e2e-red-sad-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-red-sad-bin-', { realCommitOps: true });
  // A test IS authored, but the fake classifies the run as `passed` — the RED gate requires failed-assertion.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'red', resultOutcome: 'passed', writeTest: true, review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // A passing result never satisfies the RED gate → the work turn retries once then routes out (initial + one
  // retry), never reaching a verdict. The failure is surfaced on the blocking loop-error dialog, never silent.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: error');
  expect(readIf(join(repo, '.agent-terminal', 'work-runs')).length).toBe(2);
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await expect(errorDialog).toContainText('Loop error');

  // AC2 — no clean gate was reached, so HEAD never advanced and no baseline was recorded.
  expect(gitCount(repo)).toBe(before);
  expect(readBaselineCommit(repo)).toBeNull();

  await errorDialog.locator('.dismiss').click();
  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

// ─── §28.5.3 — the GREEN loop, end-to-end (the S4 tracer bullet) ───────────────────────────────────────
// The plan-loop set to `work.completion: green` whose approve gate commits. A loop-capabilities.yaml supplies
// the test globs; a test file (tests/frozen.test.ts) is committed INTO the baseline and its SHA recorded as
// the §28.5.1 baseline (simulating a completed RED phase). The fake-agent implements + writes a passed/built
// phase-result; the frozen check (baseline↔working-tree) detects a touched test as a NON-blocking flag.
const seedGreenGateConfig = (prefix: string): string => seedCompletionGateConfig(prefix, 'green', 'GREEN: s4-tracer');

// The GREEN flow repo: a committed tests/frozen.test.ts, capabilities (globs = tests/**), and the baseline SHA
// recorded under the `plan` step (the RED phase's product the GREEN frozen check diffs against).
const seedGreenFlowRepo = (prefix: string): string => {
  const dir = seedCommitFlowRepo(prefix, {
    withChange: false,
    capabilities: 'test_globs:\n  - tests/**\ntest_command: pnpm test\nbuild_command: pnpm run build\n',
    seedTestFile: 'tests/frozen.test.ts',
  });
  recordBaselineCommit(dir, gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), gitIn(dir, 'rev-parse', 'HEAD'));
  return dir;
};

test('§28.5.3 — a clean GREEN (passed + built, no test changed) completes and commits; the panel shows NO changed-test flag', { tag: '@ownapp' }, async () => {
  const repo = seedGreenFlowRepo('agent-term-e2e-green-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-green-home-'));
  const cfg = seedGreenGateConfig('agent-term-e2e-green-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-green-bin-', { realCommitOps: true });
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'green', touchTest: false, review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // passed+built + no test changed → the GREEN gate completed and the loop drove to the clean gate.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });
  // clean GREEN records an EMPTY flag, so the panel shows NO changed-test notice:
  await expect(loopPanel().locator('[data-changed-tests]')).toHaveCount(0);
  expect(readChangedTests(repo)).toEqual({ step: 'plan', paths: [] });
  await loopPanel().locator('[data-gate-option="approve"]').click();

  // approve fired the commit side-effect: HEAD advanced by one with the GREEN label, the impl file rode in.
  await expect.poll(() => gitCount(repo), { timeout: 15_000 }).toBe(before + 1);
  expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('GREEN: s4-tracer');
  expect(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')).toContain('feature.ts');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

test('§28.5.3 / AC2 — a GREEN turn that touches a test file STILL completes, and the changed-test flag is recorded + surfaced (detect-and-escalate)', { tag: '@ownapp' }, async () => {
  const repo = seedGreenFlowRepo('agent-term-e2e-green-flag-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-green-flag-home-'));
  const cfg = seedGreenGateConfig('agent-term-e2e-green-flag-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-green-flag-bin-', { realCommitOps: true });
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'green', touchTest: true, review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // the touched test did NOT block — the turn still completed and drove to the clean gate (§28.8.3).
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });
  // the changed-test flag was recorded (naming the touched test) AND surfaced in the panel notice:
  expect(readChangedTests(repo)?.paths).toContain('tests/frozen.test.ts');
  const notice = loopPanel().locator('[data-changed-tests]');
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText('tests/frozen.test.ts');
  await loopPanel().locator('[data-gate-option="approve"]').click();

  // approve committed the change (HEAD+1, the touched test rode in) — the flag is a caution, not a block.
  await expect.poll(() => gitCount(repo), { timeout: 15_000 }).toBe(before + 1);
  expect(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')).toContain('tests/frozen.test.ts');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

test('§28.5.3 / AC3 — a GREEN turn whose tests do NOT pass never completes: it retries then routes out as a loop error, HEAD unchanged', { tag: '@ownapp' }, async () => {
  const repo = seedGreenFlowRepo('agent-term-e2e-green-sad-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-green-sad-home-'));
  const cfg = seedGreenGateConfig('agent-term-e2e-green-sad-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-green-sad-bin-', { realCommitOps: true });
  // the impl "runs" but the fake classifies the outcome as failed-assertion — the GREEN gate requires `passed`.
  // (AC3's other half — a broken BUILD, `build: build-failed` — fails the same sync clause and is proven at the
  // integration layer by IT-GREEN-3b; the `buildOutcome` fake knob exercises it there, so it is not re-run e2e.)
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'green', resultOutcome: 'failed-assertion', touchTest: false, review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // a non-passing outcome never satisfies the GREEN gate → the work turn retries once then routes out.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: error');
  expect(readIf(join(repo, '.agent-terminal', 'work-runs')).length).toBe(2);
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await expect(errorDialog).toContainText('Loop error');

  // AC3 — no clean gate was reached, so HEAD never advanced and no flag was recorded.
  expect(gitCount(repo)).toBe(before);
  expect(readChangedTests(repo)).toBeNull();

  await errorDialog.locator('.dismiss').click();
  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

// ─── §28.5.3/§28.6 — the refactor loop, end-to-end (the S5 tracer bullet) ──────────────────────────────
// The plan-loop set to `work.completion: refactor` whose approve gate commits. The work turn is a `commits`
// turn; each review-and-fix ROUND writes a round-keyed phase-result the gate reads ({report ∧ passed}, softer
// than GREEN). The baseline (a committed tests/frozen.test.ts, its SHA recorded) stands in for a completed RED;
// the frozen check (baseline↔working-tree) flags a touched test as a NON-blocking caution.
const seedRefactorGateConfig = (prefix: string): string => seedCompletionGateConfig(prefix, 'refactor', 'refactor: s5-tracer');
const seedRefactorFlowRepo = (prefix: string): string => {
  const dir = seedCommitFlowRepo(prefix, {
    withChange: false,
    capabilities: 'test_globs:\n  - tests/**\ntest_command: pnpm test\nbuild_command: pnpm run build\n',
    seedTestFile: 'tests/frozen.test.ts',
  });
  recordBaselineCommit(dir, gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), gitIn(dir, 'rev-parse', 'HEAD'));
  return dir;
};

test('§28.5.3 / AC1 — a clean refactor round (report + passing result, no test changed) completes, drives to the gate, and commits', { tag: '@ownapp' }, async () => {
  const repo = seedRefactorFlowRepo('agent-term-e2e-refac-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refac-home-'));
  const cfg = seedRefactorGateConfig('agent-term-e2e-refac-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-refac-bin-', { realCommitOps: true });
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'refactor', touchTest: false, review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // the refactor round's result classified `passed` → the round completed and the loop drove to the clean gate.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });
  // no test changed → an EMPTY flag, so the panel shows NO changed-test notice:
  await expect(loopPanel().locator('[data-changed-tests]')).toHaveCount(0);
  expect(readChangedTests(repo)).toEqual({ step: 'plan', paths: [] });
  await loopPanel().locator('[data-gate-option="approve"]').click();

  // approve fired the commit side-effect: HEAD+1 with the `refactor:` label, the refactored source rode in.
  await expect.poll(() => gitCount(repo), { timeout: 15_000 }).toBe(before + 1);
  expect(gitIn(repo, 'log', '-1', '--format=%s')).toBe('refactor: s5-tracer');
  expect(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')).toContain('feature.ts');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

test('§28.5.3 / AC3 — a refactor round that touches a test file STILL completes, and the changed-test flag is recorded + surfaced (detect-and-escalate)', { tag: '@ownapp' }, async () => {
  const repo = seedRefactorFlowRepo('agent-term-e2e-refac-flag-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refac-flag-home-'));
  const cfg = seedRefactorGateConfig('agent-term-e2e-refac-flag-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-refac-flag-bin-', { realCommitOps: true });
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'refactor', touchTest: true, review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // the touched test did NOT block — the refactor round completed and drove to the clean gate (§28.8.3).
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('verdict: clean');
  await loopReadout().click();
  await expect(loopPanel().locator('[data-gate-option="approve"]')).toBeVisible({ timeout: 10_000 });
  // the changed-test flag was recorded (naming the touched test) AND surfaced in the phase-neutral panel notice:
  expect(readChangedTests(repo)?.paths).toContain('tests/frozen.test.ts');
  const notice = loopPanel().locator('[data-changed-tests]');
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText('tests/frozen.test.ts');
  await expect(notice).not.toContainText('during GREEN'); // phase-neutral (this is a refactor round)
  await loopPanel().locator('[data-gate-option="approve"]').click();

  // approve committed the change (HEAD+1, the touched test rode in) — the flag is a caution, not a block.
  await expect.poll(() => gitCount(repo), { timeout: 15_000 }).toBe(before + 1);
  expect(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')).toContain('tests/frozen.test.ts');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

test('§28.5.3 / AC2 — a refactor round whose tests do NOT pass never completes: it retries then routes out as a loop error, HEAD unchanged', { tag: '@ownapp' }, async () => {
  const repo = seedRefactorFlowRepo('agent-term-e2e-refac-sad-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-refac-sad-home-'));
  const cfg = seedRefactorGateConfig('agent-term-e2e-refac-sad-cfg-');
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-refac-sad-bin-', { realCommitOps: true });
  // the round writes a report but the fake classifies the result as failed-assertion — the gate requires `passed`.
  seedFakeAgentV2(binDir, { stepId: 'plan', artifactRel: APP_ARTIFACT_REL, work: 'refactor', resultOutcome: 'failed-assertion', touchTest: false, review: 'full' });
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: cfg, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);

  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click();

  // a non-passing result never satisfies the refactor round's gate → the round retries once then routes out.
  await expect.poll(() => readIf(appRunState(repo)), { timeout: 40_000 }).toContain('status: error');
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toBeVisible({ timeout: 15_000 });
  await expect(errorDialog).toContainText('Loop error');

  // AC2 — no clean gate was reached, so HEAD never advanced and no flag was recorded.
  expect(gitCount(repo)).toBe(before);
  expect(readChangedTests(repo)).toBeNull();

  await errorDialog.locator('.dismiss').click();
  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

// ---- §28.10 S7 — the full-TDD chain e2e: drive the SHIPPED flow end-to-end from a groomed ticket (AC1) ----
const CHAIN_IMPL12 = ['principal', 'tests', 'security', 'taint', 'reliability', 'architecture', 'contracts', 'intent', 'maintainability', 'conventions', 'accessibility', 'diagrams'].map((l) => `impl-review-${l}`);
const CHAIN_ROSTERS: Record<string, string[]> = {
  'plan-bundle': [...['principal', 'security', 'architecture', 'intent', 'maintainability', 'contracts'].map((l) => `review-plan-${l}`), 'review-plan-test-architect', 'review-plan-determinism', 'review-plan-tracer-slicer'],
  infra: [...['tests', 'security', 'taint', 'reliability', 'maintainability', 'conventions', 'architecture'].map((l) => `impl-review-${l}`), 'review-plan-determinism'],
  red: ['impl-review-tests', 'impl-review-intent', 'impl-review-red-authenticity'],
  green: [...CHAIN_IMPL12, 'impl-review-regression-guard'],
  refactor: CHAIN_IMPL12,
  'integration-slice': [...CHAIN_IMPL12, 'review-plan-tracer-slicer'],
};

// A multi-step fake-agent: one `while read` loop whose case matches every loop step's work/review/consolidate
// turn-done token, so ONE agent process drives the whole chain. Each loop's review round writes a report
// accounting for THAT loop's roster (§27.5); the phase loops classify their §28.5 result files; the refactor
// review round writes its round-keyed result + a behavior-preserving change so its gate has something to commit.
function seedFullTddChainAgent(binDir: string): void {
  const doneRel = `.agent-terminal/loop/${TURN_DONE_FILENAME}`;
  const done = (key: string): string => `mkdir -p .agent-terminal/loop; printf '%s' '${key}' > ${doneRel}`;
  const art = '.agent-terminal/loop/artifacts';
  const decode = (b64s: string, dst: string): string => `printf %s '${b64s}' | base64 -d > ${dst}`;
  const report = (step: string): string => b64(exampleRoundReport({ sections: ['summary', 'findings', 'disposition'], roster: CHAIN_ROSTERS[step] }));

  const workArm: Record<string, string> = {
    'plan-bundle': `mkdir -p ${art}; printf '%s\\n' '# plan' '${completionMarker('plan-bundle')}' > ${art}/plan.md; ${done('work-plan-bundle')}`,
    infra: `printf '%s\\n' 'export const infra = 1;' > infra.ts; ${done('work-infra')}`,
    red: `mkdir -p tests; printf '%s\\n' 'test("adds", () => { expect(add(1, 1)).toBe(3); });' > tests/red_added.test.ts; mkdir -p ${art}; ${decode(b64(examplePhaseResult('failed-assertion')), `${art}/red-result.md`)}; ${done('work-red')}`,
    green: `printf '%s\\n' 'export const feat = 2;' > feature.ts; mkdir -p ${art}; ${decode(b64(examplePhaseResult('passed', { build: 'built' })), `${art}/green-result.md`)}; ${done('work-green')}`,
    refactor: done('work-refactor'),
    'integration-slice': `printf '%s\\n' 'export const integ = 3;' > integration.ts; ${done('work-integration-slice')}`,
  };
  const reviewArm = (step: string): string => {
    const base = `mkdir -p .agent-terminal/loop/reports; r=$(rnd); ${decode(report(step), '.agent-terminal/loop/reports/$r.md')}`;
    return step === 'refactor'
      ? `${base}; mkdir -p .agent-terminal/loop/refactor-results; ${decode(b64(examplePhaseResult('passed')), '.agent-terminal/loop/refactor-results/$r.md')}; printf '%s\\n' 'export const rf = 4;' > refactor.ts; ${done('review-refactor')}`
      : `${base}; ${done(`review-${step}`)}`;
  };
  const consolidateArm = (step: string): string =>
    `r=$(rnd); mkdir -p .agent-terminal/loop/consolidate; printf 'verdict: clean\\n' > .agent-terminal/loop/consolidate/$r.md; ${done(`consolidate-${step}`)}`;

  const steps = ['plan-bundle', 'infra', 'red', 'green', 'refactor', 'integration-slice'];
  const cases = steps
    .flatMap((s) => [
      `    *turn-done:consolidate-${s}*) ${consolidateArm(s)} ;;`,
      `    *turn-done:review-${s}*) ${reviewArm(s)} ;;`,
      `    *turn-done:work-${s}*) ${workArm[s]} ;;`,
    ])
    .join('\n');
  const script =
    '#!/usr/bin/env bash\n' +
    'rnd() { r=$(grep -m1 "^round:" .agent-terminal/loop/run-state.yaml 2>/dev/null | tr -dc "0-9"); [ -z "$r" ] && r=1; printf %s "$r"; }\n' +
    'while IFS= read -r line; do\n' +
    '  [ -z "$line" ] && continue\n' +
    '  case "$line" in\n' +
    '    /clear) mkdir -p .agent-terminal; printf x >> .agent-terminal/clear-seen ;;\n' +
    '    /compact*) mkdir -p .agent-terminal; printf x >> .agent-terminal/compact-seen ;;\n' +
    `${cases}\n` +
    '  esac\n' +
    'done\n';
  writeFileSync(join(binDir, 'fake-agent'), script, { mode: 0o755 });
}

// A real-git repo carrying the SHIPPED full-TDD flow.yaml, entered at the plan-bundle step (a groomed ticket,
// §28.2 AC1); bootstrap pre-completed so every phase loop runs on this repo's one branch (the §28.5.1 slice key).
function seedFullTddChainRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const g = (...args: string[]): void => void execFileSync('git', args, { cwd: dir });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'T');
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '.agent-terminal/\n.agent-loop/\n');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  writeFileSync(join(dir, 'loop-capabilities.yaml'), 'test_globs:\n  - tests/**\ntest_command: pnpm test\nbuild_command: pnpm run build\n');
  cpSync(join(process.cwd(), 'example', 'flow', 'flow.yaml'), join(dir, '.agent-terminal', 'flow.yaml'));
  writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'step: plan-bundle\nstatus: not_started\ninputs:\n  ticket: "176"\n  pr: "77"\n');
  seedCompletedAppBootstrap(dir);
  g('add', '-A');
  g('commit', '-qm', 'baseline');
  return dir;
}

test('§28.10 S7 — the shipped full-TDD flow runs end-to-end from a groomed ticket: plan-bundle → infra → red → green → refactor → integration-slice, the five phase commits landing on one branch and the PR body published', { tag: '@ownapp' }, async () => {
  const repo = seedFullTddChainRepo('agent-term-e2e-fulltdd-');
  const home = mkdtempSync(join(tmpdir(), 'agent-term-e2e-fulltdd-home-'));
  const { binDir, logFile } = seedFakeGhGit('agent-term-e2e-fulltdd-bin-', { realCommitOps: true });
  seedFullTddChainAgent(binDir);
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir, PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });

  const before = gitCount(repo);
  await typeCommand(`cd "${repo}"`);
  await expect(flowControl()).toHaveText('Start', { timeout: 10_000 });
  await typeCommand('fake-agent');
  await flowControl().click(); // Start → enter plan-bundle

  const approveStep = async (step: string): Promise<void> => {
    await expect.poll(() => readIf(appRunState(repo)), { timeout: 90_000 }).toContain('verdict: clean');
    // Open the loop panel if it isn't already (loopReadout TOGGLES it — re-clicking an open panel closes it).
    if ((await loopReadout().getAttribute('aria-expanded')) !== 'true') await loopReadout().click();
    const approveBtn = loopPanel().locator('[data-gate-option="approve"]');
    await expect(approveBtn).toBeVisible({ timeout: 30_000 });
    await approveBtn.click();
    await expect.poll(() => readIf(appFlowState(repo)), { timeout: 30_000 }).not.toContain(`step: ${step}\n`);
  };

  await approveStep('plan-bundle'); // planning bundle: gh mark-ready + carry plan.md into infra
  await approveStep('infra'); // infra commits
  await approveStep('red'); // RED commit + §28.5.1 baseline recorded on the branch
  await approveStep('green'); // GREEN commit — the branch-keyed baseline is FOUND across the step (slice D)
  await approveStep('refactor'); // refactor commit
  await approveStep('integration-slice'); // integration commit + PR body published

  // AC1 — the four commit groups (infra / the three slice phases / integration) all landed, in order, on ONE branch.
  expect(gitCount(repo)).toBe(before + 5);
  expect(gitIn(repo, 'log', '--format=%s', '-6').split('\n')).toEqual(['integration', 'refactor', 'GREEN', 'RED', 'infra', 'baseline']);
  // The planning gate marked the PR ready and the integration gate published its body; the flow reached finalize.
  await expect.poll(() => readGhLog(logFile)).toContain('pr ready');
  await expect.poll(() => readGhLog(logFile)).toContain('pr edit');
  await expect.poll(() => readIf(appFlowState(repo)), { timeout: 15_000 }).toContain('step: finalize');

  await app.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});
