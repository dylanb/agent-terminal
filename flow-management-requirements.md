# Requirements — Agent Terminal as a Task-Flow Management Application

> **Retired-engine note (as of 2026-07-30, post-N8):** this companion describes the app in the present tense as a management layer over the **external `agent-loop` engine** — `.agent-loop/state.yaml`, LoopDef yaml, injected `/agent-loop-*` slash-command gates. That engine (spec §26) is **retired**; the shipped engine is the in-app §27 loop engine. This document is left standing as history — its `agent-loop` mechanics are dated, not current.

**Document status:** Rationale companion (interview complete). Folded into the spec 2026-06-16.
**Relationship to existing docs:** The **normative** design is now in `terminal-web-ui-spec.md` **§17–§24** (v2.27); capture changes in **§15/§16** (v2.27). **The spec is authoritative on any conflict.** This document is retained as the **intent + decisions-log companion** — it records *why* (D1–D40, plus D63) behind the spec's *what*.

> **Reconciled 2026-06-16 (spec v2.27).** The interview is complete: every open (OPEN-1…OPEN-25) is resolved
> or deferred (OPEN-10 → user testing). The architecture/data-model (was §8), implementation breakdown (was
> §9), and first slice (was §10) have been **promoted into the spec** and are summarized here only as
> pointers — see §8/§9/§10 below. **§1 Intent**, **§7 Decisions log (D1–D40, plus D63)**, and the resolved **§6** are
> kept as the durable rationale. When updating the design, change the spec first, then back-fill a decision
> here if the *why* is new.
>
> Map: D1–D4 → spec §17 · D5/D18/D21/D22/D23 → §23 · D3/D10/D13/D14/D15/D29/D30/D34/D37/D38 → §18 ·
> D1/D2/D7/D9/D11/D31/D32/D33 → §19 · D8/D19/D24/D25/D35 → §20 · D12/D38/D39 → §21 · D6/D17/D26/D27/D28/D36/D40 → §22.
> D63 (added 2026-09-29; D41–D62 are the retired loop-engine block) → §18.7.5/§23.2.

---

## 1. Intent

Let a single person **manage the agentic development of a task from start to finish** — from an initial
artifact (a document, a set of documents, or a GitHub ticket) through a configurable sequence of steps,
each producing output artifacts, each ending at a **human gate** ("yes, this is ready to move on").

The application is a **configuration + management layer on top of the agent-loop** (`../ai-deque-org`):

- **agent-loop** provides the autonomous work/review/gate engine, loop definitions (LoopDef yaml),
  per-loop slash commands (`/agent-loop-approve`, `/agent-loop-request-changes`, `/agent-loop-impasse`,
  `/agent-loop-compose-feedback`, `/agent-loop-status`), and a state contract (`.agent-loop/state.yaml`,
  artifacts under `.agent-loop/`).
- **This app** adds: a **flow** abstraction (ordered steps, each gated, artifacts in → artifacts out),
  a **configuration skill** (Claude, running inside the hosted terminal, configures the flow), and a
  **management UI** (work with the agent, view/interact with artifacts, view/interact with todos).

### Design principles for the UI

- **Efficient to use.** Minimize clicks; keyboard-fast switching between views.
- **Progressive disclosure.** Artifacts, todos, and overall status are simple to understand at a glance;
  not everything is shown continuously, but any relevant detail is **one click away**.
- **Fast full-screen view switching** between three primary modes:
  1. **Work with the agent** (the terminal).
  2. **View and interact with artifacts** (built-in viewer + file tree).
  3. **View and interact with todos** (and overall flow status).

---

## 2. Core concepts (working definitions — to be refined)

- **Flow** — an ordered sequence of **steps** that takes an initial artifact to a finished outcome.
- **Step** — a unit of work: consumes input artifact(s), produces output artifact(s), and **always ends
  at a gate**. A step may be **agent-loop-backed** (its work is performed by an agent-loop, e.g. the plan
  step runs the plan-loop) or **[OPEN: non-loop / manual]**.
- **Gate** — the human decision point that transitions a step: approve (move on), request changes (send
  back for more work), or impasse. Maps to agent-loop gate actions for loop-backed steps.
