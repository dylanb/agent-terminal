## 12. Acceptance criteria

The automated suite (vitest unit/integration/browser and the Playwright `_electron` e2e) is the acceptance record: a criterion that a test proves needs no entry here. This section holds only what the suite cannot observe, so the gap stays visible.

**Recorded gaps.** Behaviour that no layer of the stack can assert — macOS-only window/dock/menu wiring with no Linux e2e, rendering only a human can judge, network calls that are unprovokable without a live PR — is tracked in a GitHub issue (#153) and referenced at the code site by a plain comment. Never a code `TODO`/`FIXME` (CLAUDE.md).

**Verified manually, with a real agent CLI** (`pnpm run dev`):
- The user's own prompt, aliases and functions work, which proves their startup files loaded (§5).
- Full-screen programs (`vim`, `htop`, `less`) render and respond to keys; 256-colour and truecolour output look right.
- Claude Code runs inside the session; a multi-line insert from the monitor lands in its input box as one editable paste, with or without submit, including when the terminal pane is unfocused.
- Quiescence: the indicator shows **working** while Claude Code generates and flips to **quiet** within about a second of it idling at its input box (`QUIET_MS`, §8.3).
- Closing the window kills the shell (no orphaned PTY) and disposes the shadow terminal.

---
