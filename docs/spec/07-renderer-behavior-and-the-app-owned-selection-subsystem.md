## 7. Renderer behavior and the app-owned selection subsystem

### 7.0 Why a custom selection mechanism

The selection must behave as **application state** that:

- **survives focus changes** — clicking into the action window or another pane must not erase it;
- is readable by the app as extracted text (Copy, §7.7) and clearable by the app (Escape, §7.5.1);
- never looks cleared while the app still treats it as active, or vice versa.

**xterm's native selection is the only highlight**, painted the same colour focused or blurred. The app keeps a model of the selection's extracted text that **follows xterm's selection**: whatever clears xterm's selection (typing, a click in the terminal, a normal↔alt buffer switch) clears the model too, so Copy and Escape never act on a selection the user can no longer see. The app draws no highlight of its own: an app-drawn decoration layer re-created one marker per selected row on every scroll and never released them, so a long-lived selection under a noisy agent pegged the renderer.

A pointer-capture overlay with its own pixel→cell mapping remains the escape route if the app ever needs multiple simultaneous selections or gestures xterm does not provide.

### 7.1 Base terminal setup

The renderer terminal is sized to whole character cells by `FitAddon`. Window resizes are **debounced 80 ms** before the size goes to main: a drag-resize during an agent output burst can otherwise leave the PTY, renderer, and shadow wrapping lines at different widths (§14).

### 7.2 The selection model

One persistent selection, in absolute buffer coordinates, plus the text extracted at gesture time.

### 7.3 Capturing the gesture (follows xterm's selection)

- **The text is the durable payload; coordinates are provenance.** Absolute rows are stable only until scrollback overflows — a noisy agent can trim rows between the drag and a later action — so text is extracted when the selection changes and never re-extracted from coordinates. The range carries a `baseY`/buffer-type stamp so a consumer can tell which coordinate era it belongs to.
- **An empty selection change clears the model**, because it is xterm clearing its own selection.
- **Extraction failures never crash the renderer.** Alt-buffer and mid-swap extraction edge cases are caught.

### 7.4 The highlight (xterm's native selection)

xterm paints the selection in `SEL_COLOR` (≥3:1 against the terminal background, WCAG 1.4.11) whether or not the terminal is focused, adjusts it as scrollback trims, and draws it on the **alternate buffer** too — so full-screen TUIs (Claude Code 2.x, Codex) get a visible selection.

> **Marker hygiene (the §16.8 reveal, the remaining decoration user):** disposing an `IDecoration` does **not** dispose the marker it was registered on — the marker stays in the buffer, subscribed to trim/insert/delete events, until its line trims out of scrollback. Every marker the renderer registers must be disposed explicitly (disposing the marker disposes its decoration), including markers whose decoration was refused on the alt buffer.

### 7.5 Sending selection as input (bracketed-paste aware)

Text sent to the terminal must behave like a **paste**, not a stream of keystrokes, because the hosted agents (Claude Code, Codex) — and modern bash/zsh — turn on **bracketed paste mode** and rely on it. In that mode the running program asks the terminal to fence pasted text:

```
ESC[200~   <the pasted text>   ESC[201~
```

The program turns the mode on/off with `ESC[?2004h` / `ESC[?2004l`; we never decide it — we honor whatever the foreground app currently wants. With the markers, the app inserts a multi-line block as one editable unit **without running each line**; without them, a multi-line paste into Claude Code or a REPL gets the first line executed and the rest mangled.

The renderer injects with **`term.paste()`, never a raw write**: it reads the live mode, wraps, normalizes newlines, and its output goes through the same `onData → pty:input` path as keystrokes. Every renderer paste path also strips an embedded `ESC[201~` first, so pasted text cannot break out of paste mode.

> **Why two injection paths exist:** the renderer path uses `term.paste()`. The **monitor pane** (and any programmatic actor) must not depend on the renderer's xterm, so it uses the main-process injection API (§9.3), which reads the same mode from the **shadow** terminal and applies the equivalent sanitization. Both read the mode live; neither caches it.

### 7.5.1 Clear and lifecycle

