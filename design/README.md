# Design — Agent Terminal UI (Phase 1, spec §24.1)

> **Status (as of 2026-07-30, post-N8):** pre-N8 design study, left standing as history. The `.agent-loop` bridge, the v4 `state.yaml` mirror and the per-LoopDef status/gate mechanics named below in the present tense belong to the **retired** external engine (spec §26); the shipped engine is the in-app §27 loop engine. The design language and surfaces remain current — the engine plumbing they name does not.

UI-inwards build of the flow-management three-view shell. Process: **Mood → Options → Implement** (§24.1A/B/C).

## Status

- **§24.1A Mood — DONE.** Four directions explored in `mood/` (Telemetry, Galley, Schematic, Galley · Lit). Each renders the same five components on one scenario (agent at Review, step 3/4).
- **Chosen direction: `04` Galley · Lit** (`mood/04-galley-lit.html`) — Galley's readable margin-proof model lit by Schematic's live cyan signal on a bright board. Light + dark. Locked 2026-06-16.
- **§24.1B Options — CONVERGED.** Explored three layouts (`shell/console.html`, `shell/cockpit.html`, `shell/reading-room.html`); **reading-room dropped**. The chosen synthesis is **`shell/converged.html`**, from operator feedback:
  - **Slim left chrome** (Console's minimal feel, moved to a ~200px left rail): views nav + vertical flow + compact status + quick-send/theme. Main area is full-bleed.
  - **Docked, non-blurring quick-send drawer** (right): opening it makes the layout *make room* (grid column 0→384px) rather than overlaying a scrim — so the **terminal stays fully visible alongside it**. This is required for **cross-highlight (§16.8)**: hovering a finding in the drawer lights its source line in the terminal (amber reveal), and vice-versa, with both on screen at once. Demo via `?reveal=f1`.
  - Shared widgets via `shell/tokens.css` (§22.4 layout-as-data); ⌘1/2/3 views, ⌘K toggles the drawer. Light + dark (theme set in `<head>` to avoid FOUC).
- **§24.1C Implement — pending** (build `converged.html` as the real app UI, both themes, RED-first).

## Design tokens — `src/renderer/src/tokens.css`

`src/renderer/src/tokens.css` is the source of truth for the app's design tokens. Both the agent-terminal window (`src/renderer/index.html`) and the controller window (`src/renderer/controller.html`) link it before `styles.css`, and no other renderer stylesheet defines a colour token. Each token is set on `:root` (light) and overridden under `[data-theme="dark"]`. `design/shell/tokens.css` is a historical copy kept for the mockups in `shell/`; it is not the app's palette and has drifted from it.

Token roles:

- **Surface:** `--bg`, `--card`, `--hair`, `--hair2` (and the palette names they alias: `--board`, `--leaf`, `--rule`, `--rule-soft`).
- **Text and dim:** `--text`, `--dim` (`--ink`, `--muted`).
- **Accents and their `-text` pairs:** `--signal`, `--attn`, `--pass` paint dots, borders and washes; `--signal-text`, `--attn-text`, `--pass-text` are the tones that clear 4.5:1 as small text on `--card`. `--danger` / `--danger-on` are the destructive-action text and the foreground on its fill.
- **Washes:** `--signal-wash`, `--reveal` / `--reveal-wash` (the §16.8 cross-highlight), `--changed` / `--changed-wash` (code-viewer changed lines).
- **Terminal:** `--term-bg`, `--term-text`, `--term-dim`.
- **Syntax:** `--syn-*`, the code-viewer palette (§20.2).
- **Status:** the controller's pane-status tokens, below.
- **Non-colour:** `--focus-ring-w`, `--focus-ring-offset`, `--focus-ring-extent`, `--r`.

### Controller status tokens

Each pane status has an accent `--status-<status>` (dots, card accents, rings), a text colour `--status-<status>-text` and a tint `--status-<status>-tint` (card and attention-box backgrounds). Error and needs-human cards also have a border, `--status-error-border` and `--status-needs-human-border`.

| Status | Accent | Text | Tint | Border |
| --- | --- | --- | --- | --- |
| error | `var(--attn)` | `var(--danger)` | own value | own value |
| needs-human | amber, own value | amber, own value | own value | own value |
| working | `var(--signal)` | `var(--signal-text)` | own value | — |
| completed | `var(--pass)` | `var(--pass-text)` | own value | — |
| idle (idle and unassigned) | `var(--dim)` | `var(--dim)` | `var(--hair2)` | — |

The needs-human tokens are defined on their own, never by reference to `--reveal` / `--reveal-wash`, so changing the cross-highlight never changes them and the reverse. In both themes each status text clears 4.5:1 on `--card` and on its painted tint (WCAG 2.2 SC 1.4.3), and each accent clears 3:1 on `--card` (SC 1.4.11); `tests/browser/tokenSheet.test.ts` checks this in Chromium.

### Colour rule

- **Controller status colours:** blue for working, red for errors and action, amber for needs a human, green for completed; everything else is quiet.
- **Agent-terminal window:** saturated colour is spent on **signal** (blue) and **act** (red), and needs a human is shown in red (the §24.2.3 T0 status-pill and status-bar decisions below).

## Galley · Lit — token system

- **Palette (light):** board `#FBFCFE` · leaf `#FFFFFF` · ink `#11161D` · muted `#5E6B7A` · **signal (cyan) `#0098DB`** · **act (red) `#E5484D`** · pass `#1F9D6B`.
- **Palette (dark):** board `#0E141B` · surface `#161E27` · rule `#26313C` · text `#E8EEF4` · muted `#8FA0B2` · signal `#22C7FF` · act `#FF6168` · pass `#3DDC97`.
- **Type:** display **Fraunces**, body **IBM Plex Sans**, data **IBM Plex Mono**.
- **Rule:** saturated color is spent on two things only — **signal** (cyan = where the work is / provenance link, at flow scale and line scale, §16.8) and **act** (red = request changes). Everything else is quiet ink on a bright board.

## §24.2.3 T0 — loop-step / gate surfaces (design-only)

Design study for the next phase (loop steps + the agent-loop bridge + gates), built on the converged shell + `tokens.css`. **`shell/loop-flow.html`** — five new surfaces, light + dark, Galley · Lit. Open it and try `?prompt=1` (input modal), `?gate=intermediate`, `?view=3`, `?theme=dark`; click the rail **Loop** row for the detail popout; click **Request changes** for the composer. Grounded in the real v4 `state.yaml` (`{status, iteration, pr, branch}`) and the per-LoopDef gate (`human_options: [approve, request-changes, impasse]`).

**Mockup-gap decisions taken** (the states the converged mockup didn't cover):
1. **Loop-vs-manual station** — loop steps carry a **bespoke SVG mark** (`#loop-orbit`: a node orbiting a centre point — *iteration*, deliberately not recycle's triangular arrows or redo's single curved arrow) after the name; manual steps carry none. Inherits the station colour via `currentColor` (dim → cyan when active). *(Open: orbit vs a ring treatment.)*
2. **Generic status pill** — `status` is per-LoopDef and unbounded, so it is *never* enumerated: the bridge maps any status onto one of three tones — `await` = act/red, `work` = signal/cyan, `settle` = pass/green (`.spill` widget). New status strings need no design change.
3. **Loop read-out → full-height docked panel** — the slim rail shows only `status pill · iter N`; clicking the **Loop** row opens a **full-height, non-floating** panel (it "makes room" via the grid like the right quick-send drawer, internally scrollable so it never truncates). The panel houses the **loop state mirror AND the gate together** (status/iteration/pr/branch + extensible footer, then the gate). This both answers "lots of loop info, little rail space" and fixes the gate being stranded/undiscoverable in View 3 — the gate is now reachable straight from the rail and the banner. View 3 becomes Todos-only with a pointer to the panel.
4. **Status bar** — an always-visible bar pinned atop the active view, carrying the work title, engine activity, and a red attention action while the loop needs a human. The attention action opens the loop panel and is not dismissable; it clears with the human-needed state. The OS notification remains a separate unfocused-window cue.
5. **Typed-input prompt** — a centered **modal** (the one deliberate blocking surface; reuses the `.scrim` token) with a per-type field labelled by its input type (`github-ticket`), helper naming the bootstrap it runs (§18.3).
6. **Gate panel** — lives **inside the docked loop panel** (decision 3), under the state mirror. Buttons render exactly the gate's `human_options` (data-driven). Approve-advances-flow vs approve-continues-loop is expressed in the **design language, not invented chrome**: green `pass` = the approve verdict in both; **cyan `signal` = flow motion**, so a *terminal* gate shows a cyan `→ advances flow to Ship` chip (echoing the rail lighting the next station) and an *intermediate* gate shows a muted "loop continues" instead (`?gate=intermediate`). The Approve button and its cyan consequence chip are **one bundled `.gate-action` unit** (so they stay co-located at any width and the chip never visually attaches to a neighbouring button), and the chip text joins the button's **accessible name via `aria-labelledby`** (the button references its own id + the chip's name span → name = "Approve & advance flow to Ship"; the decorative `→` is `aria-hidden`). Request-changes reveals an inline composer (curate notes + free text + Compose-with-agent / Submit-as-is); impasse injects `/agent-loop-impasse` and keeps the flow on the step. **Spec note:** §24.2.3 T5/T6 say the gate lives "in the View-3 gate pane" — this T0 study relocates it to the docked panel; update those slices' *where* when they're built.

**Open for confirmation:** the `↻` loop glyph vs a ring treatment; whether the input modal should be avoidable (inline fallback) for keyboard-only flows; exact OS-notification trigger policy (always vs unfocused-only).

### Reconcile against the shipped S5 (T0 done — spec v2.66)

S5 landed (`flow:onStateChanged` + the pure `deriveFlowView` → `FlowDerived {activity, todosDone, todosTotal, ready}`). Read against these mockups, the design holds; four rulings carry into T1/T2:

1. **The live-push seam is real and reusable.** `flow:onStateChanged` exists exactly as the plan assumed — the loop-state mirror rides it; **no new push plumbing** in T2.
2. **`loop?` rides parallel to `derived?`, not nested.** S5 gates `derived` to `in_progress` only; loop state outlives that window (it sits in `awaiting-*` states that aren't the manual lifecycle), so the v4 mirror is a **separate `loop?` field on `FlowStateView`**.
3. **The 3-tone status pill is loop `status`, not agent `activity`.** S5's `activity` is **binary** (`active`/`quiet`); the mockup's `.spill` await/work/settle pill maps to the per-LoopDef **`status`** string (T2, from `state.yaml`). The mockup had conflated two distinct signals — keep them separate.
4. **`severity` / `openFindings` / `lastVerdict` are kept as design slots** (operator decision — the information genuinely exists, in per-iteration review artifacts, just not in `state.yaml` v4). They stay in the mockup; their live backing becomes an **agent-loop exposure requirement surfaced during T2** (aggregate from artifacts, or extend the schema/engine to record `lastVerdict`). Until wired they render empty/placeholder — shown as design intent, never invented data.

The three "open for confirmation" items above remain open; T0 is otherwise done and unblocks T1.

## Viewing

Open `mood/index.html` in a browser. Light/dark toggle is top-right on every page. The §24.2.3 study is `shell/loop-flow.html`.
