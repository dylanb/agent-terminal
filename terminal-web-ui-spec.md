# Technical Specification — Agent Terminal: Foundation for a Coding-Agent Management Application

**Document status:** Draft v2.138
**Scope:** Foundation / "walking skeleton" build (shipped) + semantic/command capture (shipped, §15–§16) + the **task-flow management** phase (§17–§24): requirements drafted, and **Phase 1 — the three-view UI shell with real cores and fixture-mocked machinery (§24.1) — shipped** + the **in-terminal loop engine**, which is **being replaced, not extended**: **§26 (v2.99, tracer bullets L1–L8) shipped, works, and is RETIRED-BUT-RUNNING**; **§27 (v2.135) is the live design** and is built alongside it. §26 is superseded because its cost and latency are symptoms of machinery the loop does not need. The §27 loop: reviewers are handed **only the ticket and their charter** and pull what they need with tools (so per-round cost never grows with round depth); the **work turn runs once**; **review-and-fix is a single turn** in which the main instance hears its reviewers and fixes what they raise; the **consolidator judges the round** from the last two round reports and picks the next roster; and the same shape runs **groom → plan → impl**, each artifact feeding the next. The two engines **coexist behind one engine-neutral app-side contract** until the **N8 sweep** deletes §26 whole (§27.15)
**Target platforms:** Linux and macOS (Windows out of scope for this version)

---

## Table of contents

- [Changelog](docs/spec/changelog.md)
- [1. Purpose](docs/spec/01-purpose.md)
- [2. Scope](docs/spec/02-scope.md)
- [3. Technology stack](docs/spec/03-technology-stack.md)
- [4. Architecture](docs/spec/04-architecture.md)
- [5. Spawning the shell with the user's configuration](docs/spec/05-spawning-the-shell-with-the-users-configuration.md)
- [6. IPC contract](docs/spec/06-ipc-contract.md)
- [7. Renderer behavior and the app-owned selection subsystem](docs/spec/07-renderer-behavior-and-the-app-owned-selection-subsystem.md)
- [8. The shadow screen model (output tee) — main process](docs/spec/08-the-shadow-screen-model-output-tee-main-process.md)
- [9. The monitor pane (second UI)](docs/spec/09-the-monitor-pane-second-ui.md)
- [10. Project structure](docs/spec/10-project-structure.md)
- [11. Build, run, and packaging](docs/spec/11-build-run-and-packaging.md)
- [12. Acceptance criteria](docs/spec/12-acceptance-criteria.md)
- [13. Future extensions (explicitly deferred)](docs/spec/13-future-extensions-explicitly-deferred.md)
- [14. Risks and open questions](docs/spec/14-risks-and-open-questions.md)
- [15. Next phase — semantic capture & command-output capture (requirements)](docs/spec/15-next-phase-semantic-capture-and-command-output-capture-requirements.md)
- [16. Action window — tabs, todo lists, and layout (v2.7)](docs/spec/16-action-window-tabs-todo-lists-and-layout-v2-7.md)
- [17. Next phase — task-flow management (requirements)](docs/spec/17-next-phase-task-flow-management-requirements.md)
- [18. Flow definitions (`flow.yaml`)](docs/spec/18-flow-definitions-flow-yaml.md)
- [19. Flow progression, gates & feedback](docs/spec/19-flow-progression-gates-and-feedback.md)
- [20. Artifacts & the built-in viewer](docs/spec/20-artifacts-and-the-built-in-viewer.md)
- [21. Manual capture & todo templates](docs/spec/21-manual-capture-and-todo-templates.md)
- [22. UI shell — views, overlay, status strip, layout](docs/spec/22-ui-shell-views-overlay-status-strip-layout.md)
- [23. Multi-instance & epics](docs/spec/23-multi-instance-and-epics.md)
- [24. Build plan — UI-inwards](docs/spec/24-build-plan-ui-inwards.md)
- [25. Flow audit record (per-run, append-only)](docs/spec/25-flow-audit-record-per-run-append-only.md)
- [26. In-terminal loop engine, v2.99 — RETIRED, superseded by §27](docs/spec/26-in-terminal-loop-engine-v2-99-retired-superseded-by-section-27.md)
- [27. In-terminal loop engine — the live design](docs/spec/27-in-terminal-loop-engine-the-live-design.md)
