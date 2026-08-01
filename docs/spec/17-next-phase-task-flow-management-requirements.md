## 17. Next phase — task-flow management (requirements)

> **Status:** requirements for the next build phase, drafted v2.27. Folds the design captured in the rationale companion `flow-management-requirements.md` (decisions **D1–D40**). It builds a **management layer** on top of the §1–§16 terminal host and a loop engine (config-driven loops with phases, gates, verdicts) — the external **`agent-loop`** binary this section was originally drafted against, superseded by the in-app engine of §27. Like §15, nothing here changes the shipped §12 acceptance criteria until promoted; **on any conflict with the companion doc, the spec wins.**

### 17.1 Goal & boundary

- Turn the terminal host into a **single-operator harness** that drives one coding task **from input artifact to merged PR**. The app adds **flow** orchestration, **artifact** review, **todo/feedback** curation, and a **fast 3-view UI**; loop execution is the app's own in-app engine (§27), not the external `agent-loop` binary.
- A **flow** starts from an input artifact (document(s) or a GitHub ticket) and is an ordered list of **steps**, each producing output artifacts and ending in a **gate** — a human "ready to transition" decision (D3).
- **Configuration is authored outside the app** — by a Claude Code skill or by hand (§18.5/D20). The app **runs** definitions; there is no in-app flow-authoring UI.

### 17.2 Two-layer ownership (D1/D2)

- **The app owns both flow-progression state** (`flow-state.yaml`) **and loop state** (§27.10) — there is no external writer to keep in sync with.
- **Gates are driven in-app, not by injected slash commands** (§27.9): the app itself executes the transition and its side-effects (§27.13), never shelling a command into the hosted terminal for the loop to interpret.

### 17.3 Reuse map (D4)

- **Reused as-is/lightly:** PTY (§5), shadow + quiescence (§8), injection (§9.3), scanner **report-detection** (§15), todo store (§16), OSC-133 command tracker, the `sessionId` convention, the §9.1 relocation rule.
- **Reshaped:** monitor pane → **Todo + Capture tabs** in the quick-send overlay / Todos+Status view (§22); capture → **manual single-slot** (§21.1); status indicators → the **status strip** (§22.3).
- **New:** flow engine, artifact viewer + file tree, todo templates, feedback composer, 3-view shell + overlay + layout config, `gh` bridge, worktree/child-instance launcher, cross-instance guard.

---

