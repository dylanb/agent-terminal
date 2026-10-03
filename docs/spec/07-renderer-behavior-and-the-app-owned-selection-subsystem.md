## 7. Renderer behavior and the app-owned selection subsystem

### 7.0 Why a custom selection mechanism

The selection must behave as **application state** that:

- **survives focus changes** — clicking into the action window or another pane must not erase it;
- is readable by the app as extracted text (Copy, §7.7) and clearable by the app (Escape, §7.5.1);
- never looks cleared while the app still treats it as active, or vice versa.

The mechanism below delivers this. **xterm's native selection is the only highlight** (v2.150): in the pinned 5.5.0 it survives blur and paints with `selectionInactiveBackground`, which is set to the same `SEL_COLOR` as `selectionBackground`, so the selection reads identically focused or not (§7.1). The app keeps a model of the selection's extracted text (§7.2) that **follows xterm's selection**: xterm itself clears the selection on typing into the terminal, on a click in it, and on a normal↔alt buffer switch, and each of those clears the model too, so Copy and the Escape rule (§7.5.1) never act on a selection the user can no longer see. The drag *gesture* and the highlight both come from xterm (its cell hit-testing, wrapped-line handling, and per-frame paint); the app-owned decoration layer that previously drew a persistent highlight was **removed in v2.150** — it re-created one marker per selected row on every scroll and never released them, so a long-lived selection under a noisy agent pegged the renderer (§14).

