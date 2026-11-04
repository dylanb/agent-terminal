# Technical Specification — Agent Terminal: Foundation for a Coding-Agent Management Application

**Document status:** Draft v2.227
**Scope:** An Electron app that hosts coding agents in a PTY-attached shell, models the screen in the main process, captures what the agent shows, and runs development work as flows: chains of §27 loops (§28) moving a ticket from groom to plan to implementation. On conflict with §17–§25, §27 wins for the in-app loop.
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
- [12. Acceptance criteria](docs/spec/12-acceptance-criteria.md)
- [13. Future extensions (explicitly deferred)](docs/spec/13-future-extensions-explicitly-deferred.md)
- [14. Risks and open questions](docs/spec/14-risks-and-open-questions.md)
- [15. Semantic capture & command-output capture](docs/spec/15-next-phase-semantic-capture-and-command-output-capture-requirements.md)
- [16. Action window — tabs, todo lists, and layout](docs/spec/16-action-window-tabs-todo-lists-and-layout-v2-7.md)
- [17. Task-flow management](docs/spec/17-next-phase-task-flow-management-requirements.md)
- [18. Flow definitions (`flow.yaml`)](docs/spec/18-flow-definitions-flow-yaml.md)
- [19. Flow progression, gates & feedback](docs/spec/19-flow-progression-gates-and-feedback.md)
- [20. Artifacts & the built-in viewer](docs/spec/20-artifacts-and-the-built-in-viewer.md)
- [21. Manual capture & todo templates](docs/spec/21-manual-capture-and-todo-templates.md)
- [22. UI shell — views, overlay, status strip, layout](docs/spec/22-ui-shell-views-overlay-status-strip-layout.md)
- [23. Multi-instance & epics](docs/spec/23-multi-instance-and-epics.md)
- [24. UI-inwards build and its standing decisions](docs/spec/24-build-plan-ui-inwards.md)
- [25. Flow audit record (per-run, append-only)](docs/spec/25-flow-audit-record-per-run-append-only.md)
- [27. In-terminal loop engine — the live design](docs/spec/27-in-terminal-loop-engine-the-live-design.md)
- [28. The full-TDD development process — a chain of §27 loops](docs/spec/28-the-full-tdd-development-process-a-chain-of-loops.md)