- **Artifact** — a file or set of files produced/consumed by a step (e.g. a GitHub ticket, `ticket.md`,
  a draft plan, a plan gate report, code, review reports).
- **Configuration** — done **entirely through a Claude skill running inside the hosted terminal**, not
  through GUI config screens. The skill authors the flow definition.

---

## 3. The configuration flow

- Configuration is performed by a **new skill** we will build, run by Claude **inside the hosted
  terminal**. [OPEN: what does the skill output — a declarative flow-definition artifact the UI reads?
  Where is it stored? See §6 open questions.]
- A flow **starts with an input artifact**: a document, a set of documents, or a GitHub ticket.
- Each step has a gate. Loop-backed steps use an agent-loop (e.g. plan step: GitHub ticket → plan-loop →
  `ticket.md` + draft plan + plan gate report).

---

## 4. The review step (capabilities)

At a review/gate step, the user must be able to:

1. **Pre-baked todo templates.** Choose a todo-list template and instantiate it into working todos.
2. **Capture from agent interactions.** Capture content from the terminal agent interaction into todos
   (this is the app's *current* capture→todo functionality, `terminal-web-ui-spec.md` §15/§16).
3. **Built-in artifact viewer.** View artifacts with:
   - code viewing,
   - markdown preview **with Mermaid** rendering,
   - standalone Mermaid chart viewing.
4. **Searchable hierarchical file viewer.** Browse + search the created artifacts in a file tree and open
   them in the viewer.
5. **Select-to-act.** Select content in the viewer and send it **to the agent** or **to the todo list**.

---

## 5. UI structure (initial)

Three fast-switchable full-screen views (see §1 principles). [OPEN: exact navigation model, status
surface, how the flow/step/gate state is always-visible vs one-click.]

---

## 6. Remaining open questions (post-interview)

All numbered opens are now **resolved or explicitly deferred** — none block the §9 breakdown.

**Deferred (revisit after user testing):**
- **[OPEN-10] "Deep work mode" definition** — strip-hidden-only vs. collapse-to-terminal-only, and its
  toggle. Intentionally undefined for v1; ships the minimal strip-visibility reading under D26/D28 (see D6).

**Resolved:**
- ~~**[OPEN-18] Flow-state in VCS.**~~ **Resolved D33** — gitignored by default, user may opt to commit.
- ~~**[OPEN-19] Step input-type catalog.**~~ **Resolved D34** — `github-ticket`/`pr`/`files`/`free-text`,
  extensible registry.
- ~~**[OPEN-20] `action` step semantics.**~~ **Resolved D30** — declared shell command + gate.
- ~~**[OPEN-21] Loop-command drive mechanism.**~~ **Resolved D32** — inject, but refuse over a running
  process and tell the user what to do.
- ~~**[OPEN-22] Flow advance trigger.**~~ **Resolved D31** — user always advances; app warns if not ready.
- ~~**[OPEN-23] Manual-step skill/template binding.**~~ **Resolved D37** — `skill:` and `todo_template:`
  are **references, never inline** (registered name **or** file path), to avoid YAML bloat + enable reuse.
- ~~**[OPEN-24] Viewer tech.**~~ **Resolved D35** — CodeMirror 6 + markdown-it + mermaid.js.
- ~~**[OPEN-25] Exact hotkeys.**~~ **Resolved D36** — Ctrl/Cmd+1/2/3 + Ctrl/Cmd+K, remappable via
  `layout.json`.

---

## 8. Architecture & data model → **promoted to spec §17–§23**

> The two-layer ownership, on-disk layout, `flow.yaml` shape, IPC additions, and reuse map that used to live
> here are now **normative in `terminal-web-ui-spec.md`**: ownership → §17.2, reuse map → §17.3, `flow.yaml` +
> on-disk paths → §18.1, IPC channels (`flow:*` / `viewer:*` / `todoTemplate:*` / `capture:last`) → §6 (table)
> and §18–§21. Rationale for each choice remains in §7 (D1–D40, plus D63) below.

## 9. Implementation breakdown → **promoted to spec §24**

> The W1–W19 work units and their per-unit tests now live in **spec §24** (with the first slice in §24.1).
> Each W# cites the spec section it implements; the rationale (D-numbers) stays in §7 below.

## 10. Suggested first slice → **promoted to spec §24.1**

---

## 7. Decisions log

**[D1 · 2026-06-16] Flow ownership (resolves OPEN-1).** The **app owns the flow-progression state**;
each agent-loop keeps **its own** `.agent-loop/state.yaml`. The app must **facilitate keeping agent-loop
state in sync with what the user is doing in the UI** (e.g. driving a gate transition, then re-reading
loop state). So: app-owned flow manifest + flow-state, agent-loop-owned per-step loop state, app keeps
the two in sync.

**[D2 · 2026-06-16] Gate mechanism (resolves OPEN-2).** Gate buttons **inject the agent-loop slash
commands** (`/agent-loop-approve`, `/agent-loop-request-changes`, `/agent-loop-impasse`, …) into the
running terminal agent via the existing injection path (`terminal-web-ui-spec.md` §9.3). The agent
executes the transition; the app then re-reads loop state.

**[D3 · 2026-06-16] Step taxonomy (resolves OPEN-3).** Steps are **typed**: `loop` (runs an agent-loop),
`manual` (human produces an artifact, then a gate), and `action` (external side-effect — open PR, deploy
— then a gate). **All step kinds end in a gate.**

**[D4 · 2026-06-16] Build approach (resolves OPEN-4).** **Hybrid / reuse-where-it-fits.** Reuse the
existing main-process subsystems (PTY, shadow, scanner, injection, todo store) and renderer code where
they fit, but **nothing is sacred** — any existing piece may be reshaped or replaced if it doesn't fit
the new UX. Bias toward reuse, not constraint.

**[D5 · 2026-06-16] Multi-instance, single-flow (resolves OPEN-7/8).** **One flow per app instance**, but
the user must be able to **run many instances at once** (each instance drives its own flow — its own
terminal session, repo/branch/PR, agent-loop chain). No in-app multi-flow dashboard; concurrency is
achieved by launching multiple instances. [OPEN-9: do instances need any cross-instance coordination —
e.g. avoiding two instances on the same repo/branch — or are they fully independent?]

**[D6 · 2026-06-16] Status surface (resolves OPEN, partial).** A **persistent slim status strip** (current
step, gate state, agent activity) that is **hideable for a "deep work" mode**. Full step timeline is one
click away. [OPEN-10 — **DEFERRED to user testing** (2026-06-16): the exact meaning of "deep work mode"
(strip-hidden-only vs. collapse-to-terminal-only, and its toggle) is intentionally left undefined; revisit
once we have hands-on feedback. v1 ships the minimal reading available under D26/D28 — a strip-visibility
toggle on the Terminal view — without committing to a separate mode.]

**[D7 · 2026-06-16] "More work" applies to loop steps only (resolves OPEN-3 detail).** Only **agent-loop
steps** can be "sent back for more work" (request-changes). **Manual** steps just have a gate (done / not
done). Future automated step types that need rework would be **new step types** (an extension), not a
change to this model. [OPEN-6 still open: *how* the request-changes feedback for a loop step is composed.]

**[D9 · 2026-06-16] Request-changes feedback composition (resolves OPEN-6).** At an agent-loop gate, the
user **selects which review todos to include** (a curated subset, not all), optionally **adds free-text
instructions**, and is offered the option to **have the agent compose** the request-changes feedback from
the selected todos + instructions. The composed feedback is then submitted via
`/agent-loop-request-changes` (injected). [OPEN-11: is there also a non-agent path — submit the selected
todos verbatim as the reason without agent composition? See round 3.]

**[D10 · 2026-06-16] Flow definition format (resolves part of OPEN-1).** The config skill **writes a
declarative flow file the app reads + watches**, e.g. `.agent-terminal/flow.yaml`: ordered **steps**, each
with a `kind` (`loop` / `manual` / `action`), its loop binding (for loop steps), and input/output
**artifact paths**. File-based, mirroring agent-loop's own file contracts. [OPEN-12: flow definitions are
chosen from a **library of multiple definitions** — see D13.]