> **Current (Option A — below):** an app-owned text model over xterm's native selection and highlight. Lowest risk, reuses xterm's hit-testing and paint.
> **Option B (deferred, §11):** a transparent pointer-capture overlay with our own pixel→cell mapping and drag state, depending on xterm for *nothing*. Needed when we must select on the **alternate screen buffer** (full-screen TUIs — which includes Codex's TUI, so this lands sooner than v1.2 assumed), support multiple simultaneous selections, or define gestures xterm doesn't provide.

### 7.1 Base terminal setup

```js
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const term = new Terminal({
  fontFamily: 'monospace',
  fontSize: 14,
  cursorBlink: true,
  scrollback: 5000,
  allowProposedApi: true,                 // buffer/marker/decoration access (§16.8 reveal)
  theme: {
    // xterm's native selection is the only highlight, focused or blurred (§7.0).
    selectionBackground: SEL_COLOR,
    selectionInactiveBackground: SEL_COLOR,
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

// PTY wiring
window.term.onData((data) => term.write(data));
term.onData((data) => window.term.input(data));         // keystrokes out
window.term.onExit(({ code }) => term.write(`\r\n[process exited: ${code}]\r\n`));

// Resize — debounced: a drag-resize during an agent output burst can otherwise leave
// the PTY, renderer, and shadow wrapping lines at different widths (§14).
const sendResize = () => { fit.fit(); window.term.resize({ cols: term.cols, rows: term.rows }); };
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, 80);
});
sendResize();
```

### 7.2 The selection model

A single source of truth, in **absolute buffer coordinates** (row index into the full buffer including scrollback), plus the extracted text. One persistent selection for this version; the shape generalizes to an array later.

```js
const selection = {
  active: false,
  start: null,    // { x, y }  absolute buffer coords, inclusive
  end:   null,    // { x, y }  absolute buffer coords, inclusive
  text:  '',
  baseY: 0,            // buffer.active.baseY at gesture time — coordinate-era stamp (§7.3)
  bufferType: 'normal', // buffer the gesture happened on: 'normal' | 'alternate'
};
```

### 7.3 Capturing the gesture (follows xterm's selection)

We drive the model from xterm's selection. A non-empty selection updates the model; an **empty** one — xterm clearing its own selection on typing, a click, or a buffer switch — **clears** the model, so the model never outlives the highlight the user sees (v2.150; previously empty changes were ignored because the app painted its own persistent highlight).

```js
term.onSelectionChange(() => {
  if (!term.hasSelection()) { clearModel(); return; }   // xterm cleared it — so do we
  let range, text;
  try {
    range = term.getSelectionPosition();       // IBufferRange | undefined (absolute buffer coords)
    text  = term.getSelection();
  } catch {
    return;   // alt-buffer / mid-swap extraction edge cases must never crash the renderer
  }
  if (!range || text.length === 0) return;

  selection.active = true;
  selection.start = { x: range.start.x, y: range.start.y };
  selection.end   = { x: range.end.x,   y: range.end.y };
  selection.text  = text;                              // extracted NOW — the durable payload
  selection.baseY = term.buffer.active.baseY;          // coordinate-era stamp
  selection.bufferType = term.buffer.active.type;      // 'normal' | 'alternate'
});
```

> **Verify on integration:** confirm whether `getSelectionPosition()` returns *absolute* buffer rows (including scrollback) or viewport-relative rows in your pinned xterm.js version, and convert once in this function if needed. Everything downstream assumes absolute rows. Also verify that `getSelection()` / `getSelectionPosition()` behave sanely on the **alternate buffer** and across a normal↔alt swap mid-gesture — historical xterm.js versions have had surprises here; the `try/catch` above is the backstop, not the plan.

> **Coordinate drift under output bursts:** absolute rows are stable only until scrollback overflows — once rows trim off the top (a noisy agent can do this *between* the drag and a later Send/Capture click, or even mid-drag), every stored index points at different content. This is why the model treats the **text extracted at gesture time** as the durable payload — coordinates are never used to re-extract text at click time — and stamps `baseY`/`bufferType` so consumers can tell which coordinate era a range belongs to. (The highlight is xterm's own, which adjusts for trims itself — §7.4.)

### 7.4 The highlight (xterm's native selection)

The app draws **no highlight of its own** (v2.150). xterm paints the selection in `SEL_COLOR` (`rgba(80, 140, 255, 0.7)`, ≥3:1 against the terminal background, WCAG 1.4.11) whether or not the terminal is focused (§7.1), adjusts it as scrollback trims, and draws it on the **alternate buffer** too — so full-screen TUIs (Claude Code 2.x, Codex) now get a visible selection, which the removed decoration layer could not provide there.

> **Marker hygiene (applies to the §16.8 reveal, the remaining decoration user):** disposing an `IDecoration` does **not** dispose the marker it was registered on — the marker stays in the buffer, subscribed to its trim/insert/delete events, until its line trims out of scrollback. Every marker the renderer registers must therefore be disposed explicitly (disposing the marker disposes its decoration). The reveal disposes its markers when its highlight clears, including markers whose decoration was refused on the alt buffer.

### 7.5 Sending selection as input (bracketed-paste aware)

"Send to terminal" must behave like a **paste**, not a stream of keystrokes, because the hosted agents (Claude Code, Codex) — and modern bash/zsh themselves — turn on **bracketed paste mode** and rely on it. In that mode the running program asks the terminal to fence pasted text between two markers:

```
ESC[200~   <the pasted text>   ESC[201~
```

The program turns the mode on/off with `ESC[?2004h` / `ESC[?2004l`; we never decide it — we only honor whatever the foreground app currently wants. When the markers are present, the app knows the block was pasted and (a) inserts a multi-line selection as one editable block **without running each line**, and (b) routes it to its input box instead of treating newlines as "submit." Without the markers, a multi-line selection pasted into Claude Code or a REPL gets the first line executed and the rest mangled — the exact bug this prevents.

xterm.js already tracks the mode and does the wrapping, newline normalization, and security sanitization for us. The rule: **inject via `term.paste()`, not a raw write.** `paste()` fires the normal data event, so it flows through the same `onData → pty:input` path already wired in §7.1.

```js
// Single renderer-side injection point. Honors the foreground app's bracketed-paste mode.
function injectText(text) {
  if (!text) return;
  // term.paste():
  //   - wraps in ESC[200~ … ESC[201~ IFF term.modes.bracketedPasteMode is on,
  //   - normalizes newlines,
  //   - strips any embedded ESC[201~ so pasted text can't "break out" of paste mode,
  //   - emits via onData -> forwarded to the PTY by our §7.1 wiring.
  term.paste(text);
}

function cleanSelectionText() {
  let text = selection.text.replace(/[ \t]+$/gm, '');   // trim per-line cell padding
  return text.replace(/\r?\n$/, '');                     // drop one trailing newline (don't auto-submit)
}

// The selection has no in-terminal toolbar (removed in v2.132). It is acted on by the keyboard
// alone (§7.7): Copy writes cleanSelectionText() to the clipboard; Escape (while active) clears it
// (§7.5.1). injectText() above is the renderer-side paste path the Paste chord routes through — it
// is not tied to any button; the §9.3 injection API is the separate main-process path (see below).
```

> **Why two injection paths exist:** the renderer path uses `term.paste()`, which reads the live mode and sanitizes for free. The **monitor pane** (and any future programmatic actor) must not depend on the renderer's xterm instance, so it uses the main-process injection API (§9.3), which reads the same mode from the **shadow** terminal and applies the equivalent `wrapForPaste` sanitization. Both paths are mode-honoring; neither caches the mode.

**Escape hatch:** if a user lands in an odd session (some SSH hops, a REPL that lies about supporting paste), set the terminal option `ignoreBracketedPasteMode: true` to force raw sending. Note the default matters — defaulting to *ignore* is a known footgun that breaks multi-line paste into zsh/Claude Code, so leave bracketed paste **honored** by default (and mirror any override into the main-process injector so the two paths never disagree).

### 7.5.1 Clear and lifecycle

```js
// Explicit clear — Escape while a selection is active. (xterm's own clears — typing, a click, a
// buffer switch — reach the model through §7.3.)
function clearSelection() {
  clearModel();
  term.clearSelection();
}
// Escape (while a selection is active) is the only clear affordance — there is no toolbar button (§7.5.1, v2.132).
term.attachCustomKeyEventHandler((e) => {
  if (e.type === 'keydown' && e.key === 'Escape') { clearSelection(); return false; }
  return true;
});
```

> **Escape-key caveat for agents:** Claude Code and other TUIs bind Escape themselves (interrupt/back). Swallowing it globally for "clear selection" conflicts with driving the agent. Rule: Escape clears the selection **only when a selection is active**; otherwise it passes through to the PTY (`return true`). Revisit the binding once agents are the daily workload.

The terminal view carries **no selection toolbar** (the former **Send selection** / **Capture selection** / **Clear selection** buttons were removed in v2.132); the selection is driven by the keyboard alone (Copy via the keymap, Clear via Escape — §7.7).

### 7.5.2 Agent key bindings (added v2.8)

> Generalized in v2.72 into the cross-platform keymap (**§7.7**); the motion chords below are the OS-agnostic editing subset of that model, now sourced from `BYTES_FOR`.

The terminal pane translates a small set of editor-style chords into the exact byte sequences a coding agent's input box (Claude Code) and `readline` expect, so the prompt behaves like an editor rather than submitting on every Return. The mapping is a pure function (`keyEventToBytes`, `src/renderer/src/keymap.ts`); the bytes **are** the contract:

| Chord | Bytes sent | Meaning |
| --- | --- | --- |
| **Shift+Enter**, **Alt/Option+Enter** | `\x1b\r` (ESC + CR) | Insert a newline **without** submitting (Meta+Enter "newline" form). |
| Plain **Enter** | — (passed through → bare `\r`) | Submit the line. |
| **Alt/Option+Left** | `\x1bb` (meta-b) | Move backward one word. |
| **Alt/Option+Right** | `\x1bf` (meta-f) | Move forward one word. |
| **Alt/Option+Backspace** | `\x1b\x7f` (ESC + DEL) | Delete the previous word (backward-kill-word). |

Design constraints:

- **Why ESC+CR for newline, not CSI-u.** `@xterm/xterm` 5.5 does not implement the kitty keyboard protocol, so the agent never negotiates CSI-u mode; the `\x1b[13;2u` form would arrive as literal text in the prompt. `ESC CR` is the portable Meta+Enter form Claude Code reads as "insert newline."
- **Why the meta (ESC-prefixed) word forms.** `\eb`/`\ef`/`\e\x7f` are bound by default in stock bash `readline` **and** understood by Claude Code without any `inputrc` configuration; the CSI modifier forms (`\e[1;3D`) are not bound by stock readline. Intercepting *before* xterm's defaults is therefore an improvement on Linux (where xterm would emit the unbound CSI form) as well as on macOS (where Option is not Meta unless `macOptionIsMeta` is set — we avoid relying on that platform flag).
- **Chords that also hold Ctrl or Meta are not hijacked** — they pass through to the agent/TUI.
- **One handler.** xterm permits a single `attachCustomKeyEventHandler`; the keymap shares it with the §7.5.1 Escape rule (Escape is resolved first, then `handleTerminalKey` sends the mapped bytes via the §6 input path and suppresses xterm's default, also calling `preventDefault` so the hidden textarea doesn't double-edit).

### 7.6 Design decisions

- **xterm's native selection is the highlight; the model holds the text.** The text is extracted at gesture time and is what Copy reads (§7.3). The native highlight survives focus changes in the pinned xterm (§7.1).
- **Empty `onSelectionChange` events clear the model.** They are xterm clearing its own selection (typing, a click, a buffer switch); the model follows so Escape passes through to the agent whenever no selection is visible (§7.5.1).
- **No app-drawn selection decorations** (removed v2.150). The per-row decorations re-created a marker per row on every scroll and leaked them (§7.4 marker hygiene).
- **Trim trailing whitespace, drop one trailing newline** before sending or capturing — avoids stray padding and prevents auto-submitting the command.
- **Send as a paste, honoring bracketed-paste mode.** Required for multi-line selections to land correctly in Claude Code/Codex/REPLs instead of part-executing. We never force the mode on or off; we honor the running app's choice (with `ignoreBracketedPasteMode` as a manual override).
- **Capture and send are independent, non-destructive actions** on the same selection. Capture is the manual stand-in for the future semantic capture pipeline; it exercises the identical `monitor:capture → monitor:event` plumbing.

### 7.7 Cross-platform keymap (clipboard + editing, profile-driven & rebindable) (added v2.72)

The §7.5.2 chords generalize into a **data-driven keymap**: a profile maps each logical **action** to one or more **chords**, the renderer resolves a key event to an action and runs it. The model is pure and OS-agnostic (`src/shared/keymap.ts`): `KeyActionId` (the terminal actions `copy`, `paste`, `selectAll`, `newlineNoSubmit`, `wordBack`, `wordForward`, `deleteWordBack`, `deleteLine`, plus the §24.1C app-navigation actions `toggleDrawer`, `viewTerminal`, `viewArtifacts`, `openSettings` — see the App-navigation note below), `Chord {key, ctrl?, alt?, shift?, meta?}`, `Keymap = Record<KeyActionId, Chord[]>`; `matchChord(event, keymap)` → action id or `null`, `resolveKeymap(base, overrides)`, `eventToChord(event)` (rebinding capture), and `BYTES_FOR` (the §7.5.2 motion bytes — the bytes are still the contract). Clipboard actions are **side effects**, not bytes.

- **Interrupt is intentionally unbound.** `Ctrl+C` matches no action, so it passes straight through to the PTY as SIGINT; plain `Enter` likewise submits. Copy is *only ever* the profile/override chord — never a "smart Ctrl+C."
- **Two built-in profiles.** `MAC_DEFAULTS` (Cmd-based: `⌘C`/`⌘V`/`⌘A`) and `PC_DEFAULTS` (`Ctrl+Shift+C`/`V`/`A`, the ~20-year Linux/GNOME convention). The editing motions are identical in both (they key off Option/Alt, which the DOM reports the same on every OS).
- **Profile resolution + override.** `UiSettings.keymapProfile` (`auto`|`mac`|`pc`; `auto` → `mac` on `darwin` else `pc`) — a user override is mandatory because the OS and the desired layout can disagree (a Mac keyboard on Linux). The renderer resolves via `window.term.platform`; `keymapController` (`src/renderer/src/keymapController.ts`) holds the active keymap and is read **live per keydown** by the §7.5 dispatch, so a switch needs no rewire. `UiSettings.keymapOverrides` (per-action chords, omitted when none) merge over the profile.
- **Copy / paste / select-all wiring.** Copy writes the **app-owned selection** (§7), not xterm's hidden native one, to the OS clipboard. Paste reads the OS clipboard and goes through `term.paste(stripPasteBreakout(…))` so the **§9.3 breakout sanitization always runs** — the browser/xterm *native* paste bypasses it, so our handler `preventDefault`s and owns the path. Select-all calls `term.selectAll()`, which feeds the model via the existing `onSelectionChange` listener (so the highlight and Copy reflect it). The clipboard is an OS resource owned by **main** (the sandboxed preload cannot import electron's `clipboard`), routed via `term:clipboardWrite` / `term:clipboardRead`; `window.term.platform` exposes the OS for `auto` resolution.
- **Keyboard settings UI.** `src/renderer/src/keyboardSettings.ts` (a relocatable organism) is a dedicated **Settings view** (shell view 4), reached from the rail gear and the `openSettings` chord (**⌘0** / **Ctrl+0**) — not the rail foot. It renders the **Auto/macOS/PC** profile control plus per-action rows grouped by category (Clipboard / Editing / Navigation), each chord drawn as **keycaps** (`chordToCaps`). **Set** captures the next keypress (`eventToChord`, ignoring modifier-only presses); a combination already bound elsewhere is **blocked and named** (`findChordOwner`), keeping the old binding; an overridden row offers **Reset** (`keymapController.clearOverride`, restoring the profile default).
- **App-navigation actions (§24.1C).** The shell shortcuts are part of the same keymap (so they are profile-aware and rebindable): `toggleDrawer`, `viewTerminal`, `viewArtifacts`, `openSettings`. The Quick-send drawer is **⌘9 / Ctrl+9** and Settings is **⌘0 / Ctrl+0** (digit chords never collide with a readline chord, so bare Ctrl+K stays kill-line); views are ⌘1/2 / Ctrl+1/2 (the `viewTodos`/⌘3 chord was removed with the Todos view, v2.132; the ⌘K / Ctrl+Shift+K drawer chord and the ⌘, / Ctrl+, Settings chord were retired for the digit set). `shell.ts` matches these via the shared keymap; the terminal dispatch ignores them (no `BYTES_FOR`, so they pass through), and the shell's capture-phase handler claims them first.
- **macOS Edit menu.** Because macOS routes ⌘C/⌘V/⌘A through the application menu (and the default Edit roles act on xterm's *hidden native* selection), on darwin `src/main/appMenu.ts` installs a menu whose Copy/Paste/Select All `click` to the renderer (`menu:edit`); `src/renderer/src/menuActions.ts` routes each to the **terminal** clipboard action when the terminal is focused, else the focused input's native editing (so text fields keep ⌘C/⌘V/⌘A). Off darwin the renderer keymap owns the copy/paste and app-nav chords, so no Edit routing is needed — but a **minimal** menu (a View submenu with keyboard zoom and fullscreen, and no ⌘0/Ctrl+0 accelerator) is still installed to **replace** Electron's default menu, whose View→Reset-Zoom binds ⌘0 and would preempt the openSettings chord (§7.7). Keeping the zoom items preserves keyboard text-resize (WCAG 1.4.4) that clearing the menu outright would drop.

### 7.6.1 (note) §7.5.2 is the motion subset

The §7.5.2 table is now the editing-motion subset of §7.7; the same `attachCustomKeyEventHandler` resolves Escape (§7.5.1) first, then dispatches the active keymap.

### 7.8 Dropping files onto the terminal (added v2.85)

A file dragged from the OS onto the terminal pane **pastes its path at the prompt**, so an agent that consumes a file by path (e.g. dragging an image into Claude Code) gets it the way a native terminal would. xterm does not handle file drops; the pane wires its own `dragenter`/`dragover`/`dragleave`/`drop` handlers (`wireTerminalDrop` in `terminal.ts`, a disposer-returning organism helper alongside the §7.1 listener wiring).

- **Path resolution.** `File.path` is gone under `contextIsolation`, so the renderer resolves a dropped `File` to its absolute path through the preload `webUtils.getPathForFile` bridge (`window.term.pathForFile`, §6). A drag item with no filesystem path (dragged web text/URL) resolves to `''` and is skipped.
- **What lands at the prompt.** Every dropped **file** (any type, not image-only) contributes its path; the paths are **single-quoted** (POSIX `'\''` escaping, so spaces survive) and **space-joined**. The text is inserted via the **same §7.5/§9.3 sanitized paste seam** as the Paste chord and Copy/Paste — `term.paste(stripPasteBreakout(…))`, which honors the foreground app's bracketed-paste mode and strips an `ESC[201~` breakout (a hostile filename cannot inject one). **No submit**: nothing appends a CR — and because a POSIX filename may legally contain `\r`/`\n` (which `term.paste` would normalize to a submitting CR when bracketed-paste is off), **all C0 control chars are stripped from each path** before quoting, so a crafted filename cannot submit a line. The user adds a message and presses Enter.
- **Affordance.** While a file drag is over the pane, the terminal shows a drop-target outline (a `drag-over` class, themed via `tokens`/`--signal`); a depth counter over `dragenter`/`dragleave` keeps it stable across the pane's nested xterm elements, and `dragover` is `preventDefault`ed so the pane is a valid drop target (otherwise the webview would navigate to the file).
- **Scope.** Files only — dragged text, URLs, and directories are out of scope this phase. The handler lives in the terminal pane and touches nothing else; **no IPC channel** is added (`webUtils` runs in-process in the preload — `pathForFile` is a bridge method on the existing `term` namespace).
- **RED-first.** DOM unit tests fire `drop`/`dragenter`/`dragleave` on the host and pin the paste text (single-quoting, multi-file join, empty-path skip, `ESC[201~` strip, affordance toggle, disposer teardown); a preload unit pins `pathForFile` delegating to `webUtils.getPathForFile`; full-loop e2e drive a real native `drop` (a `File` obtained via a hidden `<input>` so the bridge resolves a real OS path) and assert the single-quoted path appears at the prompt, plus the drag affordance appears/clears.

---

