## 9. The monitor pane (second UI)

The right-hand pane. In the full product this is where the application surfaces what the agent is doing and offers actions; in the skeleton it is deliberately minimal but **real**: it renders genuinely captured content and its actions genuinely drive the agent.

**Terminology, pinned:** in *this version* the monitor pane is a **shared-renderer DOM component** — "second UI" names its role, not a process boundary. Its isolation is architectural, not physical: every interaction is mediated by the main process (§9.1), which is precisely what makes the later move to a separate process (§13.2) a relocation rather than a rewrite. Wherever this document says "(later) in a different process," it refers to that deferred move.

### 9.1 Architectural rule

The monitor pane **talks only to main-process APIs** (`window.monitor.*` — §6). It never reads the renderer xterm, the selection model, or any terminal-pane state directly, even though they share a document in this version. This keeps it trivially relocatable to a `WebContentsView` / separate web app later — the stated product direction — with zero contract change.

### 9.2 Skeleton UI

- **Status strip:** session alive/exited (the "exited" state is transient — the app terminates on shell exit, §5); **activity indicator** — `working` (output flowing) / `quiet` (no output ≥ 1 s), with a "quiet for _N_ s" counter derived from `quietSince`; `altScreen` indicator ("agent is full-screen"). `bracketedPaste` is not displayed. Driven by `monitor:update`.
- **Captured blocks list:** each `monitor:event` of type `capture` appends a block showing its text (monospace, scrollable if long) and timestamp.
- **Per-block actions:**
  - **Insert into agent** → `monitor.inject({ text, submit: false })` — places the text in the agent's input box as one editable block; nothing runs.
  - **Insert & submit** → `monitor.inject({ text, submit: true })` — same, then submits.
- Layout: terminal pane and monitor pane side by side (CSS flex, terminal keeps whole-cell sizing for `FitAddon`).

**Amended v2.7 (action window — see §16):** the monitor pane is now a **tabbed action window** — a **Capture** tab (the live-detection view above + §15) and a persistent, repo-scoped **Todo** tab (§16.3). Semantic captures (`report`/`finding`) replace their inject buttons with **Add to todo** + **Dismiss**; manual selection capture (§7.5) routes **straight to the Todo list**; command history keeps **Insert / Insert & submit** and gains **Clear commands**. Injection follows the **focus rule** (Insert → terminal, Insert & submit → stays; §16.2). The terminal↔action-window divider is a **resizable splitter** with a globally-persisted ratio (§16.6). **Amended v2.132:** the renderer command-history list and its **Clear commands** action were removed with the `monitor:commands`/`monitor:clearCommands` channels (§15.4/§15.5); the OSC-133 tracker is now main-process-only, and only the report/finding capture and the Todo tab remain in the action window.

### 9.3 The main-process injection API

The single injection point for everything that doesn't go through the renderer's xterm. Reads the live mode from the shadow; mirrors `term.paste()`'s sanitization.

```js
// main process
ipcMain.on('agent:inject', (_e, { sessionId, text, submit }) => injectToAgent(text, { submit }));

function wrapForPaste(text, bracketed) {
  const body = text.replace(/\r?\n/g, '\r')              // newlines -> CR (what a terminal sends)
                   .replace(/\x1b\[201~/g, '');          // strip end-marker (paste-mode breakout guard)
  return bracketed ? `\x1b[200~${body}\x1b[201~` : body;
}

// A setting, not a constant: a hardcoded 50 ms races on loaded machines and in CI (§14).
const SUBMIT_DELAY_MS = Number(process.env.APP_SUBMIT_DELAY_MS) || 50;

function injectToAgent(text, { submit = false } = {}) {
  if (!text) return;
  const bracketed = shadow.modes.bracketedPasteMode;     // LIVE read at injection time — never cached
  ptyProcess.write(wrapForPaste(text, bracketed));
  if (submit) setTimeout(() => ptyProcess.write('\r'), SUBMIT_DELAY_MS);
}
```

**Design decisions**
- **Mode is read at injection time from the shadow** — the same "never cache it" rule as the renderer path (§7.5), satisfied without renderer involvement.
- **Submit is `\r` after a settle delay**, not embedded in the paste. Inside bracketed-paste markers a trailing newline is *content*, not submission; the CR must arrive after the end marker, and agents need a beat to process the paste before receiving it. The race is real: if the agent is still draining the pasted block when the CR lands, the submission is silently swallowed — which is why the delay is **a setting (`APP_SUBMIT_DELAY_MS`) from day one**, not a constant to dig out later when CI flakes. The robust upgrade (deferred, but the seam is here): **echo confirmation** — after writing the paste, watch the shadow model until the pasted text appears on screen (or output activity settles, §8.3) before sending the CR, with the timeout as fallback. Verify against Claude Code and Codex and revisit (§12).
- **`submit: false` is the default posture.** Same philosophy as §7.5: nothing runs without an explicit user choice. "Insert & submit" is the deliberate, separately-labeled action.
- **Sanitization is not optional.** Captured text comes from agent output and could contain `ESC[201~`; stripping it is the breakout guard, in both this helper and `term.paste()`.

---

