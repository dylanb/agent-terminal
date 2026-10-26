## 9. The monitor pane (second UI)

The monitor pane is where the application surfaces what the agent is doing and offers actions on it. It is a **shared-renderer DOM component** — "second UI" names its role, not a process boundary. Its isolation is architectural: every interaction is mediated by the main process (§9.1), which is what makes a later move to a separate process (§13.2) a relocation rather than a rewrite.

### 9.1 Architectural rule

The monitor pane **talks only to main-process APIs** (`window.monitor.*` — §6). It never reads the renderer xterm, the selection model, or any terminal-pane state directly, even though they share a document. This keeps it relocatable to a `WebContentsView` or separate web app with zero contract change.

### 9.2 Skeleton UI

The pane is the tabbed action window of §16 (Capture and Todo); the session status lives on the status strip (§22).

### 9.3 The main-process injection API

The single injection point for everything that doesn't go through the renderer's xterm (`src/main/inject.ts`).

- **Mode is read at injection time from the shadow** — the same "never cache it" rule as the renderer path (§7.5), satisfied without the renderer.
- **Sanitization is not optional.** Captured text comes from agent output and could contain `ESC[201~`; stripping it is the paste-breakout guard, applied here and in the renderer path.
- **Submit is `\r` after a settle delay**, not embedded in the paste. Inside bracketed-paste markers a trailing newline is *content*, not submission, so the CR must arrive after the end marker — and the agent needs a beat to process the paste first. If the CR lands while the agent is still draining the paste, the submission is silently swallowed. That race is real on loaded machines and in CI, which is why the delay is a setting (`APP_SUBMIT_DELAY_MS`, default 50 ms) rather than a constant.
- **`submit: false` is the default.** Nothing runs without an explicit user choice; "Insert & submit" is the separate, deliberately labeled action.

---
