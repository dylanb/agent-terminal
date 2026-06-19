# CLAUDE.md

Agent Terminal — Electron app that hosts coding agents (Claude Code, Codex, …) in a PTY-attached bash session, renders it with xterm.js, tees output into a main-process `@xterm/headless` shadow screen model, and provides a monitor pane that captures output and injects input back into the agent.

`terminal-web-ui-spec.md` (v2.54) is the authoritative spec. Every subsystem implements a numbered section of it; when code and spec disagree, the spec wins — or the spec gets a changelog entry. Cite spec sections (e.g. §9.3) in code review discussion rather than re-arguing settled design decisions.

## Commands

```
npm run rebuild     # electron-rebuild -f -w node-pty — REQUIRED after install or Electron bump
npm run dev         # electron-vite dev (renderer HMR)
npm run build       # type-check + electron-vite build
npm test            # vitest: tests/unit + tests/integration
npm run test:e2e    # playwright _electron e2e (requires a display; real PTY)
```

`node-pty` is a native module compiled against Electron's ABI. If main-process startup fails with a NODE_MODULE_VERSION error, run `npm run rebuild`.

## Architecture (orientation only — details in the spec)

- `src/main/` — PTY lifecycle (§5), shadow terminal + quiescence (§8), injection API (§9.3), IPC handlers. node-pty and the shadow live here, never in the renderer.
- `src/preload/` — contextBridge exposing the `term` and `monitor` namespaces (§6). No raw `ipcRenderer` in the renderer.
- `src/renderer/` — terminal pane (xterm + app-owned selection, §7) and monitor pane (§9).
- `src/shared/ipc.ts` — the typed IPC contract. This file is the single source of truth for channel names and payload shapes; main, preload, and renderer all import from it.

## Test-driven development

- **TDD is mandatory for every code change — RED first, no exceptions.** No code gets written without a failing test being written and run first. Write the failing test, run it and observe the failure (the assertion message, not just an exit code), then make it pass with the smallest change that does so, then refactor. This applies to bug fixes (start with a regression test that reproduces the bug), new features (start with a test for the acceptance criterion), refactors of behavior-bearing code (start with a pinning test against the current behavior), and API changes (start by updating the test to the new contract and watching it fail to compile or fail at runtime). Tightening an existing test until it would catch the bug counts as a new test.
  - **Glue and wiring are code.** Button handlers, event subscriptions, IPC wiring, lifecycle hooks — all of it. A passing test for a lower-level helper does **not** license writing the layer above it untested: the failing test must observe the *change's own* behavior at its own observable boundary. If the change wires a button, the RED test clicks the button (e2e or DOM-level); if it subscribes to an event, the RED test fires the event and observes the consequence. "A test exists nearby" is the loophole that produced this rule.
  - **The sole exemption is code that cannot be covered at all.** Claiming it requires, *before any code is written*: (1) an explicit written statement of exactly what cannot be tested and why no layer of the stack (unit, integration, Playwright e2e) can observe it, and (2) a recorded gap — an unchecked §12-style checklist item or `// TODO(owner):` — so the hole is visible, never discovered later. "Untestable" is a design smell, not a license, and "hard/slow to test" (process-table checks, alt-buffer gestures, timing) does not qualify — those get the slow test.
  - Edits with nothing observable to test — comment/doc-only changes, formatting — are outside the rule's scope, but anything that can alter behavior (including renames, config, build files, dependency bumps) is in: if existing tests can't fail when the edit is wrong, write one that can, or invoke the exemption above in writing.
  - Tests written after the implementation are pinning tests, not TDD — they never satisfy this rule for new code. Calling tests "manual verification" or "I'll add tests after" is never acceptable.
- **Tests MUST exercise observable behavior, NOT implementation.** **Treating this as optional is a blocker-level violation.** A test asserts what a caller of the unit-under-test can observe from the outside: return values, thrown errors, bytes written to the PTY, IPC payloads emitted on a contract channel (§6), text read back out of the shadow buffer through its public read path, DOM state the user can see. A test MUST NOT assert: which private method was called, in what order, how many times; the internal data structure shape; the exact escape-sequence parsing steps; the names of intermediate variables; or anything else that a behavior-preserving refactor would legitimately change. **Tests that bind to implementation are worse than no test** — they pass while the system is broken, fail while the system is correct, and convert every refactor into a test rewrite that silently re-encodes the same assumption. The litmus test: *"Could a teammate rewrite this unit's internals from scratch — different functions, different data structures, different control flow — and keep my tests passing as long as the externally-observable behavior is unchanged?"* If no, the test is testing implementation and must be rewritten before merge. Mock-heavy tests, snapshot tests of internal structures, and assertions that re-spell the source code are the common shapes of this violation. Asserting on exact byte sequences is legitimate only where the bytes ARE the contract (e.g. `ESC[200~…ESC[201~` paste framing, `\r` submit — §9.3), not as a transcript of internal calls.
- **Comments carry invariants, not narration — and stay short.** A comment earns its place only by recording *why*: an invariant a reader cannot derive from the code, a non-obvious constraint, or a spec cross-reference (§n). Never narrate *what* the next line does or restate the code in prose. Prefer a precise name, a named test, or a spec citation over a paragraph. Use the fewest words that carry the invariant — one line wherever possible; multi-line only for a genuinely load-bearing contract, and then point at the spec section rather than re-explaining it. Delete any comment a behavior-preserving refactor would invalidate. Always allowed: doc-comments on exported identifiers (1–2 lines) and `// TODO(owner): …` tags.
- **No mocks for the terminal emulator or the PTY.** Integration tests drive the real `@xterm/headless` shadow module with scripted byte streams (it is pure JS and runs under vitest/node). Full-loop behavior (real node-pty, real bash, real renderer) is covered by Playwright `_electron` e2e — never by mocking node-pty. Fake timers/clocks are fine (the quiescence detector takes injectable timers for exactly this); mocking the VT parser is not.

