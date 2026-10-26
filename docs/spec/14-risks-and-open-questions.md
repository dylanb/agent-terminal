## 14. Risks and open questions

**Known constraints** — trade-offs the design accepts; each is why some piece of code looks the way it does.

- **Submit timing.** The CR after a paste must arrive after the agent has drained the paste: too early and it is swallowed (worse under load and in CI), too late and the UX lags. Hence a delay that is a setting (`APP_SUBMIT_DELAY_MS`, §9.3), not a constant, and a candidate for per-agent profiles (§13.5).
- **Submit key.** `\r` submits in Claude Code's input box; other agents may want `\n` or need their input box focused first. Another driver for §13.5.
- **Shadow/renderer divergence.** Two VT parsers see the same bytes; at different versions they disagree on edge cases and silently corrupt captures. Hence the exact version pin of `@xterm/headless` to `@xterm/xterm` (§8.2).
- **Resize races during output bursts.** A drag-resize while the agent streams can leave the PTY wrapping at the old width while the renderer and shadow are at the new one. Hence the ~80 ms renderer resize debounce (§7.1) and resizing PTY and shadow together in one handler (§8.2); a residual mismatch heals on the agent's next full repaint.
- **Shadow write asynchrony.** `shadow.write()` parses on a queue; a read that must reflect specific bytes waits for the write callback (§8.2).
- **Heavy redraw rates.** Agents repaint spinners many times a second; the 80 ms settle debounce keeps `monitor:update` quiet, and anything that scans the screen does so on quiescence, never per chunk.
- **Quiescence is a heuristic.** `quiet` means "the visible screen has not changed for `QUIET_MS`", not "awaiting input": an agent thinking or waiting on the network looks quiet, and an idle TUI that repaints a clock never does (§8.3).
- **Escape contention.** Escape both clears a selection and interrupts agents (Claude Code). It is swallowed only when a selection is active (§7.5.1) — a compromise to watch.
- **Decorations are normal-buffer only.** The §16.8 cross-highlight does not draw inside full-screen TUIs until Option B (§13.4). xterm's native selection highlight does draw there.
- **Marker lifetime.** A marker lives until disposed or trimmed from scrollback, and disposing a decoration does not dispose its marker. Every live marker is notified on every trim/insert/delete, so a leaked marker taxes all later output — enough, at one marker per row per scroll, to freeze the renderer under Codex. Every renderer marker is disposed explicitly (§7.4).
- **Capture provenance on a scrolling buffer.** Absolute coordinates shift once scrollback overflows and rows trim, which a noisy agent can cause between a drag and a click. Text is extracted at gesture time and is the durable payload; stored coordinates are best-effort provenance and are never used to re-extract content (§7.3).
- **GUI-launched environment.** An app started from Launchpad or a `.desktop` file inherits a minimal environment, so agent CLIs on nvm/asdf paths may not resolve. macOS is covered by the login shell; on Linux the app probes the user's shell for `PATH` (§5).

---
