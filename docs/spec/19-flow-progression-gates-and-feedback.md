## 19. Flow progression, gates & feedback

### 19.1 Flow-state & the agent-loop bridge (D1/D33)

- `flow-state.yaml` records the current step, per-step status, and gate state. A main-process **bridge** watches/parses `.agent-loop/state.yaml` and derives **loop progress** (iteration, severity cycle, latest verdict, open-findings count) for the status strip (§22.3); changes fire `flow:onStateChanged` and the pane re-pulls `flow:state`.
- **VCS:** the app **does not** modify `.gitignore` — for `flow-state.yaml`, the audit pointer, or any app-owned `.agent-terminal/` file (matching the todoStore, §16.3). Whether to ignore or commit `.agent-terminal/` (so progression travels with a branch) is the user's choice; the production system never edits the user's VCS config.

### 19.2 Advance is user-driven, with a not-ready warning (D31)

- The flow **never auto-advances**. The app detects whether the current step's gate is satisfied and surfaces an **"Advance to <next step>"** control (status strip). Advancing on an unsatisfied gate **warns** ("not ready — <reason>") but **proceeds** (human override). `flow:advance` returns the new state with a `ready` flag; on entry it runs the next step's entry actions (§18.3/§18.6).

### 19.3 Gate driver & the running-process refusal (D2/D32)

- Gate actions inject the matching agent-loop slash command (`approve` / `request-changes` / `impasse`), then reconcile via the bridge (§19.1).
- **Injection refuses while a foreground process is running** — the shell is not at a ready prompt (detected via §8.3 quiescence / OSC-133 marks). The app **stops and tells the user what to do** ("agent is busy — wait or interrupt, then retry") rather than typing over a live process. The same rule governs `action` commands (§18.2) and `bootstrap` (§18.3).

### 19.4 Request-changes feedback (D7/D9/D11)

- Only loop steps take request-changes. At the gate the user **selects which review todos** to include (a curated subset — sourced via §21.1 capture → Add-to-todo), optionally **adds free-text instructions**, and chooses **"Compose with agent"** (selected todos + instructions → agent writes the reason → inject `/agent-loop-request-changes`) **or "Submit todos as-is"** (verbatim). `flow:composeFeedback` builds the reason; the gate driver (§19.3) injects it.

---

