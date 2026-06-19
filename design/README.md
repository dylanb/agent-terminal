# Design — Agent Terminal UI (Phase 1, spec §24.1)

UI-inwards build of the flow-management three-view shell. Process: **Mood → Options → Implement** (§24.1A/B/C).

## Status

- **§24.1A Mood — DONE.** Four directions explored in `mood/` (Telemetry, Galley, Schematic, Galley · Lit). Each renders the same five components on one scenario (agent at Review, step 3/4).
- **Chosen direction: `04` Galley · Lit** (`mood/04-galley-lit.html`) — Galley's readable margin-proof model lit by Schematic's live cyan signal on a bright board. Light + dark. Locked 2026-06-16.
- **§24.1B Options — CONVERGED.** Explored three layouts (`shell/console.html`, `shell/cockpit.html`, `shell/reading-room.html`); **reading-room dropped**. The chosen synthesis is **`shell/converged.html`**, from operator feedback:
  - **Slim left chrome** (Console's minimal feel, moved to a ~200px left rail): views nav + vertical flow + compact status + quick-send/theme. Main area is full-bleed.
  - **Docked, non-blurring quick-send drawer** (right): opening it makes the layout *make room* (grid column 0→384px) rather than overlaying a scrim — so the **terminal stays fully visible alongside it**. This is required for **cross-highlight (§16.8)**: hovering a finding in the drawer lights its source line in the terminal (amber reveal), and vice-versa, with both on screen at once. Demo via `?reveal=f1`.
  - Shared widgets via `shell/tokens.css` (§22.4 layout-as-data); ⌘1/2/3 views, ⌘K toggles the drawer. Light + dark (theme set in `<head>` to avoid FOUC).
- **§24.1C Implement — pending** (build `converged.html` as the real app UI, both themes, RED-first).

## Galley · Lit — token system

- **Palette (light):** board `#FBFCFE` · leaf `#FFFFFF` · ink `#11161D` · muted `#5E6B7A` · **signal (cyan) `#0098DB`** · **act (red) `#E5484D`** · pass `#1F9D6B`.
- **Palette (dark):** board `#0E141B` · surface `#161E27` · rule `#26313C` · text `#E8EEF4` · muted `#8FA0B2` · signal `#22C7FF` · act `#FF6168` · pass `#3DDC97`.
- **Type:** display **Fraunces**, body **IBM Plex Sans**, data **IBM Plex Mono**.
- **Rule:** saturated color is spent on two things only — **signal** (cyan = where the work is / provenance link, at flow scale and line scale, §16.8) and **act** (red = request changes). Everything else is quiet ink on a bright board.

## Viewing

Open `mood/index.html` in a browser. Light/dark toggle is top-right on every page.
