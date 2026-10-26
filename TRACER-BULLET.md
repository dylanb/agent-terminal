# TRACER-BULLET.md

The definition of a tracer-bullet slice and the four criteria each must satisfy. `CLAUDE.md` carries the
planning gate; this file is the authority a plan is graded against — cite it (e.g. "TRACER-BULLET.md §
criteria") rather than re-arguing.

A **tracer bullet** is a thin but *complete* vertical slice that passes through **every layer the feature touches** — main-process logic → the typed IPC contract (`src/shared/ipc.ts`, §6) → preload bridge → renderer widget → visible, interactive UI — and does the **smallest real end-to-end thing** with **real backing, not a fixture**. Like a tracer round, you fire it through the running app and watch where it lands: each slice is hand-testable through the UI (`pnpm run dev`) and demoable on its own.

Each slice MUST satisfy all of:

1. **Back-to-front, never layer-by-layer.** A slice spans main, `ipc.ts`, preload, and renderer as far as that increment needs, so it is exercisable from the UI. Building a whole horizontal layer — the complete main-process subsystem, the entire IPC surface, or a data store — as its own phase with nothing in the UI to fire it is **forbidden**. If a slice cannot be fired from the UI, it is cut too wide or wrong; narrow it until it can.
2. **Replaces one mock with real backing, incrementally.** §24.1 stands the widgets up fixture-driven (§24); a slice swaps **one** fixture path for its real subsystem and leaves the app still running and the visible product never regressed.
3. **Ends testable through the UI, RED-first.** Each slice carries the full **Test-driven development** ladder (failing test first, observed), and that ladder MUST include a **Playwright `_electron` e2e that drives the real loop** (real PTY, main, renderer) — because the slice's contract *is* "a user does X in the app and sees Y." Main-process integration tests and renderer DOM unit tests sit underneath it.
4. **Named in the plan.** For every slice the plan states three things: the **user-visible action** that fires the bullet, the **observable result in the UI**, and the **e2e that proves it**. A slice missing any of the three is not yet planned.

**Note — design-system work comes first.** A plan for renderer UI schedules its design-system changes — new or changed tokens in `tokens.css`, new or changed shared atoms and molecules (`UI-STANDARDS.md` §1), and the contrast pairings they introduce — in the earliest slice or slices, so later slices consume the design system rather than introduce styling of their own. A slice whose main content is design-system work is a vertical slice when it applies that work to a surface that already exists, so the change is visible in the running app. Its token and stylesheet content needs no RED test (CLAUDE.md § Test-driven development), but any behaviour the slice adds is still proven RED-first with an `_electron` e2e, as criteria 3–4 require. A slice that adds tokens or shared components that nothing visible uses is still a horizontal layer.

This is the §24 "UI-inwards" build direction applied feature by feature: stand the skin up, then drive real subsystems through it one fireable slice at a time. Horizontal "finish the backend, then wire the UI later" plans are a planning-level defect — reject and re-slice.
