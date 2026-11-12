## 24. UI-inwards build and its standing decisions

The app was built **from the skin inwards**: the complete shell (§22) first, every widget present and interactive, then the backing made real slice by slice. Placement-agnostic widgets (§22.4) were therefore enforced from day one, not retrofitted. New flow machinery is still planned as tracer-bullet slices (TRACER-BULLET.md). The build plan itself is in git history; this section keeps the decisions it produced, and the slice labels code still cites.

### 24.1 The shell

- **Colour rule (Galley · Lit).** Saturated colour is spent only on **signal** (cyan — where the work is, the provenance link, §16.8) and **act** (red — needs a human, request changes); everything else is quiet ink. The controller's pane statuses (§23.6) extend it: blue working, red errors and action, amber needs a human, green completed, everything else quiet. All colour comes from the tokens in `src/renderer/src/tokens.css`, which both windows load.
- **Quick-send docks beside the terminal; it never covers it** (§22.2), so the §16.8 cross-highlight can show the capture and its terminal line at once.

#### 24.1A Mood

Galley · Lit: a readable margin-proof look lit by one live signal colour, in light and dark. Type: Fraunces / IBM Plex Sans / IBM Plex Mono.

#### 24.1B Options

The converged layout: a slim left rail (views, flow, compact status, quick-send and theme) with a full-bleed main area and the docked drawer.

#### 24.1C Implement

The frame (`src/renderer/index.html`, `shell.ts`, `crossHighlight.ts`) is organisms per UI-STANDARDS.md. The terminal, capture, todo and artifact-viewer cores were reused behind the skin with their element-id contracts unchanged, so their existing tests kept holding.

### 24.2 Backlog

Open work is tracked in GitHub issues, not here.

#### 24.2.1 Drawer panels

The Todo and Capture panels follow the converged mockup's card language. Their behaviour is specified in §16.2–§16.4.

#### 24.2.2 Manual-step slices

Labels code cites for the manual-step spine (`kind: manual`, §18.2):

- **S1** — the flow state machine: `not_started → in_progress → done`, driven by Start and Advance.
- **S2** — the definition comes from a validated `flow.yaml`; a missing or invalid file is an inert error state, never a crash.
- **S3** — progression persists per worktree in `flow-state.yaml` (§19.1).
- **S4** — entering a step injects its skill, refused while the shell is running a command (§19.3); todos come from an on-demand template picker (§21.2), never auto-created.
- **S5** — the in-progress status is derived live from agent activity (§8.3), todo completion and gate readiness, and pushed to the renderer on change (`flow:onStateChanged`).

#### 24.2.3 Loop-step slices

Labels code cites for loop steps (`kind: loop`). The app observed the loop before it was allowed to drive it — so it could not corrupt loop state before it had earned the right to.

- **T1** — multi-step flows: the machine walks N steps; the rail shows one station per step. Every place the app shows a step name (the rail, the loop panel, the composers, the controller card, the flow picker and the bootstrap error) shows it in sentence case: each `-` in the step id becomes a space and the first character is upper-cased, so `plan-approve` reads `Plan approve`. Only the displayed text changes; ids on the wire, in state and as keys stay as written. On a branched flow (§18.2) the rail shows only steps that will run: a step whose `when:` is false is left out, and each run of consecutive steps whose `when:` is not yet decided is replaced by one line, `next steps depend on the verdict`, which has no dot and is not counted. The current step always shows; the machine never lands on a step whose `when:` is false (§18.2). A deciding step that has recorded its decision shows it as a tag after its name: the value, then ` · ` and the note when the decision file carries one. After the word `Flow` the header reads `steps` while any step after the current one is undecided, and `step x / y` otherwise, where both numbers count only the shown stations, bookends included. The current step's station carries `aria-current="step"`, so a screen-reader user can find where the run is when the header shows no count (WCAG 1.3.1). The flow view carries `stepRuns` (`runs`, `skipped` or `unresolved` for each entry of `steps`, computed by `src/shared/flowBranch.ts`) and `decisions`; `position` still indexes the full `steps` list.
- **T2** — the loop view: the app-owned loop state (§27) is read on every poll, and a missing or corrupt file reads as `null`, never a throw.
- **T3** — bootstrap entry: a loop step's typed input (§18.4) is prompted for when unsatisfied, persisted, and threaded to later steps; the bootstrap is then injected, subject to the §19.3 refusal.
- **T4** — awaiting-human notification. Main classifies human-needed once (`src/shared/loopStatus.ts`), and two surfaces deliver it: the status-bar alert (§22.3.1) and the associated controller card (§23.6). Qualifying entries publish immediately, even while the terminal is focused. The controller records its receipt time and displays the newest of three retained distinct entries separately from live work, with repeat counts and expandable earlier history (§23.6). History is in memory only; reconnect reuses it, while restart, Dismiss and directory overlap forget it and rebuild only from current information. Updated terminals never create OS notifications or fall back to them during controller outages; notification failure cannot interrupt terminal work or decide a gate. Historical `notify.failed` audit entries remain readable; this destination writes no new notification audit records. Notification support uses additive controller protocol minor negotiation, and ordinary registration/status/activation remain compatible with older peers. Both apps must support the extension to show received notifications; an older terminal's own OS behavior is unchanged.
- **T5, T6** — retired labels. Gate decisions are specified in §27.9.
- **T7** — the ticket and PR a flow is working on. A flow surfaces only the refs its own typed inputs resolve (`github-ticket`, `pr`), once the step requesting each has been entered. Ref details are fetched best-effort through `gh`, cached per `(repo, kind, number)`: the same number in another repo is another ref, so a fetch issued for repo A must never answer for repo B's identically numbered PR. Links open only after an https + GitHub-host allow-list shared by main and the renderer (`src/shared/githubUrl.ts`, CWE-601). Restart clears resolved inputs so the first step asks again; Undo keeps them.

---