Escape clears the selection **only when a selection is active**; otherwise it passes through to the PTY. Claude Code and other TUIs bind Escape themselves (interrupt/back), so swallowing it unconditionally would break driving the agent.

### 7.5.2 Agent key bindings

The terminal pane translates editor-style chords into the exact bytes a coding agent's input box (Claude Code) and `readline` expect; the bytes are the contract and live in `BYTES_FOR` (`src/shared/keymap.ts`).

- **Why ESC+CR for newline-without-submit, not CSI-u.** `@xterm/xterm` 5.5 does not implement the kitty keyboard protocol, so the agent never negotiates CSI-u mode and `\x1b[13;2u` would arrive as literal text. `ESC CR` is the portable Meta+Enter form Claude Code reads as "insert newline".
- **Why the meta (ESC-prefixed) word motions.** `\eb`/`\ef`/`\e\x7f` are bound by default in stock bash `readline` **and** understood by Claude Code without any `inputrc`; the CSI modifier forms (`\e[1;3D`) are not bound by stock readline. Intercepting before xterm's defaults also avoids relying on macOS's `macOptionIsMeta`.
- **Chords that also hold Ctrl or Meta are not hijacked** — they pass through to the agent/TUI.
- **One handler.** xterm permits a single `attachCustomKeyEventHandler`, so Escape (§7.5.1) and the keymap share it: Escape is resolved first, then the active keymap.

### 7.7 Cross-platform keymap (clipboard + editing, profile-driven & rebindable)

A profile maps each logical action (clipboard, editing motions, app navigation) to one or more chords; the model is `src/shared/keymap.ts`, and the settings UI is the Settings view.

- **Interrupt is intentionally unbound.** `Ctrl+C` matches no action, so it reaches the PTY as SIGINT; plain `Enter` submits. Copy is only ever the profile/override chord — never a "smart Ctrl+C".
- **Two profiles plus overrides.** A Mac profile (⌘C/⌘V/⌘A) and a PC profile (`Ctrl+Shift+C/V/A`, the long-standing Linux convention); `auto` picks by OS. A user override is mandatory because the OS and the desired layout can disagree (a Mac keyboard on Linux). A chord already bound elsewhere is refused and named rather than silently stolen.
- **The handler owns paste.** The browser/xterm native paste bypasses the `ESC[201~` breakout strip, so the paste chord is intercepted and routed through the sanitized path. Copy writes the app-owned selection, not xterm's hidden native one.
- **The clipboard is owned by main**, because the sandboxed preload cannot import Electron's `clipboard`.
- **App-navigation chords are digits** (⌘9/Ctrl+9 drawer, ⌘0/Ctrl+0 Settings, ⌘1/⌘2 views), because digit chords never collide with readline (bare Ctrl+K stays kill-line).
- **macOS Edit menu.** macOS routes ⌘C/⌘V/⌘A through the application menu, whose default roles act on xterm's hidden native selection, so on darwin the Edit menu forwards to the renderer, which applies the terminal action when the terminal is focused and native editing otherwise. Off darwin a **minimal** menu still replaces Electron's default, whose View→Reset-Zoom binds ⌘0/Ctrl+0 and would preempt the Settings chord; it keeps keyboard zoom, which preserves text resize (WCAG 1.4.4).

### 7.8 Dropping files onto the terminal

A file dragged from the OS onto the terminal pane **pastes its path at the prompt**, as a native terminal would, so an agent that consumes a file by path gets it.

- **Path resolution.** `File.path` is gone under `contextIsolation`, so the preload resolves a dropped file through `webUtils.getPathForFile`. Drag items with no filesystem path are skipped.
- **Safe insertion.** Paths are shell-quoted (`src/shared/shellQuote.ts`), space-joined, and inserted through the same sanitized paste path as the Paste chord. **No submit.** A POSIX filename may legally contain `\r`/`\n`, which `term.paste` would turn into a submitting CR when bracketed paste is off, so all C0 control characters are stripped from each path before quoting — a crafted filename cannot submit a line.
- **Scope.** Files only; dragged text, URLs, and directories are not handled. No IPC channel is involved.

---
