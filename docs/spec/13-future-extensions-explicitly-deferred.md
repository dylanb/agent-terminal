## 13. Future extensions (explicitly deferred)

These shape choices above (the shadow model, the event schema, the `sessionId` field, main-process injection) but are not built now:

1. **Semantic capture pipeline.** Replace/augment manual capture with shadow-side detection: recognize agent questions, permission prompts, tool-use blocks, diffs, and completion summaries, and emit them as typed `monitor:event`s (`type: 'agent-question'`, etc.). Likely per-agent adapters (Claude Code's transcript layout differs from Codex's TUI) plus generic heuristics (stable top/bottom rows = status), triggered by the `active → quiet` transition the §8.3 quiescence detector already emits — including its screen-stability refinement if no-op repaints prove noisy. The §8.4 event schema is designed to absorb this. **Requirements now drafted in §15** (together with command-output capture).
2. **Richer monitor UI / out-of-process pane.** Move the monitor pane to a `WebContentsView` or separate web app; add structured rendering of typed events (answer buttons for agent questions, diff viewers, approve/deny actions). The §9.1 rule means this is a relocation, not a rewrite.
3. **Multiple agent sessions.** A `SessionManager` in main owning N (pty + shadow) pairs; the `sessionId` already in every payload becomes meaningful; the monitor pane grows a session list.
4. **Option B — full pointer-capture selection (alt-buffer + multi-select).** A transparent overlay above the terminal captures pointer events directly, maps pixels to cells, and maintains its own drag state. Required to *highlight* selections on the alternate screen buffer (Codex TUI, vim) and to support multiple simultaneous highlights. The §7 model/text/clear contract stays the same; only gesture capture and rendering change, so Option A code ports forward. **Priority raised** vs. v1.2: alt-screen agents are now a primary workload, not an edge case.
5. **Per-agent submit profiles.** Codify how each agent CLI accepts injected input and submission (paste-then-CR timing, multi-line semantics, interrupt keys) as small adapter configs consumed by the §9.3 injector.
6. **Capture persistence and export.**

> **v2.27:** items 2 (richer monitor UI / out-of-process pane) and 3 (multiple sessions) are now subsumed by the **task-flow management** phase — see **§17–§24**. That phase reuses §13's seams (shadow model, event schema, `sessionId`, main-process injection, the §9.1 relocation rule) rather than discarding them.

---

