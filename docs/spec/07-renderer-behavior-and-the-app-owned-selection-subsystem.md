## 7. Renderer behavior and the app-owned selection subsystem

### 7.0 Why a custom selection mechanism

xterm.js's built-in selection is the browser's native selection: it is tied to DOM focus and is cleared whenever focus moves elsewhere or the user clicks another element. For this app the selection must instead be a **first-class application state** that:

- **survives focus changes** — clicking the Send/Capture buttons, typing in the terminal, or clicking into the monitor pane must not erase it;
- is **owned, rendered, and cleared by the app**, so it can later be created/inspected/manipulated programmatically (e.g. the monitor pane highlighting the region a capture came from), not just by mouse;
- can outlive any single gesture and, eventually, allow more than one persistent highlight.

The mechanism below delivers this. It keeps an app-owned model in buffer coordinates and **renders the persistent highlight itself** using xterm.js decorations. xterm's native selection highlight is **left on while the terminal is focused** — it paints the live drag per-frame, the one thing the disposed-and-recreated decoration cannot do mid-gesture — and is **suppressed only on blur** (`selectionInactiveBackground` transparent), so off-focus the decoration is the sole highlight and the two never double-tint (§7.1). The drag *gesture* is still detected through xterm (so we inherit its correct cell hit-testing and wrapped-line handling), but the *selection state* is entirely ours and is never auto-cleared on blur.

> **Recommended (Option A — below):** app-owned model + decoration rendering, gesture sourced from xterm. Lowest risk, reuses xterm's hit-testing.
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
  allowProposedApi: true,                 // buffer/marker/decoration access
  theme: {
    // Focused selection paints the live drag (xterm's per-frame hit-testing); blurred selection
    // is transparent so the persistent app-owned decoration is the sole off-focus highlight (§7.1).
    selectionBackground: SEL_COLOR,                  // shared with the decoration, exported by §7.4
    selectionInactiveBackground: 'rgba(0,0,0,0)',
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
  decorations: [], // IDecoration[] currently drawn
};
```

### 7.3 Capturing the gesture (focus-independent)

We drive the model from xterm's drag, but we deliberately **ignore the "selection cleared" signal** that fires on blur — that is exactly the browser-focus coupling we are removing. Only a non-empty selection updates the model; clearing is explicit (§7.5.1).

```js
term.onSelectionChange(() => {
  let range, text;
  try {
    range = term.getSelectionPosition();       // IBufferRange | undefined (absolute buffer coords)
    text  = term.getSelection();
  } catch {
    return;   // alt-buffer / mid-swap extraction edge cases must never crash the renderer
  }
  if (!range || text.length === 0) return;     // IGNORE blur-clears: focus independence

  selection.active = true;
  selection.start = { x: range.start.x, y: range.start.y };
  selection.end   = { x: range.end.x,   y: range.end.y };
  selection.text  = text;                              // extracted NOW — the durable payload
  selection.baseY = term.buffer.active.baseY;          // coordinate-era stamp
  selection.bufferType = term.buffer.active.type;      // 'normal' | 'alternate'
  renderSelection();                           // re-draw our own highlight live during drag
});
```

> **Verify on integration:** confirm whether `getSelectionPosition()` returns *absolute* buffer rows (including scrollback) or viewport-relative rows in your pinned xterm.js version, and convert once in this function if needed. Everything downstream assumes absolute rows. Also verify that `getSelection()` / `getSelectionPosition()` behave sanely on the **alternate buffer** and across a normal↔alt swap mid-gesture — historical xterm.js versions have had surprises here; the `try/catch` above is the backstop, not the plan.

> **Coordinate drift under output bursts:** absolute rows are stable only until scrollback overflows — once rows trim off the top (a noisy agent can do this *between* the drag and a later Send/Capture click, or even mid-drag), every stored index points at different content. This is why the model treats the **text extracted at gesture time** as the durable payload — coordinates are never used to re-extract text at click time — and stamps `baseY`/`bufferType` so consumers can tell which coordinate era a range belongs to. (The rendered highlight is unaffected: decorations are marker-anchored and move with their lines, dying naturally when trimmed — §7.4.)

### 7.4 Rendering the highlight (our own, persistent)

Render the selection as xterm.js **decorations** — one per line (not one tall decoration; multi-row backgrounds render incorrectly, xterm.js #4855). A decoration is anchored to a `marker` (a buffer line that scrolls with content), so the highlight stays glued to the right text as output scrolls, and persists across focus changes because it is part of the terminal's render layer, not the DOM selection.

```js
const SEL_COLOR = 'rgba(80, 140, 255, 0.35)';  // translucent so text stays legible

