## 13. Future extensions (explicitly deferred)

Not built. The numbering is stable because code and other sections cite it.

4. **Option B — full pointer-capture selection (alt-buffer + multi-select).** A transparent overlay above the terminal captures pointer events, maps pixels to cells and keeps its own drag state. It is the only way to *draw* app-owned highlights (the §16.8 cross-highlight) on the alternate screen buffer, where full-screen agents (Claude Code, Codex TUI, vim) live, and to show several highlights at once. Text capture on the alt buffer already works without it (§21.1); only the drawing is missing. The §7 model/text/clear contract would not change — only gesture capture and rendering.
5. **Per-agent submit profiles.** How each agent CLI accepts injected input — paste-then-CR timing, multi-line semantics, the submit key, interrupt keys — as small adapter configs consumed by the §9.3 injector. Today one `SUBMIT_DELAY_MS` and `\r` serve every agent.
6. **Capture persistence and export.** Captures live in one in-memory slot (§21.1); todos and UI preferences persist (§16), captures do not.

---