**[D11 · 2026-06-16] Feedback paths (resolves OPEN-11).** Offer **both**: **"Compose with agent"**
(selected todos + instructions → agent writes the reason → inject `/agent-loop-request-changes`) **and**
**"Submit todos as-is"** (selected todos become the reason text directly, no agent round-trip).

**[D12 · 2026-06-16] Todo templates (resolves OPEN, templates).** Todo templates are **global**, stored in
app userData (e.g. `~/.config/agent-terminal/todo-templates/`), **authored in-app**, available
cross-project. Picking one at a review step instantiates its items as todos. (Format: **markdown list** —
D38. Also reusable as external files referenced by a step — D37.)

**[D13 · 2026-06-16] Flow definitions are chosen from a library.** There are **multiple flow definitions**
the user **chooses from** when starting a task.

**[D14 · 2026-06-16] Flow library location (resolves OPEN-12).** **Both** a **global** library
(`~/.config/agent-terminal/flows/`) **and per-repo** definitions (`.agent-terminal/flows/`). The picker
merges both; **repo entries win on name clash**.

**[D15 · 2026-06-16] Flow start & per-step bootstrap (resolves OPEN-13).** The user **clicks Start**, which
begins **step 1**. **Bootstrap (`agent-loop pickup`) is a per-step ENTRY action** declared by a step: it
runs on **entry to that step**, which may be **any step — including the first** (so a flow whose first step
needs a PR bootstraps at the very start; a flow that begins with a `manual` step does not). It is therefore
**not intrinsically a flow-start action** — it is tied to **step entry**, and any given step may or may not
declare it. At any step entry the app may **prompt the user to identify the required input artifact(s)**
(GitHub ticket, files, or an existing PR — D29). Worked example (a representative flow):
  1. **Groom a GitHub ticket** — `kind: manual`, no bootstrap. User works with the agent via a **skill + a
     custom todo list**; output artifact = the **modified GitHub ticket**; the **user decides when done**
     and advances (no request-changes — it's manual). *No PR exists yet.*
  2. **→ entering Plan** — `kind: loop` with `bootstrap: pickup`. On entry to this step the app runs
     `agent-loop pickup <ticket>` to **create the PR**, then `agent-loop <pr> --loop plan-loop`; the loop
     runs and **stops for human review**. Output may be a **single PR + a set of issues**, or **multiple
     PRs (an epic)**.
(Had step 1 itself been a `loop` step with `bootstrap: pickup`, the pickup would run at flow start.)
Note: **agent-loop creates new PRs as artifacts of its own work** — a step's outputs are not all known up
front. [OPEN-14: epic / multi-PR output handling — see round 5.]

**[D16 · 2026-06-16] Manual step mechanics.** A `manual` step may pair the agent with a **skill** and a
**custom todo list (template)**; the human **decides when the step is done** and advances the gate. No
agent-loop request-changes cycle for manual steps (D7).

**[D18 · 2026-06-16] Epic / multi-PR handling (resolves OPEN-14).** **All steps of a flow run on each
PR.** When a loop step produces N PRs (an epic), **each PR becomes its own flow** sharing a common
ancestor — but **there is no going back**, so the ancestry doesn't need tracking. The user ends up with
**N app instances**, each working its **own child stream in its own git worktree on its PR branch**. So:
the app does **not** centrally orchestrate an epic tree; **multi-instance + git worktrees** is the
mechanism. [OPEN-15: does the app *assist* creating the N worktrees + launching instances, or is that
manual? See round 6.] [OPEN-16: instances run in **git worktrees** — confirm the worktree model and where
per-flow state lives relative to a worktree.]
*(2026-09-29: reading "all steps of a flow run on each PR" as the child running the parent's flow is
superseded by D63 — each child worktree runs the flow the operator chooses when they Start there. The
N-worktree, N-instance model stands.)*

**[D19 · 2026-06-16] GitHub tickets/PRs are markdown artifacts.** A GitHub ticket (and PR body) is **just
markdown** and is shown in the **built-in viewer** like any other artifact. [OPEN-17: how the ticket/PR
markdown is fetched/cached for the viewer — gh CLI from main, or read from agent-written artifacts like
`pr-context.md`. See round 6.]

**[D20 · 2026-06-16] App runs definitions; authoring is separate.** Flow definitions are authored **via the
skill or hand-written**; the **app only runs** definitions (lists + starts + drives them). No in-app flow
authoring UI.

**[D21 · 2026-06-16] Cross-instance guardrail (resolves OPEN-9).** Instances are independent, but if two
target the **same repo+branch (or same PR)**, the second **warns** ("already managed elsewhere") to avoid
clobbering agent-loop state.

**[D22 · 2026-06-16] App assists worktree + instance creation (resolves OPEN-15).** The app **assists**
opening epic children: for each child PR it creates the **git worktree** for that branch and launches a new
instance — crucially **seeding that worktree's flow-state** so the new instance **resumes at the correct
step** of the flow. (The app must get flow state into the right state for each PR.)
*(2026-09-29: the flow-state seeding is superseded by D63 — a child's flow is bound at Start. The worktree
and instance-launch assist stands.)*

**[D23 · 2026-06-16] Flow state lives in the worktree, per-branch (resolves OPEN-16).** Each worktree/branch
carries its own `<worktree>/.agent-terminal/flow.yaml` (the **instantiated definition**) and
`flow-state.yaml` (the **progression**). [OPEN-18: committed vs gitignored — sub-detail, lean gitignored
unless we want flow state shared via the branch.]

**[D24 · 2026-06-16] GitHub fetch (resolves OPEN-17).** **Prefer agent/loop-written artifacts** (e.g.
`pr-context.md`, `ticket.md`) for the viewer; offer a **"Refresh from GitHub" via gh CLI** (from main) to
pull live state on demand and update the cached markdown.

**[D25 · 2026-06-16] Viewer v1 scope.** Render: **code** (syntax-highlighted, read-only), **markdown with
Mermaid** blocks, and **standalone Mermaid** charts. **No dedicated diff view in v1** (changed/PR files
viewed as code/markdown for now); diff, images, PDF are later.

**[D17 · 2026-06-16] Reconfigurable UI (cross-cutting requirement).** The **navigation/layout model is not
yet settled** and **will be decided by user testing** — e.g. "switch to the Todos view, send a todo to the
terminal, switch back" **vs.** "a hotkey overlays the Todos list for quick selection-and-send." Likewise
gate controls live in a **collapsible section** (the status strip if that proves right). Therefore the UI
**must be built from easily reconfigurable / composable widgets**: we ship **one starting configuration**
but **layout, overlays vs. full-view switching, and widget placement must be changeable without rewriting
everything**. This is a first-class architectural constraint, not a nice-to-have.

**[D26 · 2026-06-16] v1 navigation (the one starting configuration).** **Three full-screen views** with
hotkey switching — **1 Terminal**, **2 Artifacts** (file tree + viewer), **3 Todos + Status** — **plus a
hotkey "quick-send overlay"** that pops the Todos list over the current view to **pick a todo and send it
to the terminal** without leaving the view. The overlay is the headline efficiency feature.

**[D27 · 2026-06-16] Status strip contents.** The strip shows, glanceably: **step position** (n/total +
name), **gate state**, **agent activity** (working/quiet, §8.3), and **loop progress** (iteration, severity
cycle, latest verdict + open-findings count) for loop steps. Details one click away.

**[D28 · 2026-06-16] Reconfig depth for v1.** **Config-swappable layout with clean widget boundaries** —
each widget (terminal, viewer, file tree, todos, gate panel, status strip, overlay) is a self-contained,
placement-agnostic component positioned by a **layout config (data)**: which view holds which widgets, what
the overlay shows, the hotkeys. **No runtime drag-dock** workspace in v1. Changing layout = editing config,
not rewriting widgets.

**[D29 · 2026-06-16] Typed step inputs.** Each step in the flow definition **declares its required input
artifacts with types** (e.g. `github-ticket`, `pr`, `files`, `free-text`). When a step starts and an input
isn't already available, the app **prompts with the matching picker** (ticket #, file chooser, PR
selector). Makes "identify the starting artifact" systematic and validatable.

