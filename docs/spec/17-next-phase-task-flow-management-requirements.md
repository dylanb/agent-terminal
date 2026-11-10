## 17. Task-flow management

The *why* behind §17–§23 is recorded in the decisions log `flow-management-requirements.md` (D-numbers); on any conflict the spec wins.

### 17.1 Goal & boundary

- The terminal host is a **single-operator harness** that drives one coding task **from input artifact to merged PR**: **flow** orchestration, **artifact** review, **todo/feedback** curation, and a **fast 3-view UI**, with loops run by the app's own engine (§27).
- A **flow** starts from an input artifact (document(s) or a GitHub ticket) and is an ordered list of **steps**, each producing output artifacts and ending in a **gate** — a "ready to transition" decision (D3).
- **Configuration is authored outside the app** — by a Claude Code skill or by hand (§18.5/D20). The app **runs** definitions; there is no in-app flow-authoring UI.

### 17.2 Two-layer ownership (D1/D2)

- **The app owns both flow-progression state** (`flow-state.yaml`) **and loop state** (§27.10), so there is no external writer to keep in sync with.
- **Gates are driven in-app, not by injected slash commands** (§27.9): the app executes the transition and its side-effects (§27.13) itself, never shelling a command into the hosted terminal for the loop to interpret.

### 17.3 Reuse map (D4)

The flow layer is built on the terminal host rather than beside it: PTY (§5), shadow + quiescence (§8), injection (§9.3), scanner report-detection (§15), todo store (§16), the OSC-133 command tracker, the `sessionId` convention and the §9.1 relocation rule are shared, not duplicated.

---
