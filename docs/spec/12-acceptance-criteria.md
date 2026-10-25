## 12. Acceptance criteria

The foundation is "done" when all of the following pass on both Linux and macOS:

> **Verification status (2026-06-12):** a checked box means the criterion is proven by the automated suite (38 vitest unit/integration tests + 8 Playwright `_electron` e2e tests, `tests/e2e/app.spec.ts`) — on **Linux only**; the macOS pass is pending across the board. Unchecked boxes note exactly what remains: most are the agent-in-the-loop criteria, which require a manual session with real Claude Code / an alt-screen TUI via `pnpm run dev`.

**Terminal hosting (unchanged from v1.x)**
- [x] Launching the app opens a window with an interactive shell prompt. *(e2e)*
- [ ] The user's **own** prompt, aliases, and functions work (proves their startup files loaded). *(implemented — no `--rcfile`/`--noprofile`, platform login-shell rules per §5 — but only a manual check in a real user environment proves it)*
- [ ] Typing commands and seeing output works; `vim`/`htop`/`less` render and respond to keys. *(plain commands e2e-verified; full-screen apps manual)*
- [ ] 256-color and truecolor output display correctly. *(terminal identity — `TERM`/`COLORTERM` — e2e-verified; actual color rendering is a manual visual check)*
- [x] Resizing the window reflows the terminal and `tput cols` reports the new width. *(e2e)*

**Selection (unchanged behavior + capture)**
- [x] Dragging to select output shows xterm's native highlight in `SEL_COLOR`; the app draws no decoration of its own (v2.150). *(e2e, including absolute-coordinate placement after 100 lines of scrollback)*
- [x] **Focus independence:** the highlight remains, still visibly painted, after focus moves to the action window. It clears on Escape-with-active-selection and whenever xterm clears its own selection (typing, a click, a buffer switch); Escape then passes through to the agent. *(e2e: drawer-click persistence + Escape-clears + Escape-passthrough; browser test: typing clears → Escape reaches the agent)*
- [x] Trim/newline handling is unit-tested via `cleanSelectionText`. *(The former **Send selection** button was removed in v2.132; a selection is copied via the keymap and re-used through the drawer Todo tab / Artifacts add-to-todo.)*
- [x] Scrolling output under an active selection registers no terminal markers, and a §16.8 reveal releases every marker it drew once its highlight clears. *(browser test against a real xterm, `term.markers`)*

**Agent hosting + monitor loop (new — the product-defining criteria)**
- [ ] Running **Claude Code** (`claude`) inside the session works: it renders correctly, accepts input, and a multi-line insert from the monitor lands as one paste while it runs. *(manual — real agent required)*
- [x] Running an **alt-screen TUI** (Codex TUI, or `htop` as a stand-in) flips the monitor's `altScreen` indicator on, and back off on exit. *(e2e via `ESC[?1049h/l`; spot-check with a real TUI manually)*
- [ ] **Quiescence:** while Claude Code is generating output the monitor shows **working**; within ~1 s of it finishing and idling at its input box the indicator flips to **quiet** (and the quiet-for counter starts); submitting a new message flips it back to **working**. *(mechanism e2e-verified with bash output bursts; the Claude Code-specific behavior and `QUIET_MS` tuning (§14) are manual)*
- [x] **Capture:** the monitor pane's **"Capture last report"** action (§21.1) snapshots the current report + findings; each finding is **Add-to-todo**-able. Works on the alt buffer too (even though the in-terminal highlight may not draw there — known §7.4 limitation). *(The per-selection **Capture selection** button was removed in v2.132; capture-to-todo now lives in the drawer Todo tab and the Artifacts view.)*
- [ ] **Insert into agent:** with Claude Code running, clicking **Insert into agent** on a captured multi-line block places the whole block in Claude Code's input box as one editable unit, **without running anything** — including when the terminal pane is not focused. *(mechanics e2e-verified against bash, including injection with the terminal pane unfocused; the Claude Code input box is manual)*
- [ ] **Insert & submit:** the same block lands and is submitted; Claude Code receives it as a single message. *(same: bash path e2e-verified; Claude Code manual)*
- [x] **Mode honoring:** the same insert against a session with bracketed paste off (plain bash prompt with the mode disabled) arrives as raw input — no stray `ESC[200~` markers visible. *(e2e, both directions: `?2004l` → no markers, `?2004h` → fenced)*
- [x] Injected text containing the literal sequence `ESC[201~` does not break out of paste mode (sanitization works on both paths). *(main path e2e-verified end-to-end; the shared `stripPasteBreakout` guard is unit-tested and applied on both the main `wrapForPaste` and renderer `term.paste()` paths; the Send-button path is e2e-verified)*

**Lifecycle**
- [ ] Exiting the shell (`exit`) shows the exit notice in both panes; closing the window terminates the shell process (no orphaned PTY) and disposes the shadow terminal. *(exit notices in both panes e2e-verified; PTY-kill/shadow-dispose on window close implemented but not asserted by a test)*

---