## Tracer-bullet development (mandatory planning requirement)

**Every implementation plan for §24.2 backlog work MUST be decomposed into tracer-bullet slices before any code is written. This is a planning gate: a plan that is not sliced this way is incomplete and implementation does not start.**

A **tracer bullet** is a thin but *complete* vertical slice that passes through **every layer the feature touches** — main-process logic → the typed IPC contract (`src/shared/ipc.ts`, §6) → preload bridge → renderer widget → visible, interactive UI — and does the **smallest real end-to-end thing** with **real backing, not a fixture**. Like a tracer round, you fire it through the running app and watch where it lands: each slice is hand-testable through the UI (`npm run dev`) and demoable on its own.

Each slice MUST satisfy all of:

1. **Back-to-front, never layer-by-layer.** A slice spans main, `ipc.ts`, preload, and renderer as far as that increment needs, so it is exercisable from the UI. Building a whole horizontal layer — the complete main-process subsystem, the entire IPC surface, or a data store — as its own phase with nothing in the UI to fire it is **forbidden**. If a slice cannot be fired from the UI, it is cut too wide or wrong; narrow it until it can.
2. **Replaces one mock with real backing, incrementally.** §24.1 stands the widgets up fixture-driven (§24); a slice swaps **one** fixture path for its real subsystem and leaves the app still running and the visible product never regressed.
3. **Ends testable through the UI, RED-first.** Each slice carries the full **Test-driven development** ladder above (failing test first, observed), and that ladder MUST include a **Playwright `_electron` e2e that drives the real loop** (real PTY, main, renderer) — because the slice's contract *is* "a user does X in the app and sees Y." Main-process integration tests and renderer DOM unit tests sit underneath it.
4. **Named in the plan.** For every slice the plan states three things: the **user-visible action** that fires the bullet, the **observable result in the UI**, and the **e2e that proves it**. A slice missing any of the three is not yet planned.

This is the §24 "UI-inwards" build direction applied feature by feature: stand the skin up, then drive real subsystems through it one fireable slice at a time. Horizontal "finish the backend, then wire the UI later" plans are a planning-level defect — reject and re-slice.

## Code standards

- TypeScript, `strict: true`. No `any` in `src/shared/ipc.ts` — the IPC contract is the part TS exists to protect.
- `@xterm/xterm` and `@xterm/headless` are **pinned to the same exact version** (§8.2): two parsers at different versions silently corrupt captures. Bump them only together.
- Security defaults are non-negotiable: `contextIsolation: true`, `nodeIntegration: false`, paste-breakout sanitization (`ESC[201~` strip) on **both** injection paths (§7.5, §9.3).
- Bracketed-paste mode is read live at injection time (renderer: `term.paste()`; main: `shadow.modes.bracketedPasteMode`) — never cached, never decided by us (§9.3).
- **Renderer UI follows `UI-STANDARDS.md`.** Build atomic (Atoms · Molecules · Organisms), test each component individually (DOM-level unit tests for atoms/molecules; organisms also get e2e + a relocation test proving they move between frames unchanged). Organisms are factories with a typed interface (`createX(host, deps)`), touch only their host subtree, take services injected (never reached for), signal across components through the contract (not DOM reach-across), and theme via `tokens.css` only. This is the §22.4 layout-as-data boundary generalized.
- The monitor pane talks only to `window.monitor.*` (§9.1). It must never import from terminal/selection modules or touch renderer xterm state, even though they share a document — this is what keeps it relocatable to a separate process. It is the canonical example of the `UI-STANDARDS.md` stable-interface rule.
- Timing values are named and configurable where the spec says so: `SUBMIT_DELAY_MS` via `APP_SUBMIT_DELAY_MS`, `QUIET_MS`, the 80 ms resize/settle debounces (§7.1, §8.2, §9.3). No new magic-number sleeps.
- Every IPC payload carries `sessionId` (§6), even while there is only one session.