**[D8 · 2026-06-16] Artifact discovery (resolves OPEN-5).** Default review/search artifact set =
**agent-loop artifacts** (discovered from the **LoopDef `artifacts:` declarations** + the `.agent-loop/`
directory) **∪ everything in the current PR** (changed files). A **checkbox** expands the view to **any
file in the current repo**, with **visual differentiation** for files that are: (a) changed in the working
tree, (b) part of the agent-loop, (c) part of the PR. So: curated-by-default, whole-repo on demand, with
provenance tags.

**[D30 · 2026-06-16] `action` step semantics (resolves OPEN-20).** An `action` step **runs a declared shell
command + gate**. The definition expresses the side-effect as a **command string** (e.g. `gh pr create …`,
a deploy script); the app runs it in the **hosted terminal** (visible to the user, reusing the same
injection path as gates — D2/D31-refusal rule), then presents the step's gate. No built-in typed
action-handler catalog in v1; richer named actions are a later extension.

**[D31 · 2026-06-16] Flow advance is always user-driven, with a not-ready warning (resolves OPEN-22).** The
**user always triggers advance** — the flow never auto-advances. The app **detects whether the current
step's terminal gate is satisfied** and surfaces an **"Advance to <next step>"** control (in the status
strip). If the user advances while the gate is **not** satisfied, the app **warns** ("step not ready —
<reason>") but **still lets the user proceed** (human override). So: confirm-to-advance model + readiness
warning, never a hard block.

**[D32 · 2026-06-16] Loop-command drive = inject, but refuse over a running process (resolves OPEN-21).**
App-driven loop commands (`agent-loop pickup`, `agent-loop <pr> --loop …`, gate slash-commands) are
**injected into the hosted terminal** (consistent with D2 — single execution context, visible to the user).
**But** if a **foreground process is already running** (the shell isn't at a ready prompt — detected via the
shadow quiescence / OSC-133 command tracker, `terminal-web-ui-spec.md` §8/§15), the app **must not inject
over it**: it **stops and tells the user what to do** (e.g. "agent is busy — wait for it to finish or
interrupt it, then retry"). No silent queueing on top of a live process.

**[D33 · 2026-06-16] Flow-state in VCS — user chooses, gitignored by default (resolves OPEN-18).**
`flow-state.yaml` (and the app-owned `.agent-terminal/` progression) is **gitignored by default** — the app
writes the ignore entry on first use. The **user may opt to commit it** (per-repo setting) so progression
travels with the branch (useful for handing a branch to another instance/teammate — relates to D22/D23).

**[D34 · 2026-06-16] Step input-type catalog (resolves OPEN-19).** v1 ships **four input types** —
`github-ticket` (issue #), `pr` (PR # / branch), `files` (path glob / chooser), `free-text` (prompt
string) — backed by an **extensible registry** so new types can be added without a schema rewrite (D29
pickers key off the type).

**[D35 · 2026-06-16] Viewer tech (resolves OPEN-24).** Built-in viewer uses **CodeMirror 6** for code
(read-only, lightweight, strong text-selection model for select-to-send — §4.5), **markdown-it** for
markdown rendering, and **mermaid.js** for diagrams (in-markdown blocks + standalone — D25). Chosen over
Monaco (heavier, awkward selection) and Shiki (no editor affordances).

**[D36 · 2026-06-16] Hotkeys (resolves OPEN-25).** Ship defaults **Ctrl/Cmd+1/2/3** (Terminal / Artifacts /
Todos+Status) and **Ctrl/Cmd+K** (quick-send overlay — D26), but treat them as **data in `layout.json`**
(D28) so they're remappable without code changes.

**[D37 · 2026-06-16] Manual-step skill + template binding — reference, never inline (resolves OPEN-23).** A
`manual` step binds two **optional fields**, `skill:` and `todo_template:`. **Both are always *references*,
never inline bodies** — each resolves to **either a registered/global name OR an external file path**
(repo-relative or absolute). Rationale: skill playbooks and todo templates are **potentially large text
blobs** that would **bloat the flow YAML** and need to be **reused across multiple flow definitions**;
keeping them out-of-line keeps `flow.yaml` small and lets many flows share one source file.
  - **`skill:`** → a **Claude Code skill** (the `/skill-name` mechanism) by name, **or** a path to a skill
    file. On **step entry** the app **injects the skill invocation** into the hosted terminal so the agent
    loads that skill's playbook to drive the step's work. (Distinct from the *flow-author* skill of D20/W19,
    which writes definitions at config time — the per-step skill runs on every entry to its step.)
  - **`todo_template:`** → a **named global template** (D12), **or** a path to an external template file.
    Instantiated into todos on step entry.
Resolution rule (mirrors D14): if the value names a known registered entry, use it; otherwise treat it as a
file path. Repo-relative paths resolve against the worktree.

**[D38 · 2026-06-16] Todo template file format = a markdown list.** A todo template (named or file — D37/D12)
is a **markdown document whose list items are the todos**. Mapping into the existing **flat** todo model
(spec §16 — `todo:add` takes plain `text`, no nesting):
  - Each **top-level list item** (`-`, `*`, or `+`, with an optional `[ ]`/`[x]` checkbox marker that is
    **ignored** — all instantiate as **active** todos) becomes **one todo**; its text is the item text minus
    the marker.
  - **Nested sub-bullets and wrapped continuation lines stay attached to their top-level item** (one todo),
    reusing the §15.7 `splitFindings` grouping convention already in the app.
  - **Non-list content** (headings, blank lines, prose) is **ignored**, so a template can carry a
    title/notes/instructions without producing stray todos.
Chosen for simplicity and human-editability; no new on-disk todo schema — instantiation just emits
`todo:add` calls. *(W11 test: a markdown template with headings + nested items → the expected flat todo
set.)*

**[D39 · 2026-06-16] Capture becomes manual + single-slot (supersedes the §15 auto-emit model).** Capture is
**completely manual**: a **"Capture last report"** button captures **the latest agent report on demand**;
there is **no auto-emit on quiescence**. Capture holds a **single slot** — each capture **replaces** the
prior captured report (and its findings). Consequences vs. today's §15/§16:
  - The scanner's **report detection is kept** (the SCANNER_DEBUG `/tmp/scanner.log` trace stays — standing
    user note), but **runs on demand** when the button is clicked, against the **current shadow buffer** —
    the `onQuiet → emit` wiring for reports/findings is **removed**.
  - The growing newest-first **list UI and its Dismiss / Dismiss-all / dedup / supersede-retraction
    machinery are removed** — the pane shows either the **one current captured report** or nothing.
  - The captured report **still splits into findings** (§15.7 `splitFindings`); each finding is
    **individually "Add to todo"-able**, preserving the review→feedback pipeline (D9/D11). The whole report
    can also be added wholesale.
  - **New IPC** `capture:last` (renderer→main invoke): runs report detection on the current shadow buffer,
    returns `{report, findings} | null`; the renderer renders it, replacing any prior capture. Command-output
    capture keeps using the existing `monitor:captureCommandText` (spec §16.2).
  - Folding into the authoritative spec requires a **§15/§16 changelog entry** (auto-emit → manual; list →
    single slot). *(Test: clicking capture with a report present returns + renders it; a second capture
    replaces the first; findings are individually add-to-todo-able.)*

**[D40 · 2026-06-16] Capture lives as a tab in the quick-send overlay.** The quick-send overlay (D26/W14)
becomes a **tabbed overlay — `Todo | Capture`**; because these are placement-agnostic widgets (D28), the
same two tabs are also hostable in **view 3 (Todos+Status)**. The **Capture tab** = the "Capture last report"
button + the single current captured report (with findings); actions = **Add to todo** (per finding or whole
report) and **Insert / Insert & submit** (§16.2). Reached via the overlay hotkey (Ctrl/Cmd+K — D36) from any
view, sitting next to the todos it feeds. Chosen over a separate capture overlay (two surfaces to learn) and
a standalone capture view (not worth a top-level view).

**[D63 · 2026-09-29] A flow is bound to a worktree at Start, never from a ticket (supersedes D22's
flow-state seeding).** The operator picks the flow for a worktree and presses Start, which binds it; pickup
then binds the ticket to that already-bound worktree. A ticket's title, body and labels are untrusted,
attacker-authorable input, so they never select a flow. Epic child worktrees follow the same rule: the app
creates the child worktree and launches its instance (D22), and the child's flow is bound when the operator
Starts there. Continuing one ticket across worktrees is the operator's responsibility; the app does not
carry the flow across. Operator decision 2026-09-29 (#135 closed won't-do, #167). Spec: §18.7.5, §23.2.