function clearDecorations() {
  for (const d of selection.decorations) d.dispose();
  selection.decorations = [];
}

// Convert an absolute buffer row to a marker at that row.
function markerAtRow(absRow) {
  const buf = term.buffer.active;
  const cursorAbs = buf.baseY + buf.cursorY;
  return term.registerMarker(absRow - cursorAbs);   // offset relative to cursor row
}

function renderSelection() {
  clearDecorations();
  if (!selection.active) return;

  const cols = term.cols;
  const { start, end } = selection;

  for (let row = start.y; row <= end.y; row++) {
    const x     = row === start.y ? start.x : 0;
    const xEnd  = row === end.y   ? end.x   : cols;
    const width = Math.max(1, xEnd - x);

    const marker = markerAtRow(row);
    if (!marker) continue;                         // off-buffer / trimmed
    const deco = term.registerDecoration({ marker, x, width, height: 1 });
    if (!deco) continue;                           // undefined on ALT buffer — see caveat
    deco.onRender((el) => { el.style.backgroundColor = SEL_COLOR; });
    selection.decorations.push(deco);
  }
}

// Re-anchor highlight when the user scrolls the viewport.
term.onScroll(() => renderSelection());
```

> **Alt-buffer caveat:** `registerDecoration()` / `registerMarker()` return `undefined` while the **alternate screen buffer** is active. Full-screen TUI agents (Claude Code 2.x, Codex, vim/htop) run there: the drag still populates the model and **select / capture / copy still work** via xterm's native selection (`getSelectionPosition()` returns a valid range and `getSelection()` the text on the alt buffer in the pinned 5.5.0 — text extraction needs no decorations), but the app-owned **persistent** highlight and the **cross-highlight reveal** won't draw until Option B (§11). The monitor pane's `altScreen` indicator (§9) tells the user which regime they're in.

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
// Explicit clear — the ONLY way the selection goes away.
function clearSelection() {
  selection.active = false;
  selection.start = selection.end = null;
  selection.text = '';
  clearDecorations();
  term.clearSelection();          // also drop xterm's native selection (visible while focused, §7.1)
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

- **The model — not the DOM — is the source of truth.** This is what makes the selection independent of browser focus. Native xterm selection paints only the live drag (focused) and is suppressed on blur; it is **never read at send time** — the model is (§7.1).
- **Ignore empty `onSelectionChange` events.** They are the blur-clears we are decoupling from. A new non-empty drag replaces the model; only §7.5.1 clears it.
- **Per-line, height-1 decorations** styled via `onRender` with an `rgba` tint. Avoids the multi-row-background bug and keeps underlying text legible. (`IDecorationOptions.backgroundColor` only accepts opaque `#RRGGBB`, so translucency is applied on the element instead.)
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
- **macOS Edit menu.** Because macOS routes ⌘C/⌘V/⌘A through the application menu (and the default Edit roles act on xterm's *hidden native* selection), on darwin `src/main/appMenu.ts` installs a menu whose Copy/Paste/Select All `click` to the renderer (`menu:edit`); `src/renderer/src/menuActions.ts` routes each to the **terminal** clipboard action when the terminal is focused, else the focused input's native editing (so text fields keep ⌘C/⌘V/⌘A). Off darwin no menu is installed and the renderer keymap owns the chords.

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

